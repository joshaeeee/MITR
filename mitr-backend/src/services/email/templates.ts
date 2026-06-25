/**
 * Branded, cross-client compatible transactional email templates for Reca.
 *
 * Email HTML must use table-based layout + inline styles (no flexbox/grid, no
 * external CSS) to render consistently across Gmail, Outlook, Apple Mail, etc.
 * All templates share the same on-brand shell (cream canvas, forest header,
 * warm orange accent) so messages feel like one product.
 */

const BRAND = {
  forest: '#13402f',
  forestSoft: '#1b4d3b',
  cream: '#f7efe1',
  card: '#fffaf1',
  orange: '#e8743b',
  ink: '#1f2a26',
  muted: '#6b7a72',
  hairline: '#e6dcc8'
} as const;

const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface ShellOptions {
  preheader: string;
  heading: string;
  intro: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote?: string;
}

const wrapShell = ({ preheader, heading, intro, bodyHtml, cta, footerNote }: ShellOptions): string => {
  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 4px;">
         <tr><td align="center" bgcolor="${BRAND.orange}" style="border-radius:999px;">
           <a href="${esc(cta.url)}" target="_blank"
              style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">
             ${esc(cta.label)}
           </a>
         </td></tr>
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.cream};font-size:1px;line-height:1px;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
    <tr><td style="padding:4px 8px 20px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${BRAND.forest};letter-spacing:0.5px;">reca</td></tr>
    <tr><td style="background-color:${BRAND.card};border:1px solid ${BRAND.hairline};border-radius:20px;padding:36px 32px;">
      <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;color:${BRAND.forest};">${esc(heading)}</h1>
      <p style="margin:0 0 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.ink};">${esc(intro)}</p>
      ${bodyHtml}
      ${ctaHtml}
    </td></tr>
    <tr><td style="padding:22px 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${BRAND.muted};">
      ${footerNote ? `<p style="margin:0 0 8px;">${esc(footerNote)}</p>` : ''}
      <p style="margin:0;">Reca &middot; The gift of companionship for seniors.<br>This is an automated message from heyreca.com.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
};

const detailRows = (rows: Array<[string, string]>): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.hairline};border-radius:14px;overflow:hidden;margin:4px 0 8px;">
    ${rows
      .map(
        ([label, value], i) =>
          `<tr style="background-color:${i % 2 === 0 ? '#fdf7ec' : BRAND.card};">
             <td style="padding:11px 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND.muted};width:42%;">${esc(label)}</td>
             <td style="padding:11px 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:${BRAND.ink};">${esc(value)}</td>
           </tr>`
      )
      .join('')}
  </table>`;

// --- 1. Admin notification: payment confirmed by Razorpay ---------------------

export interface OrderPaidEmailData {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  productName: string;
  formattedAmount: string;
  promoCode?: string | null;
  razorpayPaymentId?: string | null;
  razorpayOrderId?: string | null;
  shippingAddress?: string;
  internalOrderId: string;
}

export const orderPaidAdminEmail = (data: OrderPaidEmailData): EmailContent => {
  const rows: Array<[string, string]> = [
    ['Product', data.productName],
    ['Amount paid', data.formattedAmount],
    ['Customer', data.customerName],
    ['Email', data.customerEmail],
    ['Phone', data.customerPhone]
  ];
  if (data.promoCode) rows.push(['Promo code', data.promoCode]);
  if (data.shippingAddress) rows.push(['Ship to', data.shippingAddress]);
  if (data.razorpayPaymentId) rows.push(['Razorpay payment', data.razorpayPaymentId]);
  rows.push(['Order ID', data.internalOrderId]);

  const html = wrapShell({
    preheader: `New paid order: ${data.formattedAmount} from ${data.customerName}`,
    heading: 'New order — payment confirmed 🎉',
    intro: `Razorpay just confirmed a successful payment of ${data.formattedAmount} for ${data.productName}. Details below.`,
    bodyHtml: detailRows(rows),
    footerNote: 'You are receiving this because you are a Reca checkout admin.'
  });

  const text = [
    'New order — payment confirmed',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`)
  ].join('\n');

  return { subject: `✅ Paid order — ${data.formattedAmount} from ${data.customerName}`, html, text };
};

// --- 1b. Customer purchase confirmation (receipt) ----------------------------

export interface OrderConfirmationEmailData {
  customerName: string;
  productName: string;
  formattedAmount: string;
  orderId: string;
  shippingAddress?: string;
  supportEmail: string;
}

