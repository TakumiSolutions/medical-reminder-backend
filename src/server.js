import { createApp } from './app.js';
import { env } from './config/env.js';
import { db } from './db/knex.js';
import { destroyPromptConnections } from './db/promptDb.js';
import { startBillReminderCatchUp } from './services/billReminderService.js';
import { startReminderSender } from './services/reminderSender.js';

const server = createApp().listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
const stopBillReminderCatchUp = startBillReminderCatchUp();
const stopReminderSender = startReminderSender();

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  stopBillReminderCatchUp();
  stopReminderSender();
  server.close(async () => {
    await Promise.all([db.destroy(), destroyPromptConnections()]);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
