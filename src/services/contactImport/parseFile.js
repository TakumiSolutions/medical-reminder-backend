import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../../utils/errors.js';

// Interim limits pending business confirmation.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 10_000;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Decides the file type from its extension and checks the content matches. */
export function detectFileType(fileName, buffer) {
  const extension = fileName.toLowerCase().split('.').pop();
  const isZip = buffer.subarray(0, 4).equals(ZIP_MAGIC);
  if (extension === 'xlsx') {
    if (!isZip) throw badRequest('The file is not a valid Excel (.xlsx) workbook.');
    return 'xlsx';
  }
  if (extension === 'csv') {
    if (isZip) throw badRequest('The file looks like an Excel workbook. Rename it to .xlsx or export as CSV.');
    return 'csv';
  }
  if (extension === 'xls') throw badRequest('Old Excel (.xls) files are not supported. Save the file as .xlsx or CSV.');
  throw badRequest('Upload an Excel (.xlsx) or CSV file.');
}

/** Converts an ExcelJS cell value to the text the user sees. */
export function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    // Avoid "9.87654321E9" for phone numbers stored as numbers.
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('result' in value) return cellToText(value.result); // formula
    if ('text' in value) return cellToText(value.text); // hyperlink
    if ('error' in value) return '';
  }
  return String(value);
}

async function readXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw badRequest('The Excel file could not be read. Check that it is not password-protected or damaged.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw badRequest('The Excel file has no worksheets.');

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cells[column - 1] = cellToText(cell.value).trim();
    });
    rows.push({ rowNumber, cells: Array.from(cells, (c) => c ?? '') });
  });
  return rows;
}

function readCsv(buffer) {
  let records;
  try {
    records = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false, trim: true });
  } catch (error) {
    throw badRequest(`The CSV file could not be read: ${error.message}`);
  }
  return records.map((cells, index) => ({ rowNumber: index + 1, cells }));
}

/**
 * Parses an uploaded file into its header and data rows.
 * Blank rows are dropped; row numbers match the line/row numbers in the source file.
 */
export async function parseContactFile(fileName, buffer) {
  const fileType = detectFileType(fileName, buffer);
  const allRows = (fileType === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer)).filter((row) =>
    row.cells.some((cell) => cell !== ''),
  );
  if (allRows.length === 0) throw badRequest('The file is empty.');

  const [header, ...dataRows] = allRows;
  if (dataRows.length === 0) throw badRequest('The file has a header row but no contacts.');
  if (dataRows.length > MAX_DATA_ROWS) {
    throw badRequest(`The file has ${dataRows.length} rows. The maximum per import is ${MAX_DATA_ROWS}.`);
  }
  return { fileType, header: header.cells, dataRows };
}
