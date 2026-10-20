export function dayKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatTime(value) {
  return new Date(value).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dayKey(date) === dayKey(today)) return 'امروز';
  if (dayKey(date) === dayKey(yesterday)) return 'دیروز';
  return date.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatConversationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  if (dayKey(date) === dayKey(today)) return formatTime(value);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'دیروز';
  const diff = today.getTime() - date.getTime();
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString('fa-IR', { weekday: 'long' });
  }
  return date.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
}
