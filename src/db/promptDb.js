import knexFactory from 'knex';
import { env } from '../config/env.js';

const configured = Boolean(env.PROMPT_DB_HOST && env.PROMPT_DB_USER);

/** One read-only connection per branch's Prompt export database, keyed by branch code. */
const connections = new Map(
  configured
    ? Object.entries(env.PROMPT_DATABASES).map(([branchCode, database]) => [
        branchCode,
        knexFactory({
          client: 'mysql2',
          connection: {
            host: env.PROMPT_DB_HOST,
            port: env.PROMPT_DB_PORT,
            user: env.PROMPT_DB_USER,
            password: env.PROMPT_DB_PASSWORD,
            database,
            ssl: env.PROMPT_DB_SSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
            // DATE columns come back as 'YYYY-MM-DD' strings, avoiding timezone shifts.
            dateStrings: true,
            decimalNumbers: true,
          },
          pool: { min: 0, max: 5 },
        }),
      ])
    : [],
);

/** Branch codes that have a Prompt export configured. */
export const promptBranchCodes = () => [...connections.keys()];

/** The export connection for a branch, or null if none is configured. */
export const promptDbFor = (branchCode) => connections.get(branchCode) ?? null;

export const destroyPromptConnections = () => Promise.all([...connections.values()].map((c) => c.destroy()));
