import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const knexConfig = {
  client: 'mysql2',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    // All DATETIME values are stored and read as UTC.
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  },
  pool: {
    min: 0,
    max: 10,
    afterCreate(connection, done) {
      connection.query("SET time_zone = '+00:00'", (error) => done(error, connection));
    },
  },
  migrations: {
    directory: path.join(dirname, 'migrations'),
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
};
