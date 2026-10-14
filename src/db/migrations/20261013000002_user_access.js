// Per-user branch and page (module) access, plus audit-log viewing.
//
// Effective permissions = role permissions, keeping module-gated permissions only for
// modules granted to the user. `modules.all` and `branches.all` bypass the per-user lists.

const MODULES = [
  { code: 'users', name: 'Users', sort_order: 10 },
  { code: 'audit_logs', name: 'Audit log', sort_order: 20 },
];

const PERMISSION_MODULES = {
  'users.read': 'users',
  'users.manage.staff': 'users',
  'users.manage.admin': 'users',
  'users.manage.superadmin': 'users',
};

const NEW_PERMISSIONS = [
  { code: 'audit_logs.read', description: 'View the audit log', module_code: 'audit_logs' },
  { code: 'branches.all', description: 'Access every branch without assignment', module_code: null },
  { code: 'modules.all', description: 'Access every page without assignment', module_code: null },
];

const NEW_ROLE_PERMISSIONS = {
  superadmin: ['audit_logs.read', 'branches.all', 'modules.all'],
  admin: ['audit_logs.read'],
};

export async function up(knex) {
  await knex.schema.createTable('modules', (t) => {
    t.string('code', 50).primary();
    t.string('name', 100).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
  });
  await knex('modules').insert(MODULES);

  await knex.schema.alterTable('permissions', (t) => {
    t.string('module_code', 50).nullable().references('modules.code').onDelete('RESTRICT');
  });
  for (const [code, moduleCode] of Object.entries(PERMISSION_MODULES)) {
    await knex('permissions').where({ code }).update({ module_code: moduleCode });
  }
  await knex('permissions').insert(NEW_PERMISSIONS);

  const roleIds = Object.fromEntries((await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]));
  const permissionIds = Object.fromEntries(
    (await knex('permissions').select('id', 'code')).map((p) => [p.code, p.id]),
  );
  await knex('role_permissions').insert(
    Object.entries(NEW_ROLE_PERMISSIONS).flatMap(([role, codes]) =>
      codes.map((code) => ({ role_id: roleIds[role], permission_id: permissionIds[code] })),
    ),
  );

  await knex.schema.createTable('user_branches', (t) => {
    t.bigInteger('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.primary(['user_id', 'branch_id']);
  });

  await knex.schema.createTable('user_modules', (t) => {
    t.bigInteger('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('module_code', 50).notNullable().references('modules.code').onDelete('RESTRICT');
    t.primary(['user_id', 'module_code']);
  });

  // Preserve current access for existing users: grant every module their role supports.
  await knex.raw(`
    INSERT INTO user_modules (user_id, module_code)
    SELECT DISTINCT ur.user_id, p.module_code
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.module_code IS NOT NULL
  `);

  // Lets future branch-specific events be shown only to users with access to that branch.
  await knex.schema.alterTable('audit_logs', (t) => {
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.index(['action']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('audit_logs', (t) => {
    t.dropForeign(['branch_id']);
    t.dropIndex(['action']);
    t.dropColumn('branch_id');
  });
  await knex.schema.dropTable('user_modules');
  await knex.schema.dropTable('user_branches');

  const codes = NEW_PERMISSIONS.map((p) => p.code);
  const ids = (await knex('permissions').whereIn('code', codes).select('id')).map((p) => p.id);
  await knex('role_permissions').whereIn('permission_id', ids).delete();
  await knex('permissions').whereIn('id', ids).delete();

  await knex.schema.alterTable('permissions', (t) => {
    t.dropForeign(['module_code']);
    t.dropColumn('module_code');
  });
  await knex.schema.dropTable('modules');
}
