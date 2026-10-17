import { env } from '../config/env.js';
import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import * as deliveryRepository from '../repositories/deliveryRepository.js';
import * as reminderRepository from '../repositories/reminderRepository.js';
import { todayIn } from '../utils/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { CANCELLABLE_STATUSES } from './deliveryRules.js';
import { planReminderDays } from './reminderRules.js';

const today = () => todayIn(env.APP_TIMEZONE);
const itemKey = (branchId, medicine) => `${branchId}|${medicine}`;

/** Loads a customer the caller can see, with medicines limited to the caller's branches. */
async function loadCustomer(auth, customerId, conn = db) {
  const customer = await customerRepository.findById(customerId, conn);
  const own = auth.branchIds === null ? null : new Set(auth.branchIds);
  if (!customer || (own && !customer.branches.some((b) => own.has(b.id)))) throw notFound('Customer not found.');
  return { ...customer, medicines: own ? customer.medicines.filter((m) => own.has(m.branchId)) : customer.medicines };
}

/** The customer's medicines (at the caller's branches) with any open reminder, for the dialog. */
export async function getScheduleOptions(auth, customerId) {
  const customer = await loadCustomer(auth, customerId);
  const now = today();
  const open = await reminderRepository.findOpenCycles(db, customerId, now);
  const branchNames = new Map(customer.branches.map((b) => [b.id, b.name]));
  return {
    today: now,
    customer: { id: customer.id, fullName: customer.fullName, mobile: customer.mobile },
    medicines: customer.medicines.map((m) => ({
      medicine: m.medicine,
      branch: { id: m.branchId, name: branchNames.get(m.branchId) ?? null },
      lastBillDate: m.lastBillDate,
      openReminder: open.get(itemKey(m.branchId, m.medicine)) ?? null,
    })),
  };
}

/**
 * Schedules one reminder cycle per item: days N, N+1, N+2 after the medicine's last bill
 * date. A `startDate` from the client is only used when no last bill date is stored.
 * @returns {Promise<string[]>} ids of the created cycles
 */
export async function schedule(auth, { customerId, items }) {
  const now = today();
  return db.transaction(async (trx) => {
    await customerRepository.lockById(trx, customerId);
    const customer = await loadCustomer(auth, customerId, trx);
    const medicines = new Map(customer.medicines.map((m) => [itemKey(m.branchId, m.medicine), m]));
    const open = await reminderRepository.findOpenCycles(trx, customerId, now);

    const created = [];
    for (const [index, item] of items.entries()) {
      const path = `items.${index}`;
      if (!hasBranches(auth, [item.branchId])) throw forbidden('You do not have access to that branch.');
      const stored = medicines.get(itemKey(item.branchId, item.medicine));
      if (!stored) throw badRequest(`${item.medicine} is not recorded for this customer at that branch.`, [{ path, message: 'Unknown medicine.' }]);
      if (open.has(itemKey(item.branchId, item.medicine))) {
        throw conflict(`${item.medicine} already has an active reminder.`, [{ path, message: 'Already has an active reminder.' }]);
      }

      const startDate = stored.lastBillDate ?? item.startDate;
      if (!startDate) {
        throw badRequest(`Enter the last bill date for ${item.medicine}.`, [{ path: `${path}.startDate`, message: 'Required.' }]);
      }
      if (startDate > now) {
        throw badRequest('The last bill date cannot be in the future.', [{ path: `${path}.startDate`, message: 'Cannot be in the future.' }]);
      }

      const days = planReminderDays({ startDate, intervalDays: item.intervalDays, today: now });
      if (days.every((d) => d.status === 'skipped')) {
        throw badRequest(`All reminder dates for ${item.medicine} have already passed. Choose more days.`, [
          { path: `${path}.intervalDays`, message: 'All dates have already passed.' },
        ]);
      }

      const cycleId = await reminderRepository.createCycle(trx, {
        customerId,
        branchId: item.branchId,
        medicine: item.medicine,
        startDate,
        intervalDays: item.intervalDays,
        userId: auth.user.id,
        days,
      });
      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'reminder.scheduled',
          entityType: 'customer',
          entityId: customerId,
          branchId: item.branchId,
          details: {
            medicine: item.medicine,
            intervalDays: item.intervalDays,
            startDate,
            dates: days.map((d) => `${d.scheduledDate}${d.status === 'skipped' ? ' (passed)' : ''}`),
          },
        },
        trx,
      );
      created.push(cycleId);
    }
    return created;
  });
}

export async function listCycles(auth, { view, search, branchId, page, pageSize }) {
  if (branchId && !hasBranches(auth, [branchId])) throw forbidden('You do not have access to that branch.');
  const now = today();
  const [{ items, total }, counts] = await Promise.all([
    reminderRepository.list({
      view,
      today: now,
      search,
      branchId,
      scopeBranchIds: auth.branchIds,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    reminderRepository.countByView({ today: now, scopeBranchIds: auth.branchIds }),
  ]);
  return { items, counts, today: now, page, pageSize, total };
}

/** Stops a reminder: reminders that have not gone out yet are cancelled. */
export async function cancelCycle(auth, id, { reason }) {
  const now = today();
  await db.transaction(async (trx) => {
    const cycle = await reminderRepository.lockCycle(trx, id);
    if (!cycle || !hasBranches(auth, [cycle.branch_id])) throw notFound('Reminder not found.');
    if (cycle.status === 'cancelled') throw conflict('This reminder has already been stopped.');
    if (cycle.outcome) throw conflict(`This customer is already marked as ${cycle.outcome}.`);
    const current = await reminderRepository.findById(id, now, trx);
    if (!current.reminders.some((r) => r.status === 'scheduled')) {
      throw conflict('This reminder has no upcoming dates left to stop.');
    }
    await reminderRepository.cancelCycle(trx, id, { userId: auth.user.id, reason });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'reminder.cancelled',
        entityType: 'customer',
        entityId: cycle.customer_id,
        branchId: cycle.branch_id,
        details: { medicine: cycle.medicine, ...(reason && { reason }) },
      },
      trx,
    );
  });
  return reminderRepository.findById(id, now);
}

