// Deliveries created when a reminded customer orders. Home delivery goes
// pending → out_for_delivery → delivered; store pickup goes pending → delivered (picked up).
// Either can fail (with a reason). Undoing the order cancels a delivery that has not left.

const MODULE = { code: 'deliveries', name: 'Deliveries', sort_order: 9 };
const PERMISSIONS = [
  { code: 'deliveries.read', description: 'View deliveries', module_code: MODULE.code },
  { code: 'deliveries.manage', description: 'Assign deliveries and update their status', module_code: MODULE.code },
];
// Role ceiling: any role may be given the page; Superadmin/Admin decide per user.
const ROLES = ['superadmin', 'admin', 'staff'];
const STATUSES = ['pending', 'out_for_delivery', 'delivered', 'failed', 'cancelled'];

export async function up(knex) {
  await knex.schema.createTable('deliveries', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('reminder_cycle_id').unsigned().nullable().references('reminder_cycles.id').onDelete('RESTRICT');
    t.bigInteger('customer_id').unsigned().notNullable().references('customers.id').onDelete('RESTRICT');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.enum('method', ['delivery', 'pickup']).notNullable();
    // Required for home delivery; null for store pickup.
    t.string('address', 500).nullable();
    t.enum('status', STATUSES).notNullable().defaultTo('pending');
    t.bigInteger('assigned_to').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('failure_reason', 500).nullable();
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('delivered_at').nullable();
    t.index(['branch_id', 'status']);
    t.index(['assigned_to', 'status']);
    t.index(['reminder_cycle_id']);
  });

  await knex.schema.createTable('delivery_status_history', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('delivery_id').unsigned().notNullable().references('deliveries.id').onDelete('CASCADE');
    t.enum('from_status', STATUSES).nullable();
    t.enum('to_status', STATUSES).notNullable();
    t.string('note', 500).nullable();
    t.bigInteger('changed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['delivery_id', 'created_at']);
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
  await knex.schema.dropTable('delivery_status_history');
  await knex.schema.dropTable('deliveries');
}
