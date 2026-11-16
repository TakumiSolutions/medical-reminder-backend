import { hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import { promptBranchCodes, promptDbFor } from '../db/promptDb.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as agentRepository from '../repositories/agentRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import * as promptCustomerRepository from '../repositories/promptCustomerRepository.js';
import * as reminderRepository from '../repositories/reminderRepository.js';
import { AppError, badRequest, forbidden } from '../utils/errors.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const UNAVAILABLE = {
  rxbridge: 'Could not read the bills sent by RxBridge. Try again shortly.',
  export: 'Could not read the Prompt export database. Check that it is running.',
};

/** Branches with Prompt data (an RxBridge agent or a configured export) that the caller can see. */
export async function listSources(auth) {
  const codes = new Set(promptBranchCodes());
  const agentBranchIds = await agentRepository.listActiveBranchIds();
  const branches = await accessRepository.listActiveBranches();
  return branches.filter((b) => (agentBranchIds.has(b.id) || codes.has(b.code)) && hasBranches(auth, [b.id]));
}

/**
 * Each branch has its own Prompt data; users only see the branches they belong to.
 * A branch with an active RxBridge agent uses the bills it sends; otherwise its export database.
 */
async function resolveSource(auth, branchId) {
  const branch = (await accessRepository.listActiveBranches()).find((b) => b.id === branchId);
  if (!branch) throw badRequest('Unknown or inactive branch.');
  if (!hasBranches(auth, [branch.id])) throw forbidden('You do not have access to that branch.');
  if ((await agentRepository.listActiveBranchIds()).has(branch.id)) {
    return { branch, kind: 'rxbridge', src: promptCustomerRepository.agentBillsSource(db, branch.id) };
  }
  const conn = promptDbFor(branch.code);
  if (!conn) throw new AppError(503, 'NOT_CONFIGURED', `No Prompt data is available for ${branch.name}.`);
  return { branch, kind: 'export', src: promptCustomerRepository.exportSource(conn) };
}

async function run(kind, query) {
  try {
    return await query();
  } catch (error) {
    console.error(`Prompt ${kind} query failed:`, error.code ?? error.message);
    throw new AppError(503, 'SOURCE_UNAVAILABLE', UNAVAILABLE[kind]);
  }
}

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

function toBill(row, medicines, cloudByMobile, branchId, remindersByCycle) {
  const phone = row.Phone?.trim() || null;
  const normalized = phone ? normalizeIndianMobile(phone) : null;
  const mobile = normalized?.ok ? normalized.value : null;
  const cloud = mobile ? cloudByMobile.get(mobile) : undefined;
  const atThisBranch = Boolean(cloud?.branchIds.includes(branchId));
  return {
    billKey: String(row.BillKey),
    billNo: row.BillNo ?? null,
    billDate: row.BillDate,
    phone,
    mobile,
    mobileStatus: !phone ? 'missing' : normalized.ok ? 'valid' : 'invalid',
    patient: row.Patient,
    address: row.Address,
    doctor: row.Doctor ?? null,
    total: toNumber(row.Total),
    items: toNumber(row.Items),
    // Remark typed on the bill in Prompt Rx (RxBridge branches only).
    remarks: row.Remarks?.trim() || null,
    medicines: medicines ?? [],
    // Reminder created automatically from this bill's remark, with its dates.
    reminder: row.ReminderId
      ? {
          id: String(row.ReminderId),
          dates: (remindersByCycle.get(String(row.ReminderId)) ?? []).map((r) => ({ date: r.scheduledDate, status: r.status })),
        }
      : null,
    // Already a cloud customer at this branch (cannot be added again).
    customerId: atThisBranch ? cloud.id : null,
    // A cloud customer at another branch only; adding links them to this branch.
    customerAtOtherBranch: Boolean(cloud) && !atThisBranch,
  };
}

/** One row per bill, newest first. */
export async function listCustomers(auth, { branchId, search, mobileStatus, medicine, page, pageSize }) {
  const { branch, kind, src } = await resolveSource(auth, branchId);

  const { result, medicines } = await run(kind, async () => {
    const listed = await promptCustomerRepository.list(src, {
      search,
      mobileStatus,
      medicine,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { result: listed, medicines: await promptCustomerRepository.billMedicines(src, listed.rows) };
  });

  const mobiles = result.rows
    .map((row) => normalizeIndianMobile(row.Phone?.trim() ?? ''))
    .filter((n) => n.ok)
    .map((n) => n.value);
  const [cloudByMobile, remindersByCycle] = await Promise.all([
    customerRepository.findByMobiles([...new Set(mobiles)]),
    reminderRepository.loadReminders(result.rows.filter((row) => row.ReminderId).map((row) => row.ReminderId)),
  ]);

  return {
    items: result.rows.map((row) => toBill(row, medicines.get(String(row.BillKey)), cloudByMobile, branch.id, remindersByCycle)),
    counts: result.counts,
    branch,
    // Where the list comes from: bills sent by RxBridge, or the Prompt export database.
    source: kind,
    page,
    pageSize,
    total: result.total,
  };
}

export async function listMedicines(auth, { branchId }) {
  const { kind, src } = await resolveSource(auth, branchId);
  return run(kind, () => promptCustomerRepository.listMedicines(src));
}
