import { db } from '../db/knex.js';
import { toIsoDate } from '../utils/dates.js';

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

function toCycle(row, remindersByCycle, today, deliveriesByCycle = new Map()) {
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
    createdAt: row.created_at,
    createdBy: row.created_by_name ? { fullName: row.created_by_name } : null,
    cancelledAt: row.cancelled_at,
    reminders,
    // Current (not cancelled) delivery of an order, if any.
    delivery: deliveriesByCycle.get(String(row.id)) ?? null,
  };
}

async function loadDeliveries(cycleIds, conn = db) {
  const map = new Map();
  if (cycleIds.length === 0) return map;
  const rows = await conn('deliveries')
    .leftJoin('users as assignee', 'assignee.id', 'deliveries.assigned_to')
    .whereIn('deliveries.reminder_cycle_id', cycleIds)
    .whereNot('deliveries.status', 'cancelled')
    .select('deliveries.id', 'deliveries.reminder_cycle_id', 'deliveries.method', 'deliveries.status', 'assignee.full_name as assigned_name');
  for (const row of rows) {
    map.set(String(row.reminder_cycle_id), {
      id: String(row.id),
      method: row.method,
      status: row.status,
      assignedTo: row.assigned_name ?? null,
    });
  }
  return map;
}

async function loadReminders(cycleIds, conn = db) {
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
    });
  }
  return map;
}

function baseQuery(conn = db) {
  return conn('reminder_cycles')
    .join('customers', 'customers.id', 'reminder_cycles.customer_id')
    .join('branches', 'branches.id', 'reminder_cycles.branch_id')
    .leftJoin('users as creator', 'creator.id', 'reminder_cycles.created_by')
    .leftJoin('users as outcome_user', 'outcome_user.id', 'reminder_cycles.outcome_by');
}

const CYCLE_COLUMNS = [
  'reminder_cycles.*',
  'customers.full_name',
  'customers.mobile',
  'customers.address',
  'branches.name as branch_name',
  'creator.full_name as created_by_name',
  'outcome_user.full_name as outcome_by_name',
];

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
  const [reminders, deliveries] = await Promise.all([loadReminders(ids), loadDeliveries(ids)]);
  return { items: rows.map((r) => toCycle(r, reminders, today, deliveries)), total: Number(total) };
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
  const [reminders, deliveries] = await Promise.all([loadReminders([row.id], conn), loadDeliveries([row.id], conn)]);
  return toCycle(row, reminders, today, deliveries);
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

export async function createCycle(conn, { customerId, branchId, medicine, startDate, intervalDays, userId, days }) {
  const [id] = await conn('reminder_cycles').insert({
    customer_id: customerId,
    branch_id: branchId,
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
