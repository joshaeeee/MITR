import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MIN_CHECKOUT_AMOUNT_PAISE = 100;

export type DiscountType = 'flat' | 'percent';

export interface PromoForCalculation {
  code: string;
  label: string;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  currency: string;
}

export interface PromoCalculation {
  code: string;
  label: string;
  discountPaise: number;
  finalPaise: number;
}

export interface ShippingAddressInput {
  line1: string;
  line2: string;
  pinCode: string;
  landmark?: string;
  city: string;
  state: string;
}

const safeEqual = (expected: string, actual: string): boolean => {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
};

export const normalizePromoCode = (code: string): string => code.trim().replace(/\s+/g, '').toUpperCase();

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const hashCustomerEmail = (email: string, pepper: string | undefined): string =>
  createHash('sha256')
    .update(`${normalizeEmail(email)}:${pepper ?? ''}`)
    .digest('hex');

export const formatAddress = (address: ShippingAddressInput): string =>
  [address.line1, address.line2, address.landmark ?? '', address.city, address.state, address.pinCode]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');

export const calculatePromoDiscount = (
  promo: PromoForCalculation,
  baseAmountPaise: number,
  currency: string
): PromoCalculation | null => {
  if (promo.currency !== currency) return null;
  if (baseAmountPaise < promo.minOrderPaise) return null;

  const rawDiscount =
    promo.discountType === 'flat'
      ? promo.discountValue
      : Math.floor((baseAmountPaise * promo.discountValue) / 100);
  const cappedByConfig =
    promo.maxDiscountPaise === null ? rawDiscount : Math.min(rawDiscount, promo.maxDiscountPaise);
  const maxAllowedDiscount = Math.max(baseAmountPaise - MIN_CHECKOUT_AMOUNT_PAISE, 0);
  const discountPaise = Math.max(0, Math.min(cappedByConfig, maxAllowedDiscount));
  if (discountPaise <= 0) return null;

  return {
    code: promo.code,
    label: promo.label,
    discountPaise,
    finalPaise: baseAmountPaise - discountPaise
  };
};

export const stableJsonFingerprint = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    if (typeof item === 'string') return item.trim();
    return item;
  };

  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
};

export const verifyRazorpayCheckoutSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): boolean => {
  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
};

export const verifyRazorpayWebhookSignature = (
  rawBody: string,
  signature: string | undefined,
  secret: string
): boolean => {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
};

export const formatINR = (paise: number): string =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
