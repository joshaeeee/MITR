import { env } from '../../config/env.js';

const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';

export interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  notes?: Record<string, string>;
  created_at: number;
}

export interface RazorpayPayment {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  order_id?: string | null;
  captured?: boolean;
  method?: string;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  created_at?: number;
}

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

const razorpayAuthHeader = (): string => {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay keys are not configured');
  }
  return `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
};

const razorpayJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  const response = await fetch(`${RAZORPAY_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: razorpayAuthHeader(),
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new RazorpayApiError('Razorpay API request failed', response.status, body);
  }
  return body as T;
};

export const createRazorpayOrder = async (input: {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> =>
  razorpayJson<RazorpayOrder>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes
    })
  });

export const fetchRazorpayPayment = async (paymentId: string): Promise<RazorpayPayment> =>
  razorpayJson<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET'
  });
