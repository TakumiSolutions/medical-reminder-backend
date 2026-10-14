import { hasBranches } from '../../config/permissions.js';
import { db } from '../../db/knex.js';
import * as accessRepository from '../../repositories/accessRepository.js';
import * as auditRepository from '../../repositories/auditRepository.js';
import * as contactImportRepository from '../../repositories/contactImportRepository.js';
import * as customerRepository from '../../repositories/customerRepository.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { analyzeRows, mapColumns, planCustomerChange } from './analyzeRows.js';
import { parseContactFile } from './parseFile.js';

export const TEMPLATE_CSV = 'Name,Mobile,Address,Doctor\r\n';

const STATUSES = ['new', 'update', 'unchanged', 'invalid', 'duplicate'];

function summarize(rows) {
  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of rows) summary[row.status] += 1;
  return { total: rows.length, ...summary };
}

async function loadVisibleImport(auth, id, conn) {
  const record = await contactImportRepository.findById(id, conn);
  if (!record || !hasBranches(auth, [record.branch.id])) throw notFound('Import not found.');
  return record;
}

/** Validates the file and stores a preview. No customer is changed until commit. */
export async function previewImport(auth, { branchId, fileName, buffer }) {
  const branches = await accessRepository.listActiveBranches();
  if (!branches.some((b) => b.id === branchId)) throw badRequest('Unknown or inactive branch.');
  if (!hasBranches(auth, [branchId])) throw forbidden('You can only import into branches you have access to.');

  const { fileType, header, dataRows } = await parseContactFile(fileName, buffer);
  const { columns, mapping, ignored } = mapColumns(header);
  const analyzed = analyzeRows(dataRows, columns);

  const validMobiles = analyzed.filter((r) => r.status === 'valid').map((r) => r.mobile);
  const existing = await customerRepository.findByMobiles(validMobiles);
  const rows = analyzed.map((row) => {
    if (row.status !== 'valid') return row;
    const plan = planCustomerChange(existing.get(row.mobile), row.data, branchId);
    return { ...row, status: plan.status, changes: plan.changes, customerId: existing.get(row.mobile)?.id };
  });
  const summary = summarize(rows);

  const id = await db.transaction(async (trx) => {
    const importId = await contactImportRepository.create(trx, {
      branchId,
      fileName,
      fileType,
      columnMapping: { mapping, ignored },
      summary,
      userId: auth.user.id,
    });
    await contactImportRepository.insertRows(trx, importId, rows);
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'contact_import.uploaded',
        entityType: 'contact_import',
        entityId: importId,
        branchId,
        details: { fileName, ...summary },
      },
      trx,
    );
    return importId;
  });
  return contactImportRepository.findById(id);
}

/**
 * Applies a previewed import. Each row is re-checked against current data, so changes
 * made since the preview are respected. Safe to retry: a finished import is rejected.
 */
export async function commitImport(auth, id) {
  await db.transaction(async (trx) => {
    await contactImportRepository.lockById(trx, id);
    const record = await loadVisibleImport(auth, id, trx);
    if (record.status !== 'previewed') throw conflict(`This import has already been ${record.status}.`);
    const branchId = record.branch.id;

    const rows = await contactImportRepository.listApplicableRows(trx, id);
    const existing = await customerRepository.findByMobiles(
      rows.map((r) => r.mobile),
      { conn: trx, forUpdate: true },
    );

    const planned = rows.map((row) => ({ row, plan: planCustomerChange(existing.get(row.mobile), row.data, branchId) }));

    const created = planned.filter(({ plan }) => plan.status === 'new');
    const newIds = await customerRepository.insertMany(
      trx,
      created.map(({ row }) => ({ mobile: row.mobile, ...row.data })),
      auth.user.id,
    );

    const links = [];
    const outcomes = [];
    for (const { row, plan } of planned) {
      const customerId = plan.status === 'new' ? newIds.get(row.mobile) : existing.get(row.mobile).id;
      if (plan.status === 'update') {
        const fields = Object.fromEntries(
          Object.entries(plan.changes)
            .filter(([field]) => field !== 'branchAdded')
            .map(([field, change]) => [field, change.to]),
        );
        if (Object.keys(fields).length) await customerRepository.update(trx, customerId, fields, auth.user.id);
      }
      if (plan.linkBranch) links.push({ customerId, branchId });
      outcomes.push({ id: row.id, status: plan.status, changes: plan.changes, customerId });
    }
    await customerRepository.addBranchLinks(trx, links, 'import');
    await contactImportRepository.updateRowOutcomes(trx, outcomes);

    const applied = summarize(outcomes);
    const summary = { ...applied, total: record.summary.total, invalid: record.summary.invalid, duplicate: record.summary.duplicate };
    await contactImportRepository.finish(trx, id, { status: 'committed', summary, userId: auth.user.id });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'contact_import.committed',
        entityType: 'contact_import',
        entityId: id,
        branchId,
        details: { fileName: record.fileName, ...summary },
      },
      trx,
    );
  });
  return contactImportRepository.findById(id);
}

export async function cancelImport(auth, id) {
  await db.transaction(async (trx) => {
    await contactImportRepository.lockById(trx, id);
    const record = await loadVisibleImport(auth, id, trx);
    if (record.status !== 'previewed') throw conflict(`This import has already been ${record.status}.`);
    await contactImportRepository.finish(trx, id, { status: 'cancelled', userId: auth.user.id });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'contact_import.cancelled',
        entityType: 'contact_import',
        entityId: id,
        branchId: record.branch.id,
        details: { fileName: record.fileName },
      },
      trx,
    );
  });
  return contactImportRepository.findById(id);
}

export async function listImports(auth, { page, pageSize }) {
  const { items, total } = await contactImportRepository.list({
    scopeBranchIds: auth.branchIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, page, pageSize, total };
}

export const getImport = (auth, id) => loadVisibleImport(auth, id);

export async function listImportRows(auth, id, { statuses, page, pageSize }) {
  await loadVisibleImport(auth, id);
  const { items, total } = await contactImportRepository.listRows(id, {
    statuses,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, page, pageSize, total };
}
