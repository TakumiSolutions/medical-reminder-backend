import { env } from '../config/env.js';
import * as sessionRepository from '../repositories/sessionRepository.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { hashToken } from '../utils/tokens.js';

/** Resolves the session cookie into req.auth, or rejects with 401. */
export async function authenticate(req, _res, next) {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) return next(unauthorized());

  const tokenHash = hashToken(token);
  const session = await sessionRepository.findActive(tokenHash);
  if (!session) return next(unauthorized('Your session has expired. Please sign in again.'));

  req.auth = { ...session, tokenHash };
  next();
}

/** Requires every listed permission. Must run after authenticate. */
export function requirePermission(...codes) {
  return (req, _res, next) => {
    const granted = req.auth?.permissions;
    if (!granted || !codes.every((code) => granted.has(code))) return next(forbidden());
    next();
  };
}

/** Allows the request only if `predicate(permissions)` is true. Must run after authenticate. */
export function requirePermissionWhere(predicate) {
  return (req, _res, next) => {
    if (!req.auth || !predicate(req.auth.permissions)) return next(forbidden());
    next();
  };
}
