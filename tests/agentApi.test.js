// Desktop agent API: checks that need no database, plus its validators and helpers.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';
import { bearerToken, requireIdempotencyKey } from '../src/middleware/agentAuth.js';
import { agentStatus } from '../src/services/agentService.js';
import { canonicalJson, hashIngestRequest, toBillRow } from '../src/services/agentApiService.js';
import { AGENT_TOKEN_PATTERN, generateAgentToken } from '../src/utils/tokens.js';
import { heartbeatSchema, ingestBillsSchema } from '../src/validators/agentValidators.js';

const app = createApp();

after(() => db.destroy());

const SAMPLE = {
  source: { database: 'PC.2026-27', job: 'sale_bills_with_phone' },
  bills: [
    {
      id: 104523,
      billNo: 'S-2041',
      series: 'HD',
      homeDelivery: true,
      date: '2026-10-22',
      phone: '98765 43210',
      patient: 'Ramesh Kumar',
      address: '12, MG Road',
      doctor: '',
      total: '1250.50',
      items: [
        {
          product: 'PARACETAMOL 650MG TAB',
          pack: "15'S",
          mfg: 'MICRO',
          qty: 2,
          free: 0,
          mrp: '35.20',
          batch: 'B1234',
          expiry: '3/27',
          rate: 30.17,
          gstPct: 12,
          gstAmt: 3.62,
          amount: 64,
        },
      ],
    },
  ],
};

const clone = (value) => structuredClone(value);

describe('agent API guards (no database)', () => {
  const endpoints = [
    ['get', '/api/v1/ping'],
    ['post', '/api/v1/ingest/bills'],
    ['post', '/api/v1/agents/heartbeat'],
  ];

  it('rejects requests without a bearer token', async () => {
    for (const [method, path] of endpoints) {
      const res = await request(app)[method](path).send({});
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    }
  });

  it('rejects malformed bearer tokens before any lookup', async () => {
    for (const header of ['Bearer', 'Bearer abc', 'Basic dXNlcjpwYXNz', `Bearer rxb_short`, `Token ${generateAgentToken()}`]) {
      const res = await request(app).get('/api/v1/ping').set('Authorization', header);
      assert.equal(res.status, 401, header);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    }
  });

  it('does not apply the browser origin check or cookies', async () => {
    const res = await request(app).post('/api/v1/ingest/bills').set('Origin', 'https://evil.example').send({});
    assert.equal(res.status, 401);
  });

  it('accepts gzip bodies only after authentication', async () => {
    const res = await request(app)
      .post('/api/v1/ingest/bills')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(JSON.stringify(SAMPLE)));
    assert.equal(res.status, 401);
  });
});

describe('agent tokens', () => {
  it('generates rxb_ tokens that the bearer parser accepts', () => {
    const token = generateAgentToken();
    assert.match(token, AGENT_TOKEN_PATTERN);
    assert.equal(token.length, 47);
    assert.equal(bearerToken(`Bearer ${token}`), token);
    assert.equal(bearerToken(`bearer  ${token}`), token);
    assert.equal(bearerToken(undefined), null);
    assert.equal(bearerToken(`Bearer ${token}x`), null);
  });
});

describe('Idempotency-Key header', () => {
  const run = (key) => {
    const req = { get: (name) => (name.toLowerCase() === 'idempotency-key' ? key : undefined) };
    let error;
    requireIdempotencyKey(req, {}, (err) => (error = err));
    return { req, error };
  };

  it('accepts 1–128 safe characters', () => {
    for (const key of ['a', 'PC.2026-27:sale_bills_with_phone:000123', 'k'.repeat(128), '3f2b8c1e-uuid']) {
      const { req, error } = run(key);
      assert.equal(error, undefined, key);
      assert.equal(req.idempotencyKey, key);
    }
  });

  it('rejects a missing, too long or unsafe key with 400', () => {
    for (const key of [undefined, '', 'k'.repeat(129), 'has space', 'semi;colon', 'ünïcode']) {
      const { error } = run(key);
      assert.equal(error?.status, 400, String(key));
      assert.equal(error.code, 'BAD_REQUEST');
    }
  });
});

describe('ingest validation', () => {
  it('accepts the sample payload and coerces numbers and text', () => {
    const parsed = ingestBillsSchema.parse(SAMPLE);
    const [bill] = parsed.bills;
    assert.equal(bill.id, '104523');
    assert.equal(bill.total, 1250.5);
    assert.equal(bill.doctor, null);
    assert.equal(bill.homeDelivery, true);
    assert.equal(bill.items[0].mrp, 35.2);
    assert.equal(bill.items[0].expiry, '03/27');
  });

  it('allows null or empty optional fields', () => {
    const payload = clone(SAMPLE);
    Object.assign(payload.bills[0], { series: null, phone: null, patient: '', address: undefined, homeDelivery: 0 });
    payload.bills[0].items[0] = { product: 'X', qty: '', free: null, expiry: 'bad' };
    const [bill] = ingestBillsSchema.parse(payload).bills;
    assert.equal(bill.series, null);
    assert.equal(bill.patient, null);
    assert.equal(bill.address, null);
    assert.equal(bill.homeDelivery, false);
    assert.deepEqual(
      { qty: bill.items[0].qty, free: bill.items[0].free, expiry: bill.items[0].expiry, mrp: bill.items[0].mrp },
      { qty: null, free: null, expiry: null, mrp: null },
    );
  });

  it('cuts long free text to its column size', () => {
    const payload = clone(SAMPLE);
    payload.bills[0].address = 'x'.repeat(900);
    assert.equal(ingestBillsSchema.parse(payload).bills[0].address.length, 500);
  });

  it('rejects more than 1000 bills, no bills and too many items', () => {
    const many = clone(SAMPLE);
    many.bills = Array.from({ length: 1001 }, (_, i) => ({ ...SAMPLE.bills[0], id: i + 1 }));
    assert.equal(ingestBillsSchema.safeParse(many).success, false);

    assert.equal(ingestBillsSchema.safeParse({ ...SAMPLE, bills: [] }).success, false);

    const items = clone(SAMPLE);
    items.bills[0].items = Array.from({ length: 501 }, () => SAMPLE.bills[0].items[0]);
    assert.equal(ingestBillsSchema.safeParse(items).success, false);
  });

  it('rejects broken bills', () => {
    for (const change of [{ id: '' }, { id: 'ü1' }, { billNo: null }, { date: '22/10/2026' }, { total: 'abc' }, { total: 1e12 }]) {
      const payload = clone(SAMPLE);
      Object.assign(payload.bills[0], change);
      assert.equal(ingestBillsSchema.safeParse(payload).success, false, JSON.stringify(change));
    }
    assert.equal(ingestBillsSchema.safeParse({ ...SAMPLE, source: { database: 'PC 2026', job: 'x' } }).success, false);
  });
});

