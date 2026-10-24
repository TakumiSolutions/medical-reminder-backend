import knexFactory from 'knex';
import { env } from '../config/env.js';

const configured = Boolean(env.PRONTOZ_DB_HOST && env.PRONTOZ_DB_USER);

/** One read-only connection per branch's ProntoZ export database, keyed by branch code. */
const connections = new Map(
  configured
    ? Object.entries(env.PRONTOZ_DATABASES).map(([branchCode, database]) => [
        branchCode,
        knexFactory({
          client: 'mysql2',
          connection: {
            host: env.PRONTOZ_DB_HOST,
            port: env.PRONTOZ_DB_PORT,
            user: env.PRONTOZ_DB_USER,
            password: env.PRONTOZ_DB_PASSWORD,
            database,
            ssl: env.PRONTOZ_DB_SSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
            // DATE columns come back as 'YYYY-MM-DD' strings, avoiding timezone shifts.
            dateStrings: true,
            decimalNumbers: true,
          },
          pool: { min: 0, max: 5 },
        }),
      ])
    : [],
);

/** Branch codes that have a ProntoZ export configured. */
export const prontozBranchCodes = () => [...connections.keys()];

/** The export connection for a branch, or null if none is configured. */
export const prontozDbFor = (branchCode) => connections.get(branchCode) ?? null;

export const destroyProntozConnections = () => Promise.all([...connections.values()].map((c) => c.destroy()));
