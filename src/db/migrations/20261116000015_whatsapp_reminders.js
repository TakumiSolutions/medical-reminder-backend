// WhatsApp sending of reminders: when a reminder went out, the WhatsApp message id, why it
// failed, and a claim so two servers never send the same reminder.

const COLUMNS = [
  (t) => t.tinyint('attempts').unsigned().notNullable().defaultTo(0),
  // Set while a server is sending the reminder; cleared when the result is stored.
  (t) => t.dateTime('send_claimed_at').nullable(),
  (t) => t.dateTime('sent_at').nullable(),
  (t) => t.string('whatsapp_message_id', 128).nullable(),
  (t) => t.string('failure_reason', 500).nullable(),
];

export async function up(knex) {
  // One column per ALTER (TiDB).
  for (const add of COLUMNS) await knex.schema.alterTable('reminders', add);
}

export async function down(knex) {
  for (const column of ['failure_reason', 'whatsapp_message_id', 'sent_at', 'send_claimed_at', 'attempts']) {
    await knex.schema.alterTable('reminders', (t) => t.dropColumn(column));
  }
}
