// A bill drawn on the branch's own Cash Memo design (billTemplates.js): header with logo and
// Gujarati name, coloured column bar, item rows, and the footer with licences, "24 HOURS DAY &
// NIGHT", who made the bill, and the totals. Pages are 21 × 11 cm, the size of the printed memo.
// A branch whose memo has a printed back (offers, WhatsApp ordering) gets it as a last page.
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const asset = (path) => fileURLToPath(new URL(`../assets/bills/${path}`, import.meta.url));
const FONTS = {
  guj: asset('fonts/MuktaVaani-Regular.ttf'),
  gujBold: asset('fonts/MuktaVaani-Bold.ttf'),
  script: asset('fonts/DancingScript.ttf'),
  // The invocation at the top of both memos is in Devanagari.
  deva: asset('fonts/NotoSansDevanagari-Regular.ttf'),
};

// Drawing units: the memo is laid out on W × H and scaled down to the 21 × 11 cm page.
const W = 842;
const H = 440;
const PAGE_W = (21 / 2.54) * 72;
const PAGE_H = (11 / 2.54) * 72;
const SCALE = Math.min(PAGE_W / W, PAGE_H / H);
const M = 14;
const TOP = 16;
const R = W - M;
const BOTTOM = H - M;
const FOOTER_H = 84;
const ROW_H = 13;
// Header: patient panel line, where it curves down, and the column bar under it.
const Y_PANEL = TOP + 15;
const Y_CURVE = TOP + 52;
const Y_BAR = TOP + 72;
const BAR_H = 20;

// [label, width, align]; widths add up to the inner width (R - M).
const COLUMNS = [
  ['Qty.', 40, 'right'],
  ['Product Name', 238, 'left'],
  ['Pack', 56, 'left'],
  ['Mfg.', 64, 'left'],
  ['M.R.P.', 56, 'right'],
  ['Batch No.', 80, 'left'],
  ['Exp. Dt.', 46, 'center'],
  ['Rate', 56, 'right'],
  ['GST %', 42, 'right'],
  ['GST Amt.', 54, 'right'],
  ['Amount', R - M - 732, 'right'],
];
const COLUMN_X = COLUMNS.reduce((xs, [, width]) => [...xs, xs.at(-1) + width], [M]);

const money = (value) => (value == null ? '' : Number(value).toFixed(2));
const number = (value) => (value == null ? '' : String(Number(value)));

