// Bills sent to customers on WhatsApp as a PDF: automatically for bills whose remark is a day
// count, or by staff from a customer's bills. One row per send.

export async function up(knex) {
  await knex.schema.createTable('bill_whatsapp_sends', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('agent_bill_id').unsigned().notNullable().references('agent_bills.id').onDelete('CASCADE');
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    // +91XXXXXXXXXX the bill was sent to.
    t.string('mobile', 16).notNullable();
    t.enum('kind', ['auto', 'manual']).notNullable();
    // Set to agent_bill_id for automatic sends only: a bill is never sent automatically twice.
    t.bigInteger('auto_bill_id').unsigned().nullable().unique();
    t.enum('status', ['pending', 'sending', 'sent', 'failed']).notNullable().defaultTo('pending');
    t.tinyint('attempts').unsigned().notNullable().defaultTo(0);
    // Set while a server is sending; a stale claim is retried.
    t.dateTime('claimed_at').nullable();
    t.dateTime('sent_at').nullable();
    t.string('whatsapp_message_id', 128).nullable();
    t.string('failure_reason', 500).nullable();
    t.bigInteger('requested_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['agent_bill_id']);
    t.index(['status', 'id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('bill_whatsapp_sends');
}
