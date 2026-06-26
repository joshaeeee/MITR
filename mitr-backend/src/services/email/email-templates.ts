import type { PoolClient } from 'pg';
import { pgPool } from '../../db/client.js';
import type { EmailTemplateVariable } from '../../db/schema.js';
import { CheckoutError } from '../checkout/checkout-service.js';
import { sendEmail } from './autosend-client.js';
import { EMAIL_TEMPLATE_CATALOG } from './template-catalog.js';

interface EmailTemplateRow {
  id: string;
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'internal';
  subject: string;
  html: string;
  text_body: string;
  variables: EmailTemplateVariable[];
  sample_data: Record<string, string>;
  sendable_from_dashboard: boolean;
  is_active: boolean;
  metadata_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

const escHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Idempotently seeds the catalog into the email_templates table. Uses
 * `on conflict (key) do nothing`, so admin edits to a template are never
 * clobbered and newly added catalog entries appear automatically.
 */
export const ensureEmailTemplatesSeeded = async (client: PoolClient): Promise<void> => {
  for (const tpl of EMAIL_TEMPLATE_CATALOG) {
    await client.query(
      `insert into email_templates (
         key, name, description, category, subject, html, text_body,
         variables, sample_data, sendable_from_dashboard, is_active, metadata_json
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, true, $11::jsonb)
       on conflict (key) do nothing`,
      [
        tpl.key,
        tpl.name,
        tpl.description,
        tpl.category,
        tpl.content.subject,
        tpl.content.html,
        tpl.content.text,
        JSON.stringify(tpl.variables),
        JSON.stringify(tpl.sampleData),
        tpl.sendableFromDashboard,
        JSON.stringify({ source: 'template_catalog' })
      ]
    );
  }
};

const publicEmailTemplateSummary = (row: EmailTemplateRow) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  category: row.category,
  subject: row.subject,
  variables: row.variables ?? [],
  sendableFromDashboard: row.sendable_from_dashboard,
  isActive: row.is_active,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const publicEmailTemplateDetail = (row: EmailTemplateRow) => ({
  ...publicEmailTemplateSummary(row),
  html: row.html,
  text: row.text_body,
  sampleData: row.sample_data ?? {}
});

/**
 * Substitutes {{key}} tokens in a template's subject/html/text with the given
 * variable values. Values are HTML-escaped in the HTML body, raw in subject and
 * plain-text. Missing required variables throw; missing optional ones resolve to
 * empty strings. Exported for the send API to reuse.
 */
export const renderEmailTemplate = (
  template: { subject: string; html: string; text: string; variables: EmailTemplateVariable[] },
  vars: Record<string, string | null | undefined>
): { subject: string; html: string; text: string } => {
  const missing = template.variables
    .filter((v) => v.required)
    .filter((v) => {
      const value = vars[v.key];
      return value === undefined || value === null || String(value).trim() === '';
    })
    .map((v) => v.key);
  if (missing.length > 0) {
    throw new CheckoutError(400, `Missing required template variables: ${missing.join(', ')}`, 'missing_template_variables', {
      missing
    });
  }

  const substitute = (input: string, escape: boolean): string =>
    input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      const raw = vars[key];
      const value = raw === undefined || raw === null ? '' : String(raw);
      return escape ? escHtml(value) : value;
    });

  return {
    subject: substitute(template.subject, false),
    html: substitute(template.html, true),
    text: substitute(template.text, false)
  };
};

export const listEmailTemplates = async (options: {
  sendableOnly?: boolean;
  includeInactive?: boolean;
} = {}): Promise<{ templates: ReturnType<typeof publicEmailTemplateSummary>[] }> => {
  const client = await pgPool.connect();
  try {
    await ensureEmailTemplatesSeeded(client);
    const conditions: string[] = [];
    if (!options.includeInactive) conditions.push('is_active = true');
    if (options.sendableOnly) conditions.push('sendable_from_dashboard = true');
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const result = await client.query<EmailTemplateRow>(
      `select id, key, name, description, category, subject, html, text_body,
              variables, sample_data, sendable_from_dashboard, is_active, metadata_json,
              created_at, updated_at
       from email_templates
       ${where}
       order by sendable_from_dashboard desc, category asc, name asc`
    );
    return { templates: result.rows.map(publicEmailTemplateSummary) };
  } finally {
    client.release();
  }
};

export const getEmailTemplate = async (
  key: string,
  options: { withPreview?: boolean } = {}
): Promise<
  ReturnType<typeof publicEmailTemplateDetail> & { preview?: { subject: string; html: string; text: string } }
> => {
  const client = await pgPool.connect();
  try {
    await ensureEmailTemplatesSeeded(client);
    const result = await client.query<EmailTemplateRow>(
      `select id, key, name, description, category, subject, html, text_body,
              variables, sample_data, sendable_from_dashboard, is_active, metadata_json,
              created_at, updated_at
       from email_templates
       where key = $1`,
      [key]
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutError(404, 'Email template was not found', 'email_template_not_found');
    const detail = publicEmailTemplateDetail(row);
    if (!options.withPreview) return detail;
    const preview = renderEmailTemplate(
      { subject: row.subject, html: row.html, text: row.text_body, variables: row.variables ?? [] },
      row.sample_data ?? {}
    );
    return { ...detail, preview };
  } finally {
    client.release();
  }
};

/** Fetch the raw row for sending. */
const getEmailTemplateForSend = async (
  key: string
): Promise<{
  subject: string;
  html: string;
  text: string;
  variables: EmailTemplateVariable[];
  isActive: boolean;
  sendableFromDashboard: boolean;
}> => {
  const client = await pgPool.connect();
  try {
    await ensureEmailTemplatesSeeded(client);
    const result = await client.query<EmailTemplateRow>(
      `select subject, html, text_body, variables, is_active, sendable_from_dashboard
       from email_templates where key = $1`,
      [key]
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutError(404, 'Email template was not found', 'email_template_not_found');
    if (!row.is_active) throw new CheckoutError(409, 'Email template is not active', 'email_template_inactive');
    return {
      subject: row.subject,
      html: row.html,
      text: row.text_body,
      variables: row.variables ?? [],
      isActive: row.is_active,
      sendableFromDashboard: row.sendable_from_dashboard
    };
  } finally {
    client.release();
  }
};

/**
 * Renders a dashboard-sendable template with the supplied variables and sends it
 * via AutoSend. Throws on unknown/inactive/non-sendable template or missing
 * required variables; throws 502 if AutoSend hard-fails. Returns skipped:true
 * when AutoSend is not configured (no key) rather than treating it as an error.
 */
export const sendEmailTemplate = async (input: {
  key: string;
  to: { email: string; name?: string };
  variables: Record<string, string | null | undefined>;
}): Promise<{ sent: boolean; skipped: boolean; emailId?: string; to: string }> => {
  const template = await getEmailTemplateForSend(input.key);
  if (!template.sendableFromDashboard) {
    throw new CheckoutError(403, 'This template cannot be sent from the dashboard', 'email_template_not_sendable');
  }

  const rendered = renderEmailTemplate(template, input.variables);
  const result = await sendEmail({
    to: { email: input.to.email, name: input.to.name },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text
  });

  if (!result.delivered && !result.skipped) {
    throw new CheckoutError(502, 'Could not send the email', 'email_send_failed');
  }

  return {
    sent: result.delivered,
    skipped: Boolean(result.skipped),
    emailId: result.emailId,
    to: input.to.email
  };
};
