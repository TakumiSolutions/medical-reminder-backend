import { env } from './env.js';

/**
 * WhatsApp Cloud API settings for a branch, from WHATSAPP_<CODE>_PHONE_NUMBER_ID and
 * WHATSAPP_<CODE>_ACCESS_TOKEN (optionally _TEMPLATE_NAME and _TEMPLATE_LANGUAGE), or null
 * when the branch has no WhatsApp number configured.
 */
export function whatsappConfigFor(branchCode, source = process.env) {
  const prefix = `WHATSAPP_${String(branchCode).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
  const read = (name) => source[prefix + name]?.trim() || null;
  const phoneNumberId = read('PHONE_NUMBER_ID');
  const accessToken = read('ACCESS_TOKEN');
  if (!phoneNumberId || !accessToken) return null;
  return {
    phoneNumberId,
    accessToken,
    templateName: read('TEMPLATE_NAME') ?? env.WHATSAPP_TEMPLATE_NAME,
    language: read('TEMPLATE_LANGUAGE') ?? env.WHATSAPP_TEMPLATE_LANGUAGE,
  };
}
