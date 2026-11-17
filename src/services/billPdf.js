// A copy of a Prompt Rx bill as a PDF, sent to the customer on WhatsApp.
// Built from what RxBridge sends (agent_bills / agent_bill_items).
import PDFDocument from 'pdfkit';

const MARGIN = 36;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

// Item table: [label, width, align]. Widths add up to the A4 text width (595 - 2 × 36 = 523).
const COLUMNS = [
  ['#', 18, 'right'],
  ['Product', 142, 'left'],
  ['Pack', 40, 'left'],
  ['Mfg', 50, 'left'],
  ['Batch', 50, 'left'],
  ['Exp', 32, 'left'],
  ['Qty', 30, 'right'],
  ['MRP', 40, 'right'],
  ['Rate', 40, 'right'],
  ['GST%', 31, 'right'],
  ['Amount', 50, 'right'],
];

const money = (value) => (value == null ? '' : Number(value).toFixed(2));
const qty = (value) => (value == null ? '' : String(Number(value)));

/** "YYYY-MM-DD" -> "DD-MM-YYYY", as printed on Prompt Rx bills. */
export function printedDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate ?? '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}

/** "Bill-CA-T-107953.pdf" for bill number "CA-T/107953". */
export function billFilename(billNo) {
  return `Bill-${String(billNo ?? 'copy').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'copy'}.pdf`;
}

function tableRow(doc, values, y, { font = FONT } = {}) {
  let x = MARGIN;
  let height = 0;
  doc.font(font).fontSize(8);
  COLUMNS.forEach(([, width, align], i) => {
    const text = values[i] ?? '';
    doc.text(text, x + 2, y, { width: width - 4, align, lineBreak: true });
    height = Math.max(height, doc.heightOfString(text, { width: width - 4 }));
    x += width;
  });
  return height + 4;
}

function tableHeader(doc, y) {
  const height = tableRow(doc, COLUMNS.map(([label]) => label), y, { font: BOLD });
  doc.moveTo(MARGIN, y + height - 1).lineTo(doc.page.width - MARGIN, y + height - 1).lineWidth(0.5).stroke();
  return y + height + 2;
}

/**
 * Renders the bill.
 * @param {{ storeName: string, headerLines: string[], branchName: string, bill: object }} input
 *   `bill`: { billNo, billDate, patientName, address, doctor, phone, total, items: [{ product,
 *   pack, mfg, batch, expiry, qty, mrp, rate, gstPct, gstAmt, amount }] }
 * @returns {Promise<Buffer>}
 */
export function renderBillPdf({ storeName, headerLines = [], branchName, bill }) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Bill ${bill.billNo}`, Author: storeName } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - 2 * MARGIN;
  doc.font(BOLD).fontSize(16).text(storeName, { align: 'center' });
  doc.font(FONT).fontSize(9);
  for (const line of headerLines) doc.text(line, { align: 'center' });
  if (branchName) doc.text(`Branch: ${branchName}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.8).stroke();
  doc.moveDown(0.5);

  // Patient on the left, bill on the right.
  const top = doc.y;
  doc.fontSize(9);
  const left = [
    ['Patient', bill.patientName],
    ['Address', bill.address],
    ['Doctor', bill.doctor],
  ].filter(([, v]) => v);
  left.forEach(([label, value]) => {
    doc.font(BOLD).text(`${label}: `, MARGIN, doc.y, { continued: true, width: width * 0.6 }).font(FONT).text(value);
  });
  const leftBottom = doc.y;
  doc.y = top;
  [
    ['Bill No', bill.billNo],
    ['Date', printedDate(bill.billDate)],
  ].forEach(([label, value]) => {
    doc.font(BOLD).text(`${label}: `, MARGIN + width * 0.62, doc.y, { continued: true, width: width * 0.38 }).font(FONT).text(value ?? '');
  });
  doc.y = Math.max(leftBottom, doc.y) + 8;

  let y = tableHeader(doc, doc.y);
  const bottom = doc.page.height - MARGIN - 70;
  bill.items.forEach((item, index) => {
    const values = [
      String(index + 1),
      item.product ?? '',
      item.pack ?? '',
      item.mfg ?? '',
      item.batch ?? '',
      item.expiry ?? '',
      qty(item.qty) + (Number(item.free) > 0 ? `+${qty(item.free)}` : ''),
      money(item.mrp),
      money(item.rate),
      item.gstPct == null ? '' : qty(item.gstPct),
      money(item.amount),
    ];
    // Measure first so a row is never split across pages.
    doc.font(FONT).fontSize(8);
    const needed = Math.max(...COLUMNS.map(([, w], i) => doc.heightOfString(values[i], { width: w - 4 }))) + 4;
    if (y + needed > bottom) {
      doc.addPage();
      y = tableHeader(doc, MARGIN);
    }
    y += tableRow(doc, values, y);
  });
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.5).stroke();

  // Totals, right-aligned.
  const subTotal = bill.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const gst = bill.items.reduce((sum, item) => sum + (Number(item.gstAmt) || 0), 0);
  // The bill total is after discount and round-off (and any charges), as in Prompt Rx.
  const difference = Number(bill.total ?? 0) - subTotal;
  const totals = [
    ['Sub Total', money(subTotal)],
    ...(gst > 0 ? [['GST included', money(gst)]] : []),
    ...(difference < -0.005 ? [['Saved', money(-difference)]] : []),
    ...(difference > 0.005 ? [['Other charges', money(difference)]] : []),
    ['Total', `Rs. ${money(bill.total)}`],
  ];
  doc.y = y + 6;
  totals.forEach(([label, value], i) => {
    const last = i === totals.length - 1;
    doc.font(last ? BOLD : FONT).fontSize(last ? 11 : 9);
    const rowY = doc.y;
    doc.text(label, MARGIN + width - 220, rowY, { width: 120, align: 'right' });
    doc.text(value, MARGIN + width - 95, rowY, { width: 95, align: 'right' });
  });

  doc.moveDown(2);
  doc.font(FONT).fontSize(8).fillColor('#555555').text('Copy of your bill, sent on WhatsApp. Get well soon.', MARGIN, doc.y, { width, align: 'center' });
  doc.end();
  return done;
}
