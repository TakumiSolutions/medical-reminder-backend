// One-time bootstrap: creates the first Superadmin account interactively.
// Refuses to run if any Superadmin account already exists.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { db } from '../db/knex.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as userRepository from '../repositories/userRepository.js';
import { hashPassword } from '../utils/password.js';
import { fullNameField, newPasswordField, usernameField } from '../validators/userValidators.js';

// Output stream that can be muted so typed passwords are not echoed.
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });

async function ask(question, schema, { secret = false } = {}) {
  for (;;) {
    process.stdout.write(question);
    muted = secret;
    const answer = await rl.question('');
    muted = false;
    if (secret) process.stdout.write('\n');

    const result = schema.safeParse(answer);
    if (result.success) return result.data;
    console.log(`  ${result.error.issues[0].message}`);
  }
}

async function superadminExists() {
  return Boolean(
    await db('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where('roles.code', 'superadmin').first('user_id'),
  );
}

async function main() {
  if (await superadminExists()) {
    console.error('A Superadmin account already exists. Use the application to manage users.');
    process.exitCode = 1;
    return;
  }

  console.log('Create the first Superadmin account.\n');
  const fullName = await ask('Full name: ', fullNameField);
  let username = await ask('Username: ', usernameField);
  while (await userRepository.usernameExists(username)) {
    console.log('  That username is already in use.');
    username = await ask('Username: ', usernameField);
  }

  let password;
  for (;;) {
    password = await ask('Password: ', newPasswordField, { secret: true });
    const confirmation = await ask('Confirm password: ', newPasswordField, { secret: true });
    if (password === confirmation) break;
    console.log('  Passwords do not match. Try again.');
  }

  const passwordHash = await hashPassword(password);
  await db.transaction(async (trx) => {
    // Re-check inside the transaction in case another bootstrap ran concurrently.
    await trx('roles').where({ code: 'superadmin' }).forUpdate().first('id');
    if (await trx('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where('roles.code', 'superadmin').first('user_id')) {
      throw new Error('A Superadmin account was created concurrently. Aborting.');
    }
    const id = await userRepository.insert(trx, { username, fullName, passwordHash, createdBy: null });
    await userRepository.setRoles(trx, id, ['superadmin']);
    await auditRepository.record(
      { action: 'user.created', entityType: 'user', entityId: id, details: { username, fullName, role: 'superadmin', source: 'cli_bootstrap' } },
      trx,
    );
  });

  console.log(`\nSuperadmin "${username}" created. You can now sign in.`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await db.destroy();
}
