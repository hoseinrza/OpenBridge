const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

// Mirrors backend/src/common/phone.ts so both sides agree on the canonical
// 09xxxxxxxxx form before any request is sent.
export function normalizeIranMobile(input) {
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

export function isIranMobile(input) {
  return /^09\d{9}$/.test(input ?? '');
}
