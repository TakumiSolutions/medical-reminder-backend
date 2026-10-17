import { db } from '../db/knex.js';
import { toIsoDate } from '../utils/dates.js';

const COLUMNS = [
  'customers.id',
  'customers.mobile',
  'customers.full_name',
  'customers.address',
  'customers.usual_doctor',
  'customers.notes',
  'customers.created_at',
  'customers.updated_at',
];

const FIELD_COLUMNS = {
  fullName: 'full_name',
  mobile: 'mobile',
  address: 'address',
  usualDoctor: 'usual_doctor',
  notes: 'notes',
};

function toCustomer(row, branchesById, medicinesById = new Map()) {
  return {
    id: String(row.id),
    mobile: row.mobile,
    fullName: row.full_name,
    address: row.address,
    usualDoctor: row.usual_doctor,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    branches: branchesById.get(String(row.id)) ?? [],
    medicines: medicinesById.get(String(row.id)) ?? [],
  };
}

/** Medicines per customer: [{ medicine, branchId, lastBillDate }], sorted by name. */
async function loadMedicines(customerIds, conn = db) {
  const map = new Map();
  if (customerIds.length === 0) return map;
  const rows = await conn('customer_medicines')
    .whereIn('customer_id', customerIds)
    .select('customer_id', 'branch_id', 'medicine', 'last_bill_date')
    .orderBy('medicine');
  for (const row of rows) {
    const key = String(row.customer_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ medicine: row.medicine, branchId: row.branch_id, lastBillDate: toIsoDate(row.last_bill_date) });
  }
  return map;
}

async function loadBranches(customerIds, conn = db) {
  const map = new Map();
  if (customerIds.length === 0) return map;
  const rows = await conn('customer_branches')
    .join('branches', 'branches.id', 'customer_branches.branch_id')
    .whereIn('customer_branches.customer_id', customerIds)
    .select('customer_branches.customer_id', 'branches.id', 'branches.code', 'branches.name')
    .orderBy('branches.id');
  for (const row of rows) {
    const key = String(row.customer_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: row.id, code: row.code, name: row.name });
  }
  return map;
}

/** Restricts a customers query to those linked to at least one of `branchIds`. */
function whereInBranches(query, branchIds) {
  return query.whereExists(
    db('customer_branches')
      .whereColumn('customer_branches.customer_id', 'customers.id')
      .whereIn('customer_branches.branch_id', branchIds),
  );
}

/**
 * @param scopeBranchIds  branches the caller may see (null = all)
 * @param branchId        optional extra filter to one branch
 */
export async function list({ search, scopeBranchIds, branchId, medicine, limit, offset }) {
  const query = db('customers');
  if (scopeBranchIds) whereInBranches(query, scopeBranchIds);
  if (branchId) whereInBranches(query, [branchId]);
  if (medicine) {
    // Only medicines recorded at branches the caller can see (and the chosen branch, if any).
    query.whereExists(function hasMedicine() {
      this.from('customer_medicines')
        .whereColumn('customer_medicines.customer_id', 'customers.id')
        .where('customer_medicines.medicine', medicine);
      if (scopeBranchIds) this.whereIn('customer_medicines.branch_id', scopeBranchIds);
      if (branchId) this.where('customer_medicines.branch_id', branchId);
    });
  }
  if (search) {
    const escaped = search.replace(/[\\%_]/g, '\\$&');
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.where('customers.full_name', 'like', `%${escaped}%`);
      if (digits.length >= 3) q.orWhere('customers.mobile', 'like', `%${digits}%`);
    });
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query.select(COLUMNS).orderBy('customers.full_name').orderBy('customers.id').limit(limit).offset(offset);
  const ids = rows.map((r) => r.id);
  const [branches, medicines] = await Promise.all([loadBranches(ids), loadMedicines(ids)]);
  return { items: rows.map((r) => toCustomer(r, branches, medicines)), total: Number(total) };
}

