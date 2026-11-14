// The remark staff type on a Prompt Rx bill, sent by RxBridge with each bill.

export async function up(knex) {
  await knex.schema.alterTable('agent_bills', (t) => {
    t.string('remarks', 500).nullable().after('doctor');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('agent_bills', (t) => {
    t.dropColumn('remarks');
  });
}
