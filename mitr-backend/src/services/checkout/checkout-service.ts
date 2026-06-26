import type { PoolClient } from 'pg';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { pgPool } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { validatePasswordPolicy } from '../auth/password-policy.js';
import {
  calculatePromoDiscount,
  formatAddress,
  formatINR,
  hashCustomerEmail,
  MIN_CHECKOUT_AMOUNT_PAISE,
  normalizeEmail,
  normalizePromoCode,
  stableJsonFingerprint,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type PromoCalculation,
  type ShippingAddressInput
} from './checkout-utils.js';
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  RazorpayApiError,
  type RazorpayPayment
} from './razorpay-client.js';
import { issueCheckoutAdminSessionToken } from './checkout-admin-auth.js';
import {
  notifyAdminOrderPaid,
  sendAdminInvite,
  sendAdminPasswordReset,
  sendCustomerPaymentReminder
} from '../email/checkout-emails.js';

type PromoKind = 'promo' | 'referral' | 'affiliate';
type DiscountType = 'flat' | 'percent';

export const CHECKOUT_ORDER_STATUSES = [
  'draft',
  'payment_order_failed',
  'payment_pending',
  'payment_signature_failed',
  'payment_authorized',
  'paid',
  'payment_failed',
  'payment_review_required',
  'cancelled',
  'expired'
] as const;

export type CheckoutOrderStatus = typeof CHECKOUT_ORDER_STATUSES[number];

export class CheckoutError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly publicCode: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export interface CheckoutCustomerInput {
  fullName: string;
  email: string;
  phone: string;
  receiveUpdates: boolean;
  address: ShippingAddressInput;
}

export interface CreateCheckoutOrderInput {
  idempotencyKey?: string;
  productId?: string;
  personalizedMessage?: string;
  customer: CheckoutCustomerInput;
  promoCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface VerifyCheckoutPaymentInput {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface CreatePromoCodeInput {
  code: string;
  label?: string;
  kind: PromoKind;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number;
  currency?: string;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number | null;
  affiliateId?: string | null;
  referrerId?: string | null;
  campaign?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface ListCheckoutOrdersInput {
  status?: CheckoutOrderStatus;
  promoCode?: string;
  email?: string;
  q?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface UpdatePromoCodeInput {
  label?: string;
  kind?: PromoKind;
  discountType?: DiscountType;
  discountValue?: number;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number;
  currency?: string;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number | null;
  affiliateId?: string | null;
  referrerId?: string | null;
  campaign?: string | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateCheckoutProductInput {
  name?: string;
  description?: string | null;
  pricePaise?: number;
  mrpPaise?: number | null;
  currency?: string;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LoginCheckoutAdminInput {
  email: string;
  password: string;
}

export interface CreateCheckoutAdminUserInput {
  email: string;
  createdBy: string;
}

export interface ChangeCheckoutAdminPasswordInput {
  adminId: string;
  currentPassword: string;
  newPassword: string;
}

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price_paise: number;
  mrp_paise: number | null;
  currency: string;
  is_active: boolean;
  metadata_json?: Record<string, unknown>;
  created_at?: Date;
  updated_at?: Date;
}

interface PromoRow {
  id: string;
  code: string;
  label: string;
  kind: PromoKind;
  discount_type: DiscountType;
  discount_value: number;
  max_discount_paise: number | null;
  min_order_paise: number;
  currency: string;
  starts_at: Date | null;
  expires_at: Date | null;
  max_redemptions: number | null;
  max_redemptions_per_customer: number | null;
  redeemed_count: number;
  is_active: boolean;
  affiliate_id: string | null;
  referrer_id: string | null;
  campaign: string | null;
  metadata_json?: Record<string, unknown>;
  created_by?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

interface OrderRow {
  id: string;
  idempotency_key: string | null;
  request_fingerprint: string;
  product_id: string;
  product_name: string;
  status: string;
  base_amount_paise: number;
  discount_paise: number;
  amount_paise: number;
  currency: string;
  promo_code_id: string | null;
  promo_code: string | null;
  promo_kind: PromoKind | null;
  affiliate_id: string | null;
  referrer_id: string | null;
  campaign: string | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  payment_signature_valid: boolean | null;
  payment_verified_at: Date | null;
  paid_at: Date | null;
  failed_at: Date | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  receive_updates: boolean;
  shipping_address_json: Record<string, unknown>;
  shipping_address_text: string;
  personalized_message: string | null;
  customer_email_hash: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface CheckoutAdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'owner' | 'admin';
  is_active: boolean;
  must_change_password: boolean;
  created_by: string | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PaymentEvent {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPayment };
  };
}

const SUPPORTED_RAZORPAY_WEBHOOK_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid'
]);

const checkoutEnabled = (): void => {
  if (!env.CHECKOUT_ENABLED) {
    throw new CheckoutError(503, 'Checkout is not enabled', 'checkout_disabled');
  }
};

const publicProduct = (row: ProductRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  pricePaise: row.price_paise,
  mrpPaise: row.mrp_paise,
  currency: row.currency,
  formattedPrice: row.currency === 'INR' ? formatINR(row.price_paise) : `${row.currency} ${row.price_paise}`
});

const applyDevPriceOverride = (row: ProductRow): ProductRow => {
  if (env.NODE_ENV === 'production' || env.CHECKOUT_DEV_PRICE_OVERRIDE_PAISE === undefined) return row;
  return {
    ...row,
    price_paise: env.CHECKOUT_DEV_PRICE_OVERRIDE_PAISE
  };
};

const checkoutKeyId = (): string => {
  if (!env.RAZORPAY_KEY_ID) {
    throw new CheckoutError(503, 'Razorpay key id is not configured', 'razorpay_not_configured');
  }
  return env.RAZORPAY_KEY_ID;
};

const hashAdminPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
};

const verifyAdminPasswordHash = (password: string, encoded: string): boolean => {
  const [scheme, salt, storedHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !storedHex) return false;
  const derived = scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
};

const DUMMY_ADMIN_PASSWORD_HASH = hashAdminPassword(randomBytes(24).toString('base64url'));

const generateTemporaryAdminPassword = (): string => `Rc-${randomBytes(14).toString('base64url')}9!`;

const publicCheckoutAdminUser = (row: CheckoutAdminUserRow) => ({
  id: row.id,
  email: row.email,
  role: row.role,
  isActive: row.is_active,
  mustChangePassword: row.must_change_password,
  createdBy: row.created_by,
  lastLoginAt: iso(row.last_login_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const ensureBootstrapCheckoutAdminUser = async (client: PoolClient): Promise<void> => {
  const countResult = await client.query<{ count: string }>('select count(*) as count from checkout_admin_users');
  if (Number(countResult.rows[0]?.count ?? 0) > 0) return;

  const bootstrapEmail = normalizeEmail(env.CHECKOUT_ADMIN_BOOTSTRAP_EMAIL || 'shivansh@heyreca.com');
  const bootstrapPassword = env.CHECKOUT_ADMIN_BOOTSTRAP_PASSWORD?.trim();
  if (!bootstrapPassword) return;

  const policy = validatePasswordPolicy({ password: bootstrapPassword, email: bootstrapEmail });
  if (!policy.ok) {
    logger.error('Checkout admin bootstrap password failed policy', { reason: policy.reason });
    return;
  }

  await client.query(
    `insert into checkout_admin_users (email, password_hash, role, must_change_password, created_by)
     values ($1, $2, 'owner', true, 'bootstrap')
     on conflict (email) do nothing`,
    [bootstrapEmail, hashAdminPassword(bootstrapPassword)]
  );
};

const getProduct = async (client: PoolClient, productId?: string): Promise<ProductRow> => {
  const resolvedProductId = productId?.trim() || env.CHECKOUT_DEFAULT_PRODUCT_ID;
  const result = await client.query<ProductRow>(
    `select id, name, description, price_paise, mrp_paise, currency, is_active
     from checkout_products
     where id = $1 and is_active = true`,
    [resolvedProductId]
  );
  const product = result.rows[0];
  if (!product) {
    throw new CheckoutError(404, 'Checkout product is not available', 'product_not_found');
  }
  if (product.price_paise < MIN_CHECKOUT_AMOUNT_PAISE) {
    throw new CheckoutError(500, 'Checkout product price is invalid', 'invalid_product_price');
  }
  const resolvedProduct = applyDevPriceOverride(product);
  if (resolvedProduct.price_paise < MIN_CHECKOUT_AMOUNT_PAISE) {
    throw new CheckoutError(500, 'Checkout product price is invalid', 'invalid_product_price');
  }
  return resolvedProduct;
};

const getPromoByCode = async (
  client: PoolClient,
  code: string,
  options?: { forUpdate?: boolean }
): Promise<PromoRow | null> => {
  const suffix = options?.forUpdate ? ' for update' : '';
  const result = await client.query<PromoRow>(
    `select id, code, label, kind, discount_type, discount_value, max_discount_paise,
            min_order_paise, currency, starts_at, expires_at, max_redemptions,
            max_redemptions_per_customer, redeemed_count, is_active, affiliate_id,
            referrer_id, campaign
     from checkout_promo_codes
     where code = $1${suffix}`,
    [code]
  );
  return result.rows[0] ?? null;
};

const promoUnavailableReason = (promo: PromoRow, now = new Date()): string | null => {
  if (!promo.is_active) return 'inactive';
  if (promo.starts_at && promo.starts_at.getTime() > now.getTime()) return 'not_started';
  if (promo.expires_at && promo.expires_at.getTime() <= now.getTime()) return 'expired';
  return null;
};

const getPromoUseCounts = async (
  client: PoolClient,
  promoCodeId: string,
  customerEmailHash?: string
): Promise<{ totalActive: number; customerActive: number }> => {
  const result = await client.query<{ total_active: string; customer_active: string }>(
    `select
       count(*) filter (
         where status = 'redeemed'
            or (status = 'reserved' and reserved_expires_at > now())
       ) as total_active,
       count(*) filter (
         where (
           status = 'redeemed'
           or (status = 'reserved' and reserved_expires_at > now())
         )
         and customer_email_hash = $2
       ) as customer_active
     from checkout_promo_redemptions
     where promo_code_id = $1`,
    [promoCodeId, customerEmailHash ?? '']
  );
  const row = result.rows[0];
  return {
    totalActive: Number(row?.total_active ?? 0),
    customerActive: Number(row?.customer_active ?? 0)
  };
};

const promoCapacityReason = async (
  client: PoolClient,
  promo: PromoRow,
  customerEmailHash?: string
): Promise<string | null> => {
  const counts = await getPromoUseCounts(client, promo.id, customerEmailHash);
  if (promo.max_redemptions !== null && counts.totalActive >= promo.max_redemptions) {
    return 'max_redemptions_reached';
  }
  if (
    customerEmailHash &&
    promo.max_redemptions_per_customer !== null &&
    counts.customerActive >= promo.max_redemptions_per_customer
  ) {
    return 'customer_limit_reached';
  }
  return null;
};

const calculatePromoForProduct = (
  promo: PromoRow,
  product: ProductRow
): PromoCalculation | null =>
  calculatePromoDiscount(
    {
      code: promo.code,
      label: promo.label,
      discountType: promo.discount_type,
      discountValue: promo.discount_value,
      maxDiscountPaise: promo.max_discount_paise,
      minOrderPaise: promo.min_order_paise,
      currency: promo.currency
    },
    product.price_paise,
    product.currency
  );

const orderFingerprint = (input: CreateCheckoutOrderInput, productId: string): string =>
  stableJsonFingerprint({
    productId,
    personalizedMessage: input.personalizedMessage ?? '',
    promoCode: input.promoCode ? normalizePromoCode(input.promoCode) : null,
    customer: {
      fullName: input.customer.fullName,
      email: normalizeEmail(input.customer.email),
      phone: input.customer.phone,
      receiveUpdates: input.customer.receiveUpdates,
      address: input.customer.address
    }
  });

const normalizeMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!metadata) return {};
  const allowed: Record<string, unknown> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'landing_page'] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length <= 512) allowed[key] = value;
  }
  return allowed;
};

