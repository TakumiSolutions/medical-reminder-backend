// Indian mobile numbers: 10 digits starting 6–9, stored in E.164 (+91XXXXXXXXXX).

const SEPARATORS = /[\s\-().]/g;

/**
 * Normalizes an Indian mobile number to E.164.
 * Accepts e.g. "98765 43210", "+91-98765-43210", "09876543210", "919876543210", 9876543210.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function normalizeIndianMobile(input) {
  if (input === null || input === undefined) return { ok: false, error: 'Mobile number is required.' };

  let digits = String(input).trim();
  if (digits === '') return { ok: false, error: 'Mobile number is required.' };
  if (/[,/;|]/.test(digits)) return { ok: false, error: 'Contains more than one number.' };

  digits = digits.replace(SEPARATORS, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return { ok: false, error: 'Mobile number may only contain digits.' };

  if (digits.length === 14 && digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return { ok: false, error: 'Not a valid Indian mobile number (10 digits starting with 6–9).' };
  }
  return { ok: true, value: `+91${digits}` };
}

