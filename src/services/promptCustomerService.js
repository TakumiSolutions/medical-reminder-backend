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
async function resolveSource(auth, branchId, { mobile } = {}) {
  const branch = (await accessRepository.listActiveBranches()).find((b) => b.id === branchId);
  if (!branch) throw badRequest('Unknown or inactive branch.');
  if (!hasBranches(auth, [branch.id])) throw forbidden('You do not have access to that branch.');
  if ((await agentRepository.listActiveBranchIds()).has(branch.id)) {
    return { branch, kind: 'rxbridge', src: promptCustomerRepository.agentBillsSource(db, branch.id, { mobile }) };
  }
  const conn = promptDbFor(branch.code);
  if (!conn) throw new AppError(503, 'NOT_CONFIGURED', `No Prompt data is available for ${branch.name}.`);
  return { branch, kind: 'export', src: promptCustomerRepository.exportSource(conn, { mobile }) };
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
    // Prompt Rx user who made / last edited the bill, with shop times (RxBridge branches only).
    createdBy: row.CreatedBy || row.CreatedAt ? { name: row.CreatedBy ?? null, at: row.CreatedAt ?? null } : null,
    modifiedBy: row.ModifiedBy || row.ModifiedAt ? { name: row.ModifiedBy ?? null, at: row.ModifiedAt ?? null } : null,
    medicines: medicines ?? [],
    // RxBridge bill id (can be sent on WhatsApp) and its latest WhatsApp send.
    agentBillId: row.AgentBillId == null ? null : String(row.AgentBillId),
    whatsapp: row.WhatsappStatus ? { status: row.WhatsappStatus, sentAt: row.WhatsappSentAt ?? null } : null,
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

// Most bills listed per branch for one customer.
export const MAX_CUSTOMER_BILLS = 200;

/**
 * Every bill with `mobile` (+91XXXXXXXXXX) at the Prompt branches the caller can see, newest
 * first. A branch whose data cannot be read is reported in `unavailable` instead of failing.
 */
export async function listBillsForMobile(auth, mobile) {
  const branches = await listSources(auth);
  const results = await Promise.all(
    branches.map(async (branch) => {
      try {
        const { kind, src } = await resolveSource(auth, branch.id, { mobile });
        const { listed, medicines } = await run(kind, async () => {
          const rows = await promptCustomerRepository.list(src, { mobileStatus: 'all', limit: MAX_CUSTOMER_BILLS, offset: 0 });
          return { listed: rows, medicines: await promptCustomerRepository.billMedicines(src, rows.rows) };
        });
        return { branch, kind, listed, medicines };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return { branch, error: error.message };
      }
    }),
  );

  const remindersByCycle = await reminderRepository.loadReminders(
    results.flatMap((r) => r.listed?.rows.filter((row) => row.ReminderId).map((row) => row.ReminderId) ?? []),
  );
  const items = results
    .filter((r) => r.listed)
    .flatMap(({ branch, kind, listed, medicines }) =>
      listed.rows.map((row) => {
        const bill = toBill(row, medicines.get(String(row.BillKey)), new Map(), branch.id, remindersByCycle);
        // Fields about adding the patient as a customer do not apply here.
        delete bill.customerId;
        delete bill.customerAtOtherBranch;
        return { ...bill, billKey: `${branch.id}:${bill.billKey}`, branch: { id: branch.id, name: branch.name }, source: kind };
      }),
    )
    .sort((a, b) => (b.billDate ?? '').localeCompare(a.billDate ?? '') || (b.createdBy?.at ?? '').localeCompare(a.createdBy?.at ?? ''));

  return {
    items,
    // Branches with more bills than were listed.
    truncated: results.filter((r) => r.listed && r.listed.total > r.listed.rows.length).map((r) => r.branch.name),
    unavailable: results.filter((r) => r.error).map((r) => ({ branch: { id: r.branch.id, name: r.branch.name }, message: r.error })),
  };
}
