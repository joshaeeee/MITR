import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createRateLimit, bodyFieldKey } from '../lib/rate-limit.js';
import {
  requireCheckoutAdminOwner,
  requireCheckoutAdminServiceAuth,
  requireCheckoutAdminSessionAuth,
  requireCheckoutAdminSessionForPasswordChange
} from '../services/checkout/checkout-admin-auth.js';
import {
  changeCheckoutAdminPassword,
  CheckoutError,
  CHECKOUT_ORDER_STATUSES,
  createCheckoutAdminUser,
  createCheckoutOrder,
  createCheckoutPromoCode,
  getCheckoutAdminStats,
  getCheckoutOrderDetail,
  getCheckoutProduct,
  handleRazorpayWebhook,
  listCheckoutOrders,
  listCheckoutProducts,
  listCheckoutPromoCodes,
  listCheckoutAdminUsers,
  loginCheckoutAdmin,
  sendCheckoutPaymentReminder,
  updateCheckoutProduct,
  updateCheckoutPromoCode,
  validateCheckoutPromo,
  verifyCheckoutPayment
} from '../services/checkout/checkout-service.js';
import {
  getEmailTemplate,
  listEmailTemplates,
  sendEmailTemplate
} from '../services/email/email-templates.js';

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
  metadata: z.record(z.unknown()).optional()
}).superRefine((value, ctx) => {
  if (value.discountType === 'percent' && value.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Percent discount cannot exceed 100'
    });
  }
});

const listOrdersQuerySchema = z.object({
  status: z.enum(CHECKOUT_ORDER_STATUSES).optional(),
  promoCode: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().min(1).max(180).optional(),
  q: z.string().trim().min(1).max(180).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(512).optional()
});

const orderParamsSchema = z.object({
  orderId: z.string().uuid()
});

const paymentReminderSchema = z.object({
  note: z.string().trim().max(500).optional()
});

const listEmailTemplatesQuerySchema = z.object({
  sendableOnly: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional()
});

const emailTemplateParamsSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]{1,80}$/)
});

const emailTemplateQuerySchema = z.object({
  preview: z.coerce.boolean().optional()
});

const sendEmailTemplateSchema = z.object({
  to: z.object({
    email: z.string().trim().email().max(180),
    name: z.string().trim().max(120).optional()
  }),
  variables: z.record(z.string(), z.string().max(2000)).default({})
});

const promoParamsSchema = z.object({
  code: z.string().trim().min(1).max(80)
});

const updatePromoCodeSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['promo', 'referral', 'affiliate']).optional(),
  discountType: z.enum(['flat', 'percent']).optional(),
  discountValue: z.number().int().positive().optional(),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  minOrderPaise: z.number().int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  maxRedemptionsPerCustomer: z.number().int().positive().nullable().optional(),
  affiliateId: z.string().trim().max(120).nullable().optional(),
  referrerId: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional()
}).superRefine((value, ctx) => {
  if (value.discountType === 'percent' && value.discountValue !== undefined && value.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Percent discount cannot exceed 100'
    });
  }
});

const productParamsSchema = z.object({
  productId: z.string().trim().min(1).max(80)
});

const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  pricePaise: z.number().int().min(100).optional(),
  mrpPaise: z.number().int().min(100).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});

const adminLoginSchema = z.object({
  email: z.string().trim().email().max(180),
  password: z.string().min(1).max(256)
});

const createAdminUserSchema = z.object({
  email: z.string().trim().email().max(180)
});

const changeAdminPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128)
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
  const emailSendLimit = createRateLimit({
    keyPrefix: 'checkout:email-send',
    windowMs: 60 * 1000,
    max: 30
  });
  const adminLoginLimit = createRateLimit({
    keyPrefix: 'checkout:admin-login',
    windowMs: 15 * 60 * 1000,
    max: 8,
    key: bodyFieldKey('email')
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

  app.get('/checkout/admin/stats', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (_request, reply) => {
    try {
      return reply.send(await getCheckoutAdminStats());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/admin/auth/login', { preHandler: [requireCheckoutAdminServiceAuth, adminLoginLimit] }, async (request, reply) => {
    const parsed = adminLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await loginCheckoutAdmin(parsed.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/auth/session', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionForPasswordChange] }, async (request, reply) => {
    const admin = request.checkoutAdminAuth;
    if (!admin) return reply.status(401).send({ error: 'Admin session is required', code: 'invalid_checkout_admin_session' });
    return reply.send({
      admin: {
        id: admin.adminId,
        email: admin.email,
        role: admin.role,
        mustChangePassword: admin.mustChangePassword
      }
    });
  });

  app.post('/checkout/admin/auth/change-password', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionForPasswordChange] }, async (request, reply) => {
    const parsed = changeAdminPasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const adminId = request.checkoutAdminAuth?.adminId;
    if (!adminId) return reply.status(401).send({ error: 'Admin session is required', code: 'invalid_checkout_admin_session' });
    try {
      return reply.send(await changeCheckoutAdminPassword({ adminId, ...parsed.data }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/users', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (_request, reply) => {
    try {
      return reply.send(await listCheckoutAdminUsers());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/admin/users', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth, requireCheckoutAdminOwner] }, async (request, reply) => {
    const parsed = createAdminUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const createdBy = request.checkoutAdminAuth?.email;
    if (!createdBy) return reply.status(401).send({ error: 'Admin session is required', code: 'invalid_checkout_admin_session' });
    try {
      return reply.status(201).send(await createCheckoutAdminUser({ email: parsed.data.email, createdBy }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/orders', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const parsed = listOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await listCheckoutOrders(parsed.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/orders/:orderId', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const parsed = orderParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await getCheckoutOrderDetail(parsed.data.orderId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/admin/orders/:orderId/payment-reminder', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const params = orderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = paymentReminderSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    try {
      return reply.send(await sendCheckoutPaymentReminder({ orderId: params.data.orderId, note: body.data.note }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/promo-codes', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (_request, reply) => {
    try {
      return reply.send(await listCheckoutPromoCodes());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/admin/promo-codes', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const parsed = createPromoCodeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const createdBy = request.checkoutAdminAuth?.email;
    if (!createdBy) return reply.status(401).send({ error: 'Admin session is required', code: 'invalid_checkout_admin_session' });
    try {
      return reply.status(201).send(await createCheckoutPromoCode({ ...parsed.data, createdBy }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/checkout/admin/promo-codes/:code', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const params = promoParamsSchema.safeParse(request.params);
    const body = updatePromoCodeSchema.safeParse(request.body);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    try {
      return reply.send(await updateCheckoutPromoCode(params.data.code, body.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/products', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (_request, reply) => {
    try {
      return reply.send(await listCheckoutProducts());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/checkout/admin/products/:productId', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const params = productParamsSchema.safeParse(request.params);
    const body = updateProductSchema.safeParse(request.body);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    try {
      return reply.send(await updateCheckoutProduct(params.data.productId, body.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/email-templates', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const parsed = listEmailTemplatesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await listEmailTemplates(parsed.data));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/checkout/admin/email-templates/:key', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth] }, async (request, reply) => {
    const params = emailTemplateParamsSchema.safeParse(request.params);
    const query = emailTemplateQuerySchema.safeParse(request.query);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.status(400).send({ error: query.error.flatten() });
    try {
      return reply.send(await getEmailTemplate(params.data.key, { withPreview: query.data.preview ?? true }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/checkout/admin/email-templates/:key/send', { preHandler: [requireCheckoutAdminServiceAuth, requireCheckoutAdminSessionAuth, emailSendLimit] }, async (request, reply) => {
    const params = emailTemplateParamsSchema.safeParse(request.params);
    const body = sendEmailTemplateSchema.safeParse(request.body);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    try {
      return reply.send(await sendEmailTemplate({ key: params.data.key, to: body.data.to, variables: body.data.variables }));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
