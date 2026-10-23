import { db } from '../db/knex.js';

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : (value ?? null));

function toAgent(row) {
  return {
    id: String(row.id),
    name: row.name,
    branch: { id: row.branch_id, name: row.branch_name },
    tokenPrefix: row.token_prefix,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastHeartbeat: parseJson(row.last_heartbeat),
    bills: { total: Number(row.bills_total ?? 0), last24h: Number(row.bills_last_24h ?? 0) },
  };
}

/** The active agent holding `tokenHash`, or null. */
export async function findActiveByTokenHash(tokenHash) {
  const row = await db('agents')
    .where({ token_hash: tokenHash, is_active: true })
    .first('id', 'name', 'branch_id', 'last_seen_at');
  if (!row) return null;
  return { id: String(row.id), name: row.name, branchId: row.branch_id, lastSeenAt: row.last_seen_at };
}

export async function touchLastSeen(id) {
  await db('agents').where({ id }).update({ last_seen_at: db.fn.now() });
}

export async function saveHeartbeat(id, heartbeat) {
  await db('agents')
    .where({ id })
    .update({ last_heartbeat: JSON.stringify(heartbeat), last_heartbeat_at: db.fn.now(), last_seen_at: db.fn.now() });
}

function baseQuery(conn = db) {
  // Bills received per agent: in total and in the last 24 hours.
  const billCounts = conn('agent_bills')
    .groupBy('agent_id')
    .select('agent_id')
    .count({ bills_total: '*' })
    .select(conn.raw('SUM(first_received_at >= NOW() - INTERVAL 1 DAY) AS bills_last_24h'))
    .as('bill_counts');
  return conn('agents')
    .join('branches', 'branches.id', 'agents.branch_id')
    .leftJoin(billCounts, 'bill_counts.agent_id', 'agents.id')
    .select('agents.*', 'branches.name as branch_name', 'bill_counts.bills_total', 'bill_counts.bills_last_24h');
}

/** Agents of `scopeBranchIds` (all when null), active first. */
export async function list({ scopeBranchIds }) {
  const query = baseQuery();
  if (scopeBranchIds) query.whereIn('agents.branch_id', scopeBranchIds);
  const rows = await query.orderBy('agents.is_active', 'desc').orderBy('branches.name').orderBy('agents.name');
  return rows.map(toAgent);
}

export async function findById(id, conn = db) {
  const row = await baseQuery(conn).where('agents.id', id).first();
  return row ? toAgent(row) : null;
}

export async function lock(conn, id) {
  return conn('agents').where({ id }).forUpdate().first();
}

export async function insert(conn, { name, branchId, tokenHash, tokenPrefix, createdBy }) {
  const [id] = await conn('agents').insert({
    name,
    branch_id: branchId,
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    created_by: createdBy ?? null,
  });
  return String(id);
}

export async function replaceToken(conn, id, { tokenHash, tokenPrefix }) {
  await conn('agents').where({ id }).update({ token_hash: tokenHash, token_prefix: tokenPrefix });
}

export async function revoke(conn, id) {
  await conn('agents').where({ id }).update({ is_active: false, revoked_at: conn.fn.now() });
}
