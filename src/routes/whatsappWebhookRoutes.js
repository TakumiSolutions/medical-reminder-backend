// Meta WhatsApp webhook: GET verifies the subscription, POST delivers customer messages and
// delivery status updates. Requests are checked against the App Secret signature, so the
// raw body is kept (mounted before the JSON body parser).
import express, { Router } from 'express';
import { env } from '../config/env.js';
import * as inboxService from '../services/inboxService.js';

export const whatsappWebhookRoutes = Router();

whatsappWebhookRoutes.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const configured = Boolean(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  if (configured && mode === 'subscribe' && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && /^[\w-]{1,100}$/.test(challenge ?? '')) {
    return res.type('text/plain').send(challenge);
  }
  res.sendStatus(403);
});

whatsappWebhookRoutes.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!env.WHATSAPP_APP_SECRET) return res.sendStatus(503);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!inboxService.isValidSignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  // A failure answers 500 so Meta delivers the webhook again; stored messages are not duplicated.
  await inboxService.handleWebhook(payload);
  res.sendStatus(200);
});
