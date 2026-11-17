// Sends Prompt bills to customers on WhatsApp as a PDF, with the branch's own number and its
// bill template (WHATSAPP_BILL_TEMPLATE_NAME, Document header).
// - Automatically: bills whose remark is a day count (the ones that get a reminder), as soon
//   as RxBridge sends them, with retries. Only recent bills, so turning this on never sends
//   old bills.
// - By staff: any RxBridge bill, from the customer's bills (answers with the result).
import { billHeaderLinesFor, whatsappConfigFor } from '../config/whatsapp.js';
import { env } from '../config/env.js';
import { hasBranches } from '../config/permissions.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as billSendRepository from '../repositories/billSendRepository.js';
import { addDays, todayIn } from '../utils/dates.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { billFilename, printedDate, renderBillPdf } from './billPdf.js';
import { renderMemoPdf } from './billMemoPdf.js';
import { billTemplateFor } from './billTemplates.js';
import { recordBillSent } from './inboxService.js';
import { parseRemarkDays } from './reminderRules.js';
import { configuredBranches } from './reminderSender.js';
import { sendBillTemplate, uploadPdf } from './whatsappClient.js';

const RUN_INTERVAL_MS = 2 * 60 * 1000;
const BATCH = 50;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MINUTES = 15;
// Bills dated today or yesterday are sent automatically; older ones never.
export const AUTO_MAX_AGE_DAYS = 1;

const rupees = (value) => `₹${Number(value ?? 0).toFixed(2)}`;

/** Template body parameters, in the order set by WHATSAPP_BILL_TEMPLATE_PARAMS. */
export function billTemplateParams(bill, order = env.WHATSAPP_BILL_TEMPLATE_PARAMS) {
  const values = {
    customer: bill.patientName?.trim() || bill.customerName || 'Customer',
    billno: bill.billNo,
    billdate: printedDate(bill.billDate),
    total: rupees(bill.total),
    branch: bill.branch.name,
  };
  return order.map((name) => values[name]);
}

/**
 * The bill as a PDF: on the branch's own Cash Memo design, or a plain bill without one.
 * `backPage` adds the memo's printed back (offers, WhatsApp ordering) where the branch has one:
 * on for WhatsApp, off for printing (the paper memo already has it).
 */
export function billPdfFor(bill, { backPage = true } = {}) {
  const template = billTemplateFor(bill.branch.code);
  if (template) return renderMemoPdf({ template, storeName: env.BILL_STORE_NAME, bill, backPage });
  return renderBillPdf({
    storeName: env.BILL_STORE_NAME,
    headerLines: billHeaderLinesFor(bill.branch.code),
    branchName: bill.branch.name,
    bill,
  });
}

/** Renders, uploads and sends one bill. Returns the WhatsApp message id. */
async function deliver(bill, mobile, config) {
  const pdf = await billPdfFor(bill);
  const filename = billFilename(bill.billNo);
  const mediaId = await uploadPdf(config, { buffer: pdf, filename });
  return sendBillTemplate(config, { mobile, mediaId, filename, params: billTemplateParams(bill) });
}

/** Shown in the branch's WhatsApp inbox; the bill is already sent if this fails. */
function addToInbox(bill, mobile, messageId, sentBy) {
  return recordBillSent({
    branchId: bill.branch.id,
    mobile,
    customerId: bill.customerId,
    waMessageId: messageId,
    sentBy,
    body: `Bill ${bill.billNo} (${printedDate(bill.billDate)}, ${rupees(bill.total)}) sent as PDF`,
  }).catch((error) => console.error(`Adding bill ${bill.id} to the inbox failed:`, error.message));
}

async function sendQueued(row, config) {
  if (!(await billSendRepository.claim(row.id))) return 'skipped';
  try {
    const bill = await billSendRepository.loadBill(row.agent_bill_id);
    if (!bill) throw Object.assign(new Error('The bill no longer exists.'), { retryable: false });
    const messageId = await deliver(bill, row.mobile, config);
    await billSendRepository.markSent(row.id, messageId);
    await addToInbox(bill, row.mobile, messageId, null);
    return 'sent';
  } catch (error) {
    const final = !error.retryable || row.attempts + 1 >= MAX_ATTEMPTS;
    await billSendRepository.markFailed(row.id, { reason: error.message, final });
    console.error(`WhatsApp bill send ${row.id} ${final ? 'failed' : 'will be retried'}: ${error.message}`);
    return final ? 'failed' : 'retry';
  }
}

