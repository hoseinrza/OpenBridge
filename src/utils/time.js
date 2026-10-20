const timeFmt = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('fa-IR', { weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' });
const mediumDateFmt = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' });

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return timeFmt.format(date);
}

export function formatConversationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (dayDiff <= 0) return timeFmt.format(date);
  if (dayDiff === 1) return 'دیروز';
  if (dayDiff < 7) return weekdayFmt.format(date);
  return shortDateFmt.format(date);
}

export function formatDayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (dayDiff === 0) return 'امروز';
  if (dayDiff === 1) return 'دیروز';
  return mediumDateFmt.format(date);
}

export function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
