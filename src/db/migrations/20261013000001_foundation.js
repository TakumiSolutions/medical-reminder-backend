// Phase 1 foundation: branches, RBAC, users, sessions and audit log.
// Seed values are written as literals so this migration stays a fixed snapshot.

const BRANCHES = [
  { code: 'central', name: 'Central' },
  { code: 'speedwell', name: 'Speedwell' },
];

const ROLES = [
  { code: 'superadmin', name: 'Superadmin' },
  { code: 'admin', name: 'Admin' },
  { code: 'staff', name: 'Staff' },
];

const PERMISSIONS = [
  { code: 'branches.read', description: 'View pharmacy branches' },
  { code: 'users.read', description: 'View user accounts' },
  { code: 'users.manage.staff', description: 'Create and manage Staff accounts' },
  { code: 'users.manage.admin', description: 'Create and manage Admin accounts' },
  { code: 'users.manage.superadmin', description: 'Create and manage Superadmin accounts' },
];

// Confirmed: Superadmin manages all users; Admin manages Staff only.
const ROLE_PERMISSIONS = {
  superadmin: [
    'branches.read',
    'users.read',
    'users.manage.staff',
    'users.manage.admin',
    'users.manage.superadmin',
  ],
  admin: ['branches.read', 'users.read', 'users.manage.staff'],
  staff: ['branches.read'],
};

export async function up(knex) {
  await knex.schema.createTable('branches', (t) => {
    t.increments('id').primary();
    t.string('code', 50).notNullable().unique();
    t.string('name', 100).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('roles', (t) => {
    t.increments('id').primary();
    t.string('code', 50).notNullable().unique();
    t.string('name', 100).notNullable();
  });

  await knex.schema.createTable('permissions', (t) => {
    t.increments('id').primary();
    t.string('code', 100).notNullable().unique();
    t.string('description', 255).notNullable();
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.integer('permission_id').unsigned().notNullable().references('permissions.id').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  await knex.schema.createTable('users', (t) => {
    t.bigIncrements('id').primary();
    // Stored lower-cased; uniqueness is enforced on the normalized value.
    t.string('username', 50).notNullable().unique();
    t.string('full_name', 150).notNullable();
    t.string('password_hash', 255).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.dateTime('last_login_at').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // A user may hold more than one role if the business later requires it.
  await knex.schema.createTable('user_roles', (t) => {
    t.bigInteger('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('RESTRICT');
    t.primary(['user_id', 'role_id']);
  });

  await knex.schema.createTable('sessions', (t) => {
    // SHA-256 of the opaque token held in the cookie; the raw token is never stored.
    t.string('token_hash', 64).primary();
    t.bigInteger('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('expires_at').notNullable();
    t.dateTime('revoked_at').nullable();
    t.index(['user_id']);
    t.index(['expires_at']);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('actor_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('action', 100).notNullable();
    t.string('entity_type', 50).nullable();
    t.string('entity_id', 64).nullable();
    t.json('details').nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['entity_type', 'entity_id']);
    t.index(['actor_user_id']);
    t.index(['created_at']);
  });

  await knex('branches').insert(BRANCHES);
  await knex('roles').insert(ROLES);
  await knex('permissions').insert(PERMISSIONS);

  const roleIds = Object.fromEntries((await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]));
  const permissionIds = Object.fromEntries(
    (await knex('permissions').select('id', 'code')).map((p) => [p.code, p.id]),
  );
  const rows = Object.entries(ROLE_PERMISSIONS).flatMap(([role, codes]) =>
    codes.map((code) => ({ role_id: roleIds[role], permission_id: permissionIds[code] })),
  );
  await knex('role_permissions').insert(rows);
}

export async function down(knex) {
  await knex.schema.dropTable('audit_logs');
  await knex.schema.dropTable('sessions');
  await knex.schema.dropTable('user_roles');
  await knex.schema.dropTable('users');
  await knex.schema.dropTable('role_permissions');
  await knex.schema.dropTable('permissions');
  await knex.schema.dropTable('roles');
  await knex.schema.dropTable('branches');
}
