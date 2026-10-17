// Removes the contact import feature (customers now come from ProntoZ) and orders the
// pages to match the navigation: ProntoZ customers, Customers, Reminders, Deliveries,
// Users, Audit log.

const PAGE_ORDER = ['prontoz_customers', 'customers', 'reminders', 'deliveries', 'users', 'audit_logs'];
const OLD_ORDER = { customers: 5, contact_imports: 6, prontoz_customers: 7, reminders: 8, deliveries: 9, users: 10, audit_logs: 20 };

export async function up(knex) {
  await knex.schema.dropTable('contact_import_rows');
  await knex.schema.dropTable('contact_imports');

  const permission = await knex('permissions').where({ code: 'contact_imports.manage' }).first('id');
  if (permission) {
    await knex('role_permissions').where({ permission_id: permission.id }).delete();
    await knex('permissions').where({ id: permission.id }).delete();
  }
  await knex('user_modules').where({ module_code: 'contact_imports' }).delete();
  await knex('modules').where({ code: 'contact_imports' }).delete();

  // Customer–branch links were either manual or from an import; only manual remains.
  await knex.raw("ALTER TABLE customer_branches MODIFY source ENUM('manual') NOT NULL");

  for (const [index, code] of PAGE_ORDER.entries()) {
    await knex('modules').where({ code }).update({ sort_order: (index + 1) * 10 });
  }
}

export async function down(knex) {
  await knex.raw("ALTER TABLE customer_branches MODIFY source ENUM('manual','import') NOT NULL");
  for (const [code, sortOrder] of Object.entries(OLD_ORDER)) {
    if (code !== 'contact_imports') await knex('modules').where({ code }).update({ sort_order: sortOrder });
  }

  await knex('modules').insert({ code: 'contact_imports', name: 'Contact import', sort_order: OLD_ORDER.contact_imports });
  await knex('permissions').insert({
    code: 'contact_imports.manage',
    description: 'Import contacts from Excel/CSV',
    module_code: 'contact_imports',
  });
  const permissionId = (await knex('permissions').where({ code: 'contact_imports.manage' }).first('id')).id;
  const roleIds = await knex('roles').whereIn('code', ['superadmin', 'admin', 'staff']).pluck('id');
  await knex('role_permissions').insert(roleIds.map((roleId) => ({ role_id: roleId, permission_id: permissionId })));

  await knex.schema.createTable('contact_imports', (t) => {
    t.bigIncrements('id').primary();
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.string('file_name', 255).notNullable();
    t.enum('file_type', ['csv', 'xlsx']).notNullable();
    t.enum('status', ['previewed', 'committed', 'cancelled']).notNullable().defaultTo('previewed');
    t.json('column_mapping').notNullable();
    t.json('summary').notNullable();
    t.bigInteger('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.bigInteger('finished_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('finished_at').nullable();
    t.index(['branch_id', 'created_at']);
  });
  await knex.schema.createTable('contact_import_rows', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('import_id').unsigned().notNullable().references('contact_imports.id').onDelete('CASCADE');
    t.integer('source_row').unsigned().notNullable();
    t.enum('status', ['new', 'update', 'unchanged', 'invalid', 'duplicate']).notNullable();
    t.string('mobile', 16).nullable();
    t.json('data').nullable();
    t.json('raw').notNullable();
    t.json('errors').nullable();
    t.json('changes').nullable();
    t.bigInteger('customer_id').unsigned().nullable().references('customers.id').onDelete('SET NULL');
    t.unique(['import_id', 'source_row']);
    t.index(['import_id', 'status']);
  });
}