export async function findById(id, conn = db) {
  const row = await conn('customers').where('customers.id', id).first(COLUMNS);
  if (!row) return null;
  const [branches, medicines] = await Promise.all([loadBranches([row.id], conn), loadMedicines([row.id], conn)]);
  return toCustomer(row, branches, medicines);
}

export async function findIdByMobile(mobile, conn = db) {
  const row = await conn('customers').where({ mobile }).first('id');
  return row ? String(row.id) : null;
}

export async function lockById(conn, id) {
  return conn('customers').where({ id }).forUpdate().first('id');
}

/**
 * Existing customers by mobile, with the branches they belong to.
 * @returns {Map<string, { id: string, branchIds: number[] }>}
 */
export async function findByMobiles(mobiles) {
  const result = new Map();
  for (let i = 0; i < mobiles.length; i += 1000) {
    const rows = await db('customers').whereIn('mobile', mobiles.slice(i, i + 1000)).select('id', 'mobile');
    if (rows.length === 0) continue;
    const links = await db('customer_branches')
      .whereIn('customer_id', rows.map((r) => r.id))
      .select('customer_id', 'branch_id');
    for (const row of rows) {
      result.set(row.mobile, {
        id: String(row.id),
        branchIds: links.filter((l) => String(l.customer_id) === String(row.id)).map((l) => l.branch_id),
      });
    }
  }
  return result;
}

export async function insert(conn, fields, userId) {
  const [id] = await conn('customers').insert({
    mobile: fields.mobile,
    full_name: fields.fullName,
    address: fields.address ?? null,
    usual_doctor: fields.usualDoctor ?? null,
    notes: fields.notes ?? null,
    created_by: userId,
    updated_by: userId,
  });
  return String(id);
}

/** Updates the given fields (camelCase keys); undefined values are skipped. */
export async function update(conn, id, fields, userId) {
  const values = { updated_by: userId, updated_at: conn.fn.now() };
  for (const [key, column] of Object.entries(FIELD_COLUMNS)) {
    if (fields[key] !== undefined) values[column] = fields[key];
  }
  await conn('customers').where({ id }).update(values);
}

/** Links customers to branches, ignoring links that already exist. */
export async function addBranchLinks(conn, links) {
  for (let i = 0; i < links.length; i += 1000) {
    await conn('customer_branches')
      .insert(links.slice(i, i + 1000).map((l) => ({ customer_id: l.customerId, branch_id: l.branchId, source: 'manual' })))
      .onConflict(['customer_id', 'branch_id'])
      .ignore();
  }
}

export async function removeBranchLinks(conn, customerId, branchIds) {
  if (branchIds.length === 0) return;
  await conn('customer_branches').where({ customer_id: customerId }).whereIn('branch_id', branchIds).delete();
}

/** Distinct medicine names recorded at the given branches (null = all). */
export async function listMedicineNames(scopeBranchIds) {
  const query = db('customer_medicines').distinct('medicine').orderBy('medicine');
  if (scopeBranchIds) query.whereIn('branch_id', scopeBranchIds);
  return query.pluck('medicine');
}

/** Adds medicines for a customer at a branch, ignoring ones already recorded. Returns names added. */
export async function addMedicines(conn, { customerId, branchId, medicines, lastBillDate = null, source, userId }) {
  const existing = new Set(
    await conn('customer_medicines').where({ customer_id: customerId, branch_id: branchId }).pluck('medicine'),
  );
  const added = medicines.filter((m) => !existing.has(m));
  if (added.length) {
    await conn('customer_medicines')
      .insert(
        added.map((medicine) => ({
          customer_id: customerId,
          branch_id: branchId,
          medicine,
          last_bill_date: lastBillDate,
          source,
          created_by: userId,
        })),
      )
      .onConflict(['customer_id', 'branch_id', 'medicine'])
      .ignore();
  }
  return added;
}
