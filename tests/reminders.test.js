import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planReminderDays } from '../src/services/reminderRules.js';
import { addDays, todayIn, toIsoDate } from '../src/utils/dates.js';
import { scheduleRemindersSchema } from '../src/validators/reminderValidators.js';

describe('date helpers', () => {
  it('adds days across month and leap-year boundaries', () => {
    assert.equal(addDays('2026-10-17', 27), '2026-11-13');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it("uses the app timezone for today's date", () => {
    // 20:00 UTC on 17 Oct is already 18 Oct in India.
    const instant = new Date('2026-10-17T20:00:00Z');
    assert.equal(todayIn('Asia/Kolkata', instant), '2026-10-18');
    assert.equal(todayIn('UTC', instant), '2026-10-17');
  });

  it('normalizes DATE values', () => {
    assert.equal(toIsoDate(new Date('2026-10-17T00:00:00Z')), '2026-10-17');
    assert.equal(toIsoDate('2026-10-17'), '2026-10-17');
    assert.equal(toIsoDate(null), null);
  });
});

describe('planReminderDays', () => {
  it('plans days N, N+1, N+2 from the last bill date', () => {
    assert.deepEqual(planReminderDays({ startDate: '2026-10-17', intervalDays: 27, today: '2026-10-17' }), [
      { dayNumber: 27, scheduledDate: '2026-11-13', status: 'scheduled' },
      { dayNumber: 28, scheduledDate: '2026-11-14', status: 'scheduled' },
      { dayNumber: 29, scheduledDate: '2026-11-15', status: 'scheduled' },
    ]);
  });

  it('marks dates that have already passed as skipped, keeping today', () => {
    const days = planReminderDays({ startDate: '2026-09-20', intervalDays: 27, today: '2026-10-18' });
    assert.deepEqual(
      days.map((d) => [d.scheduledDate, d.status]),
      [
        ['2026-10-17', 'skipped'],
        ['2026-10-18', 'scheduled'],
        ['2026-10-19', 'scheduled'],
      ],
    );
  });
});

describe('schedule validator', () => {
  const item = { branchId: 1, medicine: 'TELMA 40', intervalDays: 27 };

  it('accepts a valid request', () => {
    assert.equal(scheduleRemindersSchema.safeParse({ customerId: '5', items: [item] }).success, true);
  });

  it('rejects zero/too many days, fractions, duplicates and empty lists', () => {
    for (const intervalDays of [0, 366, 2.5]) {
      assert.equal(scheduleRemindersSchema.safeParse({ customerId: '5', items: [{ ...item, intervalDays }] }).success, false);
    }
    assert.equal(scheduleRemindersSchema.safeParse({ customerId: '5', items: [item, item] }).success, false);
    assert.equal(scheduleRemindersSchema.safeParse({ customerId: '5', items: [] }).success, false);
  });
});

describe('outcome validator', async () => {
  const { recordOutcomeSchema } = await import('../src/validators/reminderValidators.js');

  it('ordered needs delivery details: an address for delivery, nothing for pickup', () => {
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'ordered' }).success, false);
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'ordered', delivery: { method: 'delivery' } }).success, false);
    assert.equal(
      recordOutcomeSchema.safeParse({ outcome: 'ordered', delivery: { method: 'delivery', address: '  ' } }).success,
      false,
    );
    assert.deepEqual(
      recordOutcomeSchema.parse({ outcome: 'ordered', delivery: { method: 'delivery', address: ' Raiya Road ' } }),
      { outcome: 'ordered', delivery: { method: 'delivery', address: 'Raiya Road', saveAddress: false } },
    );
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'ordered', delivery: { method: 'pickup' } }).success, true);
  });

  it('refused needs a reason', () => {
    assert.deepEqual(recordOutcomeSchema.parse({ outcome: 'refused', reason: '  Bought elsewhere ' }), {
      outcome: 'refused',
      reason: 'Bought elsewhere',
    });
  });

  it('requires a reason to refuse and rejects unknown outcomes', () => {
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'refused' }).success, false);
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'refused', reason: '   ' }).success, false);
    assert.equal(recordOutcomeSchema.safeParse({ outcome: 'maybe' }).success, false);
  });
});

describe('delivery transitions', async () => {
  const { canTransition } = await import('../src/services/deliveryRules.js');

  it('home delivery goes pending → out for delivery → delivered', () => {
    assert.equal(canTransition('delivery', 'pending', 'out_for_delivery'), true);
    assert.equal(canTransition('delivery', 'out_for_delivery', 'delivered'), true);
    assert.equal(canTransition('delivery', 'pending', 'delivered'), false);
  });

  it('store pickup skips out for delivery', () => {
    assert.equal(canTransition('pickup', 'pending', 'delivered'), true);
    assert.equal(canTransition('pickup', 'pending', 'out_for_delivery'), false);
  });

  it('failed can be retried; delivered and cancelled are final', () => {
    assert.equal(canTransition('delivery', 'out_for_delivery', 'failed'), true);
    assert.equal(canTransition('delivery', 'failed', 'pending'), true);
    for (const to of ['pending', 'failed', 'out_for_delivery']) {
      assert.equal(canTransition('delivery', 'delivered', to), false);
      assert.equal(canTransition('delivery', 'cancelled', to), false);
    }
  });
});

describe('dayBoundsUtc', async () => {
  const { dayBoundsUtc } = await import('../src/utils/dates.js');

  it('gives the UTC range of an India calendar day', () => {
    // 17 Oct in India = 16 Oct 18:30 UTC to 17 Oct 18:30 UTC.
    assert.deepEqual(dayBoundsUtc('2026-10-17', 'Asia/Kolkata'), {
      start: '2026-10-16 18:30:00',
      end: '2026-10-17 18:30:00',
    });
    assert.deepEqual(dayBoundsUtc('2026-10-17', 'UTC'), { start: '2026-10-17 00:00:00', end: '2026-10-18 00:00:00' });
  });
});
