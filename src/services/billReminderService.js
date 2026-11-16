// Reminders created automatically from Prompt bills sent by RxBridge. A bill whose remark is
// a number of days N (e.g. "30") gets one reminder on day N-2, N-1 and N after the bill date,
// covering all the bill's medicines. The customer is created (or linked to the branch) by
// mobile number and the medicines are recorded, as when staff add them by hand.
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as customerRepository from '../repositories/customerRepository.js';
import * as reminderRepository from '../repositories/reminderRepository.js';
import { addDays, toIsoDate, todayIn } from '../utils/dates.js';
import { MAX_INTERVAL_DAYS, parseRemarkDays, planReminderDays } from './reminderRules.js';

const MEDICINE_MAX = 100;
const CYCLE_MEDICINE_MAX = 500;
const CATCH_UP_INTERVAL_MS = 15 * 60 * 1000;

const truncate = (value, max) => (value && value.length > max ? value.slice(0, max) : value);

/** "A, B, C" within the column size; names that do not fit are counted as "+N more". */
export function joinMedicines(names, max = CYCLE_MEDICINE_MAX) {
  for (let shown = names.length; shown > 0; shown -= 1) {
    const rest = names.length - shown;
    const text = names.slice(0, shown).join(', ') + (rest ? ` +${rest} more` : '');
    if (text.length <= max) return text;
  }
  return truncate(names[0] ?? '', max);
}

/**
 * Bills with a number in the remark, a valid mobile and no reminder yet, oldest first.
 * `filter` limits the search to one ingest batch.
 */
async function findPendingBills(today, filter) {
  const query = db('agent_bills as ab')
    .leftJoin('reminder_cycles as rc', 'rc.agent_bill_id', 'ab.id')
    .whereNull('rc.id')
    .whereNotNull('ab.phone')
    .whereRaw("ab.remarks REGEXP '^[[:space:]]*[0-9]'")
    // Older bills cannot have a reminder date left.
    .where('ab.bill_date', '>=', addDays(today, -MAX_INTERVAL_DAYS))
    .select('ab.id', 'ab.branch_id', 'ab.bill_no', 'ab.bill_date', 'ab.phone', 'ab.patient_name', 'ab.address', 'ab.doctor', 'ab.remarks')
    .orderBy('ab.bill_date')
    .orderBy('ab.id');
  if (filter) {
    query
      .where({ 'ab.agent_id': filter.agentId, 'ab.source_database': filter.sourceDatabase })
      .whereIn('ab.source_bill_id', filter.sourceBillIds);
  }
  return query;
}

async function billProducts(conn, billId) {
  const products = await conn('agent_bill_items')
    .where({ agent_bill_id: billId })
    .whereNotNull('product')
    .orderBy('line_no')
    .pluck('product');
  return [...new Set(products.map((p) => truncate(p.trim(), MEDICINE_MAX)).filter(Boolean))];
}

/** The customer with this mobile, linked to the branch; created from the bill if new. */
async function customerForBill(trx, bill) {
  const existingId = await customerRepository.findIdByMobile(bill.phone, trx);
  if (existingId) {
    await customerRepository.lockById(trx, existingId);
    const existing = await customerRepository.findById(existingId, trx);
    const current = existing.branches.map((b) => b.id);
    if (!current.includes(bill.branch_id)) {
      await customerRepository.addBranchLinks(trx, [{ customerId: existingId, branchId: bill.branch_id }]);
      await auditRepository.record(
        {
          actorUserId: null,
          action: 'customer.branch_linked',
          entityType: 'customer',
          entityId: existingId,
          branchId: bill.branch_id,
          details: { branchIds: { from: current, to: [...current, bill.branch_id] }, billNo: bill.bill_no },
        },
        trx,
      );
    }
    return existingId;
  }

  const fields = {
    mobile: bill.phone,
    fullName: truncate(bill.patient_name?.trim(), 150) || bill.phone,
    address: truncate(bill.address?.trim(), 500) || null,
    usualDoctor: truncate(bill.doctor?.trim(), 150) || null,
  };
  const id = await customerRepository.insert(trx, fields, null);
  await customerRepository.addBranchLinks(trx, [{ customerId: id, branchId: bill.branch_id }]);
  await auditRepository.record(
    {
      actorUserId: null,
      action: 'customer.created',
      entityType: 'customer',
      entityId: id,
      branchId: bill.branch_id,
      details: { ...fields, branchIds: [bill.branch_id], billNo: bill.bill_no },
    },
    trx,
  );
  return id;
}

