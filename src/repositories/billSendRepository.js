import { db } from '../db/knex.js';
import { toIsoDate } from '../utils/dates.js';
import { toLocalDateTime } from './agentBillRepository.js';

const toNumber = (value) => (value == null ? null : Number(value));

/**
 * Bills that should be sent automatically and have no automatic send yet: a valid mobile, a
 * remark starting with a number (checked further by the caller), dated `sinceDate` or later,
 * at `branchIds`. Oldest first.
 */
export function findAutoCandidates({ branchIds, sinceDate, limit = 500 }) {
  if (branchIds.length === 0) return Promise.resolve([]);
  return db('agent_bills as ab')
    .leftJoin('bill_whatsapp_sends as s', 's.auto_bill_id', 'ab.id')
    .whereNull('s.id')
    .whereNotNull('ab.phone')
    .whereIn('ab.branch_id', branchIds)
    .where('ab.bill_date', '>=', sinceDate)
    .whereRaw("ab.remarks REGEXP '^[[:space:]]*[0-9]'")
    .select('ab.id', 'ab.branch_id', 'ab.phone', 'ab.remarks')
    .orderBy('ab.id')
    .limit(limit);
}

/** Queues automatic sends; a bill already queued (unique auto_bill_id) is skipped. */
export async function queueAuto(bills) {
  if (bills.length === 0) return;
  await db('bill_whatsapp_sends')
    .insert(bills.map((b) => ({ agent_bill_id: b.id, branch_id: b.branch_id, mobile: b.phone, kind: 'auto', auto_bill_id: b.id })))
    .onConflict('auto_bill_id')
    .ignore();
}

/** A send started by a user, already claimed for sending. Returns its id. */
export async function insertManual({ agentBillId, branchId, mobile, userId }) {
  const [id] = await db('bill_whatsapp_sends').insert({
    agent_bill_id: agentBillId,
    branch_id: branchId,
    mobile,
    kind: 'manual',
    status: 'sending',
    attempts: 1,
    claimed_at: db.fn.now(),
    requested_by: userId,
  });
  return String(id);
}

/** Sends left 'sending' by a server that stopped are retried. */
export async function releaseStaleClaims(minutes) {
  await db('bill_whatsapp_sends')
    .where({ status: 'sending' })
    .where('claimed_at', '<', db.raw('NOW() - INTERVAL ? MINUTE', [minutes]))
    .update({ status: 'pending', claimed_at: null });
}

export function findPending({ branchIds, afterId, limit }) {
  return db('bill_whatsapp_sends')
    .where({ status: 'pending' })
    .whereIn('branch_id', branchIds)
    .where('id', '>', afterId)
    .orderBy('id')
    .limit(limit)
    .select('id', 'agent_bill_id', 'branch_id', 'mobile', 'attempts');
}

/** Claims a pending send; false when another server got it first. */
export async function claim(id) {
  const updated = await db('bill_whatsapp_sends')
    .where({ id, status: 'pending' })
    .update({ status: 'sending', claimed_at: db.fn.now(), attempts: db.raw('attempts + 1') });
  return updated === 1;
}

export async function markSent(id, messageId) {
  await db('bill_whatsapp_sends')
    .where({ id })
    .update({ status: 'sent', sent_at: db.fn.now(), whatsapp_message_id: messageId, failure_reason: null, claimed_at: null });
}

/** A final failure stays 'failed'; otherwise the send goes back to 'pending' for a retry. */
export async function markFailed(id, { reason, final }) {
  await db('bill_whatsapp_sends')
    .where({ id })
    .update({ status: final ? 'failed' : 'pending', failure_reason: String(reason).slice(0, 500), claimed_at: null });
}

/** Bill with its items and branch, as the PDF and the template need it; null if unknown. */
export async function loadBill(agentBillId) {
  const bill = await db('agent_bills as ab')
    .join('branches as b', 'b.id', 'ab.branch_id')
    .leftJoin('customers as c', 'c.mobile', 'ab.phone')
    .where('ab.id', agentBillId)
    .first(
      'ab.id',
      'ab.branch_id',
      'b.code as branch_code',
      'b.name as branch_name',
      'ab.bill_no',
      'ab.bill_date',
      'ab.phone',
      'ab.patient_name',
      'ab.address',
      'ab.doctor',
      'ab.total',
      'ab.created_by_name',
      'ab.bill_created_at',
      'c.id as customer_id',
      'c.full_name as customer_name',
    );
  if (!bill) return null;
  const items = await db('agent_bill_items').where({ agent_bill_id: agentBillId }).orderBy('line_no');
  return {
    id: String(bill.id),
    branch: { id: bill.branch_id, code: bill.branch_code, name: bill.branch_name },
    billNo: bill.bill_no,
    billDate: toIsoDate(bill.bill_date),
    phone: bill.phone,
    patientName: bill.patient_name,
    address: bill.address,
    doctor: bill.doctor,
    total: Number(bill.total),
    // Prompt Rx user who made the bill, and when (shop time), as printed on the memo.
    createdBy: bill.created_by_name || bill.bill_created_at ? { name: bill.created_by_name, at: toLocalDateTime(bill.bill_created_at) } : null,
    customerId: bill.customer_id == null ? null : String(bill.customer_id),
    customerName: bill.customer_name,
    items: items.map((i) => ({
      product: i.product,
      pack: i.pack,
      mfg: i.mfg,
      batch: i.batch,
      expiry: i.expiry,
      qty: toNumber(i.qty),
      free: toNumber(i.free),
      mrp: toNumber(i.mrp),
      rate: toNumber(i.rate),
      gstPct: toNumber(i.gst_pct),
      gstAmt: toNumber(i.gst_amt),
      amount: toNumber(i.amount),
    })),
  };
}
