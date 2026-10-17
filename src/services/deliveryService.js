import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as deliveryRepository from '../repositories/deliveryRepository.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { canTransition } from './deliveryRules.js';

const STATUS_LABEL = {
  pending: 'Pending',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const FINAL = new Set(['delivered', 'cancelled']);

export async function listDeliveries(auth, { status, mine, search, page, pageSize }) {
  const filters = { scopeBranchIds: auth.branchIds, assignedTo: mine ? auth.user.id : undefined, search };
  const [{ items, total }, counts] = await Promise.all([
    deliveryRepository.list({ ...filters, status, limit: pageSize, offset: (page - 1) * pageSize }),
    deliveryRepository.countByStatus(filters),
  ]);
  return { items, counts, page, pageSize, total };
}

async function loadVisible(auth, id, conn = db) {
  const delivery = await deliveryRepository.findById(id, conn);
  if (!delivery || !hasBranches(auth, [delivery.branch.id])) throw notFound('Delivery not found.');
  return delivery;
}

export const getDelivery = (auth, id) => loadVisible(auth, id);

/** Users of the delivery's branch who can be assigned. */
export async function listAssignees(auth, id) {
  const delivery = await loadVisible(auth, id);
  return deliveryRepository.listAssignableUsers(delivery.branch.id);
}

/** Assigns (or, with null, unassigns) the delivery person. */
export async function assign(auth, id, { userId }) {
  await db.transaction(async (trx) => {
    const locked = await deliveryRepository.lock(trx, id);
    if (!locked || !hasBranches(auth, [locked.branch_id])) throw notFound('Delivery not found.');
    if (FINAL.has(locked.status)) throw conflict(`This delivery is ${STATUS_LABEL[locked.status].toLowerCase()}.`);
    if (String(locked.assigned_to ?? '') === String(userId ?? '')) return;

    let assignee = null;
    if (userId) {
      assignee = (await deliveryRepository.listAssignableUsers(locked.branch_id, trx)).find((u) => u.id === userId);
      if (!assignee) {
        throw badRequest('Choose an active user of this branch.', [{ path: 'userId', message: 'Not a user of this branch.' }]);
      }
    }
    await deliveryRepository.assign(trx, id, userId);
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'delivery.assigned',
        entityType: 'customer',
        entityId: locked.customer_id,
        branchId: locked.branch_id,
        details: { assignedTo: assignee?.fullName ?? 'Nobody' },
      },
      trx,
    );
  });
  return loadVisible(auth, id);
}

/** Moves the delivery to its next status; failing needs a reason. */
export async function changeStatus(auth, id, { status, note }) {
  await db.transaction(async (trx) => {
    const locked = await deliveryRepository.lock(trx, id);
    if (!locked || !hasBranches(auth, [locked.branch_id])) throw notFound('Delivery not found.');
    if (locked.status === status) throw conflict(`Already ${STATUS_LABEL[status].toLowerCase()}.`);
    if (!canTransition(locked.method, locked.status, status)) {
      throw conflict(`Cannot change from ${STATUS_LABEL[locked.status]} to ${STATUS_LABEL[status]}.`);
    }
    await deliveryRepository.changeStatus(trx, id, { from: locked.status, to: status, note, userId: auth.user.id });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'delivery.status_changed',
        entityType: 'customer',
        entityId: locked.customer_id,
        branchId: locked.branch_id,
        details: { status: { from: STATUS_LABEL[locked.status], to: STATUS_LABEL[status] }, ...(note && { note }) },
      },
      trx,
    );
  });
  return loadVisible(auth, id);
}
