import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  calculatePromoDiscount,
  stableJsonFingerprint,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature
} from './checkout-utils.js';

test('calculatePromoDiscount clamps discounts to Razorpay minimum amount', () => {
  const applied = calculatePromoDiscount(
    {
      code: 'FREEISH',
      label: 'Almost free',
      discountType: 'flat',
      discountValue: 10_000,
      maxDiscountPaise: null,
      minOrderPaise: 0,
      currency: 'INR'
    },
    5_000,
    'INR'
  );

  assert.deepEqual(applied, {
    code: 'FREEISH',
    label: 'Almost free',
    discountPaise: 4_900,
    finalPaise: 100
  });
});

test('calculatePromoDiscount rejects currency and minimum order mismatches', () => {
  const promo = {
    code: 'RECA10',
    label: '10 percent off',
    discountType: 'percent' as const,
    discountValue: 10,
    maxDiscountPaise: null,
    minOrderPaise: 10_000,
    currency: 'INR'
  };

  assert.equal(calculatePromoDiscount(promo, 9_999, 'INR'), null);
  assert.equal(calculatePromoDiscount(promo, 20_000, 'USD'), null);
});

test('verifyRazorpayCheckoutSignature compares the expected order/payment signature', () => {
  const orderId = 'order_test_123';
  const paymentId = 'pay_test_456';
  const secret = 'test_secret';
  const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  assert.equal(verifyRazorpayCheckoutSignature(orderId, paymentId, signature, secret), true);
  assert.equal(verifyRazorpayCheckoutSignature(orderId, paymentId, 'bad', secret), false);
});

test('verifyRazorpayWebhookSignature compares the raw body HMAC signature', () => {
  const rawBody = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_test"}}}}';
  const secret = 'webhook_secret';
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(verifyRazorpayWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyRazorpayWebhookSignature(JSON.stringify(JSON.parse(rawBody)), signature, secret), true);
  assert.equal(verifyRazorpayWebhookSignature(`${rawBody}\n`, signature, secret), false);
  assert.equal(verifyRazorpayWebhookSignature(rawBody, undefined, secret), false);
});

test('stableJsonFingerprint is independent of object key order', () => {
  assert.equal(
    stableJsonFingerprint({ b: 'two', a: { d: 4, c: 3 } }),
    stableJsonFingerprint({ a: { c: 3, d: 4 }, b: 'two' })
  );
});
