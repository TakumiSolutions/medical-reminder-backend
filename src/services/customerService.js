import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const MOBILE_TAKEN = 'Another customer already has this mobile number.';
const EDITABLE_FIELDS = ['fullName', 'mobile', 'address', 'usualDoctor', 'notes'];

/** Customers are visible to users with access to at least one of their branches. */
function isVisibleTo(auth, customer) {
  if (auth.branchIds === null) return true;
  const own = new Set(auth.branchIds);
  return customer.branches.some((b) => own.has(b.id));
}

/** Audit entries tied to a single branch are only shown to users of that branch. */
const auditBranch = (branchIds) => (branchIds.length === 1 ? branchIds[0] : null);

async function assertAssignableBranches(auth, branchIds, conn) {
  const active = new Set((await accessRepository.listActiveBranches(conn)).map((b) => b.id));
  if (branchIds.some((id) => !active.has(id))) {
    throw badRequest('Unknown or inactive branch.', [{ path: 'branchIds', message: 'Unknown or inactive branch.' }]);
  }
  if (!hasBranches(auth, branchIds)) throw forbidden('You can only use branches you have access to.');
}

export async function listCustomers(auth, { search, branchId, page, pageSize }) {
  if (branchId && !hasBranches(auth, [branchId])) throw forbidden('You do not have access to that branch.');
  const { items, total } = await customerRepository.list({
    search,
    branchId,
    scopeBranchIds: auth.branchIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, page, pageSize, total };
}

export async function getCustomer(auth, id) {
  const customer = await customerRepository.findById(id);
  if (!customer || !isVisibleTo(auth, customer)) throw notFound('Customer not found.');
  return customer;
}

/**
 * Creates a customer. If the mobile number already belongs to a customer, that customer
 * is linked to the requested branches instead (one record per person across branches);
 * their stored details are left as they are.
 * @returns {{ customer, existed: boolean }}
 */
export async function createCustomer(auth, input) {
  const { branchIds, ...fields } = input;
  try {
    const { id, existed } = await db.transaction(async (trx) => {
      await assertAssignableBranches(auth, branchIds, trx);
      const links = (customerId) => branchIds.map((branchId) => ({ customerId, branchId }));

      const existingId = await customerRepository.findIdByMobile(fields.mobile, trx);
      if (existingId) {
        await customerRepository.lockById(trx, existingId);
        const existing = await customerRepository.findById(existingId, trx);
        const added = branchIds.filter((bid) => !existing.branches.some((b) => b.id === bid));
        if (added.length) {
          await customerRepository.addBranchLinks(trx, links(existingId), 'manual');
          await auditRepository.record(
            {
              actorUserId: auth.user.id,
              action: 'customer.branch_linked',
              entityType: 'customer',
              entityId: existingId,
              branchId: auditBranch(added),
              details: { branchIds: { from: existing.branches.map((b) => b.id), to: [...existing.branches.map((b) => b.id), ...added] } },
            },
            trx,
          );
        }
        return { id: existingId, existed: true };
      }

      const newId = await customerRepository.insert(trx, fields, auth.user.id);
      await customerRepository.addBranchLinks(trx, links(newId), 'manual');
      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'customer.created',
          entityType: 'customer',
          entityId: newId,
          branchId: auditBranch(branchIds),
          details: { ...fields, branchIds },
        },
        trx,
      );
      return { id: newId, existed: false };
    });
    return { customer: await customerRepository.findById(id), existed };
  } catch (error) {
    // Another request created the same mobile number at the same moment.
    if (error.code === 'ER_DUP_ENTRY') throw conflict('This customer was just added by someone else. Search for them and try again.');
    throw error;
  }
}

/**
 * Updates customer details and branch links. `branchIds` is the wanted set among the
 * caller's own branches; links to branches outside the caller's access are kept.
 */
export async function updateCustomer(auth, id, patch) {
  try {
    await db.transaction(async (trx) => {
      await customerRepository.lockById(trx, id);
      const customer = await customerRepository.findById(id, trx);
      if (!customer || !isVisibleTo(auth, customer)) throw notFound('Customer not found.');

      const changes = {};
      for (const field of EDITABLE_FIELDS) {
        if (patch[field] !== undefined && patch[field] !== customer[field]) {
          changes[field] = { from: customer[field], to: patch[field] };
        }
      }
      if (changes.mobile) {
        const owner = await customerRepository.findIdByMobile(patch.mobile, trx);
        if (owner && owner !== id) throw conflict(MOBILE_TAKEN, [{ path: 'mobile', message: MOBILE_TAKEN }]);
      }

      const current = customer.branches.map((b) => b.id);
      let added = [];
      let removed = [];
      if (patch.branchIds) {
        await assertAssignableBranches(auth, patch.branchIds, trx);
        const outOfScope = current.filter((bid) => !hasBranches(auth, [bid]));
        const next = [...new Set([...outOfScope, ...patch.branchIds])].sort((a, b) => a - b);
        if (next.length === 0) {
          throw badRequest('A customer must belong to at least one branch.', [
            { path: 'branchIds', message: 'Select at least one branch.' },
          ]);
        }
        added = next.filter((bid) => !current.includes(bid));
        removed = current.filter((bid) => !next.includes(bid));
        if (added.length || removed.length) changes.branchIds = { from: current, to: next };
      }

      if (Object.keys(changes).length === 0) return;

      const fieldChanges = Object.fromEntries(
        Object.keys(changes)
          .filter((field) => field !== 'branchIds')
          .map((field) => [field, patch[field]]),
      );
      if (Object.keys(fieldChanges).length) await customerRepository.update(trx, id, fieldChanges, auth.user.id);
      if (added.length) {
        await customerRepository.addBranchLinks(trx, added.map((branchId) => ({ customerId: id, branchId })), 'manual');
      }
      await customerRepository.removeBranchLinks(trx, id, removed);

      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          branchId: auditBranch(changes.branchIds?.to ?? current),
          details: changes,
        },
        trx,
      );
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict(MOBILE_TAKEN, [{ path: 'mobile', message: MOBILE_TAKEN }]);
    throw error;
  }
  return customerRepository.findById(id);
}
