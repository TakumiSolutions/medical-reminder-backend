// Read-only page listing customers from the ProntoZ export database.

const MODULE = { code: 'prontoz_customers', name: 'ProntoZ customers', sort_order: 7 };
const PERMISSION = { code: 'prontoz_customers.read', description: 'View customers from the ProntoZ export', module_code: MODULE.code };
// Role ceiling: any role may be given the page; Superadmin/Admin decide per user.
const ROLES = ['superadmin', 'admin', 'staff'];

export async function up(knex) {
  await knex('modules').insert(MODULE);
  await knex('permissions').insert(PERMISSION);
  const permissionId = (await knex('permissions').where({ code: PERMISSION.code }).first('id')).id;
  const roleIds = await knex('roles').whereIn('code', ROLES).pluck('id');
  await knex('role_permissions').insert(roleIds.map((roleId) => ({ role_id: roleId, permission_id: permissionId })));
}

export async function down(knex) {
  const permission = await knex('permissions').where({ code: PERMISSION.code }).first('id');
  if (permission) {
    await knex('role_permissions').where({ permission_id: permission.id }).delete();
    await knex('permissions').where({ id: permission.id }).delete();
  }
  await knex('user_modules').where({ module_code: MODULE.code }).delete();
  await knex('modules').where({ code: MODULE.code }).delete();
}
