import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignableRoles, canManageAnyUsers, canManageRoles } from '../src/config/permissions.js';
import { requireAllowedOrigin } from '../src/middleware/originCheck.js';
import { hashPassword, verifyPassword } from '../src/utils/password.js';
import { createUserSchema, updateUserSchema } from '../src/validators/userValidators.js';

const SUPERADMIN = new Set(['users.read', 'users.manage.staff', 'users.manage.admin', 'users.manage.superadmin']);
const ADMIN = new Set(['users.read', 'users.manage.staff']);
const STAFF = new Set(['branches.read']);

describe('password hashing', () => {
  it('verifies the correct password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
  });

  it('salts each hash', async () => {
    assert.notEqual(await hashPassword('same-password'), await hashPassword('same-password'));
  });

  it('rejects malformed stored hashes', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  });
});

describe('user management permissions', () => {
  it('lets Superadmin manage every role', () => {
    assert.deepEqual(assignableRoles(SUPERADMIN), ['superadmin', 'admin', 'staff']);
    assert.equal(canManageRoles(SUPERADMIN, ['superadmin']), true);
  });

  it('limits Admin to Staff accounts', () => {
    assert.deepEqual(assignableRoles(ADMIN), ['staff']);
    assert.equal(canManageRoles(ADMIN, ['staff']), true);
    assert.equal(canManageRoles(ADMIN, ['admin']), false);
    assert.equal(canManageRoles(ADMIN, ['superadmin']), false);
    assert.equal(canManageRoles(ADMIN, ['staff', 'admin']), false);
  });

  it('gives Staff no user management', () => {
    assert.equal(canManageAnyUsers(STAFF), false);
    assert.equal(canManageRoles(STAFF, ['staff']), false);
  });
});

describe('user validators', () => {
  const valid = { username: '  Jane.Doe ', fullName: ' Jane Doe ', password: 'longenough', role: 'staff' };

  it('normalizes username and trims full name', () => {
    const parsed = createUserSchema.parse(valid);
    assert.equal(parsed.username, 'jane.doe');
    assert.equal(parsed.fullName, 'Jane Doe');
  });

  it('rejects unknown roles, short passwords and bad usernames', () => {
    assert.equal(createUserSchema.safeParse({ ...valid, role: 'owner' }).success, false);
    assert.equal(createUserSchema.safeParse({ ...valid, password: 'short' }).success, false);
    assert.equal(createUserSchema.safeParse({ ...valid, username: 'has space' }).success, false);
  });

  it('rejects empty updates', () => {
    assert.equal(updateUserSchema.safeParse({}).success, false);
    assert.equal(updateUserSchema.safeParse({ isActive: false }).success, true);
  });
});

describe('origin check', () => {
  const check = requireAllowedOrigin(['http://localhost:5173']);
  const run = (method, headers) =>
    new Promise((resolve) => check({ method, get: (name) => headers[name] }, null, resolve));

  it('allows safe methods without an origin', async () => {
    assert.equal(await run('GET', {}), undefined);
  });

  it('allows state changes from an allowed origin or referer', async () => {
    assert.equal(await run('POST', { origin: 'http://localhost:5173' }), undefined);
    assert.equal(await run('POST', { referer: 'http://localhost:5173/users' }), undefined);
  });

  it('blocks state changes from other or missing origins', async () => {
    assert.equal((await run('POST', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await run('DELETE', {})).status, 403);
  });
});
