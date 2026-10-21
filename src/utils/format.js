// Byte sizes as a chat shows them: one rounded figure and a unit a person reads,
// never a raw number of bytes next to a filename.
export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}
