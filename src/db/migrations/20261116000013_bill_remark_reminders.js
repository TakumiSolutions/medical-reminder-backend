// Reminders created automatically from a Prompt bill's remark (a number of days): one
// reminder per bill, covering all its medicines, linked to the bill it came from.

export async function up(knex) {
  // A bill's medicines are listed together, e.g. "TELMA 40, ECOSPRIN 75".
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.string('medicine', 500).notNullable().alter();
  });
  // One column per ALTER: TiDB cannot place a column AFTER one added in the same statement.
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.bigInteger('agent_bill_id').unsigned().nullable().after('branch_id');
  });
  await knex.schema.alterTable('reminder_cycles', (t) => {
    // At most one reminder per bill, so a bill sent again never schedules twice.
    t.unique(['agent_bill_id']);
    t.foreign('agent_bill_id').references('agent_bills.id').onDelete('SET NULL');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.dropForeign(['agent_bill_id']);
    t.dropUnique(['agent_bill_id']);
  });
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.dropColumn('agent_bill_id');
  });
  await knex('reminder_cycles').update({ medicine: knex.raw('LEFT(medicine, 100)') });
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.string('medicine', 100).notNullable().alter();
  });
}
