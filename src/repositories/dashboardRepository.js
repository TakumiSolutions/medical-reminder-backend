import { db } from '../db/knex.js';

const LAST_DATE = '(SELECT MAX(r.scheduled_date) FROM reminders r WHERE r.cycle_id = c.id)';
const OPEN = "c.status = 'active' AND c.outcome IS NULL";

/** Rows grouped by branch_id -> Map(branchId -> row with numeric values). */
function byBranch(rows) {
  return new Map(
    rows.map(({ branch_id: branchId, ...values }) => [
      branchId,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value ?? 0)])),
    ]),
  );
}

export async function customerCounts(branchIds) {
  const rows = await db('customer_branches')
    .whereIn('branch_id', branchIds)
    .groupBy('branch_id')
    .select('branch_id', db.raw('COUNT(*) AS total'));
  return byBranch(rows);
}

/** Distinct customers across the branches (someone at two branches counts once). */
export async function distinctCustomerCount(branchIds) {
  const [{ total }] = await db('customer_branches').whereIn('branch_id', branchIds).countDistinct({ total: 'customer_id' });
  return Number(total);
}

/** @param day { today: 'YYYY-MM-DD', start, end } — start/end are the UTC bounds of today. */
export async function reminderCounts(branchIds, day) {
  const rows = await db('reminder_cycles as c')
    .whereIn('c.branch_id', branchIds)
    .groupBy('c.branch_id')
    .select(
      'c.branch_id',
      db.raw(
        `SUM(${OPEN} AND EXISTS (SELECT 1 FROM reminders r WHERE r.cycle_id = c.id AND r.scheduled_date = ? AND r.status = 'scheduled')) AS dueToday`,
        [day.today],
      ),
      db.raw(`SUM(${OPEN} AND ${LAST_DATE} >= ?) AS active`, [day.today]),
      db.raw(`SUM(${OPEN} AND ${LAST_DATE} < ?) AS awaitingResponse`, [day.today]),
      db.raw("SUM(c.outcome = 'ordered' AND c.outcome_at >= ? AND c.outcome_at < ?) AS orderedToday", [day.start, day.end]),
      db.raw("SUM(c.outcome = 'refused' AND c.outcome_at >= ? AND c.outcome_at < ?) AS refusedToday", [day.start, day.end]),
    );
  return byBranch(rows);
}

export async function deliveryCounts(branchIds, day) {
  const rows = await db('deliveries as d')
    .whereIn('d.branch_id', branchIds)
    .groupBy('d.branch_id')
    .select(
      'd.branch_id',
      db.raw("SUM(d.status = 'pending' AND d.method = 'delivery') AS toDispatch"),
      db.raw("SUM(d.status = 'pending' AND d.method = 'pickup') AS readyForPickup"),
      db.raw("SUM(d.status = 'out_for_delivery') AS outForDelivery"),
      db.raw("SUM(d.status = 'delivered' AND d.delivered_at >= ? AND d.delivered_at < ?) AS deliveredToday", [
        day.start,
        day.end,
      ]),
      db.raw("SUM(d.status = 'failed') AS failed"),
    );
  return byBranch(rows);
}
