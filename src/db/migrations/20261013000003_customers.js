// Customers (one record per mobile number, shared across branches) and contact imports.

const MODULES = [
  { code: 'customers', name: 'Customers', sort_order: 5 },
  { code: 'contact_imports', name: 'Contact import', sort_order: 6 },
];

const PERMISSIONS = [
  { code: 'customers.read', description: 'View customers', module_code: 'customers' },
  { code: 'customers.manage', description: 'Create and edit customers', module_code: 'customers' },
  { code: 'contact_imports.manage', description: 'Import contacts from Excel/CSV', module_code: 'contact_imports' },
];

// Role ceilings: every role may be given these pages; Superadmin/Admin decide per user.
const ROLE_PERMISSIONS = {
  superadmin: ['customers.read', 'customers.manage', 'contact_imports.manage'],
  admin: ['customers.read', 'customers.manage', 'contact_imports.manage'],
  staff: ['customers.read', 'customers.manage', 'contact_imports.manage'],
};

export async function up(knex) {
  await knex('modules').insert(MODULES);
  await knex('permissions').insert(PERMISSIONS);

  const roleIds = Object.fromEntries((await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]));
  const permissionIds = Object.fromEntries(
    (await knex('permissions').select('id', 'code')).map((p) => [p.code, p.id]),
  );
  await knex('role_permissions').insert(
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, codes]) =>
      codes.map((code) => ({ role_id: roleIds[role], permission_id: permissionIds[code] })),
    ),
  );

  await knex.schema.createTable('customers', (t) => {
    t.bigIncrements('id').primary();
    // E.164, e.g. +919876543210. The merge key across branches.
    t.string('mobile', 16).notNullable().unique();
    t.string('full_name', 150).notNullable();
    t.string('address', 500).nullable();
    t.string('usual_doctor', 150).nullable();
    t.text('notes').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.bigInteger('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['full_name']);
  });

  await knex.schema.createTable('customer_branches', (t) => {
    t.bigInteger('customer_id').unsigned().notNullable().references('customers.id').onDelete('CASCADE');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.enum('source', ['manual', 'import']).notNullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['customer_id', 'branch_id']);
    t.index(['branch_id']);
  });

  await knex.schema.createTable('contact_imports', (t) => {
    t.bigIncrements('id').primary();
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    t.string('file_name', 255).notNullable();
    t.enum('file_type', ['csv', 'xlsx']).notNullable();
    t.enum('status', ['previewed', 'committed', 'cancelled']).notNullable().defaultTo('previewed');
    // Which file column fed each customer field, and which columns were ignored.
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
    // 1-based line number in the source file, as the user sees it.
    t.integer('source_row').unsigned().notNullable();
    t.enum('status', ['new', 'update', 'unchanged', 'invalid', 'duplicate']).notNullable();
    t.string('mobile', 16).nullable();
    t.json('data').nullable();
    t.json('raw').notNullable();
    t.json('errors').nullable();
    // Field-level { from, to } changes applied to an existing customer.
    t.json('changes').nullable();
    t.bigInteger('customer_id').unsigned().nullable().references('customers.id').onDelete('SET NULL');
    t.unique(['import_id', 'source_row']);
    t.index(['import_id', 'status']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('contact_import_rows');
  await knex.schema.dropTable('contact_imports');
  await knex.schema.dropTable('customer_branches');
  await knex.schema.dropTable('customers');

  const ids = await knex('permissions').whereIn('code', PERMISSIONS.map((p) => p.code)).pluck('id');
  await knex('role_permissions').whereIn('permission_id', ids).delete();
  await knex('permissions').whereIn('id', ids).delete();
  await knex('user_modules').whereIn('module_code', MODULES.map((m) => m.code)).delete();
  await knex('modules').whereIn('code', MODULES.map((m) => m.code)).delete();
}
