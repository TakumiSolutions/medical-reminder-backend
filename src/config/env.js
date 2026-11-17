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
  // TLS to MySQL with certificate verification. Required by hosted MySQL such as TiDB Cloud.
  DB_SSL: booleanString.default(false),

  // Comma-separated list of frontend origins allowed to call the API with credentials.
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  SESSION_COOKIE_NAME: z.string().min(1).default('pharmacy_sid'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  // Must be true in production (HTTPS). Only disable for local HTTP development.
  SESSION_COOKIE_SECURE: booleanString.default(true),
  // "lax" when the frontend is served from the API's site (or proxies /api). "none" when the
  // frontend calls the API on another domain; the cookie is then partitioned to the frontend's site.
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'none']).default('lax'),

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

  // Optional read-only access to the Prompt export databases, one per branch.
  // The user should only have SELECT rights on those databases.
  PROMPT_DB_HOST: z.string().min(1).optional(),
  PROMPT_DB_PORT: z.coerce.number().int().positive().default(3306),
  PROMPT_DB_USER: z.string().min(1).optional(),
  PROMPT_DB_PASSWORD: z.string().default(''),
  PROMPT_DB_SSL: booleanString.default(false),
  // Branch code -> database name, e.g. "central:PharmacyExport,speedwell:PharmacyExportSpeedwell".
  PROMPT_DATABASES: z
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

  // WhatsApp reminders (Meta WhatsApp Cloud API). Each branch has its own number and token:
  // WHATSAPP_<BRANCH CODE>_PHONE_NUMBER_ID and WHATSAPP_<BRANCH CODE>_ACCESS_TOKEN, e.g.
  // WHATSAPP_CENTRAL_PHONE_NUMBER_ID. A branch without both sends nothing.
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Use the form v21.0.').default('v21.0'),
  // Approved message template, and what fills its {{1}}, {{2}}, … in order.
  WHATSAPP_TEMPLATE_NAME: z.string().min(1).default('medicine_reminder'),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).default('en'),
  WHATSAPP_TEMPLATE_PARAMS: z
    .string()
    .default('customer,medicine')
    .transform((value, ctx) => {
      const params = value.split(',').map((p) => p.trim()).filter(Boolean);
      const unknown = params.filter((p) => !['customer', 'medicine', 'branch', 'billdate'].includes(p));
      if (unknown.length) {
        ctx.addIssue({ code: 'custom', message: `Unknown template params: ${unknown.join(', ')} (use customer, medicine, branch, billdate).` });
        return z.NEVER;
      }
      return params;
    }),
  // Bills sent on WhatsApp as a PDF: an approved template with a Document header, and what
  // fills its body {{1}}, {{2}}, … in order. A branch may override the name with
  // WHATSAPP_<BRANCH CODE>_BILL_TEMPLATE_NAME.
  WHATSAPP_BILL_TEMPLATE_NAME: z.string().min(1).default('bill_copy'),
  // Automatic sending of day-count bills. Off until the bill template is approved by Meta;
  // sending by hand works either way.
  WHATSAPP_AUTO_SEND_BILLS: booleanString.default(false),
  WHATSAPP_BILL_TEMPLATE_PARAMS: z
    .string()
    .default('customer,billno,billdate,total,branch')
    .transform((value, ctx) => {
      const params = value.split(',').map((p) => p.trim()).filter(Boolean);
      const unknown = params.filter((p) => !['customer', 'billno', 'billdate', 'total', 'branch'].includes(p));
      if (unknown.length) {
        ctx.addIssue({ code: 'custom', message: `Unknown bill template params: ${unknown.join(', ')} (use customer, billno, billdate, total, branch).` });
        return z.NEVER;
      }
      return params;
    }),
  // Store name printed at the top of bill PDFs. Each branch may add lines under it with
  // BILL_<BRANCH CODE>_HEADER, lines separated by "|" (address, phone, GSTIN, DL no.).
  BILL_STORE_NAME: z.string().trim().min(1).default('Shivam Medical Store'),
  // Webhook for customer replies (WhatsApp inbox): the App Secret signs each request, and the
  // verify token is the one entered in Meta's webhook settings. Without both, the webhook is off.
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8, 'Use at least 8 characters.').optional(),
  // Local time (APP_TIMEZONE) from which the day's reminders are sent.
  WHATSAPP_SEND_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour).').default('10:00'),
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
  if (result.data.SESSION_COOKIE_SAMESITE === 'none' && !result.data.SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SAMESITE=none requires SESSION_COOKIE_SECURE=true.');
  }
  return Object.freeze(result.data);
}

export const env = loadEnv();