const insertDraftOrder = async (
  client: PoolClient,
  input: CreateCheckoutOrderInput,
  product: ProductRow,
  fingerprint: string,
  customerEmailHash: string,
  promo: { row: PromoRow; calculation: PromoCalculation } | null
): Promise<OrderRow> => {
  const addressText = formatAddress(input.customer.address);
  const orderResult = await client.query<OrderRow>(
    `insert into checkout_orders (
       idempotency_key, request_fingerprint, product_id, product_name, status,
       base_amount_paise, discount_paise, amount_paise, currency,
       promo_code_id, promo_code, promo_kind, affiliate_id, referrer_id, campaign,
       customer_name, customer_email, customer_phone, receive_updates,
       shipping_address_json, shipping_address_text, personalized_message,
       customer_email_hash, metadata_json
     )
     values (
       $1, $2, $3, $4, 'draft',
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18,
       $19::jsonb, $20, $21,
       $22, $23::jsonb
     )
     returning *`,
    [
      input.idempotencyKey?.trim() || null,
      fingerprint,
      product.id,
      product.name,
      product.price_paise,
      promo?.calculation.discountPaise ?? 0,
      promo?.calculation.finalPaise ?? product.price_paise,
      product.currency,
      promo?.row.id ?? null,
      promo?.row.code ?? null,
      promo?.row.kind ?? null,
      promo?.row.affiliate_id ?? null,
      promo?.row.referrer_id ?? null,
      promo?.row.campaign ?? null,
      input.customer.fullName.trim(),
      normalizeEmail(input.customer.email),
      input.customer.phone.trim(),
      input.customer.receiveUpdates,
      JSON.stringify(input.customer.address),
      addressText,
      input.personalizedMessage?.trim() || null,
      customerEmailHash,
      JSON.stringify(normalizeMetadata(input.metadata))
    ]
  );
  const order = orderResult.rows[0];
  if (!order) throw new CheckoutError(500, 'Could not create checkout order', 'order_insert_failed');

  if (promo) {
    await client.query(
      `insert into checkout_promo_redemptions (
         promo_code_id, order_id, customer_email_hash, status, discount_paise, reserved_expires_at
       )
       values ($1, $2, $3, 'reserved', $4, now() + ($5::text || ' seconds')::interval)`,
      [
        promo.row.id,
        order.id,
        customerEmailHash,
        promo.calculation.discountPaise,
        env.CHECKOUT_PROMO_RESERVATION_TTL_SEC
      ]
    );
  }

  return order;
};

const markPromoRedeemed = async (client: PoolClient, orderId: string): Promise<void> => {
  const redemptionResult = await client.query<{ promo_code_id: string }>(
    `update checkout_promo_redemptions
     set status = 'redeemed', redeemed_at = coalesce(redeemed_at, now()), updated_at = now()
     where order_id = $1 and status = 'reserved'
     returning promo_code_id`,
    [orderId]
  );
  for (const row of redemptionResult.rows) {
    await client.query(
      `update checkout_promo_codes
       set redeemed_count = redeemed_count + 1, updated_at = now()
       where id = $1`,
      [row.promo_code_id]
    );
  }
};

const attachRazorpayOrder = async (order: OrderRow): Promise<OrderRow> => {
  if (order.razorpay_order_id) return order;

  const client = await pgPool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [order.id]);

    const currentResult = await client.query<OrderRow>(
      `select * from checkout_orders where id = $1 for update`,
      [order.id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new CheckoutError(404, 'Checkout order was not found', 'order_not_found');
    if (current.razorpay_order_id) {
      await client.query('commit');
      return current;
    }

    let razorpayOrder;
    try {
      razorpayOrder = await createRazorpayOrder({
        amountPaise: current.amount_paise,
        currency: current.currency,
        receipt: `reca_${current.id.replace(/-/g, '').slice(0, 27)}`,
        notes: {
          internal_order_id: current.id,
          product_id: current.product_id,
          promo_code: current.promo_code ?? ''
        }
      });
    } catch (error) {
      await client.query(
        `update checkout_orders
         set status = 'payment_order_failed',
             updated_at = now(),
             metadata_json = metadata_json || $2::jsonb
         where id = $1`,
        [
          current.id,
          JSON.stringify({
            gateway_error:
              error instanceof RazorpayApiError
                ? { statusCode: error.statusCode, responseBody: error.responseBody }
                : { message: (error as Error).message }
          })
        ]
      );
      await client.query('commit');
      throw new CheckoutError(502, 'Could not create Razorpay order', 'razorpay_order_failed', {
        orderId: current.id
      });
    }

    const result = await client.query<OrderRow>(
      `update checkout_orders
       set status = 'payment_pending',
           razorpay_order_id = $2,
           updated_at = now(),
           metadata_json = metadata_json || $3::jsonb
       where id = $1 and razorpay_order_id is null
       returning *`,
      [
        current.id,
        razorpayOrder.id,
        JSON.stringify({
          razorpay_order: {
            status: razorpayOrder.status,
            attempts: razorpayOrder.attempts,
            created_at: razorpayOrder.created_at
          }
        })
      ]
    );
    const updated = result.rows[0];
    if (!updated) throw new CheckoutError(500, 'Could not update checkout order', 'order_update_failed');
    await client.query('commit');
    return updated;
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not attach Razorpay order', 'razorpay_order_attach_failed');
  } finally {
    client.release();
  }
};

