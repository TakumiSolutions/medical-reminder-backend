// Sends each day's reminders on WhatsApp from WHATSAPP_SEND_TIME (India time), using the
// branch's own WhatsApp number. Branches without a configured number are left as they are.
import { env } from '../config/env.js';
import { whatsappConfigFor } from '../config/whatsapp.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as reminderRepository from '../repositories/reminderRepository.js';
import { todayIn } from '../utils/dates.js';
import { recordReminderSent } from './inboxService.js';
import { sendTemplate } from './whatsappClient.js';

const RUN_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 100;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MINUTES = 30;

/** Local time "HH:MM" in `timeZone`. */
export function localTime(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Template body parameters, in the order set by WHATSAPP_TEMPLATE_PARAMS. */
export function templateParams(reminder, order = env.WHATSAPP_TEMPLATE_PARAMS) {
  const values = {
    customer: reminder.customerName,
    medicine: reminder.medicine,
    branch: reminder.branchName,
    billdate: reminder.billDate,
  };
  return order.map((name) => values[name]);
}

/** Branches with a WhatsApp number configured: Map(branchId -> config). */
export async function configuredBranches() {
  const branches = await accessRepository.listActiveBranches();
  return new Map(
    branches.map((b) => [b.id, { branch: b, config: whatsappConfigFor(b.code) }]).filter(([, v]) => v.config),
  );
}

async function sendOne(reminder, config) {
  if (!(await reminderRepository.claimForSending(reminder.id))) return 'skipped';
  try {
    const params = templateParams(reminder);
    const messageId = await sendTemplate(config, { mobile: reminder.mobile, params });
    await reminderRepository.markSent(reminder.id, messageId);
    // Shown in the WhatsApp inbox; the reminder is already sent if this fails.
    await recordReminderSent({
      branchId: reminder.branchId,
      mobile: reminder.mobile,
      customerId: reminder.customerId,
      reminderId: reminder.id,
      waMessageId: messageId,
      body: `Reminder (${config.templateName}): ${params.join(' · ')}`,
    }).catch((error) => console.error(`Adding reminder ${reminder.id} to the inbox failed:`, error.message));
    return 'sent';
  } catch (error) {
    const final = !error.retryable || reminder.attempts + 1 >= MAX_ATTEMPTS;
    await reminderRepository.markSendFailed(reminder.id, { reason: error.message, final });
    console.error(`WhatsApp reminder ${reminder.id} ${final ? 'failed' : 'will be retried'}: ${error.message}`);
    return final ? 'failed' : 'retry';
  }
}

/**
 * Sends today's due reminders once the send time has passed. Safe to run on several
 * servers at once: each reminder is claimed before it is sent.
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function sendDueReminders(now = new Date()) {
  const totals = { sent: 0, failed: 0 };
  if (localTime(env.APP_TIMEZONE, now) < env.WHATSAPP_SEND_TIME) return totals;
  const branches = await configuredBranches();
  if (branches.size === 0) return totals;

  await reminderRepository.failStaleClaims(STALE_CLAIM_MINUTES);
  const today = todayIn(env.APP_TIMEZONE, now);
  const branchIds = [...branches.keys()];
  // Reminders to retry stay scheduled; paging by id keeps them for the next run.
  let afterId = 0;
  for (;;) {
    const due = await reminderRepository.findDueForSending({ today, branchIds, afterId, limit: BATCH });
    if (due.length === 0) break;
    for (const reminder of due) {
      afterId = Number(reminder.id);
      const result = await sendOne(reminder, branches.get(reminder.branchId).config);
      if (result === 'sent') totals.sent += 1;
      if (result === 'failed') totals.failed += 1;
    }
  }
  return totals;
}

/** Runs the sender at start-up and every 5 minutes. Returns a function that stops it. */
export function startReminderSender() {
  configuredBranches()
    .then((branches) => {
      const names = [...branches.values()].map((v) => v.branch.name);
      console.log(names.length ? `WhatsApp reminders on for: ${names.join(', ')}.` : 'WhatsApp reminders off (no branch configured).');
    })
    .catch(() => {});

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { sent, failed } = await sendDueReminders();
      if (sent || failed) console.log(`WhatsApp reminders: ${sent} sent, ${failed} failed.`);
    } catch (error) {
      console.error('Sending WhatsApp reminders failed:', error.message);
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
