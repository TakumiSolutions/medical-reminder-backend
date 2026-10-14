import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as sessionRepository from '../repositories/sessionRepository.js';
import * as userRepository from '../repositories/userRepository.js';
import { badRequest, unauthorized } from '../utils/errors.js';
import { getDummyHash, hashPassword, verifyPassword } from '../utils/password.js';
import { generateSessionToken, hashToken } from '../utils/tokens.js';

const INVALID_CREDENTIALS = 'Invalid username or password.';

export async function login({ username, password }) {
  const credentials = await userRepository.findCredentialsByUsername(username);

  if (!credentials) {
    // Spend the same hashing time so response timing does not reveal valid usernames.
    await verifyPassword(password, await getDummyHash());
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const passwordValid = await verifyPassword(password, credentials.password_hash);
  if (!passwordValid || !credentials.is_active) {
    await auditRepository.record({
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: credentials.id,
      details: { reason: passwordValid ? 'inactive_account' : 'invalid_password' },
    });
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await sessionRepository.create({ tokenHash: hashToken(token), userId: credentials.id, expiresAt });
  await userRepository.touchLastLogin(credentials.id);
  await auditRepository.record({
    actorUserId: credentials.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: credentials.id,
  });

  return { token, expiresAt };
}

export async function logout(auth) {
  await sessionRepository.revoke(auth.tokenHash);
  await auditRepository.record({
    actorUserId: auth.user.id,
    action: 'auth.logout',
    entityType: 'user',
    entityId: auth.user.id,
  });
}

/** Changes the caller's own password and signs out their other sessions. */
export async function changePassword(auth, { currentPassword, newPassword }) {
  const storedHash = await userRepository.findPasswordHashById(auth.user.id);
  if (!storedHash || !(await verifyPassword(currentPassword, storedHash))) {
    throw badRequest('Current password is incorrect.', [
      { path: 'currentPassword', message: 'Current password is incorrect.' },
    ]);
  }

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (trx) => {
    await userRepository.update(trx, auth.user.id, { passwordHash });
    await sessionRepository.revokeAllForUser(trx, auth.user.id, { exceptTokenHash: auth.tokenHash });
    await auditRepository.record(
      { actorUserId: auth.user.id, action: 'user.password_changed', entityType: 'user', entityId: auth.user.id },
      trx,
    );
  });
}

export function toCurrentUser(auth) {
  return {
    ...auth.user,
    roles: auth.roles,
    permissions: [...auth.permissions].sort(),
    // null means unrestricted.
    branchIds: auth.branchIds,
    modules: auth.modules,
  };
}