const orderResponse = (order: OrderRow) => ({
  internalOrderId: order.id,
  razorpayOrderId: order.razorpay_order_id,
  amountPaise: order.amount_paise,
  baseAmountPaise: order.base_amount_paise,
  discountPaise: order.discount_paise,
  currency: order.currency,
  status: order.status,
  product: {
    id: order.product_id,
    name: order.product_name
  },
  promo: order.promo_code
    ? {
        code: order.promo_code,
        kind: order.promo_kind,
        affiliateId: order.affiliate_id,
        referrerId: order.referrer_id,
        campaign: order.campaign
      }
    : null,
  razorpayKeyId: checkoutKeyId()
});

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

const formattedAmount = (amountPaise: number, currency: string): string =>
  currency === 'INR' ? formatINR(amountPaise) : `${currency} ${amountPaise}`;

const publicAdminProduct = (row: ProductRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  pricePaise: row.price_paise,
  mrpPaise: row.mrp_paise,
  currency: row.currency,
  isActive: row.is_active,
  formattedPrice: formattedAmount(row.price_paise, row.currency),
  formattedMrp: row.mrp_paise === null ? null : formattedAmount(row.mrp_paise, row.currency),
  metadata: row.metadata_json ?? {},
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const publicPromoCode = (
  row: PromoRow,
  counts: { activeRedemptions?: number; redeemedCount?: number; orderCount?: number } = {}
) => ({
  id: row.id,
  code: row.code,
  label: row.label,
  kind: row.kind,
  discountType: row.discount_type,
  discountValue: row.discount_value,
  maxDiscountPaise: row.max_discount_paise,
  minOrderPaise: row.min_order_paise,
  currency: row.currency,
  startsAt: iso(row.starts_at),
  expiresAt: iso(row.expires_at),
  maxRedemptions: row.max_redemptions,
  maxRedemptionsPerCustomer: row.max_redemptions_per_customer,
  redeemedCount: counts.redeemedCount ?? row.redeemed_count,
  activeRedemptions: counts.activeRedemptions ?? 0,
  orderCount: counts.orderCount ?? 0,
  isActive: row.is_active,
  affiliateId: row.affiliate_id,
  referrerId: row.referrer_id,
  campaign: row.campaign,
  createdBy: row.created_by ?? null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const publicOrderSummary = (row: OrderRow) => ({
  id: row.id,
  status: row.status,
  product: {
    id: row.product_id,
    name: row.product_name
  },
  baseAmountPaise: row.base_amount_paise,
  discountPaise: row.discount_paise,
  amountPaise: row.amount_paise,
  currency: row.currency,
  formattedAmount: formattedAmount(row.amount_paise, row.currency),
  promo: row.promo_code
    ? {
        code: row.promo_code,
        kind: row.promo_kind,
        affiliateId: row.affiliate_id,
        referrerId: row.referrer_id,
        campaign: row.campaign
      }
    : null,
  customer: {
    name: row.customer_name,
    email: row.customer_email,
    phone: row.customer_phone,
    receiveUpdates: row.receive_updates
  },
  razorpayOrderId: row.razorpay_order_id,
  razorpayPaymentId: row.razorpay_payment_id,
  paymentSignatureValid: row.payment_signature_valid,
  paymentVerifiedAt: iso(row.payment_verified_at),
  paidAt: iso(row.paid_at),
  failedAt: iso(row.failed_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const encodeOrdersCursor = (row: OrderRow): string =>
  Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString('base64url');

const decodeOrdersCursor = (cursor: string): { createdAt: Date; id: string } => {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)
    ) {
      throw new Error('invalid cursor shape');
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor date');
    return { createdAt, id: decoded.id };
  } catch {
    throw new CheckoutError(400, 'Invalid orders cursor', 'invalid_cursor');
  }
};

export const getCheckoutProduct = async (productId?: string): Promise<ReturnType<typeof publicProduct>> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  try {
    return publicProduct(await getProduct(client, productId));
  } finally {
    client.release();
  }
};

export const listCheckoutProducts = async (): Promise<{ products: ReturnType<typeof publicAdminProduct>[] }> => {
  checkoutEnabled();
  const result = await pgPool.query<ProductRow>(
    `select id, name, description, price_paise, mrp_paise, currency, is_active, metadata_json, created_at, updated_at
     from checkout_products
     order by created_at desc, id asc`
  );
  return { products: result.rows.map(publicAdminProduct) };
};

export const updateCheckoutProduct = async (
  productId: string,
  input: UpdateCheckoutProductInput
): Promise<ReturnType<typeof publicAdminProduct>> => {
  checkoutEnabled();
  const resolvedProductId = productId.trim();
  if (!resolvedProductId) throw new CheckoutError(400, 'Product id is required', 'missing_product_id');
  if (input.pricePaise !== undefined && input.pricePaise < MIN_CHECKOUT_AMOUNT_PAISE) {
    throw new CheckoutError(400, 'Product price is below the minimum checkout amount', 'invalid_product_price');
  }
  if (input.mrpPaise !== undefined && input.mrpPaise !== null && input.mrpPaise < MIN_CHECKOUT_AMOUNT_PAISE) {
    throw new CheckoutError(400, 'Product MRP is below the minimum checkout amount', 'invalid_product_mrp');
  }
  if (input.currency !== undefined && input.currency.trim().length !== 3) {
    throw new CheckoutError(400, 'Product currency must be a 3-letter code', 'invalid_currency');
  }

  const assignments: string[] = [];
  const values: unknown[] = [resolvedProductId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    assignments.push(sql.replace('?', `$${values.length}`));
  };

  if (input.name !== undefined) add('name = ?', input.name.trim());
  if (input.description !== undefined) add('description = ?', input.description?.trim() || null);
  if (input.pricePaise !== undefined) add('price_paise = ?', input.pricePaise);
  if (input.mrpPaise !== undefined) add('mrp_paise = ?', input.mrpPaise);
  if (input.currency !== undefined) add('currency = ?', input.currency.trim().toUpperCase());
  if (input.isActive !== undefined) add('is_active = ?', input.isActive);
  if (input.metadata !== undefined) add('metadata_json = metadata_json || ?::jsonb', JSON.stringify(input.metadata));

  if (assignments.length === 0) {
    const current = await pgPool.query<ProductRow>(
      `select id, name, description, price_paise, mrp_paise, currency, is_active, metadata_json, created_at, updated_at
       from checkout_products
       where id = $1`,
      [resolvedProductId]
    );
    const row = current.rows[0];
    if (!row) throw new CheckoutError(404, 'Checkout product was not found', 'product_not_found');
    return publicAdminProduct(row);
  }

  try {
    const result = await pgPool.query<ProductRow>(
      `update checkout_products
       set ${assignments.join(', ')}, updated_at = now()
       where id = $1
       returning id, name, description, price_paise, mrp_paise, currency, is_active, metadata_json, created_at, updated_at`,
      values
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutError(404, 'Checkout product was not found', 'product_not_found');
    return publicAdminProduct(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23514') {
      throw new CheckoutError(400, 'Product pricing failed validation', 'invalid_product_pricing');
    }
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not update checkout product', 'product_update_failed');
  }
};

export const listCheckoutOrders = async (input: ListCheckoutOrdersInput): Promise<{
  orders: ReturnType<typeof publicOrderSummary>[];
  nextCursor: string | null;
}> => {
  checkoutEnabled();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const values: unknown[] = [];
  const where: string[] = [];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (input.status) where.push(`status = ${addValue(input.status)}`);
  if (input.promoCode) where.push(`promo_code = ${addValue(normalizePromoCode(input.promoCode))}`);
  if (input.email) where.push(`customer_email ilike ${addValue(`%${normalizeEmail(input.email)}%`)}`);
  if (input.from) where.push(`created_at >= ${addValue(input.from)}`);
  if (input.to) where.push(`created_at < ${addValue(input.to)}`);
  if (input.q?.trim()) {
    const search = `%${input.q.trim()}%`;
    const placeholder = addValue(search);
    where.push(`(
      id::text ilike ${placeholder}
      or customer_name ilike ${placeholder}
      or customer_email ilike ${placeholder}
      or customer_phone ilike ${placeholder}
      or coalesce(promo_code, '') ilike ${placeholder}
      or coalesce(razorpay_order_id, '') ilike ${placeholder}
      or coalesce(razorpay_payment_id, '') ilike ${placeholder}
    )`);
  }
  if (input.cursor) {
    const cursor = decodeOrdersCursor(input.cursor);
    const createdAtPlaceholder = addValue(cursor.createdAt);
    const idPlaceholder = addValue(cursor.id);
    where.push(`(created_at < ${createdAtPlaceholder} or (created_at = ${createdAtPlaceholder} and id < ${idPlaceholder}::uuid))`);
  }

  const result = await pgPool.query<OrderRow>(
    `select *
     from checkout_orders
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by created_at desc, id desc
     limit ${addValue(limit + 1)}`,
    values
  );
  const page = result.rows.slice(0, limit);
  const nextCursor = result.rows.length > limit ? encodeOrdersCursor(page[page.length - 1]) : null;
  return {
    orders: page.map(publicOrderSummary),
    nextCursor
  };
};

export const getCheckoutOrderDetail = async (orderId: string): Promise<{
  order: ReturnType<typeof publicOrderSummary> & {
    customer: ReturnType<typeof publicOrderSummary>['customer'] & {
      address: Record<string, unknown>;
      addressText: string;
    };
    personalizedMessage: string | null;
    metadata: Record<string, unknown>;
  };
  payments: Array<{
    id: string;
    provider: string;
    providerOrderId: string;
    providerPaymentId: string | null;
    status: string;
    amountPaise: number | null;
    currency: string | null;
    signatureValid: boolean | null;
    errorCode: string | null;
    errorDescription: string | null;
    verifiedAt: string | null;
    capturedAt: string | null;
    failedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  events: Array<{
    id: string;
    provider: string;
    providerEventId: string | null;
    eventType: string;
    signatureValid: boolean;
    receivedAt: string | null;
  }>;
  promoRedemption: {
    id: string;
    status: string;
    discountPaise: number;
    reservedExpiresAt: string | null;
    redeemedAt: string | null;
    releasedAt: string | null;
  } | null;
}> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  try {
    const orderResult = await client.query<OrderRow>(
      `select *
       from checkout_orders
       where id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new CheckoutError(404, 'Checkout order was not found', 'order_not_found');

    const paymentsResult = await client.query<{
      id: string;
      provider: string;
      provider_order_id: string;
      provider_payment_id: string | null;
      status: string;
      amount_paise: number | null;
      currency: string | null;
      signature_valid: boolean | null;
      error_code: string | null;
      error_description: string | null;
      verified_at: Date | null;
      captured_at: Date | null;
      failed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select id, provider, provider_order_id, provider_payment_id, status, amount_paise,
              currency, signature_valid, error_code, error_description, verified_at,
              captured_at, failed_at, created_at, updated_at
       from checkout_payments
       where order_id = $1
       order by created_at desc`,
      [orderId]
    );
    const eventsResult = await client.query<{
      id: string;
      provider: string;
      provider_event_id: string | null;
      event_type: string;
      signature_valid: boolean;
      received_at: Date;
    }>(
      `select id, provider, provider_event_id, event_type, signature_valid, received_at
       from checkout_payment_events
       where order_id = $1
       order by received_at desc
       limit 50`,
      [orderId]
    );
    const redemptionResult = await client.query<{
      id: string;
      status: string;
      discount_paise: number;
      reserved_expires_at: Date;
      redeemed_at: Date | null;
      released_at: Date | null;
    }>(
      `select id, status, discount_paise, reserved_expires_at, redeemed_at, released_at
       from checkout_promo_redemptions
       where order_id = $1
       order by created_at desc
       limit 1`,
      [orderId]
    );

    const summary = publicOrderSummary(order);
    return {
      order: {
        ...summary,
        customer: {
          ...summary.customer,
          address: order.shipping_address_json,
          addressText: order.shipping_address_text
        },
        personalizedMessage: order.personalized_message,
        metadata: order.metadata_json ?? {}
      },
      payments: paymentsResult.rows.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        providerOrderId: payment.provider_order_id,
        providerPaymentId: payment.provider_payment_id,
        status: payment.status,
        amountPaise: payment.amount_paise,
        currency: payment.currency,
        signatureValid: payment.signature_valid,
        errorCode: payment.error_code,
        errorDescription: payment.error_description,
        verifiedAt: iso(payment.verified_at),
        capturedAt: iso(payment.captured_at),
        failedAt: iso(payment.failed_at),
        createdAt: iso(payment.created_at),
        updatedAt: iso(payment.updated_at)
      })),
      events: eventsResult.rows.map((event) => ({
        id: event.id,
        provider: event.provider,
        providerEventId: event.provider_event_id,
        eventType: event.event_type,
        signatureValid: event.signature_valid,
        receivedAt: iso(event.received_at)
      })),
      promoRedemption: redemptionResult.rows[0]
        ? {
            id: redemptionResult.rows[0].id,
            status: redemptionResult.rows[0].status,
            discountPaise: redemptionResult.rows[0].discount_paise,
            reservedExpiresAt: iso(redemptionResult.rows[0].reserved_expires_at),
            redeemedAt: iso(redemptionResult.rows[0].redeemed_at),
            releasedAt: iso(redemptionResult.rows[0].released_at)
          }
        : null
    };
  } finally {
    client.release();
  }
};

export const getCheckoutAdminStats = async (): Promise<{
  statusBuckets: Array<{ status: string; count: number; revenuePaise: number }>;
  pendingPayments: number;
  paidRevenuePaise: number;
  activePromoCodes: number;
  expiringPromoCodes: number;
}> => {
  checkoutEnabled();
  const [statusResult, promoResult] = await Promise.all([
    pgPool.query<{ status: string; count: string; revenue_paise: string | null }>(
      `select status, count(*) as count, coalesce(sum(amount_paise) filter (where status = 'paid'), 0) as revenue_paise
       from checkout_orders
       group by status
       order by status asc`
    ),
    pgPool.query<{ active_count: string; expiring_count: string }>(
      `select
         count(*) filter (
           where is_active = true
             and (starts_at is null or starts_at <= now())
             and (expires_at is null or expires_at > now())
         ) as active_count,
         count(*) filter (
           where is_active = true
             and expires_at > now()
             and expires_at <= now() + interval '7 days'
         ) as expiring_count
       from checkout_promo_codes`
    )
  ]);
  const statusBuckets = statusResult.rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
    revenuePaise: Number(row.revenue_paise ?? 0)
  }));
  return {
    statusBuckets,
    pendingPayments: statusBuckets
      .filter((bucket) => ['draft', 'payment_order_failed', 'payment_pending', 'payment_authorized'].includes(bucket.status))
      .reduce((sum, bucket) => sum + bucket.count, 0),
    paidRevenuePaise: statusBuckets.reduce((sum, bucket) => sum + bucket.revenuePaise, 0),
    activePromoCodes: Number(promoResult.rows[0]?.active_count ?? 0),
    expiringPromoCodes: Number(promoResult.rows[0]?.expiring_count ?? 0)
  };
};

