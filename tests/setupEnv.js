// Minimal environment for tests that do not touch the database.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DB_HOST: '127.0.0.1',
  DB_USER: 'test',
  DB_NAME: 'test',
  CORS_ORIGINS: 'http://localhost:5173',
  SESSION_COOKIE_SECURE: 'false',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token-123',
});
