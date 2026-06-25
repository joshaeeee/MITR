import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { pgPool } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
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

type PromoKind = 'promo' | 'referral' | 'affiliate';
type DiscountType = 'flat' | 'percent';

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

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price_paise: number;
  mrp_paise: number | null;
  currency: string;
  is_active: boolean;
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
  customer_email_hash: string;
  created_at: Date;
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

export const getCheckoutProduct = async (productId?: string): Promise<ReturnType<typeof publicProduct>> => {
  checkoutEnabled();
  const client = await pgPool.connect();
  try {
    return publicProduct(await getProduct(client, productId));
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
): Promise<void> => {
  await client.query(
    `update checkout_orders
     set status = 'paid',
         razorpay_payment_id = $2,
         payment_signature_valid = true,
         payment_verified_at = coalesce(payment_verified_at, now()),
         paid_at = coalesce(paid_at, now()),
         updated_at = now()
     where id = $1`,
    [order.id, providerPaymentId]
  );
  await markPromoRedeemed(client, order.id);
  await client.query(
    `update checkout_payments
     set status = 'captured', captured_at = coalesce(captured_at, now()), updated_at = now()
     where id = $1`,
    [paymentId]
  );
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
): Promise<{ status: string; paid: boolean }> => {
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
    return { status: 'payment_review_required', paid: false };
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
    return { status: 'payment_review_required', paid: false };
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
    await markOrderPaid(client, order, paymentId, payment.id);
    return { status: 'paid', paid: true };
  }

  if (providerStatus === 'failed') {
    await markOrderFailed(client, order, payment.id);
    return { status: 'payment_failed', paid: false };
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
  return { status: providerStatus === 'authorized' ? 'payment_authorized' : 'payment_pending', paid: false };
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
    return { verified: true, ...result };
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
    return { ok: true, status: result.status };
  } catch (error) {
    await client.query('rollback');
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not handle Razorpay webhook', 'webhook_handle_failed');
  } finally {
    client.release();
  }
};

export const createCheckoutPromoCode = async (input: CreatePromoCodeInput): Promise<{
  id: string;
  code: string;
  label: string;
  kind: PromoKind;
  discountType: DiscountType;
  discountValue: number;
  active: boolean;
}> => {
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
      is_active: boolean;
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
       returning id, code, label, kind, discount_type, discount_value, is_active`,
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
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      kind: row.kind,
      discountType: row.discount_type,
      discountValue: row.discount_value,
      active: row.is_active
    };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CheckoutError(409, 'Promo code already exists', 'promo_exists');
    }
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError(500, 'Could not create promo code', 'promo_create_failed');
  }
};