export const loginCheckoutAdmin = async (
  input: LoginCheckoutAdminInput
): Promise<{ admin: ReturnType<typeof publicCheckoutAdminUser>; sessionToken: string }> => {
  checkoutEnabled();
  const email = normalizeEmail(input.email);
  if (!email || !input.password) {
    throw new CheckoutError(401, 'Invalid admin email or password', 'invalid_admin_login');
  }

  const client = await pgPool.connect();
  try {
    await ensureBootstrapCheckoutAdminUser(client);
    const result = await client.query<CheckoutAdminUserRow>(
      `select id, email, password_hash, role, is_active, must_change_password,
              created_by, last_login_at, created_at, updated_at
       from checkout_admin_users
       where email = $1`,
      [email]
    );
    const admin = result.rows[0];
    const passwordValid = verifyAdminPasswordHash(
      input.password,
      admin?.password_hash ?? DUMMY_ADMIN_PASSWORD_HASH
    );
    if (!admin || !admin.is_active || !passwordValid) {
      throw new CheckoutError(401, 'Invalid admin email or password', 'invalid_admin_login');
    }

    const updated = await client.query<CheckoutAdminUserRow>(
      `update checkout_admin_users
       set last_login_at = now(), updated_at = now()
       where id = $1
       returning id, email, password_hash, role, is_active, must_change_password,
                 created_by, last_login_at, created_at, updated_at`,
      [admin.id]
    );
    const currentAdmin = updated.rows[0] ?? admin;
    return {
      admin: publicCheckoutAdminUser(currentAdmin),
      sessionToken: issueCheckoutAdminSessionToken(currentAdmin.id, currentAdmin.password_hash)
    };
  } finally {
    client.release();
  }
};

/**
 * Forgot-password: issues a fresh temporary password for an admin and emails it,
 * forcing a change on next login. Always returns a generic success response so
 * the endpoint cannot be used to enumerate which emails are registered admins.
 */
