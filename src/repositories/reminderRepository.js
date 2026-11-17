import { db } from '../db/knex.js';
import { toIsoDate } from '../utils/dates.js';
import { loadItems as loadDeliveryItems } from './deliveryRepository.js';

const LAST_DATE = '(SELECT MAX(r.scheduled_date) FROM reminders r WHERE r.cycle_id = reminder_cycles.id)';

/**
 * List views. A cycle is "finished" once its last reminder date has passed; nothing is
 * stored for that, so it is derived from `today`.
 */
const open = (q) => q.where('reminder_cycles.status', 'active').whereNull('reminder_cycles.outcome');

const VIEWS = {
  active: (q, today) => open(q).whereRaw(`${LAST_DATE} >= ?`, [today]),
  due: (q, today) =>
    open(q).whereExists(
      db('reminders')
        .whereColumn('reminders.cycle_id', 'reminder_cycles.id')
        .where({ 'reminders.scheduled_date': today, 'reminders.status': 'scheduled' }),
    ),
  finished: (q, today) => open(q).whereRaw(`${LAST_DATE} < ?`, [today]),
  cancelled: (q) => q.where('reminder_cycles.status', 'cancelled'),
  ordered: (q) => q.where('reminder_cycles.outcome', 'ordered'),
  refused: (q) => q.where('reminder_cycles.outcome', 'refused'),
};
const OUTCOME_VIEWS = new Set(['ordered', 'refused']);
export const REMINDER_VIEWS = Object.keys(VIEWS);

function toCycle(row, remindersByCycle, today, deliveriesByCycle = new Map(), billItems = new Map()) {
  const reminders = remindersByCycle.get(String(row.id)) ?? [];
  const lastDate = reminders.at(-1)?.scheduledDate ?? null;
  return {
    id: String(row.id),
    customer: { id: String(row.customer_id), fullName: row.full_name, mobile: row.mobile, address: row.address },
    branch: { id: row.branch_id, name: row.branch_name },
    medicine: row.medicine,
    startDate: toIsoDate(row.start_date),
    intervalDays: row.interval_days,
    status:
      row.status === 'cancelled'
        ? 'cancelled'
        : (row.outcome ?? (lastDate && lastDate < today ? 'finished' : 'active')),
    outcome: row.outcome
      ? { type: row.outcome, reason: row.outcome_reason, at: row.outcome_at, by: row.outcome_by_name ? { fullName: row.outcome_by_name } : null }
      : null,
    cancelReason: row.cancel_reason,
    // Set when the reminder was created automatically from a bill's remark.
    bill: row.agent_bill_id ? { id: String(row.agent_bill_id), billNo: row.bill_no, remarks: row.bill_remarks } : null,
    // Suggested lines for the order: the bill's medicines and quantities, or the medicine alone.
    orderItems: (row.agent_bill_id && billItems.get(String(row.agent_bill_id))) || [{ medicine: row.medicine, quantity: null }],
    createdAt: row.created_at,
    createdBy: row.created_by_name ? { fullName: row.created_by_name } : null,
    cancelledAt: row.cancelled_at,
    reminders,
    // Current (not cancelled) delivery of an order, if any.
    delivery: deliveriesByCycle.get(String(row.id)) ?? null,
  };
}

/** Medicines and quantities on each bill (a repeated product added up), keyed by bill id. */
async function loadBillItems(billIds, conn = db) {
  const map = new Map();
  if (billIds.length === 0) return map;
  const rows = await conn('agent_bill_items')
    .whereIn('agent_bill_id', billIds)
    .whereNotNull('product')
    .groupBy('agent_bill_id', 'product')
    .select('agent_bill_id', 'product', conn.raw('SUM(qty) AS qty'), conn.raw('MIN(line_no) AS first_line'))
    .orderBy(['agent_bill_id', 'first_line']);
  for (const row of rows) {
    const key = String(row.agent_bill_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ medicine: row.product.trim(), quantity: row.qty == null ? null : Number(row.qty) });
  }
  return map;
}

