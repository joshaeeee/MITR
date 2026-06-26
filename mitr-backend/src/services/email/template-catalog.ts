import type { EmailTemplateVariable } from '../../db/schema.js';
import {
  adminInviteEmail,
  adminPasswordResetEmail,
  orderConfirmationCustomerEmail,
  orderPaidAdminEmail,
  paymentReminderEmail,
  type EmailContent
} from './templates.js';

/**
 * Canonical catalog of Reca email templates. Each entry is rendered once (with
 * {{handlebars}} tokens in place of real values) and seeded into the
 * email_templates table, so the admin dashboard can list/preview them and the
 * send API can substitute variables at send time.
 *
 * To add a new email: add a brand builder in templates.ts, then add an entry
 * here. It will be seeded and appear in the dashboard automatically — no schema
 * or route changes needed.
 */

export interface CatalogTemplate {
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'internal';
  sendableFromDashboard: boolean;
  variables: EmailTemplateVariable[];
  /** Built once with token placeholders; stored as the template body. */
  content: EmailContent;
  /** Realistic values used to render a preview in the dashboard. */
  sampleData: Record<string, string>;
}

// token('customerName') -> '{{customerName}}'
const token = (key: string): string => `{{${key}}}`;

export const EMAIL_TEMPLATE_CATALOG: CatalogTemplate[] = [
  {
    key: 'purchase-confirmation',
    name: 'Purchase confirmation',
    description: 'Sent to a customer after their payment succeeds — order receipt and what happens next.',
    category: 'customer',
    sendableFromDashboard: true,
    variables: [
      { key: 'customerName', label: 'Customer name', required: true, example: 'Asha Verma' },
      { key: 'productName', label: 'Product', required: true, example: 'Reca Suno' },
      { key: 'formattedAmount', label: 'Amount paid', required: true, example: 'Rs. 6,999' },
      { key: 'orderId', label: 'Order reference', required: true, example: 'RECA-7F3A21' },
      { key: 'shippingAddress', label: 'Shipping address', required: false, example: '12 MG Road, Bengaluru 560001' },
      { key: 'supportEmail', label: 'Support email', required: true, example: 'support@heyreca.com' }
    ],
    content: orderConfirmationCustomerEmail({
      customerName: token('customerName'),
      productName: token('productName'),
      formattedAmount: token('formattedAmount'),
      orderId: token('orderId'),
      shippingAddress: token('shippingAddress'),
      supportEmail: token('supportEmail')
    }),
    sampleData: {
      customerName: 'Asha Verma',
      productName: 'Reca Suno',
      formattedAmount: 'Rs. 6,999',
      orderId: 'RECA-7F3A21',
      shippingAddress: '12 MG Road, Indiranagar, Bengaluru 560001',
      supportEmail: 'support@heyreca.com'
    }
  },
  {
    key: 'payment-reminder',
    name: 'Pending payment reminder',
    description: 'Sent to a customer whose payment has not gone through, nudging them to complete checkout.',
    category: 'customer',
    sendableFromDashboard: true,
    variables: [
      { key: 'customerName', label: 'Customer name', required: true, example: 'Asha Verma' },
      { key: 'productName', label: 'Product', required: true, example: 'Reca Suno' },
      { key: 'formattedAmount', label: 'Amount due', required: true, example: 'Rs. 6,999' },
      { key: 'payUrl', label: 'Payment link', required: true, example: 'https://www.heyreca.com/order' },
      { key: 'supportEmail', label: 'Support email', required: true, example: 'support@heyreca.com' },
      { key: 'note', label: 'Personal note (optional)', required: false, example: 'Let us know if you hit any trouble!' }
    ],
    content: paymentReminderEmail({
      customerName: token('customerName'),
      productName: token('productName'),
      formattedAmount: token('formattedAmount'),
      payUrl: token('payUrl'),
      supportEmail: token('supportEmail'),
      note: token('note')
    }),
    sampleData: {
      customerName: 'Asha Verma',
      productName: 'Reca Suno',
      formattedAmount: 'Rs. 6,999',
      payUrl: 'https://www.heyreca.com/order',
      supportEmail: 'support@heyreca.com',
      note: 'Let us know if you hit any trouble completing your order!'
    }
  },
  {
    key: 'order-paid-admin',
    name: 'New paid order (internal alert)',
    description: 'Automated internal notification to the Reca team when Razorpay confirms a payment.',
    category: 'internal',
    sendableFromDashboard: false,
    variables: [
      { key: 'customerName', label: 'Customer name', required: true, example: 'Asha Verma' },
      { key: 'customerEmail', label: 'Customer email', required: true, example: 'asha@example.com' },
      { key: 'customerPhone', label: 'Customer phone', required: true, example: '+91 98765 43210' },
      { key: 'productName', label: 'Product', required: true, example: 'Reca Suno' },
      { key: 'formattedAmount', label: 'Amount paid', required: true, example: 'Rs. 6,999' },
      { key: 'promoCode', label: 'Promo code', required: false, example: 'LAUNCH200' },
      { key: 'shippingAddress', label: 'Shipping address', required: false, example: '12 MG Road, Bengaluru 560001' },
      { key: 'razorpayPaymentId', label: 'Razorpay payment id', required: false, example: 'pay_OqX...' },
      { key: 'internalOrderId', label: 'Order id', required: true, example: 'RECA-7F3A21' }
    ],
    content: orderPaidAdminEmail({
      customerName: token('customerName'),
      customerEmail: token('customerEmail'),
      customerPhone: token('customerPhone'),
      productName: token('productName'),
      formattedAmount: token('formattedAmount'),
      promoCode: token('promoCode'),
      shippingAddress: token('shippingAddress'),
      razorpayPaymentId: token('razorpayPaymentId'),
      internalOrderId: token('internalOrderId')
    }),
    sampleData: {
      customerName: 'Asha Verma',
      customerEmail: 'asha@example.com',
      customerPhone: '+91 98765 43210',
      productName: 'Reca Suno',
      formattedAmount: 'Rs. 6,999',
      promoCode: 'LAUNCH200',
      shippingAddress: '12 MG Road, Bengaluru 560001',
      razorpayPaymentId: 'pay_OqXmpL2k9',
      internalOrderId: 'RECA-7F3A21'
    }
  },
  {
    key: 'admin-invite',
    name: 'New admin invite',
    description: 'Automated email to a newly created admin with their temporary password.',
    category: 'internal',
    sendableFromDashboard: false,
    variables: [
      { key: 'email', label: 'Admin email', required: true, example: 'new-admin@heyreca.com' },
      { key: 'temporaryPassword', label: 'Temporary password', required: true, example: 'Xy7$kP2mQ9' },
      { key: 'createdBy', label: 'Invited by', required: true, example: 'shivansh@heyreca.com' },
      { key: 'loginUrl', label: 'Dashboard URL', required: true, example: 'https://admin.heyreca.com' }
    ],
    content: adminInviteEmail({
      email: token('email'),
      temporaryPassword: token('temporaryPassword'),
      createdBy: token('createdBy'),
      loginUrl: token('loginUrl')
    }),
    sampleData: {
      email: 'new-admin@heyreca.com',
      temporaryPassword: 'Xy7$kP2mQ9',
      createdBy: 'shivansh@heyreca.com',
      loginUrl: 'https://admin.heyreca.com'
    }
  },
  {
    key: 'admin-password-reset',
    name: 'Admin password reset',
    description: 'Automated email with a new temporary password when an admin requests a password reset.',
    category: 'internal',
    sendableFromDashboard: false,
    variables: [
      { key: 'email', label: 'Admin email', required: true, example: 'admin@heyreca.com' },
      { key: 'temporaryPassword', label: 'Temporary password', required: true, example: 'Rc-xxxx9!' },
      { key: 'loginUrl', label: 'Dashboard URL', required: true, example: 'https://admin.heyreca.com' }
    ],
    content: adminPasswordResetEmail({
      email: token('email'),
      temporaryPassword: token('temporaryPassword'),
      loginUrl: token('loginUrl')
    }),
    sampleData: {
      email: 'admin@heyreca.com',
      temporaryPassword: 'Rc-9aB3xK7m2!',
      loginUrl: 'https://admin.heyreca.com'
    }
  }
];