export const requestCheckoutAdminPasswordReset = async (
  input: { email: string }
): Promise<{ ok: true }> => {
  checkoutEnabled();
  const email = normalizeEmail(input.email);
  if (!email) return { ok: true };

  const client = await pgPool.connect();
  try {
    await ensureBootstrapCheckoutAdminUser(client);
    const result = await client.query<CheckoutAdminUserRow>(
      `select id, email, is_active from checkout_admin_users where email = $1`,
      [email]
    );
    const admin = result.rows[0];
    if (!admin || !admin.is_active) {
      // Unknown or disabled account: do nothing, but respond identically.
      return { ok: true };
    }

    const temporaryPassword = generateTemporaryAdminPassword();
    const policy = validatePasswordPolicy({ password: temporaryPassword, email });
    if (!policy.ok) {
      logger.error('Generated admin reset password failed policy', { reason: policy.reason });
      return { ok: true };
    }

    await client.query(
      `update checkout_admin_users
       set password_hash = $2, must_change_password = true, updated_at = now()
       where id = $1`,
      [admin.id, hashAdminPassword(temporaryPassword)]
    );

    void sendAdminPasswordReset({ email, temporaryPassword });
    return { ok: true };
  } catch (error) {
    logger.error('Checkout admin password reset failed', { error: (error as Error).message });
    return { ok: true };
  } finally {
    client.release();
  }
};

export const listCheckoutAdminUsers = async (): Promise<{
  adminUsers: ReturnType<typeof publicCheckoutAdminUser>[];
}> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  try {
    await ensureBootstrapCheckoutAdminUser(client);
    const result = await client.query<CheckoutAdminUserRow>(
      `select id, email, password_hash, role, is_active, must_change_password,
              created_by, last_login_at, created_at, updated_at
       from checkout_admin_users
       order by created_at desc, email asc`
    );
    return { adminUsers: result.rows.map(publicCheckoutAdminUser) };
  } finally {
    client.release();
  }
};

export const createCheckoutAdminUser = async (
  input: CreateCheckoutAdminUserInput
): Promise<{ admin: ReturnType<typeof publicCheckoutAdminUser>; temporaryPassword: string }> => {
  checkoutEnabled();
  const email = normalizeEmail(input.email);
  if (!email) throw new CheckoutError(400, 'Admin email is required', 'missing_admin_email');
  const temporaryPassword = generateTemporaryAdminPassword();
  const policy = validatePasswordPolicy({ password: temporaryPassword, email });
  if (!policy.ok) throw new CheckoutError(500, 'Generated admin password failed policy', 'admin_password_generate_failed');

  const client = await pgPool.connect();
  try {
    await ensureBootstrapCheckoutAdminUser(client);
    const result = await client.query<CheckoutAdminUserRow>(
      `insert into checkout_admin_users (email, password_hash, role, must_change_password, created_by)
       values ($1, $2, 'admin', true, $3)
       returning id, email, password_hash, role, is_active, must_change_password,
                 created_by, last_login_at, created_at, updated_at`,
      [email, hashAdminPassword(temporaryPassword), input.createdBy]
    );
    const admin = result.rows[0];
    if (!admin) throw new CheckoutError(500, 'Could not create admin user', 'admin_user_create_failed');
    // Best-effort: email the new admin their temporary login credentials.
    void sendAdminInvite({ email: admin.email, temporaryPassword, createdBy: input.createdBy });
    return { admin: publicCheckoutAdminUser(admin), temporaryPassword };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CheckoutError(409, 'Admin user already exists', 'admin_user_exists');
    }
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not create admin user', 'admin_user_create_failed');
  } finally {
    client.release();
  }
};

export const changeCheckoutAdminPassword = async (
  input: ChangeCheckoutAdminPasswordInput
): Promise<{ admin: ReturnType<typeof publicCheckoutAdminUser>; sessionToken: string }> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  try {
    await client.query('begin');
    const result = await client.query<CheckoutAdminUserRow>(
      `select id, email, password_hash, role, is_active, must_change_password,
              created_by, last_login_at, created_at, updated_at
       from checkout_admin_users
       where id = $1
       for update`,
      [input.adminId]
    );
    const admin = result.rows[0];
    if (!admin || !admin.is_active || !verifyAdminPasswordHash(input.currentPassword, admin.password_hash)) {
      throw new CheckoutError(401, 'Current admin password is incorrect', 'invalid_current_admin_password');
    }
    if (verifyAdminPasswordHash(input.newPassword, admin.password_hash)) {
      throw new CheckoutError(400, 'New admin password must be different', 'admin_password_unchanged');
    }
    const policy = validatePasswordPolicy({ password: input.newPassword, email: admin.email });
    if (!policy.ok) {
      throw new CheckoutError(400, policy.reason, 'invalid_admin_password');
    }

    const updated = await client.query<CheckoutAdminUserRow>(
      `update checkout_admin_users
       set password_hash = $2,
           must_change_password = false,
           updated_at = now()
       where id = $1
       returning id, email, password_hash, role, is_active, must_change_password,
                 created_by, last_login_at, created_at, updated_at`,
      [admin.id, hashAdminPassword(input.newPassword)]
    );
    const currentAdmin = updated.rows[0];
    if (!currentAdmin) throw new CheckoutError(500, 'Could not update admin password', 'admin_password_update_failed');
    await client.query('commit');
    return {
      admin: publicCheckoutAdminUser(currentAdmin),
      sessionToken: issueCheckoutAdminSessionToken(currentAdmin.id, currentAdmin.password_hash)
    };
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not update admin password', 'admin_password_update_failed');
  } finally {
    client.release();
  }
};

export const validateCheckoutPromo = async (input: {
  code?: string | null;
  productId?: string;
  customerEmail?: string;
}): Promise<
  | { valid: false; reason: string }
  | {
      valid: true;
      code: string;
      label: string;
      kind: PromoKind;
      discountPaise: number;
      finalPaise: number;
      currency: string;
      discountFormatted: string;
      finalFormatted: string;
    }
> => {
  checkoutEnabled();
  const code = input.code ? normalizePromoCode(input.code) : '';
  if (!code) return { valid: false, reason: 'missing_code' };

  const client = await pgPool.connect();
  try {
    const product = await getProduct(client, input.productId);
    const promo = await getPromoByCode(client, code);
    if (!promo) return { valid: false, reason: 'not_found' };

    const unavailable = promoUnavailableReason(promo);
    if (unavailable) return { valid: false, reason: unavailable };

    const customerEmailHash = input.customerEmail
      ? hashCustomerEmail(input.customerEmail, env.SHORT_CODE_PEPPER)
      : undefined;
    const capacityReason = await promoCapacityReason(client, promo, customerEmailHash);
    if (capacityReason) return { valid: false, reason: capacityReason };

    const calculation = calculatePromoForProduct(promo, product);
    if (!calculation) return { valid: false, reason: 'not_applicable' };

    return {
      valid: true,
      code: calculation.code,
      label: calculation.label,
      kind: promo.kind,
      discountPaise: calculation.discountPaise,
      finalPaise: calculation.finalPaise,
      currency: product.currency,
      discountFormatted: product.currency === 'INR' ? formatINR(calculation.discountPaise) : String(calculation.discountPaise),
      finalFormatted: product.currency === 'INR' ? formatINR(calculation.finalPaise) : String(calculation.finalPaise)
    };
  } finally {
    client.release();
  }
};

export const createCheckoutOrder = async (input: CreateCheckoutOrderInput): Promise<ReturnType<typeof orderResponse>> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  let draftOrder: OrderRow;
  try {
    await client.query('begin');
    const product = await getProduct(client, input.productId);
    const fingerprint = orderFingerprint(input, product.id);
    const customerEmailHash = hashCustomerEmail(input.customer.email, env.SHORT_CODE_PEPPER);
    const idempotencyKey = input.idempotencyKey?.trim();

    if (idempotencyKey) {
      const existingResult = await client.query<OrderRow>(
        `select * from checkout_orders where idempotency_key = $1 for update`,
        [idempotencyKey]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new CheckoutError(409, 'Idempotency key was already used for a different order', 'idempotency_conflict');
        }
        await client.query('commit');
        return orderResponse(await attachRazorpayOrder(existing));
      }
    }

    let promo: { row: PromoRow; calculation: PromoCalculation } | null = null;
    const promoCode = input.promoCode ? normalizePromoCode(input.promoCode) : '';
    if (promoCode) {
      const promoRow = await getPromoByCode(client, promoCode, { forUpdate: true });
      if (!promoRow) throw new CheckoutError(400, 'Promo code is invalid', 'promo_not_found');
      const unavailable = promoUnavailableReason(promoRow);
      if (unavailable) throw new CheckoutError(400, 'Promo code is not available', unavailable);
      const capacityReason = await promoCapacityReason(client, promoRow, customerEmailHash);
      if (capacityReason) throw new CheckoutError(400, 'Promo code limit has been reached', capacityReason);
      const calculation = calculatePromoForProduct(promoRow, product);
      if (!calculation) throw new CheckoutError(400, 'Promo code does not apply to this order', 'promo_not_applicable');
      promo = { row: promoRow, calculation };
    }

    draftOrder = await insertDraftOrder(client, input, product, fingerprint, customerEmailHash, promo);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not create checkout order', 'order_create_failed');
  } finally {
    client.release();
  }

  return orderResponse(await attachRazorpayOrder(draftOrder));
};

