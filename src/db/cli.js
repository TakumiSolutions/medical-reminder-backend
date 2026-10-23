import knexFactory from 'knex';
import { env } from '../config/env.js';
import { db } from './knex.js';
import { knexConfig } from './knexConfig.js';

const commands = {
  /** Creates DB_NAME if it does not exist (connects without selecting a database). */
  async create() {
    const connection = { ...knexConfig.connection, database: undefined };
    const server = knexFactory({ ...knexConfig, connection, pool: { min: 0, max: 1 } });
    try {
      await server.raw('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [env.DB_NAME]);
      console.log(`Database "${env.DB_NAME}" is ready.`);
    } finally {
      await server.destroy();
    }
  },
  /** create + migrate: safe to run on every deploy. */
  async setup() {
    await commands.create();
    await commands.migrate();
  },
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
