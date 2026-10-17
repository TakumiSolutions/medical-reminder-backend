// Calendar dates as 'YYYY-MM-DD' strings, free of timezone shifts.

/** Today's date in `timeZone`. */
export function todayIn(timeZone, now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** DATE column value (Date at UTC midnight or string) -> 'YYYY-MM-DD'. */
export function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(timeZone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * UTC start (inclusive) and end (exclusive) of the calendar day `isoDate` in `timeZone`,
 * as 'YYYY-MM-DD HH:MM:SS' strings for comparing with UTC DATETIME columns.
 */
export function dayBoundsUtc(isoDate, timeZone) {
  const toUtc = (date) => {
    const guess = new Date(`${date}T00:00:00Z`);
    return new Date(guess.getTime() - zoneOffsetMs(timeZone, guess));
  };
  const format = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: format(toUtc(isoDate)), end: format(toUtc(addDays(isoDate, 1))) };
}
