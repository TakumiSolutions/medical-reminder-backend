import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { whatsappConfigFor } from '../src/config/whatsapp.js';
import { localTime, templateParams } from '../src/services/reminderSender.js';
import { cleanParam, templateMessage, toWhatsAppError } from '../src/services/whatsappClient.js';

describe('WhatsApp branch config', () => {
  const source = {
    WHATSAPP_CENTRAL_PHONE_NUMBER_ID: ' 1234567890 ',
    WHATSAPP_CENTRAL_ACCESS_TOKEN: 'EAAG-central',
    WHATSAPP_SPEEDWELL_PHONE_NUMBER_ID: '999',
    WHATSAPP_SPEEDWELL_TEMPLATE_NAME: 'speedwell_reminder',
  };

  it('reads each branch by its code, with the default template', () => {
    assert.deepEqual(whatsappConfigFor('central', source), {
      phoneNumberId: '1234567890',
      accessToken: 'EAAG-central',
      templateName: 'medicine_reminder',
      language: 'en',
    });
  });

  it('is off for a branch without both the number id and the token', () => {
    assert.equal(whatsappConfigFor('speedwell', source), null);
    assert.equal(whatsappConfigFor('unknown', source), null);
  });

  it('lets a branch use its own template', () => {
    const config = whatsappConfigFor('speedwell', { ...source, WHATSAPP_SPEEDWELL_ACCESS_TOKEN: 't' });
    assert.equal(config.templateName, 'speedwell_reminder');
  });
});

describe('WhatsApp template message', () => {
  it('sends the template to the number without "+", with body parameters in order', () => {
    assert.deepEqual(
      templateMessage({ mobile: '+919876543210', templateName: 'medicine_reminder', language: 'en', params: ['Asha', 'TELMA 40'] }),
      {
        messaging_product: 'whatsapp',
        to: '919876543210',
        type: 'template',
        template: {
          name: 'medicine_reminder',
          language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'TELMA 40' }] }],
        },
      },
    );
  });

  it('cleans parameters WhatsApp would reject', () => {
    assert.equal(cleanParam('A\nB\t C     D'), 'A B C D');
    assert.equal(cleanParam(''), '-');
    assert.equal(cleanParam('x'.repeat(300)).length, 200);
  });

  it('fills parameters from the reminder in the configured order', () => {
    const reminder = { customerName: 'Asha', medicine: 'TELMA 40', branchName: 'Central', billDate: '2026-11-15' };
    assert.deepEqual(templateParams(reminder, ['customer', 'medicine']), ['Asha', 'TELMA 40']);
    assert.deepEqual(templateParams(reminder, ['branch', 'billdate', 'customer']), ['Central', '2026-11-15', 'Asha']);
  });
});

describe('WhatsApp errors', () => {
  it('retries rate limits and server errors, not bad requests', () => {
    assert.equal(toWhatsAppError(429, null).retryable, true);
    assert.equal(toWhatsAppError(503, null).retryable, true);
    assert.equal(toWhatsAppError(400, { error: { code: 130429, message: 'Rate limit hit' } }).retryable, true);
    const invalid = toWhatsAppError(400, { error: { code: 132001, message: 'Template name does not exist in the translation' } });
    assert.equal(invalid.retryable, false);
    assert.match(invalid.message, /132001/);
  });
});

describe('send time', () => {
  it("uses the app timezone's clock", () => {
    // 04:30 UTC is 10:00 in India.
    assert.equal(localTime('Asia/Kolkata', new Date('2026-11-16T04:30:00Z')), '10:00');
    assert.equal(localTime('Asia/Kolkata', new Date('2026-11-16T04:29:00Z')), '09:59');
  });
});