async function loadDeliveries(cycleIds, conn = db) {
  const map = new Map();
  if (cycleIds.length === 0) return map;
  const rows = await conn('deliveries')
    .leftJoin('users as assignee', 'assignee.id', 'deliveries.assigned_to')
    .whereIn('deliveries.reminder_cycle_id', cycleIds)
    .whereNot('deliveries.status', 'cancelled')
    .select(
      'deliveries.id',
      'deliveries.reminder_cycle_id',
      'deliveries.method',
      'deliveries.status',
      'deliveries.address',
      'assignee.full_name as assigned_name',
    );
  const items = await loadDeliveryItems(rows.map((r) => r.id), conn);
  for (const row of rows) {
    map.set(String(row.reminder_cycle_id), {
      items: items.get(String(row.id)) ?? [],
      id: String(row.id),
      method: row.method,
      status: row.status,
      // Where to deliver (null for store pickup); printed on the order slip.
      address: row.address ?? null,
      assignedTo: row.assigned_name ?? null,
    });
  }
  return map;
}

export async function loadReminders(cycleIds, conn = db) {
  const map = new Map();
  if (cycleIds.length === 0) return map;
  const rows = await conn('reminders').whereIn('cycle_id', cycleIds).orderBy('day_number');
  for (const row of rows) {
    const key = String(row.cycle_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      dayNumber: row.day_number,
      scheduledDate: toIsoDate(row.scheduled_date),
      status: row.status,
      cancelSource: row.cancel_source,
      sentAt: row.sent_at ?? null,
      failureReason: row.failure_reason ?? null,
    });
  }
  return map;
}

function baseQuery(conn = db) {
  return conn('reminder_cycles')
    .join('customers', 'customers.id', 'reminder_cycles.customer_id')
    .join('branches', 'branches.id', 'reminder_cycles.branch_id')
    .leftJoin('agent_bills', 'agent_bills.id', 'reminder_cycles.agent_bill_id')
    .leftJoin('users as creator', 'creator.id', 'reminder_cycles.created_by')
    .leftJoin('users as outcome_user', 'outcome_user.id', 'reminder_cycles.outcome_by');
}

const CYCLE_COLUMNS = [
  'reminder_cycles.*',
  'customers.full_name',
  'customers.mobile',
  'customers.address',
  'branches.name as branch_name',
  'agent_bills.bill_no',
  'agent_bills.remarks as bill_remarks',
  'creator.full_name as created_by_name',
  'outcome_user.full_name as outcome_by_name',
];

// A bill made up to this long before the order was marked still counts as the order's bill.
const ORDER_BILL_SLACK_MS = 12 * 3600_000;

/**
 * For ordered cycles: the latest RxBridge bill for the customer's mobile at the cycle's branch,
 * received since (shortly before) the order was marked — the bill made in Prompt for the
 * order, used to fill the amount on the order slip. Keyed by cycle id.
 */
async function loadOrderBills(rows, conn = db) {
  const map = new Map();
  const ordered = rows.filter((r) => r.outcome === 'ordered' && r.outcome_at && r.mobile);
  if (ordered.length === 0) return map;
  const since = (row) => new Date(new Date(row.outcome_at).getTime() - ORDER_BILL_SLACK_MS);
  const earliest = new Date(Math.min(...ordered.map((r) => since(r).getTime())));
  const bills = await conn('agent_bills')
    .whereIn('phone', [...new Set(ordered.map((r) => r.mobile))])
    .whereIn('branch_id', [...new Set(ordered.map((r) => r.branch_id))])
    .where('first_received_at', '>=', earliest)
    .orderBy('first_received_at', 'desc')
    .orderBy('id', 'desc')
    .select('id', 'phone', 'branch_id', 'bill_no', 'bill_date', 'total', 'first_received_at');
  for (const row of ordered) {
    const bill = bills.find(
      (b) =>
        b.phone === row.mobile &&
        b.branch_id === row.branch_id &&
        String(b.id) !== String(row.agent_bill_id ?? '') &&
        new Date(b.first_received_at) >= since(row),
    );
    if (bill) map.set(String(row.id), { id: String(bill.id), billNo: bill.bill_no, billDate: toIsoDate(bill.bill_date), total: Number(bill.total) });
  }
  return map;
}