/** Schedules the reminder for one bill. Returns false when there is nothing to schedule. */
async function scheduleBill(bill, today) {
  const intervalDays = parseRemarkDays(bill.remarks);
  if (!intervalDays) return false;
  const startDate = toIsoDate(bill.bill_date);
  const days = planReminderDays({ startDate, intervalDays, today });
  if (days.every((d) => d.status === 'skipped')) return false;

  return db.transaction(async (trx) => {
    const medicines = await billProducts(trx, bill.id);
    if (medicines.length === 0) return false;

    const customerId = await customerForBill(trx, bill);
    const added = await customerRepository.addMedicines(trx, {
      customerId,
      branchId: bill.branch_id,
      medicines,
      lastBillDate: startDate,
      source: 'prompt',
      userId: null,
    });
    await customerRepository.refreshLastBillDate(trx, { customerId, branchId: bill.branch_id, medicines, lastBillDate: startDate });
    if (added.length) {
      await auditRepository.record(
        {
          actorUserId: null,
          action: 'customer.medicines_added',
          entityType: 'customer',
          entityId: customerId,
          branchId: bill.branch_id,
          details: { medicines: added, lastBillDate: startDate, source: 'prompt', billNo: bill.bill_no },
        },
        trx,
      );
    }

    const medicine = joinMedicines(medicines);
    await reminderRepository.createCycle(trx, {
      customerId,
      branchId: bill.branch_id,
      agentBillId: bill.id,
      medicine,
      startDate,
      intervalDays,
      userId: null,
      days,
    });
    await auditRepository.record(
      {
        actorUserId: null,
        action: 'reminder.scheduled',
        entityType: 'customer',
        entityId: customerId,
        branchId: bill.branch_id,
        details: {
          medicine,
          intervalDays,
          startDate,
          dates: days.map((d) => `${d.scheduledDate}${d.status === 'skipped' ? ' (passed)' : ''}`),
          billNo: bill.bill_no,
          remarks: bill.remarks,
        },
      },
      trx,
    );
    return true;
  });
}

/**
 * Schedules reminders for bills with a day count in the remark that have none yet.
 * Each bill is handled on its own; one failing bill does not stop the others.
 * @param filter optional { agentId, sourceDatabase, sourceBillIds } (one ingest batch)
 * @returns {Promise<number>} reminders created
 */
export async function scheduleFromBillRemarks(filter) {
  if (filter && filter.sourceBillIds.length === 0) return 0;
  const today = todayIn(env.APP_TIMEZONE);
  let created = 0;
  for (const bill of await findPendingBills(today, filter)) {
    try {
      if (await scheduleBill(bill, today)) created += 1;
    } catch (error) {
      // Another process scheduled the same bill (unique agent_bill_id) or created the customer.
      if (error.code === 'ER_DUP_ENTRY') continue;
      console.error(`Reminder from bill ${bill.id} remark failed:`, error.message);
    }
  }
  return created;
}

/**
 * Catches up on bills not handled at ingest (e.g. sent before this feature, or while the
 * database was unavailable): once at start-up, then every 15 minutes.
 */
export function startBillReminderCatchUp() {
  const run = () =>
    scheduleFromBillRemarks()
      .then((created) => created && console.log(`Scheduled ${created} reminder(s) from bill remarks.`))
      .catch((error) => console.error('Scheduling reminders from bill remarks failed:', error.message));
  run();
  const timer = setInterval(run, CATCH_UP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
