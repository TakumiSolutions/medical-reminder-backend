// Outcome of a reminder: the customer ordered or refused. Either stops the remaining
// reminder dates; undoing the outcome restores them.

export async function up(knex) {
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.enum('outcome', ['ordered', 'refused']).nullable().after('status');
    t.string('outcome_reason', 500).nullable().after('outcome');
    t.bigInteger('outcome_by').unsigned().nullable().references('users.id').onDelete('SET NULL').after('outcome_reason');
    t.dateTime('outcome_at').nullable().after('outcome_by');
    t.index(['outcome', 'outcome_at']);
  });

  await knex.schema.alterTable('reminders', (t) => {
    // Why a reminder was cancelled: stopped by staff, or because an outcome was recorded
    // (only the latter is restored when the outcome is undone).
    t.enum('cancel_source', ['stop', 'outcome']).nullable().after('status');
  });
  await knex('reminders').where({ status: 'cancelled' }).update({ cancel_source: 'stop' });
}

export async function down(knex) {
  await knex.schema.alterTable('reminders', (t) => {
    t.dropColumn('cancel_source');
  });
  await knex.schema.alterTable('reminder_cycles', (t) => {
    t.dropIndex(['outcome', 'outcome_at']);
    t.dropForeign(['outcome_by']);
    t.dropColumn('outcome_at');
    t.dropColumn('outcome_by');
    t.dropColumn('outcome_reason');
    t.dropColumn('outcome');
  });
}
