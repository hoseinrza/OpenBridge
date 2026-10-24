// Byte sizes as a chat shows them: one rounded figure and a unit a person reads,
// never a raw number of bytes next to a filename.
export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}

// A length of time in the same digits the message clock uses, so a voice note
// and the timestamp under it never disagree about how a number is written.
const faDigits = new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2 });

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${faDigits.format(Math.floor(seconds / 60))}:${faDigits.format(seconds % 60)}`;
}
