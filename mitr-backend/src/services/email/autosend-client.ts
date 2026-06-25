import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface EmailParty {
  email: string;
  name?: string;
}

export interface SendEmailInput {
  to: EmailParty;
  subject: string;
  html: string;
  text?: string;
  replyTo?: EmailParty;
  cc?: EmailParty[];
  bcc?: EmailParty[];
}

export interface SendEmailResult {
  delivered: boolean;
  skipped?: boolean;
  emailId?: string;
  error?: string;
}

export class AutoSendApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'AutoSendApiError';
  }
}

const fromParty = (): EmailParty => ({
  email: env.EMAIL_FROM_ADDRESS,
  name: env.EMAIL_FROM_NAME
});

const defaultReplyTo = (): EmailParty | undefined =>
  env.EMAIL_REPLY_TO_ADDRESS ? { email: env.EMAIL_REPLY_TO_ADDRESS } : undefined;

/**
 * Sends a single transactional email through AutoSend.
 * Never throws for the caller's convenience — email is best-effort and must
 * not break the checkout/admin request that triggered it. Failures are logged
 * and returned as { delivered: false }.
 */
export const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
  if (!env.AUTOSEND_API_KEY) {
    logger.warn('AutoSend API key not configured; skipping email', { subject: input.subject });
    return { delivered: false, skipped: true };
  }

  const body = {
    to: { email: input.to.email, ...(input.to.name ? { name: input.to.name } : {}) },
    from: fromParty(),
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...((input.replyTo ?? defaultReplyTo()) ? { replyTo: input.replyTo ?? defaultReplyTo() } : {})
  };

  try {
    const response = await fetch(`${env.AUTOSEND_BASE_URL}/mails/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.AUTOSEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as { data?: { emailId?: string } }) : {};
    if (!response.ok) {
      throw new AutoSendApiError('AutoSend API request failed', response.status, parsed);
    }
    logger.info('AutoSend email queued', {
      subject: input.subject,
      to: input.to.email,
      emailId: parsed.data?.emailId
    });
    return { delivered: true, emailId: parsed.data?.emailId };
  } catch (error) {
    const message =
      error instanceof AutoSendApiError
        ? `${error.statusCode} ${JSON.stringify(error.responseBody)}`
        : (error as Error).message;
    logger.error('AutoSend email failed', { subject: input.subject, to: input.to.email, error: message });
    return { delivered: false, error: message };
  }
};