const upsertCheckoutPayment = async (
  client: PoolClient,
  input: {
    orderId: string;
    providerOrderId: string;
    providerPaymentId: string | null;
    status: string;
    amountPaise?: number | null;
    currency?: string | null;
    signatureValid?: boolean | null;
    errorCode?: string | null;
    errorDescription?: string | null;
    rawJson?: Record<string, unknown>;
    verifiedAt?: boolean;
    capturedAt?: boolean;
    failedAt?: boolean;
  }
): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `insert into checkout_payments (
       order_id, provider, provider_order_id, provider_payment_id, status,
       amount_paise, currency, signature_valid, error_code, error_description, raw_json,
       verified_at, captured_at, failed_at
     )
     values (
       $1, 'razorpay', $2, $3, $4,
       $5, $6, $7, $8, $9, $10::jsonb,
       case when $11 then now() else null end,
       case when $12 then now() else null end,
       case when $13 then now() else null end
     )
     on conflict (provider_payment_id) do update
     set status = excluded.status,
         amount_paise = excluded.amount_paise,
         currency = excluded.currency,
         signature_valid = excluded.signature_valid,
         error_code = excluded.error_code,
         error_description = excluded.error_description,
         raw_json = checkout_payments.raw_json || excluded.raw_json,
         verified_at = coalesce(checkout_payments.verified_at, excluded.verified_at),
         captured_at = coalesce(checkout_payments.captured_at, excluded.captured_at),
         failed_at = coalesce(checkout_payments.failed_at, excluded.failed_at),
         updated_at = now()
     where checkout_payments.order_id = excluded.order_id
       and checkout_payments.provider_order_id = excluded.provider_order_id
     returning id`,
    [
      input.orderId,
      input.providerOrderId,
      input.providerPaymentId,
      input.status,
      input.amountPaise ?? null,
      input.currency ?? null,
      input.signatureValid ?? null,
      input.errorCode ?? null,
      input.errorDescription ?? null,
      JSON.stringify(input.rawJson ?? {}),
      input.verifiedAt === true,
      input.capturedAt === true,
      input.failedAt === true
    ]
  );
  const paymentId = result.rows[0]?.id;
  if (!paymentId) {
    logger.error('Checkout payment ownership conflict', {
      orderId: input.orderId,
      providerOrderId: input.providerOrderId,
      providerPaymentId: input.providerPaymentId
    });
    throw new CheckoutError(409, 'Payment ownership conflict', 'payment_ownership_conflict');
  }
  return paymentId;
};

const markOrderPaid = async (
  client: PoolClient,
  order: OrderRow,
  paymentId: string,
  providerPaymentId: string
): Promise<{ firstPaid: boolean }> => {
  const result = await client.query(
    `update checkout_orders
     set status = 'paid',
         razorpay_payment_id = $2,
         payment_signature_valid = true,
         payment_verified_at = coalesce(payment_verified_at, now()),
         paid_at = coalesce(paid_at, now()),
         updated_at = now()
     where id = $1 and status <> 'paid'`,
    [order.id, providerPaymentId]
  );
  await markPromoRedeemed(client, order.id);
  await client.query(
    `update checkout_payments
     set status = 'captured', captured_at = coalesce(captured_at, now()), updated_at = now()
     where id = $1`,
    [paymentId]
  );
  // rowCount > 0 only on the transition into 'paid', so callers can fire the
  // confirmation email exactly once even though verify + webhook both run.
  return { firstPaid: (result.rowCount ?? 0) > 0 };
};

// Best-effort admin notification once an order's payment is confirmed. Fired
// after the DB transaction commits so a slow/failed email never blocks or rolls
// back the payment, and only when markOrderPaid reported the first transition.
const fireOrderPaidNotification = (order: OrderRow, providerPaymentId: string | null): void => {
  void notifyAdminOrderPaid({
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    customerPhone: order.customer_phone,
    productName: order.product_name,
    formattedAmount: formattedAmount(order.amount_paise, order.currency),
    promoCode: order.promo_code,
    razorpayPaymentId: providerPaymentId ?? order.razorpay_payment_id,
    razorpayOrderId: order.razorpay_order_id,
    shippingAddress: order.shipping_address_text || undefined,
    internalOrderId: order.id
  });
};

const markOrderFailed = async (
  client: PoolClient,
  order: OrderRow,
  providerPaymentId: string | null,
  status = 'payment_failed'
): Promise<void> => {
  await client.query(
    `update checkout_orders
     set status = $2,
         razorpay_payment_id = coalesce($3, razorpay_payment_id),
         failed_at = coalesce(failed_at, now()),
         updated_at = now()
     where id = $1 and status <> 'paid'`,
    [order.id, status, providerPaymentId]
  );
};

const reconcileVerifiedPayment = async (
  client: PoolClient,
  order: OrderRow,
  payment: RazorpayPayment,
  signatureValid: boolean
): Promise<{ status: string; paid: boolean; firstPaid: boolean }> => {
  if (payment.order_id !== order.razorpay_order_id) {
    const paymentId = await upsertCheckoutPayment(client, {
      orderId: order.id,
      providerOrderId: order.razorpay_order_id ?? '',
      providerPaymentId: payment.id,
      status: 'order_mismatch',
      amountPaise: payment.amount,
      currency: payment.currency,
      signatureValid,
      rawJson: payment as unknown as Record<string, unknown>,
      verifiedAt: true
    });
    await client.query(
      `update checkout_orders
       set status = 'payment_review_required', payment_signature_valid = $2, updated_at = now()
       where id = $1 and status <> 'paid'`,
      [order.id, signatureValid]
    );
    logger.warn('Checkout payment order mismatch', { orderId: order.id, paymentId });
    return { status: 'payment_review_required', paid: false, firstPaid: false };
  }

  if (payment.amount !== order.amount_paise || payment.currency !== order.currency) {
    const paymentId = await upsertCheckoutPayment(client, {
      orderId: order.id,
      providerOrderId: order.razorpay_order_id ?? '',
      providerPaymentId: payment.id,
      status: 'amount_mismatch',
      amountPaise: payment.amount,
      currency: payment.currency,
      signatureValid,
      rawJson: payment as unknown as Record<string, unknown>,
      verifiedAt: true
    });
    await client.query(
      `update checkout_orders
       set status = 'payment_review_required', payment_signature_valid = $2, updated_at = now()
       where id = $1 and status <> 'paid'`,
      [order.id, signatureValid]
    );
    logger.warn('Checkout payment amount mismatch', { orderId: order.id, paymentId });
    return { status: 'payment_review_required', paid: false, firstPaid: false };
  }

  const providerStatus = payment.captured || payment.status === 'captured'
    ? 'captured'
    : payment.status === 'failed'
      ? 'failed'
      : payment.status === 'authorized'
        ? 'authorized'
        : payment.status || 'unknown';
  const paymentId = await upsertCheckoutPayment(client, {
    orderId: order.id,
    providerOrderId: order.razorpay_order_id ?? '',
    providerPaymentId: payment.id,
    status: providerStatus,
    amountPaise: payment.amount,
    currency: payment.currency,
    signatureValid,
    errorCode: payment.error_code ?? null,
    errorDescription: payment.error_description ?? null,
    rawJson: payment as unknown as Record<string, unknown>,
    verifiedAt: true,
    capturedAt: providerStatus === 'captured',
    failedAt: providerStatus === 'failed'
  });

  if (providerStatus === 'captured') {
    const { firstPaid } = await markOrderPaid(client, order, paymentId, payment.id);
    return { status: 'paid', paid: true, firstPaid };
  }

  if (providerStatus === 'failed') {
    await markOrderFailed(client, order, payment.id);
    return { status: 'payment_failed', paid: false, firstPaid: false };
  }

  await client.query(
    `update checkout_orders
     set status = $2,
         razorpay_payment_id = $3,
         payment_signature_valid = $4,
         payment_verified_at = coalesce(payment_verified_at, now()),
         updated_at = now()
     where id = $1 and status <> 'paid'`,
    [order.id, providerStatus === 'authorized' ? 'payment_authorized' : 'payment_pending', payment.id, signatureValid]
  );
  return {
    status: providerStatus === 'authorized' ? 'payment_authorized' : 'payment_pending',
    paid: false,
    firstPaid: false
  };
};