/** "YYYY-MM-DD" -> "DD/MM/YYYY", as printed on the memo. */
export const memoDate = (isoDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate ?? '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

/** "YYYY-MM-DDTHH:mm:ss" -> "4:36 pm". */
export const memoTime = (localDateTime) => {
  const match = /T(\d{2}):(\d{2})/.exec(localDateTime ?? '');
  if (!match) return '';
  const hours = Number(match[1]);
  return `${hours % 12 || 12}:${match[2]} ${hours < 12 ? 'am' : 'pm'}`;
};

/** Cuts `text` to fit `width` at the current font, ending with "…". */
function fit(doc, text, width) {
  let value = String(text ?? '');
  if (doc.widthOfString(value) <= width) return value;
  while (value.length > 1 && doc.widthOfString(`${value}…`) > width) value = value.slice(0, -1);
  return `${value.trimEnd()}…`;
}

/** One line of text, never wrapping. */
function line(doc, text, x, y, { font = 'Helvetica', size = 9, color = '#1e1e1e', width, align = 'left' } = {}) {
  doc.font(font).fontSize(size).fillColor(color);
  const value = width ? fit(doc, text, width) : String(text ?? '');
  doc.text(value, x, y, { width, align, lineBreak: false });
}

function drawHeader(doc, t, bill) {
  const xC = M + 372; // where the patient panel curves down
  const yA = Y_PANEL;
  const yB = Y_CURVE;
  const yBar = Y_BAR;

  line(doc, '॥ श्री गुरुदेवाय नमः ॥', 0, 2, { font: FONTS.deva, size: 7, color: t.accent, width: W, align: 'center' });
  if (t.cashMemo) line(doc, 'Cash Memo', M + 8, TOP + 2.5, { font: 'Helvetica-Bold', size: 11, color: t.accent });

  // Patient panel outline: across, curving down, then across under the store name.
  doc
    .moveTo(M, yA)
    .lineTo(xC, yA)
    .bezierCurveTo(xC + 12, yA, xC + 18, yA + 6, xC + 18, yA + 14)
    .lineTo(xC + 18, yB - 12)
    .bezierCurveTo(xC + 18, yB - 4, xC + 24, yB, xC + 34, yB)
    .lineTo(R, yB)
    .lineWidth(0.8)
    .strokeColor(t.rule)
    .stroke();

  const value = { font: 'Helvetica', size: 10, color: '#1e1e1e' };
  [
    ['Doctor', bill.doctor, yA + 5],
    ['Patient', bill.patientName, yA + 20],
  ].forEach(([label, text, y]) => {
    line(doc, label, M + 8, y, { size: 9, color: t.label });
    line(doc, ':', M + 52, y, { size: 9, color: t.label });
    line(doc, text ?? '', M + 64, y - 0.5, { ...value, width: xC - M - 70 });
  });
  line(doc, 'Address', M + 8, yB + 4, { size: 9, color: t.label });
  line(doc, ':', M + 52, yB + 4, { size: 9, color: t.label });
  line(doc, bill.address ?? '', M + 64, yB + 3.5, { ...value, width: 410 });
  line(doc, 'No. :', 500, yB + 4, { size: 9, color: t.label });
  line(doc, bill.billNo ?? '', 524, yB + 3, { font: 'Helvetica-Bold', size: 10.5, color: '#1e1e1e', width: 130 });
  line(doc, 'Date :', 668, yB + 4, { size: 9, color: t.label });
  line(doc, memoDate(bill.billDate), 696, yB + 3, { font: 'Helvetica-Bold', size: 10.5, color: '#1e1e1e', width: 120 });

  // Store: logo, picture, name, address and WhatsApp number.
  doc.image(asset(`images/${t.logo}`), xC + 30, TOP + 2, { fit: [54, 46], align: 'center', valign: 'center' });
  doc.image(asset(`images/${t.deity}`), xC + 90, TOP + 3, { fit: [32, 38], align: 'center', valign: 'center' });
  const nx = xC + 130;
  const nameWidth = R - 8 - nx;
  let size = 24;
  doc.font(FONTS.gujBold);
  while (size > 16 && doc.fontSize(size).widthOfString(`${t.nameBox}  ${t.nameRest}`) + 14 > nameWidth) size -= 1;
  const boxHeight = size * 1.12;
  const boxWidth = doc.fontSize(size).widthOfString(t.nameBox) + 12;
  doc.rect(nx, TOP + 2, boxWidth, boxHeight).fill(t.accent);
  line(doc, t.nameBox, nx + 6, TOP + 2 - size * 0.12, { font: FONTS.gujBold, size, color: '#ffffff' });
  const restX = nx + boxWidth + 8;
  line(doc, t.nameRest, restX, TOP + 2 - size * 0.12, { font: FONTS.gujBold, size, color: t.dark });
  doc.rect(restX, TOP + 2 + boxHeight - 2.5, R - 8 - restX, 2.2).fill(t.accent);

  // Address wrapped by hand, so the WhatsApp number can follow on its last line, as printed.
  const small = 7.4;
  const lineStep = 8.8;
  doc.font(FONTS.guj).fontSize(small);
  const lines = [''];
  for (const word of t.address.split(' ')) {
    const next = lines.at(-1) ? `${lines.at(-1)} ${word}` : word;
    if (doc.widthOfString(next) <= nameWidth || !lines.at(-1)) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  const phoneWidth = 12 + doc.widthOfString(t.phone);
  if (doc.widthOfString(lines.at(-1)) + 8 + phoneWidth > nameWidth) lines.push('');
  const addressY = TOP + 3 + boxHeight;
  lines.forEach((text, i) => line(doc, text, nx, addressY + i * lineStep, { font: FONTS.guj, size: small, color: t.dark }));
  const phoneX = nx + (lines.at(-1) ? doc.font(FONTS.guj).fontSize(small).widthOfString(lines.at(-1)) + 8 : 0);
  const phoneY = addressY + (lines.length - 1) * lineStep;
  doc.circle(phoneX + 3.5, phoneY + 5.6, 3).fill('#25d366');
  line(doc, t.phone, phoneX + 9, phoneY, { font: FONTS.guj, size: small, color: t.dark });

  // Column bar.
  doc.rect(M, yBar, R - M, BAR_H).fill(t.bar);
  COLUMNS.forEach(([label, width], i) => {
    const x = COLUMN_X[i];
    if (i > 0) doc.moveTo(x, yBar).lineTo(x, yBar + 20).lineWidth(0.8).strokeColor('#ffffff').stroke();
    const [first, second] = label.split(' ');
    if (second && (label.startsWith('GST'))) {
      line(doc, first, x, yBar + 2, { font: 'Helvetica-Bold', size: 7.5, color: '#ffffff', width, align: 'center' });
      line(doc, second, x, yBar + 10.5, { font: 'Helvetica-Bold', size: 7.5, color: '#ffffff', width, align: 'center' });
    } else {
      line(doc, label, x, yBar + 6, { font: 'Helvetica-Bold', size: 8.5, color: '#ffffff', width, align: 'center' });
    }
  });
  return yBar + BAR_H;
}

function drawFooter(doc, t, bill, totals) {
  const yFoot = BOTTOM - FOOTER_H;
  const xL = COLUMN_X[3]; // left block ends at the Mfg. column
  const xT = COLUMN_X[8]; // totals start at the GST % column
  const xA = COLUMN_X[10]; // values in the Amount column

  doc.moveTo(M, yFoot).lineTo(R, yFoot).lineWidth(0.8).strokeColor(t.rule).stroke();
  for (const x of [xL, xT, xA]) doc.moveTo(x, yFoot).lineTo(x, BOTTOM).lineWidth(0.8).strokeColor(t.rule).stroke();

  // Licences and the store's notes.
  t.legal.forEach((text, i) => line(doc, text, M + 5, yFoot + 4 + i * 9, { size: 7.2, color: '#333333', width: xL - M - 8 }));
  t.notes.forEach((pair, i) => {
    let x = M + 5;
    const y = yFoot + 41 + i * 12;
    for (const note of pair) {
      doc.circle(x + 2, y + 6.3, 1.9).fill(t.bullet);
      line(doc, note, x + 6, y, { font: FONTS.guj, size: 7.3, color: '#333333' });
      x += 6 + doc.font(FONTS.guj).fontSize(7.3).widthOfString(note) + 8;
    }
  });

  // 24 HOURS DAY & NIGHT, who made the bill, and the sign-off.
  doc.font('Helvetica-Bold').fontSize(19);
  const hoursWidth = doc.widthOfString('24 HOURS') + 12;
  doc.rect(xL, yFoot, hoursWidth, 24).fill(t.hours.box);
  if (t.hours.restBg) doc.rect(xL + hoursWidth, yFoot, xT - xL - hoursWidth, 24).fill(t.hours.restBg);
  line(doc, '24 HOURS', xL + 6, yFoot + 4, { font: 'Helvetica-Bold', size: 19, color: t.hours.boxText });
  line(doc, 'DAY & NIGHT', xL + hoursWidth + 8, yFoot + 4, { font: 'Helvetica-Bold', size: 19, color: t.hours.rest });
  doc.moveTo(xL, yFoot + 24).lineTo(xT, yFoot + 24).lineWidth(0.6).strokeColor(t.rule).stroke();
  if (bill.createdBy?.name) line(doc, bill.createdBy.name, xL + 24, yFoot + 30, { font: 'Times-Roman', size: 10.5, width: 160 });
  if (bill.createdBy?.at) line(doc, memoTime(bill.createdBy.at), xL + 196, yFoot + 30, { font: 'Times-Roman', size: 10.5 });
  line(doc, 'Get well soon', xL + 8, BOTTOM - 27, { font: FONTS.script, size: 17, color: '#4a4a4a' });
  line(doc, t.forLine, xL, BOTTOM - 15, { font: 'Helvetica-Bold', size: 8.5, color: t.accent, width: xT - xL - 6, align: 'right' });

  // Totals.
  const amountWidth = R - xA - 6;
  line(doc, 'Sub Total', xT + 6, yFoot + 5, { size: 9.5, color: '#1e1e1e' });
  if (!totals) {
    line(doc, 'Continued on next page', xT + 6, BOTTOM - 20, { size: 8, color: '#666666', width: R - xT - 12 });
    return;
  }
  line(doc, money(totals.subTotal), xA, yFoot + 18, { size: 10, width: amountWidth, align: 'right' });
  if (totals.saved) {
    line(doc, 'Saved :-', xT + 6, yFoot + 38, { size: 9.5 });
    line(doc, money(totals.saved), xA, yFoot + 38, { size: 10, width: amountWidth, align: 'right' });
  }
  if (totals.charges) {
    line(doc, 'Other charges', xT + 6, yFoot + 38, { size: 9.5 });
    line(doc, money(totals.charges), xA, yFoot + 38, { size: 10, width: amountWidth, align: 'right' });
  }
  line(doc, 'Total (₹)', xT + 6, BOTTOM - 22, { font: FONTS.gujBold, size: 12, color: '#1e1e1e' });
  line(doc, money(bill.total), xA, BOTTOM - 21, { font: 'Helvetica-Bold', size: 13, width: amountWidth, align: 'right' });
}

function drawRows(doc, t, items, yTop) {
  const yFoot = BOTTOM - FOOTER_H;
  for (const x of COLUMN_X.slice(1, -1)) doc.moveTo(x, yTop).lineTo(x, yFoot).lineWidth(0.6).strokeColor(t.rule).stroke();
  items.forEach((item, i) => {
    const y = yTop + 5 + i * ROW_H;
    const values = [
      number(item.qty) + (Number(item.free) > 0 ? `+${number(item.free)}` : ''),
      item.product ?? '',
      item.pack ?? '',
      item.mfg ?? '',
      money(item.mrp),
      item.batch ?? '',
      item.expiry ?? '',
      money(item.rate),
      item.gstPct == null ? '' : money(item.gstPct),
      money(item.gstAmt),
      money(item.amount),
    ];
    values.forEach((text, c) => {
      const [, width, align] = COLUMNS[c];
      line(doc, text, COLUMN_X[c] + 3, y, { size: 8.8, width: width - 6, align });
    });
  });
}

/** Rows that fit between the column bar and the footer. */
const ROWS_PER_PAGE = Math.floor((BOTTOM - FOOTER_H - (Y_BAR + BAR_H) - 6) / ROW_H);

/** A new 21 × 11 cm page in `paper` colour, with the W × H drawing scaled and centred on it. */
function startPage(doc, paper) {
  // pdfkit starts a new page when text passes the bottom margin, measured in drawing units
  // (before scaling); margins past the W × H drawing stop it from breaking pages early.
  // Options given here replace the document's, so the size is repeated.
  doc.addPage({
    size: [PAGE_W, PAGE_H],
    margins: { top: 0, left: 0, right: PAGE_W - W - 100, bottom: PAGE_H - H - 100 },
  });
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(paper);
  doc.translate((PAGE_W - W * SCALE) / 2, (PAGE_H - H * SCALE) / 2).scale(SCALE);
}

/** "*red* words and WHATSAPP" -> text runs: *…* red bold, all-caps Latin words bold. */
function styledRuns(text, { size, color, red }) {
  return String(text)
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .flatMap((part) =>
      part.startsWith('*')
        ? [{ text: part.slice(1, -1), font: FONTS.gujBold, color: red }]
        : part
            .split(/\b([A-Z]{2,})\b/)
            .filter(Boolean)
            .map((piece) => ({ text: piece, font: /^[A-Z]{2,}$/.test(piece) ? FONTS.gujBold : FONTS.guj, color })),
    )
    .map((run) => ({ size, ...run }));
}

/**
 * Draws runs side by side on one baseline, shrunk to fit `width` if needed; `align: 'center'`
 * centres them in `width` from `x`.
 */
function drawRuns(doc, runs, x, baseline, { width, align = 'left' } = {}) {
  const measure = (scale) => runs.map((r) => doc.font(r.font).fontSize(r.size * scale).widthOfString(r.text));
  let scale = 1;
  let widths = measure(scale);
  const total = () => widths.reduce((sum, w) => sum + w, 0);
  if (width && total() > width) {
    scale = width / total();
    widths = measure(scale);
  }
  let cx = align === 'center' && width ? x + (width - total()) / 2 : x;
  runs.forEach((r, i) => {
    doc.font(r.font).fontSize(r.size * scale).fillColor(r.color);
    doc.text(r.text, cx, baseline, { lineBreak: false, baseline: 'alphabetic' });
    cx += widths[i];
  });
}

/** A QR code of `text`, drawn as squares (sharp at any size), `size` wide at (x, y). */
function drawQr(doc, text, x, y, size) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 2;
  const cell = size / (modules.size + 2 * quiet);
  doc.rect(x, y, size, size).fill('#ffffff');
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      // Slightly oversized squares, so no hairline gaps show between neighbours.
      if (modules.get(row, col)) doc.rect(x + (col + quiet) * cell, y + (row + quiet) * cell, cell + 0.05, cell + 0.05);
    }
  }
  doc.fill('#000000');
}

