// Renames ProntoZ to Prompt in stored codes: the page (module) and its permission, and the
// source of medicines added from bills. Safe to run on a database that already uses Prompt.

const OLD = { module: 'prontoz_customers', permission: 'prontoz_customers.read', source: 'prontoz' };
const NEW = {
  module: { code: 'prompt_customers', name: 'Prompt Customer' },
  permission: { code: 'prompt_customers.read', description: 'View customers from Prompt bills' },
  source: 'prompt',
};

async function renameModule(knex, from, to) {
  const old = await knex('modules').where({ code: from }).first();
  if (!old) return;
  // permissions and user_modules reference modules.code, so add the new row before moving them.
  await knex('modules').insert({ ...old, ...to });
  await knex('permissions').where({ module_code: from }).update({ module_code: to.code });
  await knex('user_modules').where({ module_code: from }).update({ module_code: to.code });
  await knex('modules').where({ code: from }).delete();
}

async function renameSource(knex, from, to) {
  // Append the new value first (a cheap change on TiDB), move the rows, then drop the old value.
  await knex.raw(`ALTER TABLE customer_medicines MODIFY source ENUM(?, 'manual', ?) NOT NULL`, [from, to]);
  await knex('customer_medicines').where({ source: from }).update({ source: to });
  await knex.raw(`ALTER TABLE customer_medicines MODIFY source ENUM(?, 'manual') NOT NULL`, [to]);
}

export async function up(knex) {
  await renameModule(knex, OLD.module, NEW.module);
  await knex('permissions').where({ code: OLD.permission }).update(NEW.permission);
  await renameSource(knex, OLD.source, NEW.source);
}

export async function down(knex) {
  await renameModule(knex, NEW.module.code, { code: OLD.module, name: 'ProntoZ customers' });
  await knex('permissions')
    .where({ code: NEW.permission.code })
    .update({ code: OLD.permission, description: 'View customers from the ProntoZ export' });
  await renameSource(knex, NEW.source, OLD.source);
}
