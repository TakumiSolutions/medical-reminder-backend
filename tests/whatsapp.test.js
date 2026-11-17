import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { billHeaderLinesFor, whatsappConfigFor } from '../src/config/whatsapp.js';
import { billFilename, printedDate, renderBillPdf } from '../src/services/billPdf.js';
import { billPdfFor, billTemplateParams } from '../src/services/billSender.js';
import { memoDate, memoTime } from '../src/services/billMemoPdf.js';
import { billTemplateFor } from '../src/services/billTemplates.js';
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
      billTemplateName: 'bill_copy',
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

describe('WhatsApp bill', () => {
  const bill = {
    id: '7',
    branch: { id: 1, code: 'central', name: 'Central' },
    billNo: 'CA-T/107953',
    billDate: '2026-11-16',
    phone: '+919876543210',
    patientName: 'RAVIBHAI',
    customerName: 'Ravi Patel',
    address: 'Kalavad Road',
    doctor: 'Dr Shah',
    total: 465,
    items: [
      { product: 'TELMA 40 TAB', pack: "15'S", mfg: 'GLENMARK', batch: 'B12', expiry: '08/27', qty: 2, free: 0, mrp: 250, rate: 210, gstPct: 12, gstAmt: 45, amount: 420 },
      { product: 'ECOSPRIN 75', pack: "14'S", mfg: 'USV', batch: 'E9', expiry: '01/28', qty: 1, free: null, mrp: 50, rate: 45, gstPct: 12, gstAmt: 4.82, amount: 45 },
    ],
  };

  it('sends the PDF as the document header with body parameters in order', () => {
    const message = templateMessage({
      mobile: '+919876543210',
      templateName: 'bill_copy',
      language: 'en',
      params: billTemplateParams(bill, ['customer', 'billno', 'billdate', 'total', 'branch']),
      document: { id: 'MEDIA1', filename: billFilename(bill.billNo) },
    });
    assert.deepEqual(message.template.components, [
      { type: 'header', parameters: [{ type: 'document', document: { id: 'MEDIA1', filename: 'Bill-CA-T-107953.pdf' } }] },
      {
        type: 'body',
        parameters: ['RAVIBHAI', 'CA-T/107953', '16-11-2026', '₹465.00', 'Central'].map((text) => ({ type: 'text', text })),
      },
    ]);
  });

  it("falls back to the customer's name, then to 'Customer'", () => {
    assert.deepEqual(billTemplateParams({ ...bill, patientName: ' ' }, ['customer']), ['Ravi Patel']);
    assert.deepEqual(billTemplateParams({ ...bill, patientName: null, customerName: null }, ['customer']), ['Customer']);
  });

  it('names files and dates as printed on the bill', () => {
    assert.equal(billFilename('DB-T/29654'), 'Bill-DB-T-29654.pdf');
    assert.equal(billFilename(null), 'Bill-copy.pdf');
    assert.equal(printedDate('2026-04-01'), '01-04-2026');
  });

  it('reads branch header lines', () => {
    assert.deepEqual(billHeaderLinesFor('central', { BILL_CENTRAL_HEADER: ' Kalavad Road, Rajkot | Ph: 0281 123456 |' }), [
      'Kalavad Road, Rajkot',
      'Ph: 0281 123456',
    ]);
    assert.deepEqual(billHeaderLinesFor('speedwell', {}), []);
  });

  it('renders a PDF, adding pages for long bills', async () => {
    const short = await renderBillPdf({ storeName: 'Shivam Medical Store', branchName: 'Central', bill });
    assert.equal(short.subarray(0, 5).toString(), '%PDF-');
    const many = { ...bill, items: Array.from({ length: 80 }, (_, i) => ({ ...bill.items[0], product: `ITEM ${i + 1}` })) };
    const long = await renderBillPdf({ storeName: 'Shivam Medical Store', branchName: 'Central', bill: many });
    assert.ok((long.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length >= 2);
  });
});

describe("bills on the branch's Cash Memo", () => {
  const bill = {
    id: '9',
    branch: { id: 1, code: 'central', name: 'Central' },
    billNo: 'CA-T/95571',
    billDate: '2026-10-21',
    patientName: 'VASANTBHAI BHATT',
    address: 'RAJKOT',
    doctor: 'PRAYAG PANDYA',
    total: 792,
    createdBy: { name: 'DEEP SUREJA', at: '2026-10-21T16:36:00' },
    items: [
      { product: 'DGSON 10 TAB #', pack: '10 TAB', mfg: 'X', batch: '260410452', expiry: '03/29', qty: 30, mrp: 50, rate: 4.76, gstPct: 5, gstAmt: 6.42, amount: 150 },
      { product: 'ISTAMET 50/500 TAB #', pack: '15 TAB', mfg: 'Y', batch: 'SIH0944A', expiry: '04/28', qty: 60, mrp: 176.25, rate: 11.19, gstPct: 5, gstAmt: 30.22, amount: 729.89 },
    ],
  };
  const pages = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

  it('has a design for Central and Speedwell only', () => {
    assert.ok(billTemplateFor('central'));
    assert.ok(billTemplateFor('SPEEDWELL'));
    assert.equal(billTemplateFor('other'), null);
  });

  it('prints date and time as on the memo', () => {
    assert.equal(memoDate('2026-10-21'), '21/10/2026');
    assert.equal(memoTime('2026-10-21T16:36:00'), '4:36 pm');
    assert.equal(memoTime('2026-10-21T00:05:00'), '12:05 am');
    assert.equal(memoTime(null), '');
  });

  it('renders each branch on its own memo, adding pages for long bills', async () => {
    for (const code of ['central', 'speedwell']) {
      const pdf = await billPdfFor({ ...bill, branch: { ...bill.branch, code } }, { backPage: false });
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.equal(pages(pdf), 1);
    }
    const long = await billPdfFor({ ...bill, items: Array.from({ length: 40 }, () => bill.items[0]) });
    assert.equal(pages(long), 3);
  });

  it('adds the printed back page where the branch has one, unless printing', async () => {
    const speedwell = { ...bill, branch: { ...bill.branch, code: 'speedwell' } };
    assert.equal(pages(await billPdfFor(speedwell)), 2);
    assert.equal(pages(await billPdfFor(speedwell, { backPage: false })), 1);
    // Central has no back page yet.
    assert.equal(pages(await billPdfFor({ ...bill, branch: { ...bill.branch, code: 'central' } })), 1);
  });

  it('makes memo pages 21 × 11 cm', async () => {
    const pdf = (await billPdfFor({ ...bill, branch: { ...bill.branch, code: 'central' } })).toString('latin1');
    const [width, height] = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf).slice(1).map(Number);
    assert.ok(Math.abs((width / 72) * 2.54 - 21) < 0.01, `width ${width}`);
    assert.ok(Math.abs((height / 72) * 2.54 - 11) < 0.01, `height ${height}`);
  });

  it('falls back to the plain bill for a branch without a memo design', async () => {
    const pdf = await billPdfFor({ ...bill, branch: { id: 3, code: 'other', name: 'Other' } });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });
});
