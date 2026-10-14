import { z } from 'zod';
import { customerFields } from '../../validators/customerValidators.js';
import { badRequest } from '../../utils/errors.js';

// Accepted header spellings per field, compared after lower-casing and removing
// everything except letters and digits ("Mobile No." -> "mobileno").
const HEADER_ALIASES = {
  fullName: ['name', 'patient', 'patientname', 'customer', 'customername', 'fullname'],
  mobile: [
    'mobile', 'mobileno', 'mobilenumber', 'mob', 'mobno', 'phone', 'phoneno', 'phonenumber',
    'contact', 'contactno', 'contactnumber', 'whatsapp', 'whatsappno', 'whatsappnumber', 'cell', 'cellno',
  ],
  address: ['address', 'addr', 'patientaddress', 'customeraddress'],
  usualDoctor: ['doctor', 'doctorname', 'dr', 'drname', 'usualdoctor', 'refdoctor', 'referringdoctor'],
};

export const FIELD_LABELS = {
  fullName: 'Name',
  mobile: 'Mobile',
  address: 'Address',
  usualDoctor: 'Doctor',
};

const REQUIRED_FIELDS = ['fullName', 'mobile'];

const normalizeHeader = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Maps header cells to customer fields.
 * @returns {{ columns: Record<string, number>, mapping: Record<string, string>, ignored: string[] }}
 */
export function mapColumns(header) {
  const columns = {};
  const ignored = [];

  header.forEach((cell, index) => {
    if (cell === '') return;
    const key = normalizeHeader(cell);
    const field = Object.keys(HEADER_ALIASES).find((f) => HEADER_ALIASES[f].includes(key));
    if (!field) {
      ignored.push(cell);
      return;
    }
    if (field in columns) {
      throw badRequest(
        `Both "${header[columns[field]]}" and "${cell}" look like the ${FIELD_LABELS[field]} column. Keep only one.`,
      );
    }
    columns[field] = index;
  });

  const missing = REQUIRED_FIELDS.filter((field) => !(field in columns));
  if (missing.length) {
    const names = missing.map((f) => FIELD_LABELS[f]).join(' and ');
    throw badRequest(
      `Could not find the ${names} column. The first row must be a header row, e.g. Name, Mobile, Address, Doctor.`,
      [{ path: 'file', message: `Headers found: ${header.filter(Boolean).join(', ') || 'none'}` }],
    );
  }

  const mapping = Object.fromEntries(Object.entries(columns).map(([field, index]) => [field, header[index]]));
  return { columns, mapping, ignored };
}

const rowSchema = z.object({
  fullName: customerFields.fullName,
  mobile: customerFields.mobile,
  address: customerFields.address,
  usualDoctor: customerFields.usualDoctor,
});

/**
 * Validates data rows and flags repeated mobile numbers within the file.
 * The first row for a mobile number wins; later rows are reported as duplicates.
 * @returns {Array<{ rowNumber, raw, status: 'valid'|'invalid'|'duplicate', data?, mobile?, errors? }>}
 */
export function analyzeRows(dataRows, columns) {
  const firstRowByMobile = new Map();

  return dataRows.map(({ rowNumber, cells }) => {
    const raw = Object.fromEntries(Object.entries(columns).map(([field, index]) => [field, cells[index] ?? '']));
    const result = rowSchema.safeParse(raw);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path[0],
        message: `${FIELD_LABELS[issue.path[0]] ?? 'Row'}: ${issue.message}`,
      }));
      return { rowNumber, raw, status: 'invalid', errors };
    }

    const data = {
      fullName: result.data.fullName,
      address: result.data.address ?? null,
      usualDoctor: result.data.usualDoctor ?? null,
    };
    const { mobile } = result.data;

    if (firstRowByMobile.has(mobile)) {
      return {
        rowNumber,
        raw,
        mobile,
        data,
        status: 'duplicate',
        errors: [{ field: 'mobile', message: `Same mobile number as row ${firstRowByMobile.get(mobile)}.` }],
      };
    }
    firstRowByMobile.set(mobile, rowNumber);
    return { rowNumber, raw, mobile, data, status: 'valid' };
  });
}

/**
 * Decides what importing `data` into `branchId` does to an existing customer.
 * Non-empty imported values replace stored ones; blank cells never clear stored data.
 * Notes are staff-entered and never imported.
 * @returns {{ status: 'new'|'update'|'unchanged', changes: Record<string, {from, to}> | null, linkBranch: boolean }}
 */
export function planCustomerChange(existing, data, branchId) {
  if (!existing) return { status: 'new', changes: null, linkBranch: true };

  const changes = {};
  for (const field of ['fullName', 'address', 'usualDoctor']) {
    const next = data[field];
    if (next && next !== existing[field]) changes[field] = { from: existing[field], to: next };
  }
  const linkBranch = !existing.branchIds.includes(branchId);
  if (linkBranch) changes.branchAdded = { from: null, to: branchId };

  const changed = Object.keys(changes).length > 0;
  return { status: changed ? 'update' : 'unchanged', changes: changed ? changes : null, linkBranch };
}
