// Persian text in this app is read as Persian, so a count written with Latin
// digits looks like a bug report rather than a label. Only digits and the
// decimal separator are mapped — never a version, filename or code.
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function fa(value) {
  return String(value ?? '')
    .replace(/[0-9]/g, digit => FA_DIGITS[Number(digit)])
    .replace(/\.(?=\d)/g, '٫');
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${fa(value)} بایت`;
  if (value < 1024 * 1024) return `${fa(Math.round(value / 1024))} کیلوبایت`;
  return `${fa((value / (1024 * 1024)).toFixed(1))} مگابایت`;
}
