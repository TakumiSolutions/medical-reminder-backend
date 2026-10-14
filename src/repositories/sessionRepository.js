import { db } from '../db/knex.js';
import { loadAccess } from './accessRepository.js';

export async function create({ tokenHash, userId, expiresAt }) {
  await db('sessions').insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
}

/** Returns the session's user and effective access, or null if the session is not usable. */
export async function findActive(tokenHash) {
  const session = await db('sessions')
    .join('users', 'users.id', 'sessions.user_id')
    .where('sessions.token_hash', tokenHash)
    .whereNull('sessions.revoked_at')
    .where('sessions.expires_at', '>', db.fn.now())
    .where('users.is_active', true)
    .first('users.id', 'users.username', 'users.full_name', 'sessions.expires_at');
  if (!session) return null;

  return {
    user: { id: String(session.id), username: session.username, fullName: session.full_name },
    ...(await loadAccess(session.id)),
    expiresAt: session.expires_at,
  };
}

export async function revoke(tokenHash) {
  await db('sessions').where({ token_hash: tokenHash }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}

export async function revokeAllForUser(conn, userId, { exceptTokenHash } = {}) {
  const query = conn('sessions').where({ user_id: userId }).whereNull('revoked_at');
  if (exceptTokenHash) query.whereNot({ token_hash: exceptTokenHash });
  await query.update({ revoked_at: conn.fn.now() });
}
