import { addDays } from '../utils/dates.js';

/** Reminders go out on day N-2, N-1 and N after the start (last bill) date, never before day 1. */
const REMINDER_DAY_OFFSETS = [-2, -1, 0];
export const MAX_INTERVAL_DAYS = 365;

/**
 * Plans one reminder cycle. Dates before `today` are marked 'skipped' (never sent late).
 * For N below 3 the days that would fall on or before the bill date are left out.
 * @returns {Array<{ dayNumber: number, scheduledDate: string, status: 'scheduled'|'skipped' }>}
 */
export function planReminderDays({ startDate, intervalDays, today }) {
  const dayNumbers = [...new Set(REMINDER_DAY_OFFSETS.map((offset) => Math.max(1, intervalDays + offset)))];
  return dayNumbers.map((dayNumber) => {
    const scheduledDate = addDays(startDate, dayNumber);
    return { dayNumber, scheduledDate, status: scheduledDate < today ? 'skipped' : 'scheduled' };
  });
}

// A bill remark that is just a number of days: "30", "30 days", "10 DAY", "15d".
const REMARK_DAYS = /^\s*(\d{1,3})\s*(?:d|days?)?\s*\.?\s*$/i;

/** Number of days in a bill remark, or null when the remark is not a day count (1–365). */
export function parseRemarkDays(remarks) {
  const match = REMARK_DAYS.exec(remarks ?? '');
  if (!match) return null;
  const days = Number(match[1]);
  return days >= 1 && days <= MAX_INTERVAL_DAYS ? days : null;
}