/** @param scopeBranchIds branches the caller may see (null = all) */
export async function list({ view, today, search, scopeBranchIds, branchId, limit, offset }) {
  const query = baseQuery();
  if (scopeBranchIds) query.whereIn('reminder_cycles.branch_id', scopeBranchIds);
  if (branchId) query.where('reminder_cycles.branch_id', branchId);
  VIEWS[view](query, today);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.where('customers.full_name', 'like', pattern).orWhere('reminder_cycles.medicine', 'like', pattern);
      if (digits.length >= 3) q.orWhere('customers.mobile', 'like', `%${digits}%`);
    });
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .select(CYCLE_COLUMNS)
    // Outcomes: most recently marked first. Otherwise soonest upcoming reminder first.
    .modify((q) => {
      if (OUTCOME_VIEWS.has(view)) q.orderBy('reminder_cycles.outcome_at', 'desc');
      else q.orderByRaw(`${LAST_DATE} ${view === 'active' || view === 'due' ? 'ASC' : 'DESC'}`);
    })
    .orderBy('reminder_cycles.id', 'desc')
    .limit(limit)
    .offset(offset);
  const ids = rows.map((r) => r.id);
  const billIds = rows.filter((r) => r.agent_bill_id).map((r) => r.agent_bill_id);
  const [reminders, deliveries, billItems, orderBills] = await Promise.all([
    loadReminders(ids),
    loadDeliveries(ids),
    loadBillItems(billIds),
    view === 'ordered' ? loadOrderBills(rows) : new Map(),
  ]);
  return {
    items: rows.map((r) => {
      const cycle = toCycle(r, reminders, today, deliveries, billItems);
      // Ordered page only: the Prompt bill made for the order, if RxBridge has sent it.
      return view === 'ordered' ? { ...cycle, orderBill: orderBills.get(String(r.id)) ?? null } : cycle;
    }),
    total: Number(total),
  };
}

/** Counts per view, for the tab badges. */
export async function countByView({ today, scopeBranchIds }) {
  const entries = await Promise.all(
    REMINDER_VIEWS.map(async (view) => {
      const query = db('reminder_cycles');
      if (scopeBranchIds) query.whereIn('reminder_cycles.branch_id', scopeBranchIds);
      VIEWS[view](query, today);
      const [{ total }] = await query.count({ total: '*' });
      return [view, Number(total)];
    }),
  );
  return Object.fromEntries(entries);
}

export async function findById(id, today, conn = db) {
  const row = await baseQuery(conn).where('reminder_cycles.id', id).first(CYCLE_COLUMNS);
  if (!row) return null;
  const [reminders, deliveries, billItems] = await Promise.all([
    loadReminders([row.id], conn),
    loadDeliveries([row.id], conn),
    loadBillItems(row.agent_bill_id ? [row.agent_bill_id] : [], conn),
  ]);
  return toCycle(row, reminders, today, deliveries, billItems);
}

/** Active (not cancelled, not finished) cycles for a customer, keyed "branchId|medicine". */
export async function findOpenCycles(conn, customerId, today) {
  const rows = await conn('reminder_cycles')
    .where({ customer_id: customerId, status: 'active' })
    .whereNull('outcome')
    .whereRaw(`${LAST_DATE} >= ?`, [today])
    .select('id', 'branch_id', 'medicine');
  const reminders = await loadReminders(rows.map((r) => r.id), conn);
  return new Map(rows.map((r) => [`${r.branch_id}|${r.medicine}`, { id: String(r.id), reminders: reminders.get(String(r.id)) ?? [] }]));
}

/** `agentBillId` is set for a reminder created from a bill's remark; `userId` is null then. */
export async function createCycle(conn, { customerId, branchId, agentBillId = null, medicine, startDate, intervalDays, userId, days }) {
  const [id] = await conn('reminder_cycles').insert({
    customer_id: customerId,
    branch_id: branchId,
    agent_bill_id: agentBillId,
    medicine,
    start_date: startDate,
    interval_days: intervalDays,
    created_by: userId,
  });
  await conn('reminders').insert(
    days.map((d) => ({
      cycle_id: id,
      day_number: d.dayNumber,
      scheduled_date: d.scheduledDate,
      status: d.status,
      status_changed_at: d.status === 'skipped' ? conn.fn.now() : null,
    })),
  );
  return String(id);
}

export async function lockCycle(conn, id) {
  return conn('reminder_cycles')
    .where({ id })
    .forUpdate()
    .first('id', 'status', 'outcome', 'outcome_reason', 'branch_id', 'customer_id', 'medicine');
}

/** Cancels the cycle and its reminders that have not gone out yet. */
export async function cancelCycle(conn, id, { userId, reason }) {
  await conn('reminder_cycles')
    .where({ id })
    .update({ status: 'cancelled', cancelled_by: userId, cancelled_at: conn.fn.now(), cancel_reason: reason ?? null });
  await conn('reminders')
    .where({ cycle_id: id, status: 'scheduled' })
    .update({ status: 'cancelled', cancel_source: 'stop', status_changed_at: conn.fn.now() });
}

