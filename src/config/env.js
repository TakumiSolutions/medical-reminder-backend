import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),

  // Comma-separated list of frontend origins allowed to call the API with credentials.
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  SESSION_COOKIE_NAME: z.string().min(1).default('pharmacy_sid'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  // Must be true in production (HTTPS). Only disable for local HTTP development.
  SESSION_COOKIE_SECURE: booleanString.default(true),

  // Timezone that decides "today" for reminder dates (the pharmacies are in India).
  APP_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown timezone.'),

  // Optional read-only access to the ProntoZ export databases, one per branch.
  // The user should only have SELECT rights on those databases.
  PRONTOZ_DB_HOST: z.string().min(1).optional(),
  PRONTOZ_DB_PORT: z.coerce.number().int().positive().default(3306),
  PRONTOZ_DB_USER: z.string().min(1).optional(),
  PRONTOZ_DB_PASSWORD: z.string().default(''),
  // Branch code -> database name, e.g. "central:PharmacyExport,speedwell:PharmacyExportSpeedwell".
  PRONTOZ_DATABASES: z
    .string()
    .default('')
    .transform((value, ctx) => {
      const map = {};
      for (const pair of value.split(',').map((p) => p.trim()).filter(Boolean)) {
        const [branch, database] = pair.split(':').map((p) => p?.trim());
        if (!branch || !database || !/^\w+$/.test(database)) {
          ctx.addIssue({ code: 'custom', message: `Expected "branch:Database" pairs, got "${pair}".` });
          return z.NEVER;
        }
        map[branch] = database;
      }
      return map;
    }),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  if (result.data.NODE_ENV === 'production' && !result.data.SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SECURE must be true in production.');
  }
  return Object.freeze(result.data);
}

export const env = loadEnv();
