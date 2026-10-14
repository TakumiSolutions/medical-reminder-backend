import { db } from '../db/knex.js';

const PUBLIC_COLUMNS = [
  'users.id',
  'users.username',
  'users.full_name',
  'users.is_active',
  'users.last_login_at',
  'users.created_at',
  'users.updated_at',
];

function toUser(row, related) {
  const key = String(row.id);
  return {
    id: key,
    username: row.username,
    fullName: row.full_name,
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roles: related.roles.get(key) ?? [],
    branches: related.branches.get(key) ?? [],
    modules: related.modules.get(key) ?? [],
  };
}

function groupBy(rows, toValue) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.user_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(toValue(row));
  }
  return map;
}

/** Roles, branches and modules for a set of users, keyed by user id. */
async function loadRelated(userIds, conn = db) {
  if (userIds.length === 0) return { roles: new Map(), branches: new Map(), modules: new Map() };
  const [roles, branches, modules] = await Promise.all([
    conn('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .whereIn('user_roles.user_id', userIds)
      .select('user_roles.user_id', 'roles.code')
      .orderBy('roles.id'),
    conn('user_branches')
      .join('branches', 'branches.id', 'user_branches.branch_id')
      .whereIn('user_branches.user_id', userIds)
      .select('user_branches.user_id', 'branches.id', 'branches.code', 'branches.name')
      .orderBy('branches.id'),
    conn('user_modules')
      .join('modules', 'modules.code', 'user_modules.module_code')
      .whereIn('user_modules.user_id', userIds)
      .select('user_modules.user_id', 'modules.code')
      .orderBy('modules.sort_order'),
  ]);
  return {
    roles: groupBy(roles, (r) => r.code),
    branches: groupBy(branches, (b) => ({ id: b.id, code: b.code, name: b.name })),
    modules: groupBy(modules, (m) => m.code),
  };
}

export async function findCredentialsByUsername(username) {
  return db('users').where({ username }).first('id', 'password_hash', 'is_active');
}

export async function findPasswordHashById(id) {
  const row = await db('users').where({ id }).first('password_hash');
  return row?.password_hash ?? null;
}

export async function findById(id, conn = db) {
  const row = await conn('users').where({ id }).first(PUBLIC_COLUMNS);
  if (!row) return null;
  return toUser(row, await loadRelated([row.id], conn));
}

/**
 * Lists users. When `branchIds` is an array, only users assigned to at least one of
 * those branches are included; null means no branch restriction.
 */
export async function list({ search, limit, offset, branchIds }) {
  const query = db('users');
  if (branchIds) {
    query.whereExists(
      db('user_branches').whereColumn('user_branches.user_id', 'users.id').whereIn('user_branches.branch_id', branchIds),
    );
  }
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    query.where((q) => q.whereLike('username', pattern).orWhereLike('full_name', pattern));
  }
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query.select(PUBLIC_COLUMNS).orderBy('users.full_name').limit(limit).offset(offset);
  const related = await loadRelated(rows.map((r) => r.id));
  return { items: rows.map((r) => toUser(r, related)), total: Number(total) };
}

export async function usernameExists(username, conn = db) {
  return Boolean(await conn('users').where({ username }).first('id'));
}

export async function insert(conn, { username, fullName, passwordHash, createdBy }) {
  const [id] = await conn('users').insert({
    username,
    full_name: fullName,
    password_hash: passwordHash,
    created_by: createdBy,
  });
  return String(id);
}

export async function update(conn, id, fields) {
  const columns = {};
  if (fields.fullName !== undefined) columns.full_name = fields.fullName;
  if (fields.isActive !== undefined) columns.is_active = fields.isActive;
  if (fields.passwordHash !== undefined) columns.password_hash = fields.passwordHash;
  if (Object.keys(columns).length === 0) return;
  await conn('users').where({ id }).update({ ...columns, updated_at: conn.fn.now() });
}

export async function touchLastLogin(id) {
  await db('users').where({ id }).update({ last_login_at: db.fn.now() });
}

export async function setRoles(conn, userId, roleCodes) {
  const roles = await conn('roles').whereIn('code', roleCodes).select('id');
  await conn('user_roles').where({ user_id: userId }).delete();
  await conn('user_roles').insert(roles.map((r) => ({ user_id: userId, role_id: r.id })));
}

/** Returns (and locks) the ids of active users holding `roleCode`. */
export async function lockActiveIdsWithRole(conn, roleCode) {
  const rows = await conn('users')
    .join('user_roles', 'user_roles.user_id', 'users.id')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where({ 'roles.code': roleCode, 'users.is_active': true })
    .forUpdate()
    .select('users.id');
  return rows.map((r) => String(r.id));
}

/** Locks the user row for the rest of the transaction. */
export async function lockById(conn, id) {
  return conn('users').where({ id }).forUpdate().first('id');
}
