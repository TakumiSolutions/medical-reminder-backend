// Sends template messages through the Meta WhatsApp Cloud API.
import { env } from '../config/env.js';

const TIMEOUT_MS = 15_000;
const PARAM_MAX = 200;

// Meta error codes that are worth retrying later (rate limits, temporary outages).
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056]);

export class WhatsAppError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.retryable = retryable;
  }
}

/** Template parameters cannot contain new lines, tabs or more than 4 spaces in a row. */
export function cleanParam(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim() || '-';
  return text.length > PARAM_MAX ? `${text.slice(0, PARAM_MAX - 1)}…` : text;
}

/** Request body for a template message to `mobile` (+91XXXXXXXXXX) with body parameters in order. */
export function templateMessage({ mobile, templateName, language, params }) {
  return {
    messaging_product: 'whatsapp',
    to: mobile.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      ...(params.length && {
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) }],
      }),
    },
  };
}

/** Turns a failed response into a WhatsAppError, retryable for rate limits and server errors. */
export function toWhatsAppError(status, body) {
  const error = body?.error ?? {};
  const detail = error.error_data?.details;
  const message = [error.message ?? `HTTP ${status}`, detail].filter(Boolean).join(' — ');
  const retryable = status === 429 || status >= 500 || RETRYABLE_CODES.has(error.code);
  return new WhatsAppError(`WhatsApp ${status}${error.code ? ` (code ${error.code})` : ''}: ${message}`, { retryable });
}

async function post(config, body) {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WhatsAppError(`Could not reach WhatsApp: ${error.message}`, { retryable: true });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw toWhatsAppError(response.status, payload);
  const id = payload?.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('WhatsApp accepted the request but returned no message id.', { retryable: false });
  return id;
}

/** Sends a free-text message (only allowed within 24 hours of the customer's last message). */
export function sendText(config, { mobile, text }) {
  return post(config, { messaging_product: 'whatsapp', to: mobile.replace(/^\+/, ''), type: 'text', text: { body: text } });
}

/**
 * Sends one template message with the branch's number.
 * @returns {Promise<string>} the WhatsApp message id
 */
export function sendTemplate(config, { mobile, params }) {
  return post(config, templateMessage({ mobile, templateName: config.templateName, language: config.language, params }));
}