export const verifyCheckoutPayment = async (
  input: VerifyCheckoutPaymentInput
): Promise<{ verified: boolean; status: string; paid: boolean }> => {
  checkoutEnabled();
  if (!env.RAZORPAY_KEY_SECRET) {
    throw new CheckoutError(503, 'Razorpay secret is not configured', 'razorpay_not_configured');
  }

  const client = await pgPool.connect();
  try {
    await client.query('begin');
    const orderResult = await client.query<OrderRow>(
      `select * from checkout_orders where razorpay_order_id = $1 for update`,
      [input.razorpay_order_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw new CheckoutError(404, 'Checkout order was not found', 'order_not_found');

    const signatureValid = verifyRazorpayCheckoutSignature(
      input.razorpay_order_id,
      input.razorpay_payment_id,
      input.razorpay_signature,
      env.RAZORPAY_KEY_SECRET
    );

    if (!signatureValid) {
      await upsertCheckoutPayment(client, {
        orderId: order.id,
        providerOrderId: input.razorpay_order_id,
        providerPaymentId: null,
        status: 'signature_failed',
        signatureValid: false,
        rawJson: { source: 'checkout_verify', submittedPaymentId: input.razorpay_payment_id }
      });
      await client.query(
        `update checkout_orders
         set status = 'payment_signature_failed',
             payment_signature_valid = false,
             updated_at = now()
         where id = $1 and status <> 'paid'`,
        [order.id]
      );
      await client.query('commit');
      return { verified: false, status: 'payment_signature_failed', paid: false };
    }

    let payment: RazorpayPayment;
    try {
      payment = await fetchRazorpayPayment(input.razorpay_payment_id);
    } catch (error) {
      await upsertCheckoutPayment(client, {
        orderId: order.id,
        providerOrderId: input.razorpay_order_id,
        providerPaymentId: input.razorpay_payment_id,
        status: 'signature_verified_fetch_failed',
        signatureValid: true,
        rawJson: {
          source: 'checkout_verify',
          fetchError: error instanceof RazorpayApiError
            ? { statusCode: error.statusCode, responseBody: error.responseBody }
            : { message: (error as Error).message }
        },
        verifiedAt: true
      });
      await client.query(
        `update checkout_orders
         set status = 'payment_review_required',
             razorpay_payment_id = $2,
             payment_signature_valid = true,
             payment_verified_at = coalesce(payment_verified_at, now()),
             updated_at = now()
         where id = $1 and status <> 'paid'`,
        [order.id, input.razorpay_payment_id]
      );
      await client.query('commit');
      return { verified: true, status: 'payment_review_required', paid: false };
    }

    const result = await reconcileVerifiedPayment(client, order, payment, true);
    await client.query('commit');
    if (result.firstPaid) fireOrderPaidNotification(order, payment.id);
    return { verified: true, status: result.status, paid: result.paid };
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not verify checkout payment', 'payment_verify_failed');
  } finally {
    client.release();
  }
};

export const handleRazorpayWebhook = async (input: {
  rawBody: string;
  signature?: string;
  providerEventId?: string;
}): Promise<{ ok: true; ignored?: boolean; duplicate?: boolean; status?: string }> => {
  checkoutEnabled();
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw new CheckoutError(503, 'Razorpay webhook secret is not configured', 'razorpay_webhook_not_configured');
  }
  if (!verifyRazorpayWebhookSignature(input.rawBody, input.signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    throw new CheckoutError(400, 'Invalid Razorpay webhook signature', 'invalid_webhook_signature');
  }

  let event: PaymentEvent;
  try {
    event = JSON.parse(input.rawBody) as PaymentEvent;
  } catch {
    throw new CheckoutError(400, 'Invalid Razorpay webhook JSON', 'invalid_webhook_json');
  }

  const recordWebhookEvent = async (
    client: PoolClient,
    eventType: string,
    options: { orderId?: string | null; paymentId?: string | null } = {}
  ): Promise<void> => {
    await client.query(
      `insert into checkout_payment_events (
         order_id, payment_id, provider, provider_event_id, event_type, signature_valid, payload_json
       )
       values ($1, $2, 'razorpay', $3, $4, true, $5::jsonb)
       on conflict (provider_event_id) do nothing`,
      [options.orderId ?? null, options.paymentId ?? null, input.providerEventId ?? null, eventType, input.rawBody]
    );
  };

  const payment = event.payload?.payment?.entity;
  const providerOrderId = payment?.order_id;
  const eventType = event.event ?? 'unknown';

  const client = await pgPool.connect();
  try {
    await client.query('begin');
    if (input.providerEventId) {
      const duplicate = await client.query<{ id: string }>(
        `select id from checkout_payment_events where provider_event_id = $1`,
        [input.providerEventId]
      );
      if (duplicate.rows[0]) {
        await client.query('commit');
        return { ok: true, duplicate: true };
      }
    }

    if (!SUPPORTED_RAZORPAY_WEBHOOK_EVENTS.has(eventType)) {
      await recordWebhookEvent(client, eventType);
      await client.query('commit');
      logger.info('Ignored unsupported Razorpay webhook event', { eventType });
      return { ok: true, ignored: true, status: 'unsupported_event' };
    }

    if (!payment || !providerOrderId) {
      await recordWebhookEvent(client, eventType);
      await client.query('commit');
      logger.warn('Ignored Razorpay webhook event without payment order id', { eventType });
      return { ok: true, ignored: true, status: 'missing_payment_order' };
    }

    const orderResult = await client.query<OrderRow>(
      `select * from checkout_orders where razorpay_order_id = $1 for update`,
      [providerOrderId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query(
        `insert into checkout_payment_events (
         provider, provider_event_id, event_type, signature_valid, payload_json
       )
       values ('razorpay', $1, $2, true, $3::jsonb)
       on conflict (provider_event_id) do nothing`,
        [input.providerEventId ?? null, eventType, input.rawBody]
      );
      await client.query('commit');
      return { ok: true, ignored: true };
    }

    const result = await reconcileVerifiedPayment(client, order, payment, true);
    const paymentRow = await client.query<{ id: string }>(
      `select id from checkout_payments where provider_payment_id = $1`,
      [payment.id]
    );

    await client.query(
      `insert into checkout_payment_events (
       order_id, payment_id, provider, provider_event_id, event_type, signature_valid, payload_json
     )
     values ($1, $2, 'razorpay', $3, $4, true, $5::jsonb)
     on conflict (provider_event_id) do nothing`,
      [order.id, paymentRow.rows[0]?.id ?? null, input.providerEventId ?? null, eventType, input.rawBody]
    );

    await client.query('commit');
    if (result.firstPaid) fireOrderPaidNotification(order, payment.id);
    return { ok: true, status: result.status };
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not handle Razorpay webhook', 'webhook_handle_failed');
  } finally {
    client.release();
  }
};

export const sendCheckoutPaymentReminder = async (input: {
  orderId: string;
  note?: string;
}): Promise<{ sent: boolean; skipped: boolean; email: string; status: string }> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  let order: OrderRow;
  try {
    const result = await client.query<OrderRow>(
      `select * from checkout_orders where id = $1`,
      [input.orderId]
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutError(404, 'Checkout order was not found', 'order_not_found');
    order = row;
  } finally {
    client.release();
  }

  if (order.status === 'paid') {
    throw new CheckoutError(409, 'Order is already paid', 'order_already_paid');
  }

  const outcome = await sendCustomerPaymentReminder({
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    productName: order.product_name,
    formattedAmount: formattedAmount(order.amount_paise, order.currency),
    note: input.note
  });

  if (!outcome.delivered && !outcome.skipped) {
    throw new CheckoutError(502, 'Could not send the payment reminder email', 'payment_reminder_failed');
  }

  return {
    sent: outcome.delivered,
    skipped: Boolean(outcome.skipped),
    email: order.customer_email,
    status: order.status
  };
};

export const listCheckoutPromoCodes = async (): Promise<{
  promoCodes: ReturnType<typeof publicPromoCode>[];
}> => {
  checkoutEnabled();
  const result = await pgPool.query<PromoRow & {
    active_redemptions: string;
    live_redeemed_count: string;
    order_count: string;
  }>(
    `select p.id, p.code, p.label, p.kind, p.discount_type, p.discount_value,
            p.max_discount_paise, p.min_order_paise, p.currency, p.starts_at,
            p.expires_at, p.max_redemptions, p.max_redemptions_per_customer,
            p.redeemed_count, p.is_active, p.affiliate_id, p.referrer_id,
            p.campaign, p.metadata_json, p.created_by, p.created_at, p.updated_at,
            coalesce(r.active_redemptions, 0) as active_redemptions,
            coalesce(r.live_redeemed_count, 0) as live_redeemed_count,
            coalesce(o.order_count, 0) as order_count
     from checkout_promo_codes p
     left join lateral (
       select
         count(*) filter (where status = 'reserved' and reserved_expires_at > now()) as active_redemptions,
         count(*) filter (where status = 'redeemed') as live_redeemed_count
       from checkout_promo_redemptions
       where promo_code_id = p.id
     ) r on true
     left join lateral (
       select count(*) as order_count
       from checkout_orders
       where promo_code_id = p.id
     ) o on true
     order by p.created_at desc, p.code asc`
  );
  return {
    promoCodes: result.rows.map((row) =>
      publicPromoCode(row, {
        activeRedemptions: Number(row.active_redemptions),
        redeemedCount: Number(row.live_redeemed_count),
        orderCount: Number(row.order_count)
      })
    )
  };
};

export const updateCheckoutPromoCode = async (
  code: string,
  input: UpdatePromoCodeInput
): Promise<ReturnType<typeof publicPromoCode>> => {
  checkoutEnabled();
  const resolvedCode = normalizePromoCode(code);
  if (!resolvedCode) throw new CheckoutError(400, 'Promo code is required', 'missing_code');

  const client = await pgPool.connect();
  try {
    await client.query('begin');
    const currentResult = await client.query<PromoRow>(
      `select id, code, label, kind, discount_type, discount_value, max_discount_paise,
              min_order_paise, currency, starts_at, expires_at, max_redemptions,
              max_redemptions_per_customer, redeemed_count, is_active, affiliate_id,
              referrer_id, campaign, metadata_json, created_by, created_at, updated_at
       from checkout_promo_codes
       where code = $1
       for update`,
      [resolvedCode]
    );
    const current = currentResult.rows[0];
    if (!current) throw new CheckoutError(404, 'Promo code was not found', 'promo_not_found');

    const nextDiscountType = input.discountType ?? current.discount_type;
    const nextDiscountValue = input.discountValue ?? current.discount_value;
    if (nextDiscountType === 'percent' && nextDiscountValue > 100) {
      throw new CheckoutError(400, 'Percent discount cannot exceed 100', 'invalid_discount_value');
    }
    const nextStartsAt = input.startsAt === undefined ? current.starts_at : input.startsAt;
    const nextExpiresAt = input.expiresAt === undefined ? current.expires_at : input.expiresAt;
    if (nextStartsAt && nextExpiresAt && nextExpiresAt <= nextStartsAt) {
      throw new CheckoutError(400, 'Promo expiry must be after start time', 'invalid_promo_window');
    }

    const assignments: string[] = [];
    const values: unknown[] = [resolvedCode];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      assignments.push(sql.replace('?', `$${values.length}`));
    };

    if (input.label !== undefined) add('label = ?', input.label.trim());
    if (input.kind !== undefined) add('kind = ?', input.kind);
    if (input.discountType !== undefined) add('discount_type = ?', input.discountType);
    if (input.discountValue !== undefined) add('discount_value = ?', input.discountValue);
    if (input.maxDiscountPaise !== undefined) add('max_discount_paise = ?', input.maxDiscountPaise);
    if (input.minOrderPaise !== undefined) add('min_order_paise = ?', input.minOrderPaise);
    if (input.currency !== undefined) add('currency = ?', input.currency.trim().toUpperCase());
    if (input.startsAt !== undefined) add('starts_at = ?', input.startsAt);
    if (input.expiresAt !== undefined) add('expires_at = ?', input.expiresAt);
    if (input.maxRedemptions !== undefined) add('max_redemptions = ?', input.maxRedemptions);
    if (input.maxRedemptionsPerCustomer !== undefined) add('max_redemptions_per_customer = ?', input.maxRedemptionsPerCustomer);
    if (input.affiliateId !== undefined) add('affiliate_id = ?', input.affiliateId?.trim() || null);
    if (input.referrerId !== undefined) add('referrer_id = ?', input.referrerId?.trim() || null);
    if (input.campaign !== undefined) add('campaign = ?', input.campaign?.trim() || null);
    if (input.isActive !== undefined) add('is_active = ?', input.isActive);
    if (input.metadata !== undefined) add('metadata_json = metadata_json || ?::jsonb', JSON.stringify(input.metadata));

    let updated = current;
    if (assignments.length > 0) {
      const updateResult = await client.query<PromoRow>(
        `update checkout_promo_codes
         set ${assignments.join(', ')}, updated_at = now()
         where code = $1
         returning id, code, label, kind, discount_type, discount_value, max_discount_paise,
                   min_order_paise, currency, starts_at, expires_at, max_redemptions,
                   max_redemptions_per_customer, redeemed_count, is_active, affiliate_id,
                   referrer_id, campaign, metadata_json, created_by, created_at, updated_at`,
        values
      );
      updated = updateResult.rows[0] ?? current;
    }
    const counts = await client.query<{
      active_redemptions: string;
      redeemed_count: string;
      order_count: string;
    }>(
      `select
         count(*) filter (where r.status = 'reserved' and r.reserved_expires_at > now()) as active_redemptions,
         count(*) filter (where r.status = 'redeemed') as redeemed_count,
         (select count(*) from checkout_orders where promo_code_id = $1) as order_count
       from checkout_promo_redemptions r
       where r.promo_code_id = $1`,
      [updated.id]
    );
    await client.query('commit');
    return publicPromoCode(updated, {
      activeRedemptions: Number(counts.rows[0]?.active_redemptions ?? 0),
      redeemedCount: Number(counts.rows[0]?.redeemed_count ?? updated.redeemed_count),
      orderCount: Number(counts.rows[0]?.order_count ?? 0)
    });
  } catch (error) {
    await client.query('rollback');
    if ((error as { code?: string }).code === '23514') {
      throw new CheckoutError(400, 'Promo code failed validation', 'invalid_promo_code');
    }
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not update promo code', 'promo_update_failed');
  } finally {
    client.release();
  }
};

export const createCheckoutPromoCode = async (
  input: CreatePromoCodeInput
): Promise<ReturnType<typeof publicPromoCode>> => {
  checkoutEnabled();
  const code = normalizePromoCode(input.code);
  if (!code) throw new CheckoutError(400, 'Promo code is required', 'missing_code');
  if (input.expiresAt && input.startsAt && input.expiresAt <= input.startsAt) {
    throw new CheckoutError(400, 'Promo expiry must be after start time', 'invalid_promo_window');
  }

  try {
    const result = await pgPool.query<{
      id: string;
      code: string;
      label: string;
      kind: PromoKind;
      discount_type: DiscountType;
      discount_value: number;
      max_discount_paise: number | null;
      min_order_paise: number;
      currency: string;
      starts_at: Date | null;
      expires_at: Date | null;
      max_redemptions: number | null;
      max_redemptions_per_customer: number | null;
      redeemed_count: number;
      is_active: boolean;
      affiliate_id: string | null;
      referrer_id: string | null;
      campaign: string | null;
      metadata_json: Record<string, unknown>;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `insert into checkout_promo_codes (
         code, label, kind, discount_type, discount_value, max_discount_paise,
         min_order_paise, currency, starts_at, expires_at, max_redemptions,
         max_redemptions_per_customer, affiliate_id, referrer_id, campaign,
         metadata_json, created_by
       )
       values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16::jsonb, $17
       )
       returning id, code, label, kind, discount_type, discount_value, max_discount_paise,
                 min_order_paise, currency, starts_at, expires_at, max_redemptions,
                 max_redemptions_per_customer, redeemed_count, is_active, affiliate_id,
                 referrer_id, campaign, metadata_json, created_by, created_at, updated_at`,
      [
        code,
        input.label ?? code,
        input.kind,
        input.discountType,
        input.discountValue,
        input.maxDiscountPaise ?? null,
        input.minOrderPaise ?? 0,
        input.currency ?? 'INR',
        input.startsAt ?? null,
        input.expiresAt ?? null,
        input.maxRedemptions ?? null,
        input.maxRedemptionsPerCustomer ?? null,
        input.affiliateId ?? null,
        input.referrerId ?? null,
        input.campaign ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.createdBy ?? 'internal'
      ]
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutError(500, 'Could not create promo code', 'promo_create_failed');
    return publicPromoCode(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CheckoutError(409, 'Promo code already exists', 'promo_exists');
    }
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not create promo code', 'promo_create_failed');
  }
};
