// RxBridge desktop agents: one per pharmacy PC, authenticated by a bearer token, pushing
// sale bills (with the customer's phone) read from the branch's billing database.
// Bills are only stored here; nothing is created in `customers` from them yet.

const MODULE = { code: 'agents', name: 'Desktop agents', sort_order: 70 };
const PERMISSION = {
  code: 'agents.manage',
  description: 'Manage desktop agents and view the bills they send',
  module_code: MODULE.code,
};
// Role ceiling: tokens give write access to bill data, so Superadmin only.
const ROLES = ['superadmin'];

export async function up(knex) {
  await knex.schema.createTable('agents', (t) => {
    t.bigIncrements('id').primary();
    t.string('name', 100).notNullable();
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    // SHA-256 of the bearer token; the raw token is shown once and never stored.
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    // First characters of the token, so staff can tell which token a PC holds.
    t.string('token_prefix', 12).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('revoked_at').nullable();
    t.dateTime('last_seen_at').nullable();
    t.dateTime('last_heartbeat_at').nullable();
    t.json('last_heartbeat').nullable();
  });

  await knex.schema.createTable('agent_bills', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('agent_id').unsigned().notNullable().references('agents.id').onDelete('RESTRICT');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    // Billing database the bill came from, e.g. "PC.2026-27"; bill ids restart each financial year.
    // Binary ASCII collation so ids match exactly (the API only accepts printable ASCII).
    t.specificType('source_database', 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin').notNullable();
    // The billing system's own bill id (TagBillingRef).
    t.specificType('source_bill_id', 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin').notNullable();
    t.string('bill_no', 40).notNullable();
    t.string('series', 20).nullable();
    t.boolean('home_delivery').notNullable().defaultTo(false);
    t.date('bill_date').notNullable();
    // +91XXXXXXXXXX, or null when the bill's phone is not a valid Indian mobile.
    t.string('phone', 16).nullable();
    t.string('patient_name', 150).nullable();
    t.string('address', 500).nullable();
    t.string('doctor', 150).nullable();
    t.decimal('total', 12, 2).notNullable();
    t.integer('item_count').unsigned().notNullable().defaultTo(0);
    t.dateTime('first_received_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['agent_id', 'source_database', 'source_bill_id']);
    t.index(['branch_id', 'bill_date']);
    t.index(['phone']);
  });

  await knex.schema.createTable('agent_bill_items', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('agent_bill_id').unsigned().notNullable().references('agent_bills.id').onDelete('CASCADE');
    t.smallint('line_no').unsigned().notNullable();
    t.string('product', 200).nullable();
    t.string('pack', 40).nullable();
    t.string('mfg', 100).nullable();
    t.string('batch', 40).nullable();
    // "MM/yy" as printed on the bill.
    t.string('expiry', 5).nullable();
    t.decimal('qty', 12, 3).nullable();
    t.decimal('free', 12, 3).nullable();
    t.decimal('mrp', 12, 2).nullable();
    t.decimal('rate', 12, 2).nullable();
    t.decimal('gst_pct', 5, 2).nullable();
    t.decimal('gst_amt', 12, 2).nullable();
    t.decimal('amount', 12, 2).nullable();
  });

  // Stored responses for ingest requests, so a retried request is answered without re-processing.
  await knex.schema.createTable('agent_idempotency_keys', (t) => {
    t.bigInteger('agent_id').unsigned().notNullable().references('agents.id').onDelete('CASCADE');
    // Binary collation: keys are case-sensitive.
    t.specificType('idempotency_key', 'VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin').notNullable();
    t.specificType('request_hash', 'CHAR(64)').notNullable();
    t.smallint('status_code').unsigned().notNullable();
    t.json('response').notNullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['agent_id', 'idempotency_key']);
    t.index(['created_at']);
  });

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

  await knex.schema.dropTable('agent_idempotency_keys');
  await knex.schema.dropTable('agent_bill_items');
  await knex.schema.dropTable('agent_bills');
  await knex.schema.dropTable('agents');
}
