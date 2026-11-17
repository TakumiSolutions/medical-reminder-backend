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

/**
 * Request body for a template message to `mobile` (+91XXXXXXXXXX) with body parameters in
 * order and, optionally, a document header ({ id, filename } of uploaded media).
 */
export function templateMessage({ mobile, templateName, language, params, document }) {
  const components = [];
  if (document) components.push({ type: 'header', parameters: [{ type: 'document', document }] });
  if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) });
  return {
    messaging_product: 'whatsapp',
    to: mobile.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      ...(components.length && { components }),
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

/** POSTs to the branch number's `edge` (messages, media); returns the JSON answer. */
async function request(config, edge, body) {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${encodeURIComponent(config.phoneNumberId)}/${edge}`;
  const json = !(body instanceof FormData);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, ...(json && { 'Content-Type': 'application/json' }) },
      body: json ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WhatsAppError(`Could not reach WhatsApp: ${error.message}`, { retryable: true });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw toWhatsAppError(response.status, payload);
  return payload;
}

async function post(config, body) {
  const payload = await request(config, 'messages', body);
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

/**
 * Uploads a PDF to WhatsApp (kept by Meta for 30 days).
 * @returns {Promise<string>} the media id
 */
export async function uploadPdf(config, { buffer, filename }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const payload = await request(config, 'media', form);
  if (!payload?.id) throw new WhatsAppError('WhatsApp accepted the upload but returned no media id.', { retryable: false });
  return payload.id;
}

/**
 * Sends the branch's bill template with the PDF (uploaded media) as its document header.
 * @returns {Promise<string>} the WhatsApp message id
 */
export function sendBillTemplate(config, { mobile, mediaId, filename, params }) {
  return post(
    config,
    templateMessage({ mobile, templateName: config.billTemplateName, language: config.language, params, document: { id: mediaId, filename } }),
  );
}
