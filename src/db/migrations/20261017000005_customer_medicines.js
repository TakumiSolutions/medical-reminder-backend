// Medicines a customer takes, per branch (a customer may buy different medicines at each branch).

export async function up(knex) {
  await knex.schema.createTable('customer_medicines', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('customer_id').unsigned().notNullable().references('customers.id').onDelete('CASCADE');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    // Product name as it appears on the bill, e.g. "TELMA 40".
    t.string('medicine', 100).notNullable();
    t.enum('source', ['prontoz', 'manual']).notNullable();
    t.bigInteger('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['customer_id', 'branch_id', 'medicine']);
    t.index(['branch_id', 'medicine']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('customer_medicines');
}
