import { db } from './knex.js';

const commands = {
  async migrate() {
    const [batch, applied] = await db.migrate.latest();
    console.log(applied.length ? `Batch ${batch} applied:\n  ${applied.join('\n  ')}` : 'Already up to date.');
  },
  async rollback() {
    const [batch, reverted] = await db.migrate.rollback();
    console.log(reverted.length ? `Batch ${batch} rolled back:\n  ${reverted.join('\n  ')}` : 'Nothing to roll back.');
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: node src/db/cli.js <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

try {
  await command();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