export const orderConfirmationCustomerEmail = (data: OrderConfirmationEmailData): EmailContent => {
  const rows: Array<[string, string]> = [
    ['Product', data.productName],
    ['Amount paid', data.formattedAmount],
    ['Order reference', data.orderId]
  ];
  if (data.shippingAddress) rows.push(['Shipping to', data.shippingAddress]);

  const html = wrapShell({
    preheader: `Thank you ${data.customerName} — your Reca order is confirmed.`,
    heading: 'Your Reca order is confirmed 🎉',
    intro: `Thank you, ${data.customerName}! We've received your payment and your order for ${data.productName} is confirmed. Here's your receipt.`,
    bodyHtml:
      detailRows(rows) +
      `<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${BRAND.ink};">Your Reca includes a Lifetime Reca Membership. We'll email you with shipping updates as your device makes its way to you.</p>`,
    footerNote: `Questions about your order? Reach us anytime at ${data.supportEmail}.`
  });

  const text = [
    `Thank you, ${data.customerName}!`,
    `Your order for ${data.productName} is confirmed.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Questions? ${data.supportEmail}`
  ].join('\n');

  return { subject: `Your Reca order is confirmed — ${data.formattedAmount}`, html, text };
};

// --- 2. New admin invite with temporary password -----------------------------

export interface AdminInviteEmailData {
  email: string;
  temporaryPassword: string;
  createdBy: string;
  loginUrl: string;
}

export const adminInviteEmail = (data: AdminInviteEmailData): EmailContent => {
  const credentials = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ${BRAND.orange};border-radius:14px;margin:4px 0 8px;background-color:#fdf3ea;">
      <tr><td style="padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND.muted};">Email</td>
          <td style="padding:14px 16px;font-family:'Courier New',monospace;font-size:14px;font-weight:700;color:${BRAND.ink};">${esc(data.email)}</td></tr>
      <tr><td style="padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND.muted};border-top:1px solid ${BRAND.hairline};">Temporary password</td>
          <td style="padding:14px 16px;font-family:'Courier New',monospace;font-size:16px;font-weight:700;color:${BRAND.forest};border-top:1px solid ${BRAND.hairline};letter-spacing:1px;">${esc(data.temporaryPassword)}</td></tr>
    </table>
    <p style="margin:14px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${BRAND.muted};">For your security, you'll be asked to set a new password the first time you sign in. This temporary password expires once changed.</p>`;

  const html = wrapShell({
    preheader: 'Your Reca admin access is ready — temporary password inside.',
    heading: "You've been added as a Reca admin",
    intro: `${esc(data.createdBy)} added you to the Reca checkout admin dashboard. Use the credentials below to sign in.`,
    bodyHtml: credentials,
    cta: { label: 'Sign in to the dashboard', url: data.loginUrl },
    footerNote: "If you weren't expecting this, you can safely ignore this email."
  });

  const text = [
    "You've been added as a Reca admin",
    `${data.createdBy} added you to the Reca checkout admin dashboard.`,
    '',
    `Email: ${data.email}`,
    `Temporary password: ${data.temporaryPassword}`,
    '',
    `Sign in: ${data.loginUrl}`,
    "You'll be asked to set a new password on first sign-in."
  ].join('\n');

  return { subject: 'Your Reca admin access (temporary password inside)', html, text };
};

// --- 3. Customer pending-payment reminder ------------------------------------

export interface PaymentReminderEmailData {
  customerName: string;
  productName: string;
  formattedAmount: string;
  payUrl: string;
  supportEmail: string;
  note?: string;
}

export const paymentReminderEmail = (data: PaymentReminderEmailData): EmailContent => {
  const summary = detailRows([
    ['Product', data.productName],
    ['Amount due', data.formattedAmount]
  ]);
  const noteHtml = data.note
    ? `<p style="margin:4px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${BRAND.ink};">${esc(data.note)}</p>`
    : '';

  const html = wrapShell({
    preheader: `Complete your Reca order — ${data.formattedAmount} pending.`,
    heading: 'Your Reca order is almost there',
    intro: `Hi ${data.customerName}, we noticed your payment for ${data.productName} hasn't gone through yet. You can finish it securely in just a moment.`,
    bodyHtml: summary + noteHtml,
    cta: { label: 'Complete your payment', url: data.payUrl },
    footerNote: `Questions? Just reply to this email or reach us at ${data.supportEmail}.`
  });

  const text = [
    `Hi ${data.customerName},`,
    `Your payment for ${data.productName} (${data.formattedAmount}) is still pending.`,
    '',
    data.note ? `${data.note}\n` : '',
    `Complete your payment: ${data.payUrl}`,
    `Questions? ${data.supportEmail}`
  ]
    .filter(Boolean)
    .join('\n');

  return { subject: `Complete your Reca order — ${data.formattedAmount} pending`, html, text };
};
