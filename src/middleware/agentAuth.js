import * as agentRepository from '../repositories/agentRepository.js';
import { badRequest, unauthorized } from '../utils/errors.js';
import { AGENT_TOKEN_PATTERN, hashToken } from '../utils/tokens.js';
import { IDEMPOTENCY_KEY_PATTERN } from '../validators/agentValidators.js';

const LAST_SEEN_INTERVAL_MS = 60 * 1000;

/** Bearer token from the Authorization header, or null when absent or malformed. */
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match && AGENT_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** Resolves `Authorization: Bearer <agent token>` into req.agent, or rejects with 401. */
export async function authenticateAgent(req, _res, next) {
  // Malformed headers are rejected without a database lookup.
  const token = bearerToken(req.get('authorization'));
  if (!token) return next(unauthorized('A valid agent token is required.'));

  const agent = await agentRepository.findActiveByTokenHash(hashToken(token));
  if (!agent) return next(unauthorized('This agent token is not valid or has been revoked.'));

  // Polling agents call every few seconds; record "last seen" at most once a minute.
  if (!agent.lastSeenAt || Date.now() - new Date(agent.lastSeenAt).getTime() >= LAST_SEEN_INTERVAL_MS) {
    await agentRepository.touchLastSeen(agent.id);
  }

  req.agent = { id: agent.id, branchId: agent.branchId, name: agent.name };
  next();
}

/** Requires an `Idempotency-Key` header and exposes it as req.idempotencyKey. */
export function requireIdempotencyKey(req, _res, next) {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return next(
      badRequest('A valid Idempotency-Key header is required.', [
        { path: 'Idempotency-Key', message: 'Use 1–128 characters: letters, digits, _ . : -' },
      ]),
    );
  }
  req.idempotencyKey = key;
  next();
}
