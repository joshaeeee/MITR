import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { sendEmail, type SendEmailResult } from './autosend-client.js';
import {
  adminInviteEmail,
  adminPasswordResetEmail,
  orderPaidAdminEmail,
  paymentReminderEmail,
  type AdminInviteEmailData,
  type OrderPaidEmailData,
  type PaymentReminderEmailData
} from './templates.js';

/**
 * High-level checkout email senders. Each is best-effort: it swallows errors so
 * a failed email never breaks the checkout/admin flow that triggered it. Call
 * sites can `void` these or await the boolean result for logging/UI feedback.
 */

const safeSend = async (
  context: string,
  run: () => Promise<SendEmailResult>
): Promise<SendEmailResult> => {
  try {
    return await run();
  } catch (error) {
    logger.error('Checkout email sender threw', { context, error: (error as Error).message });
    return { delivered: false, error: (error as Error).message };
  }
};

/** Notify the Reca team that a Razorpay payment was confirmed. */
export const notifyAdminOrderPaid = (data: OrderPaidEmailData): Promise<SendEmailResult> =>
  safeSend('order_paid_admin', () => {
    const content = orderPaidAdminEmail(data);
    return sendEmail({
      to: { email: env.EMAIL_ADMIN_NOTIFY_ADDRESS, name: 'Reca Team' },
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  });

/** Email a newly created admin their temporary password. */
export const sendAdminInvite = (
  input: Pick<AdminInviteEmailData, 'email' | 'temporaryPassword' | 'createdBy'>
): Promise<SendEmailResult> =>
  safeSend('admin_invite', () => {
    const content = adminInviteEmail({ ...input, loginUrl: env.EMAIL_ADMIN_LOGIN_URL });
    return sendEmail({
      to: { email: input.email },
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  });

/** Email an admin a new temporary password after a forgot-password request. */
export const sendAdminPasswordReset = (
  input: { email: string; temporaryPassword: string }
): Promise<SendEmailResult> =>
  safeSend('admin_password_reset', () => {
    const content = adminPasswordResetEmail({ ...input, loginUrl: env.EMAIL_ADMIN_LOGIN_URL });
    return sendEmail({
      to: { email: input.email },
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  });

/** Email a customer a reminder to complete a pending payment. */
export const sendCustomerPaymentReminder = (
  input: Pick<PaymentReminderEmailData, 'customerName' | 'productName' | 'formattedAmount' | 'note'> & {
    customerEmail: string;
    payUrl?: string;
  }
): Promise<SendEmailResult> =>
  safeSend('payment_reminder', () => {
    const content = paymentReminderEmail({
      customerName: input.customerName,
      productName: input.productName,
      formattedAmount: input.formattedAmount,
      note: input.note,
      payUrl: input.payUrl ?? env.EMAIL_PAYMENT_LINK_BASE_URL,
      supportEmail: env.EMAIL_BRAND_SUPPORT_ADDRESS
    });
    return sendEmail({
      to: { email: input.customerEmail, name: input.customerName },
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  });