describe('ingest request hash', () => {
  const hash = (payload) => hashIngestRequest(ingestBillsSchema.parse(payload));

  it('is stable for identical payloads and key order', () => {
    const reordered = { bills: SAMPLE.bills.map((b) => Object.fromEntries(Object.entries(b).reverse())), source: SAMPLE.source };
    assert.equal(hash(SAMPLE), hash(clone(SAMPLE)));
    assert.equal(hash(SAMPLE), hash(reordered));
    assert.match(hash(SAMPLE), /^[0-9a-f]{64}$/);
  });

  it('differs when the payload changes', () => {
    const changed = clone(SAMPLE);
    changed.bills[0].items[0].qty = 3;
    const otherDb = { ...clone(SAMPLE), source: { ...SAMPLE.source, database: 'PC.2025-26' } };
    assert.notEqual(hash(SAMPLE), hash(changed));
    assert.notEqual(hash(SAMPLE), hash(otherDb));
  });

  it('serialises canonically', () => {
    assert.equal(canonicalJson({ b: 1, a: [null, { d: 'x', c: undefined }] }), '{"a":[null,{"d":"x"}],"b":1}');
  });
});

describe('bill row mapping', () => {
  const rowFor = (phone) => toBillRow(ingestBillsSchema.parse({ ...SAMPLE, bills: [{ ...SAMPLE.bills[0], phone }] }).bills[0]);

  it('normalises the phone to +91', () => {
    assert.equal(rowFor('98765 43210').phone, '+919876543210');
    assert.equal(rowFor('+91-98765-43210').phone, '+919876543210');
    assert.equal(rowFor(9876543210).phone, '+919876543210');
  });

  it('stores an invalid or missing phone as null', () => {
    for (const phone of ['12345', '0471 2345678', '98765 43210 / 91234 56789', null, '']) {
      assert.equal(rowFor(phone).phone, null, String(phone));
    }
  });

  it('maps fields and items to columns', () => {
    const row = rowFor('9876543210');
    assert.equal(row.source_bill_id, '104523');
    assert.equal(row.bill_no, 'S-2041');
    assert.equal(row.bill_date, '2026-10-22');
    assert.equal(row.home_delivery, true);
    assert.equal(row.patient_name, 'Ramesh Kumar');
    assert.equal(row.items[0].gst_pct, 12);
    assert.equal(row.items[0].expiry, '03/27');
  });
});

describe('heartbeat validation', () => {
  it('accepts the documented heartbeat and strips unknown fields', () => {
    const parsed = heartbeatSchema.parse({
      agentVersion: '1.0.0',
      database: 'PC.2026-27',
      watermarks: { 'PC.2026-27': 104523 },
      outboxCount: 3,
      outboxBytes: 20480,
      oldestPendingAgeSeconds: 12.5,
      lastError: null,
      sentAt: '2026-10-23T10:00:00Z',
      extra: 'dropped',
    });
    assert.equal(parsed.extra, undefined);
    assert.deepEqual(parsed.watermarks, { 'PC.2026-27': 104523 });
  });

  it('bounds its size', () => {
    const watermarks = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`db${i}`, i]));
    assert.equal(heartbeatSchema.safeParse({ watermarks }).success, false);
    assert.equal(heartbeatSchema.parse({ lastError: 'e'.repeat(5000) }).lastError.length, 2000);
  });
});

describe('agent status', () => {
  const now = new Date('2026-10-23T10:00:00Z');
  const ago = (minutes) => new Date(now.getTime() - minutes * 60 * 1000);

  it('reports revoked, never seen, online and stale', () => {
    assert.equal(agentStatus({ isActive: false, lastHeartbeatAt: ago(1) }, now), 'revoked');
    assert.equal(agentStatus({ isActive: true, lastSeenAt: null, lastHeartbeatAt: null }, now), 'never_seen');
    assert.equal(agentStatus({ isActive: true, lastSeenAt: ago(1), lastHeartbeatAt: ago(2) }, now), 'online');
    assert.equal(agentStatus({ isActive: true, lastSeenAt: ago(1), lastHeartbeatAt: ago(11) }, now), 'stale');
    assert.equal(agentStatus({ isActive: true, lastSeenAt: ago(1), lastHeartbeatAt: null }, now), 'stale');
  });
});
