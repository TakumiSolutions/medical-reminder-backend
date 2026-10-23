// What the desktop agents call: bill ingest (idempotent) and heartbeats.
import { createHash } from 'node:crypto';
import { db } from '../db/knex.js';
import * as agentBillRepository from '../repositories/agentBillRepository.js';
import * as agentRepository from '../repositories/agentRepository.js';
import { AppError } from '../utils/errors.js';
import { normalizeIndianMobile } from '../utils/phone.js';

const KEY_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

/** JSON with object keys sorted, so equal payloads always serialise the same way. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of a validated ingest request; a reused Idempotency-Key must come with the same hash. */
export const hashIngestRequest = ({ source, bills }) =>
  createHash('sha256').update(canonicalJson({ source, bills })).digest('hex');

/** Validated bill -> agent_bills row (plus its item rows). An invalid phone is stored as null. */
export function toBillRow(bill) {
  const phone = normalizeIndianMobile(bill.phone);
  return {
    source_bill_id: bill.id,
    bill_no: bill.billNo,
    series: bill.series,
    home_delivery: bill.homeDelivery,
    bill_date: bill.date,
    phone: phone.ok ? phone.value : null,
    patient_name: bill.patient,
    address: bill.address,
    doctor: bill.doctor,
    total: bill.total,
    items: bill.items.map((item) => ({
      product: item.product,
      pack: item.pack,
      mfg: item.mfg,
      batch: item.batch,
      expiry: item.expiry,
      qty: item.qty,
      free: item.free,
      mrp: item.mrp,
      rate: item.rate,
      gst_pct: item.gstPct,
      gst_amt: item.gstAmt,
      amount: item.amount,
    })),
  };
}

function replay(stored, requestHash) {
  if (stored.requestHash !== requestHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
  }
  return { status: stored.statusCode, body: stored.response };
}

/** Deletes expired keys at most once an hour per process, without delaying the response. */
function pruneOldKeys() {
  if (Date.now() - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = Date.now();
  agentBillRepository
    .deleteIdempotencyKeysOlderThan(KEY_RETENTION_DAYS)
    .catch((error) => console.error('Deleting old idempotency keys failed:', error));
}

/**
 * Stores a batch of bills for `agent`. A repeated Idempotency-Key with the same request
 * returns the stored response without processing again; with a different request, 409.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function ingestBills(agent, idempotencyKey, payload) {
  const requestHash = hashIngestRequest(payload);
  const stored = await agentBillRepository.findIdempotencyKey(agent.id, idempotencyKey);
  if (stored) return replay(stored, requestHash);

  // A bill sent twice in one batch: the last copy wins.
  const bills = [...new Map(payload.bills.map((bill) => [bill.id, toBillRow(bill)])).values()];
  const response = { accepted: payload.bills.length };

  const result = await db.transaction(async (trx) => {
    // The key is claimed before any bill is written. A concurrent request with the same key
    // waits on this insert until our transaction ends, then fails with a duplicate (or, if
    // we rolled back, proceeds itself) — so a batch is never processed twice.
    try {
      await agentBillRepository.insertIdempotencyKey(trx, {
        agentId: agent.id,
        key: idempotencyKey,
        requestHash,
        statusCode: 200,
        response,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return null;
      throw error;
    }
    await agentBillRepository.upsertBills(trx, {
      agentId: agent.id,
      branchId: agent.branchId,
      sourceDatabase: payload.source.database,
      bills,
    });
    return { status: 200, body: response };
  });

  // Lost the race to a concurrent duplicate: answer with what it stored.
  if (!result) return replay(await agentBillRepository.findIdempotencyKey(agent.id, idempotencyKey), requestHash);

  pruneOldKeys();
  return result;
}

/** Keeps only the latest heartbeat. */
export async function recordHeartbeat(agent, heartbeat) {
  await agentRepository.saveHeartbeat(agent.id, heartbeat);
  return { serverTime: new Date().toISOString() };
}
