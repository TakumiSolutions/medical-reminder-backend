// Medicine reminders: per customer medicine, three reminder days (N, N+1, N+2) counted
// from the medicine's last bill date. One cycle per scheduling; it does not repeat.

const MODULE = { code: 'reminders', name: 'Reminders', sort_order: 8 };
const PERMISSIONS = [
  { code: 'reminders.read', description: 'View reminders', module_code: MODULE.code },
  { code: 'reminders.manage', description: 'Schedule and stop reminders', module_code: MODULE.code },
];
// Role ceiling: any role may be given the page; Superadmin/Admin decide per user.
const ROLES = ['superadmin', 'admin', 'staff'];

export async function up(knex) {
  await knex.schema.alterTable('customer_medicines', (t) => {
    // Date of the bill this medicine was taken from; reminder days count from it.
    t.date('last_bill_date').nullable().after('medicine');
  });

  await knex.schema.createTable('reminder_cycles', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('customer_id').unsigned().notNullable().references('customers.id').onDelete('RESTRICT');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.string('medicine', 100).notNullable();
    t.date('start_date').notNullable();
    t.smallint('interval_days').unsigned().notNullable();
    t.enum('status', ['active', 'cancelled']).notNullable().defaultTo('active');
    t.string('cancel_reason', 255).nullable();
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.bigInteger('cancelled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('cancelled_at').nullable();
    t.index(['customer_id', 'branch_id', 'medicine', 'status']);
    t.index(['branch_id', 'status']);
  });

  await knex.schema.createTable('reminders', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('cycle_id').unsigned().notNullable().references('reminder_cycles.id').onDelete('CASCADE');
    // N, N+1 or N+2 days after the cycle's start date.
    t.smallint('day_number').unsigned().notNullable();
    t.date('scheduled_date').notNullable();
    // skipped = the date had already passed when scheduled; sent/failed are set once
    // WhatsApp sending is connected.
    t.enum('status', ['scheduled', 'sent', 'failed', 'skipped', 'cancelled']).notNullable();
    t.dateTime('status_changed_at').nullable();
    t.unique(['cycle_id', 'day_number']);
    t.index(['scheduled_date', 'status']);
  });

  await knex('modules').insert(MODULE);
  await knex('permissions').insert(PERMISSIONS);
  const permissionIds = await knex('permissions').whereIn('code', PERMISSIONS.map((p) => p.code)).pluck('id');
  const roleIds = await knex('roles').whereIn('code', ROLES).pluck('id');
  await knex('role_permissions').insert(
    roleIds.flatMap((roleId) => permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId }))),
  );
}

export async function down(knex) {
  const permissionIds = await knex('permissions').whereIn('code', PERMISSIONS.map((p) => p.code)).pluck('id');
  await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  await knex('permissions').whereIn('id', permissionIds).delete();
  await knex('user_modules').where({ module_code: MODULE.code }).delete();
  await knex('modules').where({ code: MODULE.code }).delete();

  await knex.schema.dropTable('reminders');
  await knex.schema.dropTable('reminder_cycles');
  await knex.schema.alterTable('customer_medicines', (t) => {
    t.dropColumn('last_bill_date');
  });
}
