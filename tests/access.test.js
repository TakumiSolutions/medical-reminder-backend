import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeAccess, hasBranches } from '../src/config/permissions.js';
import { grantableModules, resolveAccessAssignment } from '../src/services/userAccessRules.js';

const CENTRAL = 1;
const SPEEDWELL = 2;

const g = (role, permission, module = null) => ({ role, permission, module });
const SUPERADMIN_GRANTS = [
  g('superadmin', 'branches.read'),
  g('superadmin', 'branches.all'),
  g('superadmin', 'modules.all'),
  g('superadmin', 'users.read', 'users'),
  g('superadmin', 'users.manage.admin', 'users'),
  g('superadmin', 'audit_logs.read', 'audit_logs'),
];
const ADMIN_GRANTS = [
  g('admin', 'branches.read'),
  g('admin', 'users.read', 'users'),
  g('admin', 'users.manage.staff', 'users'),
  g('admin', 'audit_logs.read', 'audit_logs'),
];

const roleDef = (code, { allBranches = false, allModules = false, modules = [] } = {}) => ({
  code,
  name: code,
  allBranches,
  allModules,
  modules: modules.map((m) => ({ code: m, name: m })),
});
const STAFF_ROLE = roleDef('staff', { modules: ['customers', 'orders'] });
const ADMIN_ROLE = roleDef('admin', { modules: ['users', 'audit_logs'] });
const SUPERADMIN_ROLE = roleDef('superadmin', { allBranches: true, allModules: true });

describe('computeAccess', () => {
  it('gives Superadmin every permission, branch and module regardless of assignments', () => {
    const access = computeAccess(SUPERADMIN_GRANTS, [], []);
    assert.equal(access.branchIds, null);
    assert.equal(access.modules, null);
    assert.ok(access.permissions.has('audit_logs.read'));
    assert.ok(access.permissions.has('users.manage.admin'));
  });

  it('drops module permissions for modules not granted to the user', () => {
    const access = computeAccess(ADMIN_GRANTS, ['users'], [CENTRAL]);
    assert.ok(access.permissions.has('users.read'));
    assert.ok(access.permissions.has('branches.read'), 'non-module permissions are kept');
    assert.equal(access.permissions.has('audit_logs.read'), false);
    assert.deepEqual(access.modules, ['users']);
    assert.deepEqual(access.branchIds, [CENTRAL]);
  });

  it('ignores granted modules the role does not support', () => {
    const access = computeAccess(ADMIN_GRANTS, ['users', 'campaigns'], [CENTRAL]);
    assert.deepEqual(access.modules, ['users']);
  });

  it('limits a user with no branches to nothing', () => {
    const access = computeAccess(ADMIN_GRANTS, ['users'], []);
    assert.deepEqual(access.branchIds, []);
    assert.equal(hasBranches(access, [CENTRAL]), false);
  });
});

describe('resolveAccessAssignment', () => {
  const superadmin = { branchIds: null, modules: null };
  const centralAdmin = { branchIds: [CENTRAL], modules: ['customers', 'users'] };
  const base = { activeBranchIds: [CENTRAL, SPEEDWELL], requestedModules: [] };

  it('lets Superadmin assign any branch and module', () => {
    const result = resolveAccessAssignment({
      ...base,
      actor: superadmin,
      roleDef: STAFF_ROLE,
      requestedBranchIds: [SPEEDWELL, CENTRAL],
      requestedModules: ['orders', 'customers'],
    });
    assert.deepEqual(result, { branchIds: [CENTRAL, SPEEDWELL], modules: ['customers', 'orders'] });
  });

  it('requires at least one branch for branch-limited roles', () => {
    assert.throws(
      () => resolveAccessAssignment({ ...base, actor: superadmin, roleDef: STAFF_ROLE, requestedBranchIds: [] }),
      { status: 400 },
    );
  });

  it('stores no branches or modules for Superadmin accounts', () => {
    const result = resolveAccessAssignment({
      ...base,
      actor: superadmin,
      roleDef: SUPERADMIN_ROLE,
      requestedBranchIds: [CENTRAL],
      requestedModules: ['users'],
    });
    assert.deepEqual(result, { branchIds: [], modules: [] });
  });

  it('stops an Admin assigning a branch they do not have', () => {
    assert.throws(
      () =>
        resolveAccessAssignment({ ...base, actor: centralAdmin, roleDef: STAFF_ROLE, requestedBranchIds: [SPEEDWELL] }),
      { status: 403 },
    );
  });

  it('stops an Admin granting a page they do not have', () => {
    assert.throws(
      () =>
        resolveAccessAssignment({
          ...base,
          actor: centralAdmin,
          roleDef: STAFF_ROLE,
          requestedBranchIds: [CENTRAL],
          requestedModules: ['orders'],
        }),
      { status: 403 },
    );
  });

  it('rejects pages the role does not support', () => {
    assert.throws(
      () =>
        resolveAccessAssignment({
          ...base,
          actor: superadmin,
          roleDef: STAFF_ROLE,
          requestedBranchIds: [CENTRAL],
          requestedModules: ['users'],
        }),
      { status: 400 },
    );
  });

  it('rejects unknown branches', () => {
    assert.throws(
      () => resolveAccessAssignment({ ...base, actor: superadmin, roleDef: STAFF_ROLE, requestedBranchIds: [99] }),
      { status: 400 },
    );
  });

  it('keeps pages an Admin cannot grant when they edit a user', () => {
    const result = resolveAccessAssignment({
      ...base,
      actor: centralAdmin,
      roleDef: STAFF_ROLE,
      requestedBranchIds: [CENTRAL],
      currentModules: ['orders', 'customers'],
      requestedModules: [],
    });
    // 'customers' was removed by the admin; 'orders' is outside their reach and stays.
    assert.deepEqual(result.modules, ['orders']);
  });

  it('only offers pages that both the role supports and the actor holds', () => {
    assert.deepEqual(grantableModules(centralAdmin, STAFF_ROLE), ['customers']);
    assert.deepEqual(grantableModules(superadmin, ADMIN_ROLE), ['users', 'audit_logs']);
    assert.deepEqual(grantableModules(superadmin, SUPERADMIN_ROLE), []);
  });
});
