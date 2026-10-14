import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { analyzeRows, mapColumns, planCustomerChange } from '../src/services/contactImport/analyzeRows.js';
import { cellToText, detectFileType, parseContactFile } from '../src/services/contactImport/parseFile.js';
import { normalizeIndianMobile } from '../src/utils/phone.js';
import { createCustomerSchema, updateCustomerSchema } from '../src/validators/customerValidators.js';

const CENTRAL = 1;
const SPEEDWELL = 2;

describe('normalizeIndianMobile', () => {
  it('accepts common Indian formats', () => {
    for (const input of ['9876543210', '98765 43210', '+91 98765-43210', '919876543210', '09876543210', '0091 9876543210', 9876543210]) {
      assert.deepEqual(normalizeIndianMobile(input), { ok: true, value: '+919876543210' }, String(input));
    }
  });

  it('rejects landlines, short numbers, letters and multiple numbers', () => {
    for (const input of ['', null, '0281 2345678', '12345', '5876543210', '98765abc10', '9876543210 / 9123456789']) {
      assert.equal(normalizeIndianMobile(input).ok, false, String(input));
    }
  });
});

describe('customer validators', () => {
  it('normalizes mobile and blanks', () => {
    const parsed = createCustomerSchema.parse({ fullName: ' Rishit ', mobile: '98765 43210', address: '', branchIds: [1, 1] });
    assert.deepEqual(parsed, { fullName: 'Rishit', mobile: '+919876543210', address: null, branchIds: [1] });
  });

  it('requires a branch and a valid mobile', () => {
    assert.equal(createCustomerSchema.safeParse({ fullName: 'A', mobile: '123', branchIds: [1] }).success, false);
    assert.equal(createCustomerSchema.safeParse({ fullName: 'A', mobile: '9876543210', branchIds: [] }).success, false);
  });

  it('keeps omitted fields out of partial updates but lets them be cleared', () => {
    assert.deepEqual(updateCustomerSchema.parse({ notes: 'VIP' }), { notes: 'VIP' });
    assert.deepEqual(updateCustomerSchema.parse({ address: '' }), { address: null });
    assert.equal(updateCustomerSchema.safeParse({}).success, false);
  });
});

describe('import column mapping', () => {
  it('recognises common header spellings and reports ignored columns', () => {
    const { columns, ignored } = mapColumns(['Patient Name', 'Mobile No.', 'ADDRESS', 'Dr. Name', 'Balance']);
    assert.deepEqual(columns, { fullName: 0, mobile: 1, address: 2, usualDoctor: 3 });
    assert.deepEqual(ignored, ['Balance']);
  });

  it('requires name and mobile columns', () => {
    assert.throws(() => mapColumns(['Name', 'Address']), { status: 400, message: /Mobile/ });
  });

  it('rejects two columns for the same field', () => {
    assert.throws(() => mapColumns(['Name', 'Mobile', 'Phone']), { status: 400 });
  });
});

describe('import row analysis', () => {
  const columns = { fullName: 0, mobile: 1, address: 2 };
  const rows = [
    { rowNumber: 2, cells: ['Rishit Bhai', '98765 43210', 'Rajkot'] },
    { rowNumber: 3, cells: ['No Phone', '', 'Rajkot'] },
    { rowNumber: 4, cells: ['Rishit again', '+919876543210', ''] },
    { rowNumber: 5, cells: ['', '9123456789', ''] },
  ];

  it('marks invalid rows and in-file duplicates, keeping the first occurrence', () => {
    const result = analyzeRows(rows, columns);
    assert.deepEqual(
      result.map((r) => r.status),
      ['valid', 'invalid', 'duplicate', 'invalid'],
    );
    assert.equal(result[0].mobile, '+919876543210');
    assert.match(result[1].errors[0].message, /Mobile/);
    assert.match(result[2].errors[0].message, /row 2/);
    assert.match(result[3].errors[0].message, /Name/);
  });
});

describe('planCustomerChange', () => {
  const existing = { id: '7', fullName: 'Rishit', address: 'Rajkot', usualDoctor: null, branchIds: [CENTRAL] };

  it('creates customers that do not exist', () => {
    assert.equal(planCustomerChange(undefined, { fullName: 'A' }, CENTRAL).status, 'new');
  });

  it('updates non-empty imported values and links the new branch', () => {
    const plan = planCustomerChange(existing, { fullName: 'Rishit Bhai', address: null, usualDoctor: 'M.O Govt Hospital' }, SPEEDWELL);
    assert.equal(plan.status, 'update');
    assert.equal(plan.linkBranch, true);
    assert.deepEqual(Object.keys(plan.changes).sort(), ['branchAdded', 'fullName', 'usualDoctor']);
    assert.equal(plan.changes.address, undefined, 'blank cells never clear stored data');
  });

  it('reports unchanged when nothing differs', () => {
    const plan = planCustomerChange(existing, { fullName: 'Rishit', address: 'Rajkot', usualDoctor: null }, CENTRAL);
    assert.deepEqual(plan, { status: 'unchanged', changes: null, linkBranch: false });
  });
});

describe('file parsing', () => {
  it('checks file type against content', () => {
    assert.equal(detectFileType('a.csv', Buffer.from('Name,Mobile')), 'csv');
    assert.throws(() => detectFileType('a.xlsx', Buffer.from('Name,Mobile')), { status: 400 });
    assert.throws(() => detectFileType('a.xls', Buffer.from('x')), { status: 400 });
    assert.throws(() => detectFileType('a.pdf', Buffer.from('x')), { status: 400 });
  });

  it('keeps large numeric cells as plain digits', () => {
    assert.equal(cellToText(9876543210), '9876543210');
    assert.equal(cellToText({ richText: [{ text: 'Ris' }, { text: 'hit' }] }), 'Rishit');
    assert.equal(cellToText({ formula: 'A1', result: 919876543210 }), '919876543210');
  });

  it('parses CSV with BOM and skips blank lines, keeping source row numbers', async () => {
    const csv = '﻿Name,Mobile\r\nRishit,9876543210\r\n,\r\n"Shah, Amit",9123456789\r\n';
    const { fileType, header, dataRows } = await parseContactFile('contacts.csv', Buffer.from(csv));
    assert.equal(fileType, 'csv');
    assert.deepEqual(header, ['Name', 'Mobile']);
    assert.deepEqual(dataRows, [
      { rowNumber: 2, cells: ['Rishit', '9876543210'] },
      { rowNumber: 4, cells: ['Shah, Amit', '9123456789'] },
    ]);
  });

  it('parses the first sheet of an xlsx workbook, including numeric phones', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Name', 'Mobile']);
    sheet.addRow(['Rishit', 9876543210]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const { fileType, dataRows } = await parseContactFile('contacts.xlsx', buffer);
    assert.equal(fileType, 'xlsx');
    assert.deepEqual(dataRows, [{ rowNumber: 2, cells: ['Rishit', '9876543210'] }]);
  });

  it('rejects files with no data rows', async () => {
    await assert.rejects(parseContactFile('a.csv', Buffer.from('Name,Mobile\n')), { status: 400 });
  });
});