const OUTCOME_LABEL = { ordered: 'Ordered', refused: 'Refused' };

/** Locks a cycle the caller may manage that has not been stopped. */
async function lockManageableCycle(trx, auth, id) {
  const cycle = await reminderRepository.lockCycle(trx, id);
  if (!cycle || !hasBranches(auth, [cycle.branch_id])) throw notFound('Reminder not found.');
  if (cycle.status === 'cancelled') throw conflict('This reminder was stopped, so no outcome can be recorded.');
  return cycle;
}

/**
 * Cancels the order's delivery when an Ordered outcome is undone. Not possible once the
 * delivery has left the store or been completed.
 */
async function cancelOrderDelivery(trx, auth, cycle) {
  const delivery = await deliveryRepository.lockOpenForReminder(trx, cycle.id);
  if (!delivery) return;
  if (!CANCELLABLE_STATUSES.includes(delivery.status)) {
    const state = delivery.status === 'delivered' ? 'already delivered' : 'already out for delivery';
    throw conflict(`This order is ${state}, so it cannot be changed.`);
  }
  await deliveryRepository.changeStatus(trx, delivery.id, {
    from: delivery.status,
    to: 'cancelled',
    note: 'Order undone',
    userId: auth.user.id,
  });
  await auditRepository.record(
    {
      actorUserId: auth.user.id,
      action: 'delivery.cancelled',
      entityType: 'customer',
      entityId: cycle.customer_id,
      branchId: cycle.branch_id,
      details: { medicine: cycle.medicine, reason: 'Order undone' },
    },
    trx,
  );
}

/** Creates the delivery for an order; optionally saves the address on the customer. */
async function createOrderDelivery(trx, auth, cycle, { method, address, saveAddress }) {
  await deliveryRepository.create(trx, {
    reminderCycleId: cycle.id,
    customerId: cycle.customer_id,
    branchId: cycle.branch_id,
    method,
    address,
    userId: auth.user.id,
  });
  await auditRepository.record(
    {
      actorUserId: auth.user.id,
      action: 'delivery.created',
      entityType: 'customer',
      entityId: cycle.customer_id,
      branchId: cycle.branch_id,
      details: { medicine: cycle.medicine, method, ...(method === 'delivery' && { address }) },
    },
    trx,
  );

  if (method === 'delivery' && saveAddress) {
    const customer = await customerRepository.findById(cycle.customer_id, trx);
    if (customer.address !== address) {
      await customerRepository.update(trx, cycle.customer_id, { address }, auth.user.id);
      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'customer.updated',
          entityType: 'customer',
          entityId: cycle.customer_id,
          branchId: cycle.branch_id,
          details: { address: { from: customer.address, to: address } },
        },
        trx,
      );
    }
  }
}

/**
 * Records that the customer ordered (with delivery or store pickup) or refused (with a
 * reason), or switches between the two. Remaining reminder dates are cancelled; an
 * order creates a delivery, and leaving Ordered cancels it.
 */
export async function recordOutcome(auth, id, { outcome, reason, delivery }) {
  const now = today();
  await db.transaction(async (trx) => {
    const cycle = await lockManageableCycle(trx, auth, id);
    if (cycle.outcome === outcome && (outcome === 'ordered' || cycle.outcome_reason === reason)) {
      throw conflict(`Already marked as ${OUTCOME_LABEL[outcome]}.`);
    }
    if (cycle.outcome === 'ordered') await cancelOrderDelivery(trx, auth, cycle);
    if (outcome === 'ordered') await createOrderDelivery(trx, auth, cycle, delivery);
    await reminderRepository.setOutcome(trx, id, {
      outcome,
      reason: outcome === 'refused' ? reason : null,
      userId: auth.user.id,
    });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: `reminder.${outcome}`,
        entityType: 'customer',
        entityId: cycle.customer_id,
        branchId: cycle.branch_id,
        details: {
          medicine: cycle.medicine,
          ...(outcome === 'refused' && { reason }),
          ...(cycle.outcome && { changedFrom: OUTCOME_LABEL[cycle.outcome] }),
        },
      },
      trx,
    );
  });
  return reminderRepository.findById(id, now);
}

/** Undoes an outcome: the customer goes back to the reminder list. */
export async function reopen(auth, id) {
  const now = today();
  await db.transaction(async (trx) => {
    const cycle = await lockManageableCycle(trx, auth, id);
    if (!cycle.outcome) throw conflict('This reminder has no outcome to undo.');
    if (cycle.outcome === 'ordered') await cancelOrderDelivery(trx, auth, cycle);
    await reminderRepository.clearOutcome(trx, id, now);
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'reminder.reopened',
        entityType: 'customer',
        entityId: cycle.customer_id,
        branchId: cycle.branch_id,
        details: { medicine: cycle.medicine, changedFrom: OUTCOME_LABEL[cycle.outcome] },
      },
      trx,
    );
  });
  return reminderRepository.findById(id, now);
}
