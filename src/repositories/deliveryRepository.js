import { db } from '../db/knex.js';
import { DELIVERY_STATUSES } from '../services/deliveryRules.js';

const toNumber = (value) => (value == null ? null : Number(value));

/** Ordered medicines per delivery, keyed by delivery id. */
export async function loadItems(deliveryIds, conn = db) {
  const map = new Map();
  if (deliveryIds.length === 0) return map;
  const rows = await conn('delivery_items').whereIn('delivery_id', deliveryIds).orderBy(['delivery_id', 'line_no']);
  for (const row of rows) {
    const key = String(row.delivery_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ medicine: row.medicine, quantity: toNumber(row.quantity) });
  }
  return map;
}

function toDelivery(row, itemsByDelivery = new Map()) {
  return {
    id: String(row.id),
    reminderId: row.reminder_cycle_id ? String(row.reminder_cycle_id) : null,
    customer: { id: String(row.customer_id), fullName: row.full_name, mobile: row.mobile },
    branch: { id: row.branch_id, name: row.branch_name },
    medicine: row.medicine ?? null,
    // What was ordered; empty for orders recorded before items were entered.
    items: itemsByDelivery.get(String(row.id)) ?? [],
    method: row.method,
    address: row.address,
    status: row.status,
    failureReason: row.failure_reason,
    assignedTo: row.assigned_to ? { id: String(row.assigned_to), fullName: row.assigned_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

function baseQuery(conn = db) {
  return conn('deliveries')
    .join('customers', 'customers.id', 'deliveries.customer_id')
    .join('branches', 'branches.id', 'deliveries.branch_id')
    .leftJoin('reminder_cycles', 'reminder_cycles.id', 'deliveries.reminder_cycle_id')
    .leftJoin('users as assignee', 'assignee.id', 'deliveries.assigned_to');
}

const COLUMNS = [
  'deliveries.*',
  'customers.full_name',
  'customers.mobile',
  'branches.name as branch_name',
  'reminder_cycles.medicine',
  'assignee.full_name as assigned_name',
];

function applyFilters(query, { scopeBranchIds, assignedTo, search }) {
  if (scopeBranchIds) query.whereIn('deliveries.branch_id', scopeBranchIds);
  if (assignedTo) query.where('deliveries.assigned_to', assignedTo);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.where('customers.full_name', 'like', pattern)
        .orWhere('reminder_cycles.medicine', 'like', pattern)
        .orWhereExists(
          db('delivery_items')
            .whereColumn('delivery_items.delivery_id', 'deliveries.id')
            .where('delivery_items.medicine', 'like', pattern),
        )
        .orWhere('deliveries.address', 'like', pattern);
      if (digits.length >= 3) q.orWhere('customers.mobile', 'like', `%${digits}%`);
    });
  }
  return query;
}

export async function list({ status, scopeBranchIds, assignedTo, search, limit, offset }) {
  const query = applyFilters(baseQuery(), { scopeBranchIds, assignedTo, search }).where('deliveries.status', status);
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .select(COLUMNS)
    // Open work oldest first; finished work newest first.
    .orderBy('deliveries.updated_at', status === 'pending' || status === 'out_for_delivery' ? 'asc' : 'desc')
    .orderBy('deliveries.id')
    .limit(limit)
    .offset(offset);
  const items = await loadItems(rows.map((r) => r.id));
  return { items: rows.map((r) => toDelivery(r, items)), total: Number(total) };
}

/** Counts per status for the same filters (excluding the status itself). */
export async function countByStatus(filters) {
  const rows = await applyFilters(baseQuery(), filters)
    .groupBy('deliveries.status')
    .select('deliveries.status')
    .count({ total: '*' });
  const counts = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

export async function findById(id, conn = db) {
  const row = await baseQuery(conn).where('deliveries.id', id).first(COLUMNS);
  if (!row) return null;
  const history = await conn('delivery_status_history as h')
    .leftJoin('users as u', 'u.id', 'h.changed_by')
    .where('h.delivery_id', id)
    .orderBy('h.id')
    .select('h.from_status', 'h.to_status', 'h.note', 'h.created_at', 'u.full_name');
  return {
    ...toDelivery(row, await loadItems([row.id], conn)),
    history: history.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      note: h.note,
      at: h.created_at,
      by: h.full_name ? { fullName: h.full_name } : null,
    })),
  };
}

export async function lock(conn, id) {
  return conn('deliveries').where({ id }).forUpdate().first();
}

/** The current (not cancelled) delivery for a reminder, locked. */
export async function lockOpenForReminder(conn, reminderCycleId) {
  return conn('deliveries')
    .where({ reminder_cycle_id: reminderCycleId })
    .whereNot('status', 'cancelled')
    .forUpdate()
    .first();
}

async function addHistory(conn, { deliveryId, from, to, note, userId }) {
  await conn('delivery_status_history').insert({
    delivery_id: deliveryId,
    from_status: from,
    to_status: to,
    note: note ?? null,
    changed_by: userId,
  });
}

export async function create(conn, { reminderCycleId, customerId, branchId, method, address, items = [], userId }) {
  const [id] = await conn('deliveries').insert({
    reminder_cycle_id: reminderCycleId,
    customer_id: customerId,
    branch_id: branchId,
    method,
    address: method === 'delivery' ? address : null,
    created_by: userId,
  });
  if (items.length) {
    await conn('delivery_items').insert(
      items.map((item, index) => ({ delivery_id: id, line_no: index + 1, medicine: item.medicine, quantity: item.quantity })),
    );
  }
  await addHistory(conn, { deliveryId: id, from: null, to: 'pending', userId });
  return String(id);
}

export async function changeStatus(conn, id, { from, to, note, userId }) {
  await conn('deliveries')
    .where({ id })
    .update({
      status: to,
      failure_reason: to === 'failed' ? note : null,
      delivered_at: to === 'delivered' ? conn.fn.now() : null,
      updated_at: conn.fn.now(),
    });
  await addHistory(conn, { deliveryId: id, from, to, note, userId });
}

export async function assign(conn, id, assigneeId) {
  await conn('deliveries').where({ id }).update({ assigned_to: assigneeId, updated_at: conn.fn.now() });
}

/** Active users assigned to the branch, who can be given a delivery. */
export async function listAssignableUsers(branchId, conn = db) {
  const rows = await conn('users')
    .join('user_branches', 'user_branches.user_id', 'users.id')
    .where({ 'user_branches.branch_id': branchId, 'users.is_active': true })
    .select('users.id', 'users.full_name', 'users.username')
    .orderBy('users.full_name');
  return rows.map((r) => ({ id: String(r.id), fullName: r.full_name, username: r.username }));
}
