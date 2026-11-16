// What the customer ordered: medicine name and quantity per line, entered when a
// reminder is marked as Ordered.

export async function up(knex) {
  await knex.schema.createTable('delivery_items', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('delivery_id').unsigned().notNullable().references('deliveries.id').onDelete('CASCADE');
    t.smallint('line_no').unsigned().notNullable();
    t.string('medicine', 200).notNullable();
    t.decimal('quantity', 10, 2).notNullable();
    t.unique(['delivery_id', 'line_no']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('delivery_items');
}
