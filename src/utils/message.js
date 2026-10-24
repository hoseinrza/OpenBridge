const TYPE_LABEL = {
  image: 'تصویر',
  voice: 'پیام صوتی',
  audio: 'پیام صوتی',
  video: 'ویدیو',
  file: 'فایل',
};

// One line that stands for a message wherever only a line fits: the reply bar
// above the composer, the picker that forwards it, and the quote in the bubble
// that answers it. The text is the message, so it always wins.
export function messagePreview(message) {
  if (!message) return '';
  if (message.text) return message.text.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (message.name) return message.name.slice(0, 180);
  return TYPE_LABEL[message.type] ?? 'پیام';
}
