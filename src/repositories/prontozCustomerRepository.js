// Read-only customer queries over a branch's ProntoZ data, in the shape of the export's
// CustomerList / CustomerBills tables. The data comes either from the export database or,
// for branches with an RxBridge desktop agent, from the bills it sends (agent_bills).
// A customer row has no id: it is identified by (Phone, Patient, Address).

/** Source over the ProntoZ export database's own tables. */
export const exportSource = (conn) => ({
  conn,
  list: (alias) => `CustomerList as ${alias}`,
  bills: (alias) => `CustomerBills as ${alias}`,
});

// agent_bills.phone is stored as +91XXXXXXXXXX; the export holds the bare 10 digits.
const AGENT_PHONE = "CASE WHEN ab.phone LIKE '+91%' THEN SUBSTRING(ab.phone, 4) ELSE ab.phone END";

/** Source over the bills an RxBridge agent sent for `branchId` (main database). */
export const agentBillsSource = (conn, branchId) => ({
  conn,
  list: (alias) =>
    conn.raw(
      `(SELECT ${AGENT_PHONE} AS Phone, ab.patient_name AS Patient, ab.address AS Address,
               COUNT(*) AS Bills, SUM(ab.item_count) AS Items, SUM(ab.total) AS TotalSpend,
               DATE_FORMAT(MIN(ab.bill_date), '%Y-%m-%d') AS FirstBill,
               DATE_FORMAT(MAX(ab.bill_date), '%Y-%m-%d') AS LastBill
        FROM agent_bills ab
        WHERE ab.branch_id = ?
        GROUP BY ab.phone, ab.patient_name, ab.address) AS ??`,
      [branchId, alias],
    ),
  bills: (alias) =>
    conn.raw(
      `(SELECT ${AGENT_PHONE} AS Phone, ab.patient_name AS Patient, ab.address AS Address,
               ab.doctor AS Doctor, ab.bill_date AS BillDate, i.product AS Product, i.qty AS Qty, i.pack AS Pack
        FROM agent_bills ab
        LEFT JOIN agent_bill_items i ON i.agent_bill_id = ab.id
        WHERE ab.branch_id = ?) AS ??`,
      [branchId, alias],
    ),
});

// SQL classification of the raw Phone column, matching normalizeIndianMobile for 10-char values.
const PHONE = 'TRIM(`Phone`)';
const IS_MISSING = `(\`Phone\` IS NULL OR ${PHONE} = '')`;
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
    q.where('l.Patient', 'like', pattern).orWhere('l.Address', 'like', pattern);
    if (digits.length >= 3) q.orWhere('l.Phone', 'like', `%${digits}%`);
  });
}

/** Bills of the CustomerList row `l` on its last bill date. */
const lastBillLines = (src) =>
  src.conn
    .from(src.bills('b'))
    .whereRaw('b.Phone <=> l.Phone')
    .whereRaw('b.Patient <=> l.Patient')
    .whereRaw('b.Address <=> l.Address')
    .whereRaw('b.BillDate = l.LastBill');

/**
 * Rows of CustomerList, plus counts by mobile status for the same search/medicine filter.
 * `medicine` keeps customers whose last bill contains that product.
 */
export async function list(src, { search, mobileStatus, medicine, limit, offset }) {
  const { conn } = src;
  const base = conn.from(src.list('l'));
  applySearch(base, search);
  if (medicine) base.whereExists(lastBillLines(src).where('b.Product', medicine).select(conn.raw('1')));

  const [counts] = await base
    .clone()
    .select(
      conn.raw('COUNT(*) AS total'),
      conn.raw(`SUM(${IS_VALID.replaceAll('`Phone`', 'l.`Phone`')}) AS valid`),
      conn.raw(`SUM(${IS_MISSING.replaceAll('`Phone`', 'l.`Phone`')}) AS missing`),
    );

  const query = base.clone();
  if (mobileStatus !== 'all') MOBILE_FILTERS[mobileStatus](query);
  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .select('l.Phone', 'l.Patient', 'l.Address', 'l.Bills', 'l.Items', 'l.TotalSpend', 'l.FirstBill', 'l.LastBill')
    .orderBy('l.LastBill', 'desc')
    .orderBy('l.Patient')
    .limit(limit)
    .offset(offset);

  const all = Number(counts.total);
  const valid = Number(counts.valid ?? 0);
  const missing = Number(counts.missing ?? 0);
  return { rows, total: Number(total), counts: { all, valid, missing, invalid: all - valid - missing } };
}

const rowKey = (phone, patient, address) => JSON.stringify([phone ?? null, patient ?? null, address ?? null]);
export const customerKey = (row) => rowKey(row.Phone?.trim() || null, row.Patient, row.Address);

/**
 * Products (and the doctor) on each row's last bill date.
 * @returns {Map<string, { doctor: string|null, medicines: Array<{ product, qty, pack }> }>} keyed by customerKey
 */
export async function lastBillDetails(src, rows) {
  const result = new Map();
  if (rows.length === 0) return result;

  const lines = await src.conn
    .from(src.bills('b'))
    .where((q) => {
      for (const row of rows) {
        q.orWhere((w) => {
          w.whereRaw('Phone <=> ?', [row.Phone]).whereRaw('Patient <=> ?', [row.Patient]).whereRaw('Address <=> ?', [row.Address]);
          w.where('BillDate', row.LastBill);
        });
      }
    })
    .select('Phone', 'Patient', 'Address', 'Doctor', 'Product', 'Qty', 'Pack')
    .orderBy('Product');

  for (const line of lines) {
    const key = customerKey(line);
    if (!result.has(key)) result.set(key, { doctor: null, medicines: [] });
    const entry = result.get(key);
    entry.doctor ??= line.Doctor;
    const existing = entry.medicines.find((m) => m.product === line.Product);
    if (existing) existing.qty += Number(line.Qty ?? 0);
    else if (line.Product) entry.medicines.push({ product: line.Product, qty: Number(line.Qty ?? 0), pack: line.Pack });
  }
  return result;
}

/** Products that appear on any customer's last bill, for the medicine filter. */
export async function listLastBillMedicines(src) {
  const { conn } = src;
  return conn
    .from(src.list('l'))
    .join(src.bills('b'), function onLastBill() {
      this.on(conn.raw('b.Phone <=> l.Phone'))
        .andOn(conn.raw('b.Patient <=> l.Patient'))
        .andOn(conn.raw('b.Address <=> l.Address'))
        .andOn('b.BillDate', '=', 'l.LastBill');
    })
    .whereNotNull('b.Product')
    .distinct('b.Product')
    .orderBy('b.Product')
    .pluck('b.Product');
}
