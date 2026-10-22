import { useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import AttachMenu from './AttachMenu.jsx';

const MAX_TEXTAREA_HEIGHT = 132;

export default function InputArea({
  onSend, onTyping, connected = true, blocked = null,
  editing = null, onSaveEdit, onCancelEdit,
}) {
  const [text, setText]           = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [sending, setSending]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState('');
  const textareaRef = useRef(null);
  const fileRef     = useRef(null);
  const emojiRef    = useRef(null);
  const attachRef   = useRef(null);
  // Which kind the user asked for, remembered across the native picker: an image
  // sent under «فایل» must stay a file row.
  const pickRef     = useRef(null);
  // What was being typed before an edit began. The composer is the one place
  // both live, so the draft is parked here and handed back when the edit ends —
  // saved, cancelled, or interrupted by a chat switch.
  const draftRef    = useRef('');
  const textRef     = useRef('');
  const editingRef  = useRef(null);
  const caretRef    = useRef(false);

  const isEditing = Boolean(editing);
  const busy = sending || uploading;

  useEffect(() => { textRef.current = text; }, [text]);

  useEffect(() => {
    if (!editing) {
      if (editingRef.current !== null) {
        setText(draftRef.current);
        draftRef.current = '';
        editingRef.current = null;
        setError('');
        caretRef.current = true;
      }
      return;
    }
    if (editingRef.current === editing.id) return;
    editingRef.current = editing.id;
    draftRef.current = textRef.current;
    setError('');
    setText(editing.text);
    // The text being corrected opens under the cursor with the caret after it,
    // which is where a correction is almost always made.
    caretRef.current = true;
  }, [editing]);

  // The caret is placed after the new text has been committed to the field, not
  // while it is still being swapped in — which is also the only moment its
  // length is known.
  useEffect(() => {
    if (!caretRef.current) return;
    caretRef.current = false;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [text, editing]);

  function dismissEmoji() {
    setShowEmoji(false);
    requestAnimationFrame(() => emojiRef.current?.focus());
  }

  function chooseAttachment(choice) {
    setShowAttach(false);
    pickRef.current = choice.kind;
    // Written on the element, not in state, so the picker is already filtered
    // when the click that opens it happens in this same turn.
    if (fileRef.current) fileRef.current.accept = choice.accept;
    requestAnimationFrame(() => fileRef.current?.click());
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
      setError(isEditing ? 'اتصال به سرور برقرار نیست؛ پیام ویرایش نشد' : 'اتصال به سرور برقرار نیست؛ پیام ارسال نشد');
      return;
    }

    setSending(true);
    setError('');
    // One field, two jobs: while a message is being corrected its new text is
    // saved in place of it, and nothing else is ever sent from here.
    const result = isEditing
      ? await onSaveEdit?.(value)
      : await onSend({ type: 'text', text: value });
    setSending(false);

    if (!result?.ok) {
      setError(result?.error || (isEditing ? 'ویرایش پیام ناموفق بود' : 'ارسال پیام ناموفق بود'));
      return;
    }
    // A saved edit ends with the parent dropping the edit, which hands the
    // composer back to the parked draft.
    if (isEditing) return;
    setText('');
    setShowEmoji(false);
    textareaRef.current?.focus();
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      if (showEmoji) setShowEmoji(false);
      else if (isEditing) onCancelEdit?.();
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
    if (blocked) {
      setError(blocked);
      return;
    }
    if (!connected) {
      setError('اتصال به سرور برقرار نیست؛ فایل ارسال نشد');
      return;
    }

    const type = pickRef.current === 'file' || !file.type.startsWith('image/') ? 'file' : 'image';
    pickRef.current = null;
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

      {showAttach && (
        <AttachMenu
          onPick={chooseAttachment}
          onClose={() => setShowAttach(false)}
          ignoreRef={attachRef}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="*/*"
        hidden
        onChange={handleFile}
      />

      {/* Editing is a mode of the composer, not a dialog: what is being
          corrected stays named, one line of it is kept in sight, and the way
          out is the same whether the text is saved, cancelled or escapes. */}
      {editing && (
        <div className="edit-bar">
          <span className="edit-bar-title">
            <i className="fas fa-pen-to-square" aria-hidden="true" />
            ویرایش پیام
          </span>
          <span className="edit-bar-preview" title={editing.text}>{editing.text}</span>
          <button
            type="button"
            className="edit-bar-cancel"
            onClick={onCancelEdit}
            title="انصراف"
            aria-label="انصراف از ویرایش"
          >
            <i className="fas fa-xmark" aria-hidden="true" />
          </button>
        </div>
      )}

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
              {uploading
                ? 'در حال بارگذاری و ارسال فایل…'
                : isEditing ? 'در حال ذخیره…' : 'در حال ارسال…'}
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
          ref={attachRef}
          type="button"
          className={`icon-btn attach-btn${showAttach ? ' active' : ''}`}
          title={blocked ?? (isEditing ? 'ویرایش فقط متن را عوض می‌کند؛ پیوست در این حالت نیست' : 'پیوست')}
          aria-label="پیوست"
          aria-haspopup="menu"
          aria-expanded={showAttach}
          // An edit rewrites one text row, so there is nothing for a file to
          // attach to — the picker stays shut until the edit is over.
          disabled={busy || Boolean(blocked) || isEditing}
          onClick={() => setShowAttach(open => !open)}
        >
          <i className={`fas ${blocked ? 'fa-lock' : 'fa-paperclip'}`} aria-hidden="true" />
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
          title={blocked ?? (isEditing ? 'ذخیره ویرایش' : 'ارسال پیام')}
          aria-label={isEditing ? 'ذخیره ویرایش' : 'ارسال پیام'}
          disabled={!text.trim() || busy || !connected || Boolean(blocked)}
        >
          {sending
            ? <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            : <i className={`fas ${isEditing ? 'fa-check' : 'fa-paper-plane'}`} aria-hidden="true" />}
        </button>
      </form>
    </div>
  );
}
