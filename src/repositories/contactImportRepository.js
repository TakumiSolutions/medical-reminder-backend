import { db } from '../db/knex.js';

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

function toImport(row) {
  return {
    id: String(row.id),
    branch: { id: row.branch_id, name: row.branch_name },
    fileName: row.file_name,
    fileType: row.file_type,
    status: row.status,
    columnMapping: parseJson(row.column_mapping),
    summary: parseJson(row.summary),
    uploadedBy: row.uploader_id ? { id: String(row.uploader_id), fullName: row.uploader_name } : null,
    finishedBy: row.finisher_id ? { id: String(row.finisher_id), fullName: row.finisher_name } : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function importsQuery(conn = db) {
  return conn('contact_imports')
    .join('branches', 'branches.id', 'contact_imports.branch_id')
    .leftJoin('users as uploader', 'uploader.id', 'contact_imports.uploaded_by')
    .leftJoin('users as finisher', 'finisher.id', 'contact_imports.finished_by')
    .select(
      'contact_imports.*',
      'branches.name as branch_name',
      'uploader.id as uploader_id',
      'uploader.full_name as uploader_name',
      'finisher.id as finisher_id',
      'finisher.full_name as finisher_name',
    );
}

export async function create(conn, { branchId, fileName, fileType, columnMapping, summary, userId }) {
  const [id] = await conn('contact_imports').insert({
    branch_id: branchId,
    file_name: fileName,
    file_type: fileType,
    column_mapping: JSON.stringify(columnMapping),
    summary: JSON.stringify(summary),
    uploaded_by: userId,
  });
  return String(id);
}

export async function insertRows(conn, importId, rows) {
  const values = rows.map((r) => ({
    import_id: importId,
    source_row: r.rowNumber,
    status: r.status,
    mobile: r.mobile ?? null,
    data: r.data ? JSON.stringify(r.data) : null,
    raw: JSON.stringify(r.raw),
    errors: r.errors ? JSON.stringify(r.errors) : null,
    changes: r.changes ? JSON.stringify(r.changes) : null,
    customer_id: r.customerId ?? null,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await conn('contact_import_rows').insert(values.slice(i, i + 500));
  }
}

export async function findById(id, conn = db) {
  const row = await importsQuery(conn).where('contact_imports.id', id).first();
  return row ? toImport(row) : null;
}

export async function lockById(conn, id) {
  return conn('contact_imports').where({ id }).forUpdate().first('id');
}

export async function list({ scopeBranchIds, limit, offset }) {
  const query = db('contact_imports');
  if (scopeBranchIds) query.whereIn('contact_imports.branch_id', scopeBranchIds);
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await importsQuery()
    .modify((q) => scopeBranchIds && q.whereIn('contact_imports.branch_id', scopeBranchIds))
    .orderBy('contact_imports.id', 'desc')
    .limit(limit)
    .offset(offset);
  return { items: rows.map(toImport), total: Number(total) };
}

export async function listRows(importId, { statuses, limit, offset }) {
  const query = db('contact_import_rows').where({ import_id: importId });
  if (statuses?.length) query.whereIn('status', statuses);
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query.select('*').orderBy('source_row').limit(limit).offset(offset);
  return {
    items: rows.map((r) => ({
      rowNumber: r.source_row,
      status: r.status,
      mobile: r.mobile,
      data: parseJson(r.data),
      raw: parseJson(r.raw),
      errors: parseJson(r.errors),
      changes: parseJson(r.changes),
      customerId: r.customer_id ? String(r.customer_id) : null,
    })),
    total: Number(total),
  };
}

/** Rows that passed validation in the preview, i.e. candidates to apply. */
export async function listApplicableRows(conn, importId) {
  const rows = await conn('contact_import_rows')
    .where({ import_id: importId })
    .whereIn('status', ['new', 'update', 'unchanged'])
    .select('id', 'source_row', 'mobile', 'data')
    .orderBy('source_row');
  return rows.map((r) => ({ id: r.id, rowNumber: r.source_row, mobile: r.mobile, data: parseJson(r.data) }));
}

/** Records what applying each row actually did. */
export async function updateRowOutcomes(conn, outcomes) {
  for (const o of outcomes) {
    await conn('contact_import_rows')
      .where({ id: o.id })
      .update({
        status: o.status,
        changes: o.changes ? JSON.stringify(o.changes) : null,
        customer_id: o.customerId,
      });
  }
}

export async function finish(conn, id, { status, summary, userId }) {
  await conn('contact_imports')
    .where({ id })
    .update({
      status,
      ...(summary && { summary: JSON.stringify(summary) }),
      finished_by: userId,
      finished_at: conn.fn.now(),
    });
}
