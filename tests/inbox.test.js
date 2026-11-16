import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';
import { describeIncoming, isValidSignature } from '../src/services/inboxService.js';

const app = createApp();
after(() => db.destroy());

const sign = (body, secret = 'test-app-secret') => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('WhatsApp webhook signature', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it('accepts the App Secret signature of the exact body', () => {
    assert.equal(isValidSignature(body, sign(body)), true);
  });

  it('rejects other secrets, changed bodies and missing signatures', () => {
    assert.equal(isValidSignature(body, sign(body, 'other')), false);
    assert.equal(isValidSignature(Buffer.from('{}'), sign(body)), false);
    assert.equal(isValidSignature(body, undefined), false);
    assert.equal(isValidSignature(body, 'sha256=abc'), false);
    assert.equal(isValidSignature(body, sign(body), ''), false);
  });
});

describe('incoming message text', () => {
  it('reads text, buttons and replies', () => {
    assert.equal(describeIncoming({ type: 'text', text: { body: 'Yes please send' } }), 'Yes please send');
    assert.equal(describeIncoming({ type: 'button', button: { text: 'Order now' } }), 'Order now');
    assert.equal(describeIncoming({ type: 'interactive', interactive: { button_reply: { title: 'Yes' } } }), 'Yes');
  });

  it('describes media and other types', () => {
    assert.equal(describeIncoming({ type: 'image', image: { caption: 'prescription' } }), '[Photo] prescription');
    assert.equal(describeIncoming({ type: 'audio', audio: { voice: true } }), '[Voice message]');
    assert.equal(describeIncoming({ type: 'reaction', reaction: { emoji: '👍' } }), 'Reacted 👍');
    assert.equal(describeIncoming({ type: 'location', location: { latitude: 22.3, longitude: 70.8 } }), '[Location] 22.3, 70.8');
    assert.equal(describeIncoming({ type: 'order' }), '[order not supported]');
  });
});

describe('webhook routes', () => {
  it('answers Meta’s verification with the challenge only for the right token', async () => {
    const ok = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-123', 'hub.challenge': '1158201444' });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '1158201444');

    const wrong = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1158201444' });
    assert.equal(wrong.status, 403);
  });

  it('rejects deliveries without a valid signature', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').send(body);
    assert.equal(res.status, 401);
    const forged = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body, 'wrong'))
      .send(body);
    assert.equal(forged.status, 401);
  });

  it('accepts a signed delivery', async () => {
    // Not a WhatsApp payload, so nothing is stored (no database needed).
    const body = JSON.stringify({ object: 'page', entry: [] });
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    assert.equal(res.status, 200);
  });
});