/** The printed back of the memo: offers, WhatsApp number and QR code for ordering. */
function drawBackPage(doc, back) {
  const dark = '#2b2b2b';
  doc.rect(M, TOP, R - M, BOTTOM - TOP).lineWidth(1.6).strokeColor(dark).stroke();
  doc.rect(M + 5, TOP + 5, R - M - 10, BOTTOM - TOP - 10).lineWidth(0.8).strokeColor(dark).stroke();

  drawRuns(doc, [{ text: back.title, font: FONTS.gujBold, size: 30, color: back.red }], M, 59, { width: R - M, align: 'center' });

  doc.font(FONTS.gujBold).fontSize(15);
  const badgeWidth = doc.widthOfString(back.badge) + 34;
  doc.roundedRect((W - badgeWidth) / 2, 76, badgeWidth, 27, 5).fill(dark);
  drawRuns(doc, [{ text: back.badge, font: FONTS.gujBold, size: 15, color: '#ffffff' }], 0, 95, { width: W, align: 'center' });

  back.points.forEach((point, i) => {
    const centre = 141 + i * 33;
    doc.image(asset('images/pointing-hand.png'), 36, centre - 9, { fit: [30, 18] });
    drawRuns(doc, styledRuns(point, { size: 18, color: dark, red: back.red }), 80, centre + 6, { width: 720 });
  });

  // WhatsApp number and ordering note (left), delivery picture (middle).
  doc.image(asset('images/whatsapp-icon.png'), 46, 308, { fit: [44, 44] });
  drawRuns(doc, [{ text: back.whatsapp, font: 'Helvetica-Bold', size: 50, color: '#3d3d3d' }], 104, 347, { width: 345 });
  back.orderLines.forEach((text, i) => {
    drawRuns(doc, styledRuns(text, { size: 17, color: dark, red: back.red }), 46, 376 + i * 29, { width: 400, align: 'center' });
  });
  doc.image(asset(`images/${back.picture}`), 456, 304, { fit: [130, 110], align: 'center', valign: 'center' });

  // WhatsApp business account and its QR code (right).
  const col = 618;
  const colWidth = 174;
  drawRuns(doc, [{ text: back.account, font: 'Helvetica-Bold', size: 13, color: '#1e1e1e' }], col, 238, { width: colWidth, align: 'center' });
  drawRuns(doc, [{ text: back.accountNote, font: 'Helvetica', size: 8, color: '#555555' }], col, 250, { width: colWidth, align: 'center' });
  drawQr(doc, back.qrUrl, col + (colWidth - 100) / 2, 256, 100);
  back.qrLines.forEach((text, i) => {
    drawRuns(doc, styledRuns(text, { size: 12.5, color: back.red, red: back.red }), col - 10, 378 + i * 17, {
      width: colWidth + 20,
      align: 'center',
    });
  });
}

