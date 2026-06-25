import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createRateLimit, bodyFieldKey } from '../lib/rate-limit.js';
import { requireInternalServiceAuth } from '../services/auth/internal-service-auth.js';
import {
  CheckoutError,
  createCheckoutOrder,
  createCheckoutPromoCode,
  getCheckoutProduct,
  handleRazorpayWebhook,
  validateCheckoutPromo,
  verifyCheckoutPayment
} from '../services/checkout/checkout-service.js';

const addressSchema = z.object({
  line1: z.string().trim().min(2).max(160),
  line2: z.string().trim().max(160).default(''),
  pinCode: z.string().trim().regex(/^\d{6}$/),
  landmark: z.string().trim().max(160).optional().default(''),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80)
});

const customerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().min(8).max(20),
  receiveUpdates: z.boolean().default(true),
  address: addressSchema
});

const productQuerySchema = z.object({
  productId: z.string().trim().min(1).max(80).optional()
});

const validatePromoSchema = z.object({
  code: z.string().trim().min(1).max(80),
  productId: z.string().trim().min(1).max(80).optional(),
  customerEmail: z.string().trim().email().max(180).optional()
});

const createOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  productId: z.string().trim().min(1).max(80).optional(),
  personalizedMessage: z.string().trim().max(2000).optional(),
  customer: customerSchema,
  promoCode: z.string().trim().max(80).nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string().trim().min(5).max(80),
  razorpay_payment_id: z.string().trim().min(5).max(80),
  razorpay_signature: z.string().trim().min(32).max(256)
});

const createPromoCodeSchema = z.object({
  code: z.string().trim().min(2).max(80),
  label: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['promo', 'referral', 'affiliate']).default('promo'),
  discountType: z.enum(['flat', 'percent']),
  discountValue: z.number().int().positive(),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  minOrderPaise: z.number().int().min(0).optional(),
  currency: z.string().trim().length(3).default('INR'),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  maxRedemptionsPerCustomer: z.number().int().positive().nullable().optional(),
  affiliateId: z.string().trim().max(120).nullable().optional(),
  referrerId: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdBy: z.string().trim().max(120).optional()
}).superRefine((value, ctx) => {
  if (value.discountType === 'percent' && value.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Percent discount cannot exceed 100'
    });
  }
});

const sendError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof CheckoutError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.publicCode,
      ...(error.details ? { details: error.details } : {})
    });
  }
  return reply.status(500).send({ error: 'Checkout request failed', code: 'checkout_failed' });
};

export const registerCheckoutRoutes = (app: FastifyInstance): void => {
  const productLimit = createRateLimit({ keyPrefix: 'checkout:product', windowMs: 60_000, max: 120 });
  const promoLimit = createRateLimit({
    keyPrefix: 'checkout:promo',
    windowMs: 10 * 60 * 1000,
    max: 60,
    key: bodyFieldKey('code')
  });
  const orderLimit = createRateLimit({
    keyPrefix: 'checkout:order',
    windowMs: 10 * 60 * 1000,
    max: 12
  });
  const verifyLimit = createRateLimit({
    keyPrefix: 'checkout:verify',
    windowMs: 10 * 60 * 1000,
    max: 30,
    key: bodyFieldKey('razorpay_order_id')
  });
  const verifyPaymentHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = verifyPaymentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await verifyCheckoutPayment(parsed.data);
      if (!result.verified) return reply.status(400).send(result);
      return reply.send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  };

  app.get('/checkout/product', { preHandler: productLimit }, async (request, reply) => {
    const parsed = productQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await getCheckoutProduct(parsed.data.productId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/promo/validate', { preHandler: promoLimit }, async (request, reply) => {
    const parsed = validatePromoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await validateCheckoutPromo(parsed.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/orders', { preHandler: orderLimit }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.status(201).send(await createCheckoutOrder(parsed.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/verify', { preHandler: verifyLimit }, verifyPaymentHandler);
  app.post('/checkout/payments/verify', { preHandler: verifyLimit }, verifyPaymentHandler);

  app.post('/checkout/webhooks/razorpay', async (request, reply) => {
    const rawBody = request.rawBody;
    if (!rawBody) return reply.status(400).send({ error: 'Raw webhook body is missing' });
    const signature = request.headers['x-razorpay-signature'];
    const eventId = request.headers['x-razorpay-event-id'];
    try {
      const result = await handleRazorpayWebhook({
        rawBody,
        signature: typeof signature === 'string' ? signature : undefined,
        providerEventId: typeof eventId === 'string' ? eventId : undefined
      });
      return reply.status(result.ignored ? 202 : 200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    '/checkout/admin/promo-codes',
    { preHandler: requireInternalServiceAuth },
    async (request, reply) => {
      const parsed = createPromoCodeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      try {
        return reply.status(201).send(await createCheckoutPromoCode(parsed.data));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
};
