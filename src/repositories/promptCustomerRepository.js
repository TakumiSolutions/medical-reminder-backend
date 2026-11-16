// Read-only bill queries over a branch's Prompt data: one row per bill, newest first.
// The data comes either from the export database (CustomerBills, one row per bill line) or,
// for branches with an RxBridge desktop agent, from the bills it sends (agent_bills).
//
// Each source exposes the same derived table `b` with columns:
//   BillKey, SortKey, Phone, Patient, Address, Doctor, BillNo, BillDate (YYYY-MM-DD), Total, Items, Remarks,
//   ReminderId (the reminder created from the bill's remark; RxBridge bills only)
// plus `medicineFilter` (EXISTS on the bill's lines), `lines(rows)` and `medicines()`.

/** Source over the Prompt export database's CustomerBills table (one row per bill line). */
export const exportSource = (conn) => ({
  conn,
  bills: (alias) =>
    conn.raw(
      // A bill is its (BillNo, BillDate); its header fields repeat on every line.
      `(SELECT CONCAT(COALESCE(BillNo, ''), '|', COALESCE(DATE_FORMAT(BillDate, '%Y-%m-%d'), '')) AS BillKey,
               BillNo AS SortKey, MAX(Phone) AS Phone, MAX(Patient) AS Patient, MAX(Address) AS Address,
               MAX(Doctor) AS Doctor, BillNo, DATE_FORMAT(BillDate, '%Y-%m-%d') AS BillDate,
               MAX(BillTotal) AS Total, COUNT(*) AS Items, NULL AS Remarks, NULL AS ReminderId
        FROM CustomerBills
        GROUP BY BillNo, BillDate) AS ??`,
      [alias],
    ),
  medicineFilter: (medicine) =>
    conn.raw(
      'EXISTS (SELECT 1 FROM CustomerBills x WHERE x.BillNo <=> b.BillNo AND x.BillDate <=> b.BillDate AND x.Product = ?)',
      [medicine],
    ),
  async lines(rows) {
    if (rows.length === 0) return [];
    const lines = await conn('CustomerBills')
      .where((q) => {
        for (const row of rows) q.orWhere((w) => w.whereRaw('BillNo <=> ?', [row.BillNo]).whereRaw('BillDate <=> ?', [row.BillDate]));
      })
      .select('BillNo', conn.raw("DATE_FORMAT(BillDate, '%Y-%m-%d') AS BillDate"), 'Product', 'Qty', 'Pack')
      .orderBy('Product');
    return lines.map((l) => ({ BillKey: `${l.BillNo ?? ''}|${l.BillDate ?? ''}`, Product: l.Product, Qty: l.Qty, Pack: l.Pack }));
  },
  medicines: () => conn('CustomerBills').whereNotNull('Product').distinct('Product').orderBy('Product').pluck('Product'),
});

// agent_bills.phone is stored as +91XXXXXXXXXX; the export holds the bare 10 digits.
const AGENT_PHONE = "CASE WHEN ab.phone LIKE '+91%' THEN SUBSTRING(ab.phone, 4) ELSE ab.phone END";

/** Source over the bills an RxBridge agent sent for `branchId` (main database). */
export const agentBillsSource = (conn, branchId) => ({
  conn,
  bills: (alias) =>
    conn.raw(
      `(SELECT CAST(ab.id AS CHAR) AS BillKey, ab.id AS SortKey, ${AGENT_PHONE} AS Phone,
               ab.patient_name AS Patient, ab.address AS Address, ab.doctor AS Doctor, ab.bill_no AS BillNo,
               DATE_FORMAT(ab.bill_date, '%Y-%m-%d') AS BillDate, ab.total AS Total, ab.item_count AS Items,
               ab.remarks AS Remarks,
               (SELECT rc.id FROM reminder_cycles rc WHERE rc.agent_bill_id = ab.id) AS ReminderId
        FROM agent_bills ab
        WHERE ab.branch_id = ?) AS ??`,
      [branchId, alias],
    ),
  medicineFilter: (medicine) =>
    conn.raw('EXISTS (SELECT 1 FROM agent_bill_items x WHERE x.agent_bill_id = b.SortKey AND x.product = ?)', [medicine]),
  async lines(rows) {
    if (rows.length === 0) return [];
    const lines = await conn('agent_bill_items')
      .whereIn('agent_bill_id', rows.map((r) => r.SortKey))
      .select('agent_bill_id', 'product', 'qty', 'pack')
      .orderBy('product');
    return lines.map((l) => ({ BillKey: String(l.agent_bill_id), Product: l.product, Qty: l.qty, Pack: l.pack }));
  },
  medicines: () =>
    conn('agent_bill_items as i')
      .join('agent_bills as ab', 'ab.id', 'i.agent_bill_id')
      .where('ab.branch_id', branchId)
      .whereNotNull('i.product')
      .distinct('i.product')
      .orderBy('i.product')
      .pluck('i.product'),
});

