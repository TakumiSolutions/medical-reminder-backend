// Who made and who last edited each bill in Prompt Rx (BillsMain.CreatedBy / ModifiedBy,
// named from UserMaster), and when, as sent by RxBridge 0.1.4 and later.
// Times are the shop PC's wall-clock time, stored without a timezone.
// No AFTER placement: TiDB rejects AFTER a column added in the same ALTER.

export async function up(knex) {
  await knex.schema.alterTable('agent_bills', (t) => {
    t.integer('created_by_code').nullable();
    t.string('created_by_name', 100).nullable();
    t.dateTime('bill_created_at').nullable();
    t.integer('modified_by_code').nullable();
    t.string('modified_by_name', 100).nullable();
    t.dateTime('bill_modified_at').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('agent_bills', (t) => {
    t.dropColumn('created_by_code');
    t.dropColumn('created_by_name');
    t.dropColumn('bill_created_at');
    t.dropColumn('modified_by_code');
    t.dropColumn('modified_by_name');
    t.dropColumn('bill_modified_at');
  });
}
