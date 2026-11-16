// WhatsApp inbox: one conversation per branch number and customer, with the reminders sent
// and the customer's replies (received through the Meta webhook). Each branch only sees
// its own conversations.

const MODULE = { code: 'whatsapp_inbox', name: 'WhatsApp inbox', sort_order: 35 };
const PERMISSIONS = [
  { code: 'whatsapp_inbox.read', description: 'View WhatsApp conversations', module_code: MODULE.code },
  { code: 'whatsapp_inbox.reply', description: 'Reply to customers on WhatsApp', module_code: MODULE.code },
];
// Role ceiling: any role may be given the page; Superadmin/Admin decide per user.
const ROLES = ['superadmin', 'admin', 'staff'];

export async function up(knex) {
  await knex.schema.createTable('whatsapp_conversations', (t) => {
    t.bigIncrements('id').primary();
    t.integer('branch_id').unsigned().notNullable().references('branches.id').onDelete('RESTRICT');
    // The customer's WhatsApp number as WhatsApp sends it: digits with country code, no "+".
    t.string('wa_id', 20).notNullable();
    t.bigInteger('customer_id').unsigned().nullable().references('customers.id').onDelete('SET NULL');
    // Name from the customer's WhatsApp profile.
    t.string('profile_name', 150).nullable();
    t.dateTime('last_message_at').nullable();
    t.string('last_message_preview', 200).nullable();
    t.enum('last_direction', ['in', 'out']).nullable();
    // Free-text replies are only allowed within 24 hours of the customer's last message.
    t.dateTime('last_inbound_at').nullable();
    t.integer('unread_count').unsigned().notNullable().defaultTo(0);
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['branch_id', 'wa_id']);
    t.index(['branch_id', 'last_message_at']);
  });

  await knex.schema.createTable('whatsapp_messages', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('conversation_id').unsigned().notNullable().references('whatsapp_conversations.id').onDelete('CASCADE');
    t.enum('direction', ['in', 'out']).notNullable();
    // WhatsApp's message id (wamid…); unique so a webhook delivered twice is stored once.
    t.string('wa_message_id', 128).nullable().unique();
    // text, image, audio, document, button, reminder, …
    t.string('type', 20).notNullable();
    t.text('body').nullable();
    t.enum('status', ['received', 'sent', 'delivered', 'read', 'failed']).notNullable();
    t.string('error', 500).nullable();
    t.bigInteger('reminder_id').unsigned().nullable().references('reminders.id').onDelete('SET NULL');
    t.bigInteger('sent_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    // When the message was sent or received (WhatsApp's timestamp for incoming messages).
    t.dateTime('message_at').notNullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['conversation_id', 'message_at']);
  });

  await knex('modules').insert(MODULE);
  await knex('permissions').insert(PERMISSIONS);
  const permissionIds = await knex('permissions').whereIn('code', PERMISSIONS.map((p) => p.code)).pluck('id');
  const roleIds = await knex('roles').whereIn('code', ROLES).pluck('id');
  await knex('role_permissions').insert(
    roleIds.flatMap((roleId) => permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId }))),
  );
}

export async function down(knex) {
  const permissionIds = await knex('permissions').whereIn('code', PERMISSIONS.map((p) => p.code)).pluck('id');
  await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  await knex('permissions').whereIn('id', permissionIds).delete();
  await knex('user_modules').where({ module_code: MODULE.code }).delete();
  await knex('modules').where({ code: MODULE.code }).delete();
  await knex.schema.dropTable('whatsapp_messages');
  await knex.schema.dropTable('whatsapp_conversations');
}
