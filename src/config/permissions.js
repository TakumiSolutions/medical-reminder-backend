// Permission codes as seeded in the database. Role -> permission mapping lives in the
// role_permissions table, never in route code.
export const PERMISSIONS = Object.freeze({
  BRANCHES_READ: 'branches.read',
  BRANCHES_ALL: 'branches.all',
  MODULES_ALL: 'modules.all',
  USERS_READ: 'users.read',
  AUDIT_LOGS_READ: 'audit_logs.read',
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_MANAGE: 'customers.manage',
  PRONTOZ_CUSTOMERS_READ: 'prontoz_customers.read',
  REMINDERS_READ: 'reminders.read',
  REMINDERS_MANAGE: 'reminders.manage',
  DELIVERIES_READ: 'deliveries.read',
  DELIVERIES_MANAGE: 'deliveries.manage',
  AGENTS_MANAGE: 'agents.manage',
});

export const ROLE_CODES = Object.freeze(['superadmin', 'admin', 'staff']);

const managePermissionFor = (roleCode) => `users.manage.${roleCode}`;

/**
 * Builds a user's effective access.
 * @param grants       rows of { role, permission, module } from the user's roles (permission/module may be null)
 * @param userModules  module codes granted to the user
 * @param userBranchIds branch ids assigned to the user
 * @returns {{ roles: string[], permissions: Set<string>, modules: string[] | null, branchIds: number[] | null }}
 *          `modules`/`branchIds` are null when the user has access to all of them.
 */
export function computeAccess(grants, userModules, userBranchIds) {
  const roles = [...new Set(grants.map((g) => g.role))];
  const rolePermissions = new Set(grants.map((g) => g.permission).filter(Boolean));

  const allModules = rolePermissions.has(PERMISSIONS.MODULES_ALL);
  const grantedModules = new Set(userModules);
  const permissions = new Set(
    grants
      .filter((g) => g.permission && (!g.module || allModules || grantedModules.has(g.module)))
      .map((g) => g.permission),
  );

  // Only modules the role actually supports count as granted.
  const roleModules = new Set(grants.map((g) => g.module).filter(Boolean));
  const modules = allModules ? null : [...grantedModules].filter((m) => roleModules.has(m)).sort();
  const branchIds = rolePermissions.has(PERMISSIONS.BRANCHES_ALL)
    ? null
    : [...new Set(userBranchIds.map(Number))].sort((a, b) => a - b);

  return { roles, permissions, modules, branchIds };
}

/** True if the holder of `permissions` may manage accounts holding every role in `roleCodes`. */
export function canManageRoles(permissions, roleCodes) {
  return roleCodes.every((role) => permissions.has(managePermissionFor(role)));
}

/** Role codes the holder of `permissions` may assign. */
export function assignableRoles(permissions) {
  return ROLE_CODES.filter((role) => permissions.has(managePermissionFor(role)));
}

/** True if the holder of `permissions` may manage at least one kind of account. */
export function canManageAnyUsers(permissions) {
  return assignableRoles(permissions).length > 0;
}

/** True if `access` covers every branch in `branchIds`. */
export function hasBranches(access, branchIds) {
  if (access.branchIds === null) return true;
  const own = new Set(access.branchIds);
  return branchIds.every((id) => own.has(Number(id)));
}

