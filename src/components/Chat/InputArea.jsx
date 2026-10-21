import { useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker.jsx';

const MAX_TEXTAREA_HEIGHT = 132;

export default function InputArea({
  onSend, onTyping, connected = true, blocked = null, attachmentBlocked = null,
}) {
  const [text, setText]           = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [sending, setSending]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState('');
  const textareaRef = useRef(null);
  const fileRef     = useRef(null);
  const emojiRef    = useRef(null);

  const busy = sending || uploading;

  function dismissEmoji() {
    setShowEmoji(false);
    requestAnimationFrame(() => emojiRef.current?.focus());
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  async function handleSend() {
    const value = text.trim();
    if (!value || busy) return;
    if (!connected) {
      setError('اتصال به سرور برقرار نیست؛ پیام ارسال نشد');
      return;
    }

    setSending(true);
    setError('');
    const result = await onSend({ type: 'text', text: value });
    setSending(false);

    if (!result?.ok) {
      setError(result?.error || 'ارسال پیام ناموفق بود');
      return;
    }
    setText('');
    setShowEmoji(false);
    textareaRef.current?.focus();
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && showEmoji) {
      setShowEmoji(false);
    }
  }

  function handleEmoji(emoji) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(prev => prev.slice(0, start) + emoji + prev.slice(end));
    el?.focus();
    requestAnimationFrame(() => {
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file || busy) return;
    e.target.value = '';
    if (attachmentBlocked) {
      setError(attachmentBlocked);
      return;
    }
    if (!connected) {
      setError('اتصال به سرور برقرار نیست؛ فایل ارسال نشد');
      return;
    }

    const type = file.type.startsWith('image/') ? 'image' : 'file';
    setUploading(true);
    setError('');
    const result = await onSend({
      type,
      src: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      text: '',
      _file: file,
    });
    setUploading(false);

    if (!result?.ok) {
      setError(result?.error || 'ارسال فایل ناموفق بود');
      return;
    }
    textareaRef.current?.focus();
  }

  return (
    <div className="composer">
      {showEmoji && (
        <EmojiPicker
          onSelect={handleEmoji}
          onClose={() => setShowEmoji(false)}
          onDismiss={dismissEmoji}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*,*/*"
        hidden
        onChange={handleFile}
      />

      {blocked && (
        <div className="composer-note is-blocked" role="status">
          <i className="fas fa-lock" aria-hidden="true" />
          <span>{blocked}</span>
        </div>
      )}

      {(busy || error) && (
        <div className={`composer-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {busy ? (
            <>
              <i className="fas fa-spinner fa-spin" aria-hidden="true" />
              {uploading ? 'در حال بارگذاری و ارسال فایل…' : 'در حال ارسال…'}
            </>
          ) : (
            <>
              <i className="fas fa-triangle-exclamation" aria-hidden="true" />
              <span>{error}</span>
              <button type="button" className="composer-note-dismiss" onClick={() => setError('')} aria-label="بستن پیام خطا">
                <i className="fas fa-xmark" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}

      <form
        className="input-area"
        onSubmit={e => { e.preventDefault(); handleSend(); }}
      >
        <button
          type="button"
          className="icon-btn attach-btn"
          title={attachmentBlocked ?? 'پیوست فایل'}
          aria-label="پیوست فایل"
          disabled={busy || Boolean(attachmentBlocked)}
          onClick={() => fileRef.current?.click()}
        >
          <i className={`fas ${attachmentBlocked ? 'fa-lock' : 'fa-paperclip'}`} aria-hidden="true" />
        </button>

        <div className="input-wrap">
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={Boolean(blocked)}
            onChange={e => { setText(e.target.value); setError(''); onTyping?.(); }}
            onKeyDown={handleKey}
            placeholder={blocked ?? (connected ? 'پیامت را بنویس…' : 'در انتظار اتصال به سرور…')}
            aria-label="متن پیام"
            autoComplete="off"
          />

          <button
            ref={emojiRef}
            type="button"
            className={`icon-btn emoji ${showEmoji ? 'active' : ''}`}
            title="ایموجی"
            aria-label="انتخاب ایموجی"
            aria-expanded={showEmoji}
            onClick={() => setShowEmoji(open => !open)}
          >
            <i className="far fa-face-smile" aria-hidden="true" />
          </button>
        </div>

        <button
          type="submit"
          className="send-btn"
          title={blocked ?? 'ارسال پیام'}
          aria-label="ارسال پیام"
          disabled={!text.trim() || busy || !connected || Boolean(blocked)}
        >
          {sending
            ? <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            : <i className="fas fa-paper-plane" aria-hidden="true" />}
        </button>
      </form>
    </div>
  );
}