/** Records (or changes) the outcome; reminders not yet sent are cancelled because of it. */
export async function setOutcome(conn, id, { outcome, reason, userId }) {
  await conn('reminder_cycles')
    .where({ id })
    .update({ outcome, outcome_reason: reason ?? null, outcome_by: userId, outcome_at: conn.fn.now() });
  await conn('reminders')
    .where({ cycle_id: id, status: 'scheduled' })
    .update({ status: 'cancelled', cancel_source: 'outcome', status_changed_at: conn.fn.now() });
}

/**
 * Removes the outcome and restores the reminders it cancelled: dates from `today` on are
 * scheduled again, earlier ones are marked skipped (never sent late).
 */
export async function clearOutcome(conn, id, today) {
  await conn('reminder_cycles')
    .where({ id })
    .update({ outcome: null, outcome_reason: null, outcome_by: null, outcome_at: null });
  const restore = conn('reminders').where({ cycle_id: id, status: 'cancelled', cancel_source: 'outcome' });
  await restore
    .clone()
    .where('scheduled_date', '>=', today)
    .update({ status: 'scheduled', cancel_source: null, status_changed_at: conn.fn.now() });
  await restore
    .clone()
    .where('scheduled_date', '<', today)
    .update({ status: 'skipped', cancel_source: null, status_changed_at: conn.fn.now() });
}

// --- WhatsApp sending ---

/**
 * Reminders due on `today` that have not been sent, for active cycles at the given branches,
 * in id order after `afterId` (for paging through one run).
 */
export async function findDueForSending({ today, branchIds, afterId = 0, limit }) {
  if (branchIds.length === 0) return [];
  const rows = await db('reminders as r')
    .join('reminder_cycles as c', 'c.id', 'r.cycle_id')
    .join('customers as cu', 'cu.id', 'c.customer_id')
    .join('branches as b', 'b.id', 'c.branch_id')
    .where({ 'r.status': 'scheduled', 'r.scheduled_date': today, 'c.status': 'active' })
    .whereNull('c.outcome')
    .whereNull('r.send_claimed_at')
    .whereIn('c.branch_id', branchIds)
    .where('r.id', '>', afterId)
    .orderBy('r.id')
    .limit(limit)
    .select('r.id', 'r.attempts', 'c.branch_id', 'c.customer_id', 'c.medicine', 'c.start_date', 'cu.full_name', 'cu.mobile', 'b.name as branch_name');
  return rows.map((row) => ({
    id: String(row.id),
    attempts: row.attempts,
    branchId: row.branch_id,
    branchName: row.branch_name,
    medicine: row.medicine,
    billDate: toIsoDate(row.start_date),
    customerId: String(row.customer_id),
    customerName: row.full_name,
    mobile: row.mobile,
  }));
}

/** Claims a reminder for sending; false when another server claimed it or it is no longer scheduled. */
export async function claimForSending(id) {
  const updated = await db('reminders')
    .where({ id, status: 'scheduled' })
    .whereNull('send_claimed_at')
    .update({ send_claimed_at: db.fn.now() });
  return updated === 1;
}

export async function markSent(id, messageId) {
  await db('reminders').where({ id }).update({
    status: 'sent',
    sent_at: db.fn.now(),
    status_changed_at: db.fn.now(),
    whatsapp_message_id: messageId,
    failure_reason: null,
    attempts: db.raw('attempts + 1'),
    send_claimed_at: null,
  });
}

/** Records a failed attempt: `final` marks the reminder failed, otherwise it is tried again later. */
export async function markSendFailed(id, { reason, final }) {
  await db('reminders')
    .where({ id })
    .update({
      ...(final && { status: 'failed', status_changed_at: db.fn.now() }),
      failure_reason: reason.slice(0, 500),
      attempts: db.raw('attempts + 1'),
      send_claimed_at: null,
    });
}

/**
 * A claim left by a server that stopped mid-send. The message may have gone out, so it is
 * marked failed rather than sent again.
 */
export async function failStaleClaims(staleMinutes) {
  return db('reminders')
    .where('status', 'scheduled')
    .where('send_claimed_at', '<', db.raw('NOW() - INTERVAL ? MINUTE', [staleMinutes]))
    .update({
      status: 'failed',
      status_changed_at: db.fn.now(),
      failure_reason: 'Sending was interrupted. Check WhatsApp before contacting the customer again.',
      send_claimed_at: null,
    });
}
