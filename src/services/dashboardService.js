import { env } from '../config/env.js';
import { hasBranches, PERMISSIONS } from '../config/permissions.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as dashboardRepository from '../repositories/dashboardRepository.js';
import { dayBoundsUtc, todayIn } from '../utils/dates.js';

const EMPTY = {
  customers: { total: 0 },
  reminders: { dueToday: 0, active: 0, awaitingResponse: 0, orderedToday: 0, refusedToday: 0 },
  deliveries: { toDispatch: 0, readyForPickup: 0, outForDelivery: 0, deliveredToday: 0, failed: 0 },
};

const sumSection = (sections) =>
  Object.fromEntries(Object.keys(sections[0]).map((key) => [key, sections.reduce((sum, s) => sum + s[key], 0)]));

/**
 * Today's figures per branch the caller can access, with a total when there is more
 * than one. Each section is included only if the caller can see that page.
 */
export async function getDashboard(auth) {
  const today = todayIn(env.APP_TIMEZONE);
  const day = { today, ...dayBoundsUtc(today, env.APP_TIMEZONE) };
  const branches = (await accessRepository.listActiveBranches()).filter((b) => hasBranches(auth, [b.id]));
  const ids = branches.map((b) => b.id);

  const sections = {
    customers: auth.permissions.has(PERMISSIONS.CUSTOMERS_READ),
    reminders: auth.permissions.has(PERMISSIONS.REMINDERS_READ),
    deliveries: auth.permissions.has(PERMISSIONS.DELIVERIES_READ),
  };
  const visible = Object.keys(sections).filter((key) => sections[key]);

  const [customers, reminders, deliveries] =
    ids.length === 0
      ? [new Map(), new Map(), new Map()]
      : await Promise.all([
          sections.customers ? dashboardRepository.customerCounts(ids) : new Map(),
          sections.reminders ? dashboardRepository.reminderCounts(ids, day) : new Map(),
          sections.deliveries ? dashboardRepository.deliveryCounts(ids, day) : new Map(),
        ]);
  const source = { customers, reminders, deliveries };

  const perBranch = branches.map((branch) => ({
    branch,
    ...Object.fromEntries(visible.map((key) => [key, source[key].get(branch.id) ?? EMPTY[key]])),
  }));
  let total = null;
  if (perBranch.length > 1) {
    total = Object.fromEntries(visible.map((key) => [key, sumSection(perBranch.map((b) => b[key]))]));
    // A customer of both branches is one person, so count distinct customers.
    if (sections.customers) total.customers = { total: await dashboardRepository.distinctCustomerCount(ids) };
  }

  return { today, sections: visible, branches: perBranch, total };
}
