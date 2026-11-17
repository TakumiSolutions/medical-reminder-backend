import { z } from 'zod';

// Request schemas for the desktop agent API (/api/v1) and its admin pages (/api/agents).
//
// Any 4xx makes the agent park the batch as failed, so ingest validation only rejects what
// is truly broken (missing ids, bad dates, impossible numbers). Free text is trimmed and cut
// to its column size, and an unusable phone or expiry is stored as null instead.

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_BILLS_PER_REQUEST = 1000;
export const MAX_ITEMS_PER_BILL = 500;

const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Optional text: string or number, trimmed, empty -> null, cut to `max` characters. */
const text = (max) =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .transform((value) => {
      const trimmed = value == null ? '' : String(value).trim();
      return trimmed === '' ? null : trimmed.slice(0, max);
    });

/** Required identifier: string or number, trimmed, 1..max characters (never cut). */
const identifier = (max, label) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().min(1, `${label} is required.`).max(max, `${label} is longer than ${max} characters.`));

/** Like `identifier`, limited to printable ASCII (stored with a binary collation). */
const asciiIdentifier = (max, label) =>
  identifier(max, label).pipe(z.string().regex(/^[\x21-\x7E]+$/, `${label} may only contain printable ASCII.`));

/** Number or numeric string, within ±`limit`. */
const decimal = (limit = 1e8) =>
  z
    .union([z.number(), z.string().trim().regex(NUMERIC_STRING, 'Expected a number.')])
    .transform(Number)
    .pipe(z.number().min(-limit).max(limit));

const optionalDecimal = (limit) =>
  z
    .union([decimal(limit), z.string().trim().max(0)])
    .nullish()
    .transform((value) => (typeof value === 'number' ? value : null));

/** "MM/yy" (a single-digit month is padded); anything else -> null. */
const expiry = text(10).transform((value) => {
  const match = value && /^(\d{1,2})\/(\d{2})$/.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12) return null;
  return `${match[1].padStart(2, '0')}/${match[2]}`;
});

const flag = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .nullish()
  .transform((value) => Boolean(value));

const billItemSchema = z.object({
  product: text(200),
  pack: text(40),
  mfg: text(100),
  qty: optionalDecimal(),
  free: optionalDecimal(),
  mrp: optionalDecimal(),
  batch: text(40),
  expiry,
  rate: optionalDecimal(),
  gstPct: optionalDecimal(100),
  gstAmt: optionalDecimal(),
  amount: optionalDecimal(),
});

/** Prompt Rx user (UserMaster) as { code, name }; a non-integer code is stored as null. */
const billUser = z
  .object({
    code: z
      .union([z.number(), z.string()])
      .nullish()
      .transform((value) => {
        const n = value == null || String(value).trim() === '' ? NaN : Number(value);
        return Number.isInteger(n) && Math.abs(n) <= 2_147_483_647 ? n : null;
      }),
    name: text(100),
  })
  .nullish()
  .transform((value) => (value && (value.code !== null || value.name !== null) ? value : null));

/** Shop wall-clock time "YYYY-MM-DDTHH:mm:ss" (no zone); anything else -> null. */
const localDateTime = text(40).transform((value) => {
  const match = value && /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return null;
  if (!z.iso.date().safeParse(match[1]).success) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}`;
});

const billSchema = z.object({
  id: asciiIdentifier(64, 'Bill id'),
  billNo: identifier(40, 'Bill number'),
  series: text(20),
  homeDelivery: flag,
  date: z.iso.date('Use the YYYY-MM-DD format.'),
  // Raw phone as printed; normalised (or dropped) when stored.
  phone: text(64),
  patient: text(150),
  address: text(500),
  doctor: text(150),
  // Sent by RxBridge 0.1.2 and later. Left undefined when absent so older agents' request
  // hashes (idempotency) stay the same.
  remarks: text(500).optional(),
  // Who made / last edited the bill in Prompt Rx, and when (RxBridge 0.1.4 and later;
  // optional for the same reason as remarks).
  createdBy: billUser.optional(),
  createdAt: localDateTime.optional(),
  modifiedBy: billUser.optional(),
  modifiedAt: localDateTime.optional(),
  total: decimal(),
  items: z.array(billItemSchema).max(MAX_ITEMS_PER_BILL, `At most ${MAX_ITEMS_PER_BILL} items per bill.`).default([]),
});

export const ingestBillsSchema = z.object({
  source: z.object({
    database: z.string().trim().min(1).max(32).regex(/^[\w.-]+$/, 'Invalid database name.'),
    job: z.string().trim().min(1).max(64).regex(/^\w+$/, 'Invalid job name.'),
  }),
  bills: z
    .array(billSchema)
    .min(1, 'Send at least one bill.')
    .max(MAX_BILLS_PER_REQUEST, `At most ${MAX_BILLS_PER_REQUEST} bills per request.`),
});

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const heartbeatSchema = z.object({
  agentVersion: text(40),
  database: text(32),
  watermarks: z
    .record(z.string().max(32), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
    .refine((value) => Object.keys(value).length <= 20, 'At most 20 watermarks.')
    .nullish()
    .transform((value) => value ?? {}),
  outboxCount: count.nullish(),
  outboxBytes: count.nullish(),
  oldestPendingAgeSeconds: z.number().min(0).max(1e10).nullish(),
  lastError: text(2000),
  sentAt: text(40),
});

// --- Admin (/api/agents) ---

export const createAgentSchema = z.object({
  name: z.string({ error: 'Enter a name.' }).trim().min(1, 'Enter a name.').max(100),
  branchId: z.coerce.number().int().positive(),
});

export const listAgentBillsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
