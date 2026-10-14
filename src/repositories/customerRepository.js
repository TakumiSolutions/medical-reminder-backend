import { db } from '../db/knex.js';

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

function toCustomer(row, branchesById) {
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
  };
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
export async function list({ search, scopeBranchIds, branchId, limit, offset }) {
  const query = db('customers');
  if (scopeBranchIds) whereInBranches(query, scopeBranchIds);
  if (branchId) whereInBranches(query, [branchId]);
  if (search) {
    const escaped = search.replace(/[\\%_]/g, '\\$&');
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.whereLike('customers.full_name', `%${escaped}%`);
      if (digits.length >= 3) q.orWhereLike('customers.mobile', `%${digits}%`);
    });
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query.select(COLUMNS).orderBy('customers.full_name').orderBy('customers.id').limit(limit).offset(offset);
  const branches = await loadBranches(rows.map((r) => r.id));
  return { items: rows.map((r) => toCustomer(r, branches)), total: Number(total) };
}

export async function findById(id, conn = db) {
  const row = await conn('customers').where('customers.id', id).first(COLUMNS);
  if (!row) return null;
  return toCustomer(row, await loadBranches([row.id], conn));
}

export async function findIdByMobile(mobile, conn = db) {
  const row = await conn('customers').where({ mobile }).first('id');
  return row ? String(row.id) : null;
}

export async function lockById(conn, id) {
  return conn('customers').where({ id }).forUpdate().first('id');
}

/**
 * Existing customers by mobile, with their branch ids. Pass `forUpdate` inside a
 * transaction to lock them.
 * @returns {Map<string, { id, fullName, address, usualDoctor, branchIds: number[] }>}
 */
export async function findByMobiles(mobiles, { conn = db, forUpdate = false } = {}) {
  const result = new Map();
  for (let i = 0; i < mobiles.length; i += 1000) {
    const chunk = mobiles.slice(i, i + 1000);
    const query = conn('customers').whereIn('mobile', chunk);
    if (forUpdate) query.forUpdate();
    const rows = await query.select('id', 'mobile', 'full_name', 'address', 'usual_doctor');
    if (rows.length === 0) continue;
    const links = await conn('customer_branches')
      .whereIn('customer_id', rows.map((r) => r.id))
      .select('customer_id', 'branch_id');
    for (const row of rows) {
      result.set(row.mobile, {
        id: String(row.id),
        fullName: row.full_name,
        address: row.address,
        usualDoctor: row.usual_doctor,
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

/** Inserts many customers and returns a map of mobile -> new id. */
export async function insertMany(conn, rows, userId) {
  for (let i = 0; i < rows.length; i += 500) {
    await conn('customers').insert(
      rows.slice(i, i + 500).map((r) => ({
        mobile: r.mobile,
        full_name: r.fullName,
        address: r.address ?? null,
        usual_doctor: r.usualDoctor ?? null,
        created_by: userId,
        updated_by: userId,
      })),
    );
  }
  // Re-read ids by mobile rather than assuming consecutive auto-increment values.
  const ids = new Map();
  const mobiles = rows.map((r) => r.mobile);
  for (let i = 0; i < mobiles.length; i += 1000) {
    const found = await conn('customers').whereIn('mobile', mobiles.slice(i, i + 1000)).select('id', 'mobile');
    for (const row of found) ids.set(row.mobile, String(row.id));
  }
  return ids;
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
export async function addBranchLinks(conn, links, source) {
  for (let i = 0; i < links.length; i += 1000) {
    await conn('customer_branches')
      .insert(links.slice(i, i + 1000).map((l) => ({ customer_id: l.customerId, branch_id: l.branchId, source })))
      .onConflict(['customer_id', 'branch_id'])
      .ignore();
  }
}

export async function removeBranchLinks(conn, customerId, branchIds) {
  if (branchIds.length === 0) return;
  await conn('customer_branches').where({ customer_id: customerId }).whereIn('branch_id', branchIds).delete();
}
