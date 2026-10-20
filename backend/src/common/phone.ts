const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Accepts Iranian mobile numbers written as 09xxxxxxxxx, +989xxxxxxxxx,
 * 00989xxxxxxxxx, 989xxxxxxxxx or 9xxxxxxxxx (with optional spaces, dashes,
 * parentheses and Persian/Arabic digits) and returns the canonical
 * 09xxxxxxxxx form, or null when the input is not a mobile number.
 */
export function normalizeIranMobile(input: string): string | null {
  if (typeof input !== 'string') return null;

  let value = input
    .trim()
    .replace(/[۰-۹]/g, digit => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[\s\-()]/g, '');

  if (value.startsWith('+98')) value = `0${value.slice(3)}`;
  else if (value.startsWith('0098')) value = `0${value.slice(4)}`;
  else if (value.startsWith('98') && value.length === 12) value = `0${value.slice(2)}`;
  else if (value.length === 10 && value.startsWith('9')) value = `0${value}`;

  return /^09\d{9}$/.test(value) ? value : null;
}

export function isIranMobile(input: string): boolean {
  return /^09\d{9}$/.test(input);
}
