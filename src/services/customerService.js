import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import { env } from '../config/env.js';
import { todayIn } from '../utils/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const MOBILE_TAKEN = 'Another customer already has this mobile number.';
const EDITABLE_FIELDS = ['fullName', 'mobile', 'address', 'usualDoctor', 'notes'];

/** Customers are visible to users with access to at least one of their branches. */
function isVisibleTo(auth, customer) {
  if (auth.branchIds === null) return true;
  const own = new Set(auth.branchIds);
  return customer.branches.some((b) => own.has(b.id));
}

/** Hides medicines recorded at branches the caller cannot see. */
function forViewer(auth, customer) {
  if (auth.branchIds === null) return customer;
  const own = new Set(auth.branchIds);
  return { ...customer, medicines: customer.medicines.filter((m) => own.has(m.branchId)) };
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

export async function listCustomers(auth, { search, branchId, medicine, page, pageSize }) {
  if (branchId && !hasBranches(auth, [branchId])) throw forbidden('You do not have access to that branch.');
  const { items, total } = await customerRepository.list({
    search,
    branchId,
    medicine,
    scopeBranchIds: auth.branchIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items: items.map((c) => forViewer(auth, c)), page, pageSize, total };
}

export async function getCustomer(auth, id) {
  const customer = await customerRepository.findById(id);
  if (!customer || !isVisibleTo(auth, customer)) throw notFound('Customer not found.');
  return forViewer(auth, customer);
}

/** Medicine names for the filter, limited to the caller's branches. */
export const listMedicineNames = (auth) => customerRepository.listMedicineNames(auth.branchIds);

/**
 * Creates a customer, or — if the mobile number already belongs to one — links that
 * customer to `branchIds` instead (one record per person across branches). An existing
 * customer's stored details are left as they are. Runs inside the caller's transaction.
 * @returns {{ id: string, existed: boolean }}
 */
async function createOrLinkCustomer(trx, auth, fields, branchIds) {
  await assertAssignableBranches(auth, branchIds, trx);
  const links = (customerId) => branchIds.map((branchId) => ({ customerId, branchId }));

  const existingId = await customerRepository.findIdByMobile(fields.mobile, trx);
  if (existingId) {
    await customerRepository.lockById(trx, existingId);
    const existing = await customerRepository.findById(existingId, trx);
    const current = existing.branches.map((b) => b.id);
    const added = branchIds.filter((bid) => !current.includes(bid));
    if (added.length) {
      await customerRepository.addBranchLinks(trx, links(existingId));
      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'customer.branch_linked',
          entityType: 'customer',
          entityId: existingId,
          branchId: auditBranch(added),
          details: { branchIds: { from: current, to: [...current, ...added] } },
        },
        trx,
      );
    }
    return { id: existingId, existed: true };
  }

  const newId = await customerRepository.insert(trx, fields, auth.user.id);
  await customerRepository.addBranchLinks(trx, links(newId));
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
}

const RACE_MESSAGE = 'This customer was just added by someone else. Search for them and try again.';

/**
 * Creates a customer, or links the existing customer with the same mobile number.
 * @returns {{ customer, existed: boolean }}
 */
export async function createCustomer(auth, input) {
  const { branchIds, ...fields } = input;
  try {
    const { id, existed } = await db.transaction((trx) => createOrLinkCustomer(trx, auth, fields, branchIds));
    return { customer: forViewer(auth, await customerRepository.findById(id)), existed };
  } catch (error) {
    // Another request created the same mobile number at the same moment.
    if (error.code === 'ER_DUP_ENTRY') throw conflict(RACE_MESSAGE);
    throw error;
  }
}

/**
 * Adds a customer from a branch's ProntoZ export, together with the chosen medicines for
 * that branch. A customer of another branch (same mobile) is linked to this branch and
 * gets the medicines; their details are not overwritten. Someone who is already a
 * customer at this branch is rejected — medicines are not added to existing customers.
 * @returns {{ customer, existed: boolean, medicinesAdded: string[] }}
 */
export async function addFromProntoz(auth, { branchId, medicines, lastBillDate, ...fields }) {
  if (lastBillDate > todayIn(env.APP_TIMEZONE)) {
    throw badRequest('The last bill date cannot be in the future.', [{ path: 'lastBillDate', message: 'Cannot be in the future.' }]);
  }
  try {
    const result = await db.transaction(async (trx) => {
      const existingId = await customerRepository.findIdByMobile(fields.mobile, trx);
      if (existingId) {
        await customerRepository.lockById(trx, existingId);
        const existing = await customerRepository.findById(existingId, trx);
        if (existing.branches.some((b) => b.id === branchId)) {
          throw conflict(`${existing.fullName} is already a customer at this branch.`);
        }
      }
      const { id, existed } = await createOrLinkCustomer(trx, auth, fields, [branchId]);
      const added = await customerRepository.addMedicines(trx, {
        customerId: id,
        branchId,
        medicines,
        lastBillDate,
        source: 'prontoz',
        userId: auth.user.id,
      });
      if (added.length) {
        await auditRepository.record(
          {
            actorUserId: auth.user.id,
            action: 'customer.medicines_added',
            entityType: 'customer',
            entityId: id,
            branchId,
            details: { medicines: added, lastBillDate, source: 'prontoz' },
          },
          trx,
        );
      }
      return { id, existed, medicinesAdded: added };
    });
    return { ...result, customer: forViewer(auth, await customerRepository.findById(result.id)) };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict(RACE_MESSAGE);
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
        await customerRepository.addBranchLinks(trx, added.map((branchId) => ({ customerId: id, branchId })));
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
  return forViewer(auth, await customerRepository.findById(id));
}