// SQL classification of the raw Phone column, matching normalizeIndianMobile for 10-char values.
const PHONE = 'TRIM(b.`Phone`)';
const IS_MISSING = `(b.\`Phone\` IS NULL OR ${PHONE} = '')`;
const IS_VALID = `${PHONE} REGEXP '^[6-9][0-9]{9}$'`;

const MOBILE_FILTERS = {
  valid: (q) => q.whereRaw(IS_VALID),
  invalid: (q) => q.whereRaw(`NOT ${IS_MISSING} AND NOT ${IS_VALID}`),
  missing: (q) => q.whereRaw(IS_MISSING),
};

function applySearch(query, search) {
  if (!search) return;
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const digits = search.replace(/\D/g, '');
  query.where((q) => {
    q.where('b.Patient', 'like', pattern).orWhere('b.Address', 'like', pattern).orWhere('b.BillNo', 'like', pattern);
    if (digits.length >= 3) q.orWhere('b.Phone', 'like', `%${digits}%`);
  });
}

/**
 * One row per bill, newest first, plus counts by mobile status for the same search/medicine filter.
 * `medicine` keeps bills that contain that product.
 */
export async function list(src, { search, mobileStatus, medicine, limit, offset }) {
  const { conn } = src;
  const base = conn.from(src.bills('b'));
  applySearch(base, search);
  if (medicine) base.whereRaw(src.medicineFilter(medicine));

  const [counts] = await base
    .clone()
    .select(conn.raw('COUNT(*) AS total'), conn.raw(`SUM(${IS_VALID}) AS valid`), conn.raw(`SUM(${IS_MISSING}) AS missing`));

  const query = base.clone();
  if (mobileStatus !== 'all') MOBILE_FILTERS[mobileStatus](query);
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .select('b.BillKey', 'b.SortKey', 'b.Phone', 'b.Patient', 'b.Address', 'b.Doctor', 'b.BillNo', 'b.BillDate', 'b.Total', 'b.Items', 'b.Remarks', 'b.ReminderId')
    .orderBy('b.BillDate', 'desc')
    .orderBy('b.SortKey', 'desc')
    .limit(limit)
    .offset(offset);

  const all = Number(counts.total);
  const valid = Number(counts.valid ?? 0);
  const missing = Number(counts.missing ?? 0);
  return { rows, total: Number(total), counts: { all, valid, missing, invalid: all - valid - missing } };
}

/**
 * Medicines on each listed bill (quantities of a repeated product added up).
 * @returns {Map<string, Array<{ product, qty, pack }>>} keyed by BillKey
 */
export async function billMedicines(src, rows) {
  const result = new Map();
  for (const line of await src.lines(rows)) {
    if (!line.Product) continue;
    if (!result.has(line.BillKey)) result.set(line.BillKey, []);
    const medicines = result.get(line.BillKey);
    const existing = medicines.find((m) => m.product === line.Product);
    if (existing) existing.qty += Number(line.Qty ?? 0);
    else medicines.push({ product: line.Product, qty: Number(line.Qty ?? 0), pack: line.Pack });
  }
  return result;
}

/** Products that appear on any of the branch's bills, for the medicine filter. */
export const listMedicines = (src) => src.medicines();
