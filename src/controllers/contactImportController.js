import * as contactImportService from '../services/contactImport/contactImportService.js';
import { badRequest } from '../utils/errors.js';

export async function upload(req, res) {
  if (!req.file) throw badRequest('Choose a file to import.', [{ path: 'file', message: 'Choose a file to import.' }]);
  // Browsers send the filename as UTF-8 bytes; busboy reads them as latin1.
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255);
  const record = await contactImportService.previewImport(req.auth, {
    branchId: req.body.branchId,
    fileName,
    buffer: req.file.buffer,
  });
  res.status(201).json({ import: record });
}

export async function list(req, res) {
  res.json(await contactImportService.listImports(req.auth, req.validatedQuery));
}

export async function get(req, res) {
  res.json({ import: await contactImportService.getImport(req.auth, req.params.id) });
}

export async function rows(req, res) {
  const { status, page, pageSize } = req.validatedQuery;
  res.json(await contactImportService.listImportRows(req.auth, req.params.id, { statuses: status, page, pageSize }));
}

export async function commit(req, res) {
  res.json({ import: await contactImportService.commitImport(req.auth, req.params.id) });
}

export async function cancel(req, res) {
  res.json({ import: await contactImportService.cancelImport(req.auth, req.params.id) });
}

export function template(_req, res) {
  res.attachment('contacts-template.csv').type('text/csv').send(contactImportService.TEMPLATE_CSV);
}