/**
 * Renders `bill` on the branch's memo design `template`.
 * `bill`: { billNo, billDate, patientName, address, doctor, total, createdBy?: { name, at },
 *   items: [{ product, pack, mfg, batch, expiry, qty, free, mrp, rate, gstPct, gstAmt, amount }] }
 * @returns {Promise<Buffer>}
 */
export function renderMemoPdf({ template: t, storeName, bill, backPage = true }) {
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
    info: { Title: `Bill ${bill.billNo}`, Author: storeName },
  });
  doc.registerFont(FONTS.guj, FONTS.guj);
  doc.registerFont(FONTS.gujBold, FONTS.gujBold);
  doc.registerFont(FONTS.script, FONTS.script);
  doc.registerFont(FONTS.deva, FONTS.deva);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const subTotal = bill.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const difference = Number(bill.total ?? 0) - subTotal;
  const totals = {
    subTotal,
    saved: difference < -0.005 ? -difference : 0,
    charges: difference > 0.005 ? difference : 0,
  };

  const pages = [];
  for (let i = 0; i < Math.max(bill.items.length, 1); i += ROWS_PER_PAGE) pages.push(bill.items.slice(i, i + ROWS_PER_PAGE));
  pages.forEach((items, index) => {
    startPage(doc, t.paper);
    doc.rect(M, TOP, R - M, BOTTOM - TOP).lineWidth(1).strokeColor(t.rule).stroke();
    const yRows = drawHeader(doc, t, bill);
    drawRows(doc, t, items, yRows);
    drawFooter(doc, t, bill, index === pages.length - 1 ? totals : null);
  });
  if (backPage && t.back) {
    startPage(doc, '#ffffff');
    drawBackPage(doc, t.back);
  }
  doc.end();
  return done;
}
