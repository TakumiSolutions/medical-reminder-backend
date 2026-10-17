import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeIndianMobile } from '../src/utils/phone.js';
import { createCustomerSchema, updateCustomerSchema } from '../src/validators/customerValidators.js';

describe('normalizeIndianMobile', () => {
  it('accepts common Indian formats', () => {
    for (const input of ['9876543210', '98765 43210', '+91 98765-43210', '919876543210', '09876543210', '0091 9876543210', 9876543210]) {
      assert.deepEqual(normalizeIndianMobile(input), { ok: true, value: '+919876543210' }, String(input));
    }
  });

  it('rejects landlines, short numbers, letters and multiple numbers', () => {
    for (const input of ['', null, '0281 2345678', '12345', '5876543210', '98765abc10', '9876543210 / 9123456789']) {
      assert.equal(normalizeIndianMobile(input).ok, false, String(input));
    }
  });
});

describe('customer validators', () => {
  it('normalizes mobile and blanks', () => {
    const parsed = createCustomerSchema.parse({ fullName: ' Rishit ', mobile: '98765 43210', address: '', branchIds: [1, 1] });
    assert.deepEqual(parsed, { fullName: 'Rishit', mobile: '+919876543210', address: null, branchIds: [1] });
  });

  it('requires a branch and a valid mobile', () => {
    assert.equal(createCustomerSchema.safeParse({ fullName: 'A', mobile: '123', branchIds: [1] }).success, false);
    assert.equal(createCustomerSchema.safeParse({ fullName: 'A', mobile: '9876543210', branchIds: [] }).success, false);
  });

  it('keeps omitted fields out of partial updates but lets them be cleared', () => {
    assert.deepEqual(updateCustomerSchema.parse({ notes: 'VIP' }), { notes: 'VIP' });
    assert.deepEqual(updateCustomerSchema.parse({ address: '' }), { address: null });
    assert.equal(updateCustomerSchema.safeParse({}).success, false);
  });
});
