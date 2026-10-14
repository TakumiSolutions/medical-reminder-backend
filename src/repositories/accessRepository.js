import { computeAccess } from '../config/permissions.js';
import { db } from '../db/knex.js';

/** Effective roles, permissions, modules and branches for a user. */
export async function loadAccess(userId, conn = db) {
  const [grants, modules, branches] = await Promise.all([
    conn('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .leftJoin('role_permissions', 'role_permissions.role_id', 'roles.id')
      .leftJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('user_roles.user_id', userId)
      .select('roles.code as role', 'permissions.code as permission', 'permissions.module_code as module'),
    conn('user_modules').where({ user_id: userId }).pluck('module_code'),
    conn('user_branches').where({ user_id: userId }).pluck('branch_id'),
  ]);
  return computeAccess(grants, modules, branches);
}

/** For each role: its name, the modules it supports, and whether it is branch-limited. */
export async function loadRoleDefinitions(conn = db) {
  const [roles, rows, modules] = await Promise.all([
    conn('roles').select('code', 'name').orderBy('id'),
    conn('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .select('roles.code as role', 'permissions.code as permission', 'permissions.module_code as module'),
    listModules(conn),
  ]);

  return Object.fromEntries(
    roles.map((role) => {
      const own = rows.filter((r) => r.role === role.code);
      const permissions = new Set(own.map((r) => r.permission));
      const moduleCodes = permissions.has('modules.all')
        ? modules.map((m) => m.code)
        : [...new Set(own.map((r) => r.module).filter(Boolean))];
      return [
        role.code,
        {
          code: role.code,
          name: role.name,
          allModules: permissions.has('modules.all'),
          allBranches: permissions.has('branches.all'),
          modules: modules.filter((m) => moduleCodes.includes(m.code)),
        },
      ];
    }),
  );
}

export async function listModules(conn = db) {
  return conn('modules').select('code', 'name').orderBy('sort_order');
}

export async function listActiveBranches(conn = db) {
  const rows = await conn('branches').where({ is_active: true }).select('id', 'code', 'name').orderBy('id');
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name }));
}

export async function setUserBranches(conn, userId, branchIds) {
  await conn('user_branches').where({ user_id: userId }).delete();
  if (branchIds.length) {
    await conn('user_branches').insert(branchIds.map((branchId) => ({ user_id: userId, branch_id: branchId })));
  }
}

export async function setUserModules(conn, userId, moduleCodes) {
  await conn('user_modules').where({ user_id: userId }).delete();
  if (moduleCodes.length) {
    await conn('user_modules').insert(moduleCodes.map((code) => ({ user_id: userId, module_code: code })));
  }
}
