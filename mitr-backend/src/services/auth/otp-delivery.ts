import { env } from '../../config/env.js';
import { authConfig } from '../../config/auth-config.js';
import { logger } from '../../lib/logger.js';

const maskPhone = (phone: string): string => `${phone.slice(0, 2)}******${phone.slice(-2)}`;

const sendWithTwilio = async (phone: string, code: string): Promise<void> => {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromPhone = env.TWILIO_FROM_PHONE;
  if (!accountSid || !authToken || !fromPhone) {
    throw new Error('Twilio OTP delivery is not configured');
  }

  const body = new URLSearchParams({
    To: phone,
    From: fromPhone,
    Body: `Your Mitr verification code is ${code}. It expires in ${Math.ceil(authConfig.otpTtlSec / 60)} minutes.`
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }
  );

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    logger.warn('Twilio OTP send failed', {
      status: response.status,
      phoneMasked: maskPhone(phone),
      responseChars: responseText.length
    });
    throw new Error('Failed to send OTP');
  }
};

export const sendOtpCode = async (phone: string, code: string): Promise<void> => {
  if (authConfig.devOtpBypassEnabled || authConfig.otpDeliveryMode === 'dev_log') {
    logger.warn('Development OTP code generated', {
      phoneMasked: maskPhone(phone)
    });
    return;
  }

  if (authConfig.otpDeliveryMode === 'twilio') {
    await sendWithTwilio(phone, code);
    logger.info('OTP code sent', { phoneMasked: maskPhone(phone), provider: 'twilio' });
    return;
  }

  throw new Error('Phone OTP login is not configured');
};
