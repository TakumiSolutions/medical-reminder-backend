import { addDays } from '../utils/dates.js';

/** Reminders go out on day N, N+1 and N+2 after the start (last bill) date. */
const REMINDER_DAY_OFFSETS = [0, 1, 2];
export const MAX_INTERVAL_DAYS = 365;

/**
 * Plans one reminder cycle. Dates before `today` are marked 'skipped' (never sent late).
 * @returns {Array<{ dayNumber: number, scheduledDate: string, status: 'scheduled'|'skipped' }>}
 */
export function planReminderDays({ startDate, intervalDays, today }) {
  return REMINDER_DAY_OFFSETS.map((offset) => {
    const dayNumber = intervalDays + offset;
    const scheduledDate = addDays(startDate, dayNumber);
    return { dayNumber, scheduledDate, status: scheduledDate < today ? 'skipped' : 'scheduled' };
  });
}
