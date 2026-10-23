// Admin side of the desktop agents: tokens, status and the bills they have sent.
import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as agentBillRepository from '../repositories/agentBillRepository.js';
import * as agentRepository from '../repositories/agentRepository.js';
import * as auditRepository from '../repositories/auditRepository.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { generateAgentToken, hashToken } from '../utils/tokens.js';

// Agents send a heartbeat every 60 s; none for this long means the PC or agent is down.
export const STALE_AFTER_MS = 10 * 60 * 1000;
const TOKEN_PREFIX_LENGTH = 12;

/** 'revoked' | 'never_seen' | 'online' | 'stale' */
export function agentStatus(agent, now = new Date()) {
  if (!agent.isActive) return 'revoked';
  if (!agent.lastSeenAt && !agent.lastHeartbeatAt) return 'never_seen';
  if (agent.lastHeartbeatAt && now - new Date(agent.lastHeartbeatAt) < STALE_AFTER_MS) return 'online';
  return 'stale';
}

const withStatus = (agent) => ({ ...agent, status: agentStatus(agent) });

const tokenFields = (token) => ({ tokenHash: hashToken(token), tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH) });

export async function listAgents(auth) {
  const agents = await agentRepository.list({ scopeBranchIds: auth.branchIds });
  return agents.map(withStatus);
}

async function loadVisible(auth, id) {
  const agent = await agentRepository.findById(id);
  if (!agent || !hasBranches(auth, [agent.branch.id])) throw notFound('Agent not found.');
  return withStatus(agent);
}

export const getAgent = (auth, id) => loadVisible(auth, id);

/**
 * Creates an agent for `branchId` and returns its token, the only time the token is
 * available. Also used by the CLI (actorUserId null, source 'cli').
 */
export async function insertAgent({ name, branchId, actorUserId = null, source }) {
  const token = generateAgentToken();
  const fields = tokenFields(token);
  const id = await db.transaction(async (trx) => {
    const agentId = await agentRepository.insert(trx, { name, branchId, ...fields, createdBy: actorUserId });
    await auditRepository.record(
      {
        actorUserId,
        action: 'agent.created',
        entityType: 'agent',
        entityId: agentId,
        branchId,
        details: { name, tokenPrefix: fields.tokenPrefix, ...(source && { source }) },
      },
      trx,
    );
    return agentId;
  });
  return { id, token };
}

export async function createAgent(auth, { name, branchId }) {
  if (!hasBranches(auth, [branchId])) throw forbidden('You do not have access to that branch.');
  const branches = await accessRepository.listActiveBranches();
  if (!branches.some((b) => b.id === branchId)) {
    throw badRequest('Unknown or inactive branch.', [{ path: 'branchId', message: 'Unknown or inactive branch.' }]);
  }
  const { id, token } = await insertAgent({ name, branchId, actorUserId: auth.user.id });
  return { agent: await loadVisible(auth, id), token };
}

/** Locks a visible, active agent inside `trx`. */
async function lockActive(trx, auth, id) {
  const locked = await agentRepository.lock(trx, id);
  if (!locked || !hasBranches(auth, [locked.branch_id])) throw notFound('Agent not found.');
  if (!locked.is_active) throw conflict('This agent has been revoked. Add a new agent instead.');
  return locked;
}

/** Issues a new token; the old one stops working immediately. */
export async function rotateToken(auth, id) {
  const token = generateAgentToken();
  const fields = tokenFields(token);
  await db.transaction(async (trx) => {
    const locked = await lockActive(trx, auth, id);
    await agentRepository.replaceToken(trx, id, fields);
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'agent.token_rotated',
        entityType: 'agent',
        entityId: id,
        branchId: locked.branch_id,
        details: { name: locked.name, tokenPrefix: { from: locked.token_prefix, to: fields.tokenPrefix } },
      },
      trx,
    );
  });
  return { agent: await loadVisible(auth, id), token };
}

/** Permanently disables the agent's token. */
export async function revokeAgent(auth, id) {
  await db.transaction(async (trx) => {
    const locked = await lockActive(trx, auth, id);
    await agentRepository.revoke(trx, id);
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'agent.revoked',
        entityType: 'agent',
        entityId: id,
        branchId: locked.branch_id,
        details: { name: locked.name, tokenPrefix: locked.token_prefix },
      },
      trx,
    );
  });
  return loadVisible(auth, id);
}

export async function listBills(auth, agentId, { search, page, pageSize }) {
  await loadVisible(auth, agentId);
  const { items, total } = await agentBillRepository.listForAgent({
    agentId,
    search,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, page, pageSize, total };
}

export async function getBill(auth, billId) {
  const bill = await agentBillRepository.findById(billId);
  if (!bill || !hasBranches(auth, [bill.branch.id])) throw notFound('Bill not found.');
  return bill;
}
