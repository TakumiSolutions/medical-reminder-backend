import { db } from '../db/knex.js';
import { toIsoDate } from '../utils/dates.js';

const BILL_CHUNK = 200;
const ITEM_CHUNK = 1000;

// Columns refreshed when a bill is sent again (first_received_at is kept).
const MERGE_COLUMNS = [
  'branch_id',
  'bill_no',
  'series',
  'home_delivery',
  'bill_date',
  'phone',
  'patient_name',
  'address',
  'doctor',
  'total',
  'item_count',
  'updated_at',
];

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const toNumber = (value) => (value == null ? null : Number(value));

function* chunks(rows, size) {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

// --- Idempotency keys ---

/** Stored response for an ingest request; `lock` reads the latest committed row FOR UPDATE. */
export async function findIdempotencyKey(agentId, key, conn = db, { lock = false } = {}) {
  const query = conn('agent_idempotency_keys').where({ agent_id: agentId, idempotency_key: key });
  if (lock) query.forUpdate();
  const row = await query.first('request_hash', 'status_code', 'response');
  return row ? { requestHash: row.request_hash, statusCode: row.status_code, response: parseJson(row.response) } : null;
}

export async function insertIdempotencyKey(conn, { agentId, key, requestHash, statusCode, response }) {
  await conn('agent_idempotency_keys').insert({
    agent_id: agentId,
    idempotency_key: key,
    request_hash: requestHash,
    status_code: statusCode,
    response: JSON.stringify(response),
  });
}

/** Deletes up to `limit` keys older than `days`. */
export async function deleteIdempotencyKeysOlderThan(days, limit = 5000) {
  return db('agent_idempotency_keys')
    .where('created_at', '<', db.raw('NOW() - INTERVAL ? DAY', [days]))
    .limit(limit)
    .delete();
}

// --- Bills ---

/**
 * Inserts or updates each bill by (agent, source database, source bill id) and replaces
 * its items. `bills` are rows from toBillRow(), with unique sourceBillIds.
 */
export async function upsertBills(conn, { agentId, branchId, sourceDatabase, bills }) {
  for (const chunk of chunks(bills, BILL_CHUNK)) {
    await conn('agent_bills')
      .insert(
        chunk.map(({ items, ...bill }) => ({
          agent_id: agentId,
          branch_id: branchId,
          source_database: sourceDatabase,
          ...bill,
          item_count: items.length,
          updated_at: conn.fn.now(),
        })),
      )
      .onConflict(['agent_id', 'source_database', 'source_bill_id'])
      .merge(MERGE_COLUMNS);
  }

  const idBySource = new Map();
  for (const chunk of chunks(bills, ITEM_CHUNK)) {
    const rows = await conn('agent_bills')
      .where({ agent_id: agentId, source_database: sourceDatabase })
      .whereIn('source_bill_id', chunk.map((b) => b.source_bill_id))
      .select('id', 'source_bill_id');
    for (const row of rows) idBySource.set(row.source_bill_id, row.id);
  }

  const billIds = [...idBySource.values()];
  for (const chunk of chunks(billIds, ITEM_CHUNK)) {
    await conn('agent_bill_items').whereIn('agent_bill_id', chunk).delete();
  }
  const items = bills.flatMap((bill) =>
    bill.items.map((item, index) => ({ agent_bill_id: idBySource.get(bill.source_bill_id), line_no: index + 1, ...item })),
  );
  for (const chunk of chunks(items, ITEM_CHUNK)) {
    await conn('agent_bill_items').insert(chunk);
  }
}

function toBill(row) {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    branch: { id: row.branch_id, name: row.branch_name },
    sourceDatabase: row.source_database,
    sourceBillId: row.source_bill_id,
    billNo: row.bill_no,
    series: row.series,
    homeDelivery: Boolean(row.home_delivery),
    billDate: toIsoDate(row.bill_date),
    phone: row.phone,
    patientName: row.patient_name,
    address: row.address,
    doctor: row.doctor,
    total: Number(row.total),
    itemCount: row.item_count,
    firstReceivedAt: row.first_received_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row) {
  return {
    lineNo: row.line_no,
    product: row.product,
    pack: row.pack,
    mfg: row.mfg,
    batch: row.batch,
    expiry: row.expiry,
    qty: toNumber(row.qty),
    free: toNumber(row.free),
    mrp: toNumber(row.mrp),
    rate: toNumber(row.rate),
    gstPct: toNumber(row.gst_pct),
    gstAmt: toNumber(row.gst_amt),
    amount: toNumber(row.amount),
  };
}

const baseQuery = () =>
  db('agent_bills')
    .join('branches', 'branches.id', 'agent_bills.branch_id')
    .select('agent_bills.*', 'branches.name as branch_name');

/** An agent's bills, newest bill date first. `search` matches phone digits, patient or bill number. */
export async function listForAgent({ agentId, search, limit, offset }) {
  const query = db('agent_bills').where('agent_bills.agent_id', agentId);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.where('agent_bills.patient_name', 'like', pattern).orWhere('agent_bills.bill_no', 'like', pattern);
      if (digits.length >= 3) q.orWhere('agent_bills.phone', 'like', `%${digits}%`);
    });
  }
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .join('branches', 'branches.id', 'agent_bills.branch_id')
    .select('agent_bills.*', 'branches.name as branch_name')
    .orderBy('agent_bills.bill_date', 'desc')
    .orderBy('agent_bills.id', 'desc')
    .limit(limit)
    .offset(offset);
  return { items: rows.map(toBill), total: Number(total) };
}

export async function findById(id) {
  const row = await baseQuery().where('agent_bills.id', id).first();
  if (!row) return null;
  const items = await db('agent_bill_items').where({ agent_bill_id: id }).orderBy('line_no');
  return { ...toBill(row), items: items.map(toItem) };
}