/** Queues new day-count bills at branches with WhatsApp, then sends what is pending. */
export async function sendAutoBills(now = new Date()) {
  const totals = { sent: 0, failed: 0 };
  if (!env.WHATSAPP_AUTO_SEND_BILLS) return totals;
  const branches = await configuredBranches();
  if (branches.size === 0) return totals;
  const branchIds = [...branches.keys()];

  const sinceDate = addDays(todayIn(env.APP_TIMEZONE, now), -AUTO_MAX_AGE_DAYS);
  const candidates = await billSendRepository.findAutoCandidates({ branchIds, sinceDate });
  await billSendRepository.queueAuto(candidates.filter((b) => parseRemarkDays(b.remarks)));

  await billSendRepository.releaseStaleClaims(STALE_CLAIM_MINUTES);
  // Sends to retry stay pending; paging by id leaves them for the next run.
  let afterId = 0;
  for (;;) {
    const pending = await billSendRepository.findPending({ branchIds, afterId, limit: BATCH });
    if (pending.length === 0) break;
    for (const row of pending) {
      afterId = Number(row.id);
      const result = await sendQueued(row, branches.get(row.branch_id).config);
      if (result === 'sent') totals.sent += 1;
      if (result === 'failed') totals.failed += 1;
    }
  }
  return totals;
}

let running = null;

/** Runs sendAutoBills unless a run is already going (then waits for that one). */
export function runAutoBills() {
  running ??= sendAutoBills()
    .then(({ sent, failed }) => {
      if (sent || failed) console.log(`WhatsApp bills: ${sent} sent, ${failed} failed.`);
    })
    .catch((error) => console.error('Sending WhatsApp bills failed:', error.message))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Runs the automatic sender at start-up and every 2 minutes. Returns a function that stops it. */
export function startBillSender() {
  console.log(env.WHATSAPP_AUTO_SEND_BILLS ? 'WhatsApp bills: automatic sending on.' : 'WhatsApp bills: automatic sending off (WHATSAPP_AUTO_SEND_BILLS).');
  runAutoBills();
  const timer = setInterval(runAutoBills, RUN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Sends one RxBridge bill now, for a user with access to its branch.
 * @returns {Promise<{ status: 'sent', sentAt: string, mobile: string }>}
 */
export async function sendBillNow(auth, agentBillId) {
  const bill = await billSendRepository.loadBill(agentBillId);
  if (!bill || !hasBranches(auth, [bill.branch.id])) throw notFound('Bill not found.');
  if (!bill.phone) throw badRequest('This bill has no valid mobile number.');
  const config = whatsappConfigFor(bill.branch.code);
  if (!config) throw new AppError(409, 'WHATSAPP_NOT_CONFIGURED', `WhatsApp is not set up for ${bill.branch.name}.`);

  const id = await billSendRepository.insertManual({ agentBillId: bill.id, branchId: bill.branch.id, mobile: bill.phone, userId: auth.user.id });
  let messageId;
  try {
    messageId = await deliver(bill, bill.phone, config);
  } catch (error) {
    await billSendRepository.markFailed(id, { reason: error.message, final: true });
    throw new AppError(502, 'WHATSAPP_SEND_FAILED', `WhatsApp did not send the bill: ${error.message}`);
  }
  await billSendRepository.markSent(id, messageId);
  await addToInbox(bill, bill.phone, messageId, auth.user.id);
  await auditRepository
    .record({
      actorUserId: auth.user.id,
      action: 'bill.whatsapp_sent',
      entityType: 'customer',
      entityId: bill.customerId,
      branchId: bill.branch.id,
      details: { billNo: bill.billNo, billDate: bill.billDate, mobile: bill.phone },
    })
    .catch((error) => console.error(`Auditing bill ${bill.id} send failed:`, error.message));
  return { status: 'sent', sentAt: new Date().toISOString(), mobile: bill.phone };
}

/**
 * One RxBridge bill as a PDF for printing (the front, as WhatsApp gets it), for a user with
 * access to its branch.
 * @returns {Promise<{ pdf: Buffer, filename: string }>}
 */
export async function billPdfForUser(auth, agentBillId) {
  const bill = await billSendRepository.loadBill(agentBillId);
  if (!bill || !hasBranches(auth, [bill.branch.id])) throw notFound('Bill not found.');
  // Printed on the memo's front only.
  return { pdf: await billPdfFor(bill, { backPage: false }), filename: billFilename(bill.billNo) };
}
