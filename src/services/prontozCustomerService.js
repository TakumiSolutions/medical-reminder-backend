import { hasBranches } from '../config/permissions.js';
import { prontozBranchCodes, prontozDbFor } from '../db/prontozDb.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import * as prontozCustomerRepository from '../repositories/prontozCustomerRepository.js';
import { AppError, badRequest, forbidden } from '../utils/errors.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const unavailable = () =>
  new AppError(503, 'SOURCE_UNAVAILABLE', 'Could not read the ProntoZ export database. Check that it is running.');

/** Branches with a configured ProntoZ export that the caller has access to. */
export async function listSources(auth) {
  const codes = new Set(prontozBranchCodes());
  const branches = await accessRepository.listActiveBranches();
  return branches.filter((b) => codes.has(b.code) && hasBranches(auth, [b.id]));
}

/** Each branch has its own ProntoZ data; users only see the branches they belong to. */
async function resolveSource(auth, branchId) {
  const branch = (await accessRepository.listActiveBranches()).find((b) => b.id === branchId);
  if (!branch) throw badRequest('Unknown or inactive branch.');
  if (!hasBranches(auth, [branch.id])) throw forbidden('You do not have access to that branch.');
  const conn = prontozDbFor(branch.code);
  if (!conn) throw new AppError(503, 'NOT_CONFIGURED', `No ProntoZ export is configured for ${branch.name}.`);
  return { branch, conn };
}

async function run(query) {
  try {
    return await query();
  } catch (error) {
    console.error('ProntoZ export query failed:', error.code ?? error.message);
    throw unavailable();
  }
}

function toCustomer(row, details, cloudByMobile, branchId) {
  const phone = row.Phone?.trim() || null;
  const normalized = phone ? normalizeIndianMobile(phone) : null;
  const mobile = normalized?.ok ? normalized.value : null;
  const cloud = mobile ? cloudByMobile.get(mobile) : undefined;
  const atThisBranch = Boolean(cloud?.branchIds.includes(branchId));
  return {
    phone,
    mobile,
    mobileStatus: !phone ? 'missing' : normalized.ok ? 'valid' : 'invalid',
    patient: row.Patient,
    address: row.Address,
    bills: row.Bills,
    items: row.Items,
    totalSpend: row.TotalSpend === null ? null : Number(row.TotalSpend),
    firstBill: row.FirstBill,
    lastBill: row.LastBill,
    lastBillDoctor: details?.doctor ?? null,
    lastBillMedicines: details?.medicines ?? [],
    // Already a cloud customer at this branch (cannot be added again).
    customerId: atThisBranch ? cloud.id : null,
    // A cloud customer at another branch only; adding links them to this branch.
    customerAtOtherBranch: Boolean(cloud) && !atThisBranch,
  };
}

export async function listCustomers(auth, { branchId, search, mobileStatus, medicine, page, pageSize }) {
  const { branch, conn } = await resolveSource(auth, branchId);

  const { result, details } = await run(async () => {
    const listed = await prontozCustomerRepository.list(conn, {
      search,
      mobileStatus,
      medicine,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { result: listed, details: await prontozCustomerRepository.lastBillDetails(conn, listed.rows) };
  });

  const mobiles = result.rows
    .map((row) => normalizeIndianMobile(row.Phone?.trim() ?? ''))
    .filter((n) => n.ok)
    .map((n) => n.value);
  const cloudByMobile = await customerRepository.findByMobiles([...new Set(mobiles)]);

  return {
    items: result.rows.map((row) =>
      toCustomer(row, details.get(prontozCustomerRepository.customerKey(row)), cloudByMobile, branch.id),
    ),
    counts: result.counts,
    branch,
    page,
    pageSize,
    total: result.total,
  };
}

export async function listMedicines(auth, { branchId }) {
  const { conn } = await resolveSource(auth, branchId);
  return run(() => prontozCustomerRepository.listLastBillMedicines(conn));
}
