import { useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import AttachMenu from './AttachMenu.jsx';
import { createVoiceRecorder, voiceRecordingSupported } from '../../services/voice.js';
import { formatDuration } from '../../utils/format.js';

const MAX_TEXTAREA_HEIGHT = 132;
// How many bars the scrolling meter keeps, and how often a new one is pushed into
// it. The meter is decoration with a purpose — it says the microphone is alive —
// so it is sampled far below the frame rate the level is read at.
const LEVEL_BARS = 24;
const LEVEL_SAMPLE_MS = 55;

export default function InputArea({
  onSend, onTyping, connected = true, blocked = null,
  editing = null, onSaveEdit, onCancelEdit,
  replying = null, onCancelReply,
}) {
  const [text, setText]           = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [sending, setSending]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState('');
  // Recording is a mode of the composer, the same way editing is: the text field
  // steps aside, the send button becomes a stop, and the only way out is to send
  // what was captured or throw it away.
  const [recording, setRecording] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bars, setBars]           = useState([]);
  const textareaRef = useRef(null);
  const fileRef     = useRef(null);
  const emojiRef    = useRef(null);
  const attachRef   = useRef(null);
  const recorderRef = useRef(null);
  const stoppingRef = useRef(false);
  const sampleAtRef = useRef(0);
  const voiceSendRef = useRef(null);
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
  const canRecordVoice = voiceRecordingSupported();

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
      : await onSend({ type: 'text', text: value, reply: replying ?? undefined });
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
      else if (replying) onCancelReply?.();
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
      reply: replying ?? undefined,
    });
    setUploading(false);

    if (!result?.ok) {
      setError(result?.error || 'ارسال فایل ناموفق بود');
      return;
    }
    textareaRef.current?.focus();
  }

  function dropRecording() {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stoppingRef.current = false;
    setRecording(null);
    setElapsedMs(0);
    setBars([]);
  }

  async function startRecording() {
    if (busy || recording || isEditing) return;
    if (blocked) { setError(blocked); return; }
    if (!connected) { setError('اتصال به سرور برقرار نیست؛ پیام صوتی ارسال نشد'); return; }

    const recorder = createVoiceRecorder();
    try {
      await recorder.start();
    } catch (err) {
      // A refused permission comes back as a named error and says what to do
      // about it; anything else means there was no microphone to open at all.
      setError(err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
        ? 'برای ضبط پیام صوتی، دسترسی به میکروفون را اجازه بده'
        : 'دستگاه ضبط صدا پیدا نشد');
      return;
    }
    recorderRef.current = recorder;
    setElapsedMs(0);
    setBars([]);
    setError('');
    setRecording('live');
  }

  async function sendRecording() {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRef.current) return;
    stoppingRef.current = true;
    setRecording('sending');

    let file;
    let durationMs;
    try {
      ({ file, durationMs } = await recorder.stop());
    } catch (err) {
      dropRecording();
      setError(err?.message || 'ضبط پیام صوتی ناموفق بود');
      return;
    }
    recorderRef.current = null;
    stoppingRef.current = false;
    setUploading(true);
    // No object URL is made for a preview: the bubble that appears is the one the
    // server broadcasts back, with its own signed address on it.
    const result = await onSend({
      type: 'voice', name: file.name, size: file.size, durationMs, _file: file,
      reply: replying ?? undefined,
    });
    setUploading(false);
    setRecording(null);
    setElapsedMs(0);
    setBars([]);

    if (!result?.ok) setError(result?.error || 'ارسال پیام صوتی ناموفق بود');
  }

  // The ceiling is enforced from inside the frame loop, which is one turn away
  // from the render that made the handler — so the loop reaches the current one
  // through a ref instead of depending on it and restarting every frame.
  const sendVoiceRef = useRef(null);
  useEffect(() => { sendVoiceRef.current = sendRecording; });

  // The timer, the meter and the ceiling all ride one frame loop, and the loop
  // only exists while a recording is open. Past the ceiling the composer stops
  // on its own rather than recording something it cannot send.
  useEffect(() => {
    if (recording !== 'live') return undefined;
    let frame = requestAnimationFrame(function tick(now) {
      const recorder = recorderRef.current;
      if (!recorder) return;
      setElapsedMs(recorder.elapsed());
      if (now - sampleAtRef.current >= LEVEL_SAMPLE_MS) {
        sampleAtRef.current = now;
        const level = recorder.level();
        setBars(prev => [...prev.slice(-(LEVEL_BARS - 1)), level]);
      }
      if (recorder.elapsed() >= recorder.maxMs) { sendVoiceRef.current?.(); return; }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [recording]);

  // A chat switch, an edit or a lost connection while the microphone is open
  // throws the recording away: a voice note is never meant to land in a
  // conversation nobody started it in.
  useEffect(() => {
    if (recording === 'live' && (blocked || isEditing || !connected)) dropRecording();
  }, [recording, blocked, isEditing, connected]);

  // Escape throws the recording away wherever the focus has got to: opening the
  // bar moves focus onto its send button, but a click elsewhere must not leave an
  // open microphone running behind a screen that no longer shows one.
  useEffect(() => {
    if (!recording) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') dropRecording();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [recording]);

  useEffect(() => {
    if (recording === 'live') voiceSendRef.current?.focus();
  }, [recording]);

  // Leaving the screen takes the microphone with it.
  useEffect(() => () => recorderRef.current?.cancel(), []);

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

      {/* A reply is a state of the composer too: it says who is being answered
          and keeps one line of the question in sight until the answer is sent
          or the state is dropped. */}
      {replying && !editing && (
        <div className="edit-bar reply-bar">
          <span className="edit-bar-title">
            <i className="fas fa-reply" aria-hidden="true" />
            پاسخ به {replying.senderName || 'کاربر'}
          </span>
          <span className="edit-bar-preview" title={replying.preview}>{replying.preview}</span>
          <button
            type="button"
            className="edit-bar-cancel"
            onClick={onCancelReply}
            title="انصراف"
            aria-label="انصراف از پاسخ"
          >
            <i className="fas fa-xmark" aria-hidden="true" />
          </button>
        </div>
      )}

      {blocked && (
        <div className="composer-note is-blocked" role="status">
          <i className="fas fa-circle-info" aria-hidden="true" />
          <span>{blocked}</span>
        </div>
      )}

      {(busy || error) && (
        <div className={`composer-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {busy ? (
            <>
              <i className="fas fa-spinner fa-spin" aria-hidden="true" />
              {uploading
                ? (recording ? 'در حال بارگذاری و ارسال پیام صوتی…' : 'در حال بارگذاری و ارسال فایل…')
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

      {recording ? (
        <div className="input-area voice-recording">
          {/* The same capsule the written message uses, so starting a recording
              moves nothing: only what sits inside the pill changes. */}
          <div className="input-wrap">
            <button
              type="button"
              className="icon-btn voice-rec-cancel"
              onClick={dropRecording}
              title="لغو"
              aria-label="لغو ضبط پیام صوتی"
            >
              <i className="fas fa-trash" aria-hidden="true" />
            </button>

            <span className="voice-rec-timer" role="timer">
              <i className="fas fa-circle" aria-hidden="true" />
              {formatDuration(elapsedMs)}
            </span>

            {/* The bars are the microphone's own level, sampled as it happens: they
                say the recording is alive, and nothing more. They are not a picture
                of the finished file, and the bubble does not pretend otherwise. */}
            <span className="voice-rec-meter" aria-hidden="true">
              {bars.map((level, index) => (
                <b key={index} style={{ transform: `scaleY(${0.14 + Math.min(1, level) * 0.86})` }} />
              ))}
            </span>
          </div>

          <button
            type="button"
            ref={voiceSendRef}
            className="send-btn"
            onClick={sendRecording}
            disabled={recording === 'sending'}
            title="ارسال پیام صوتی"
            aria-label="ارسال پیام صوتی"
          >
            <i className={`fas ${recording === 'sending' ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} aria-hidden="true" />
          </button>
        </div>
      ) : (
      <form
        className="input-area"
        onSubmit={e => { e.preventDefault(); handleSend(); }}
      >
        {/* One surface, not three boxes: the clip, the field and the smiley share
            a single capsule and only the button that leaves the chat stands
            outside it, as the one solid shape in the row. */}
        <div className="input-wrap">
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
            <i className="fas fa-paperclip" aria-hidden="true" />
          </button>

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

        {/* One button, two jobs, exactly as the phone app does it: an empty field
            offers the microphone and a written one offers the plane. A browser
            with no recording support simply never shows it. */}
        {canRecordVoice && !text.trim() && !isEditing ? (
          <button
            type="button"
            className="send-btn mic-btn"
            onClick={startRecording}
            disabled={busy || !connected || Boolean(blocked)}
            title={blocked ?? 'ضبط پیام صوتی'}
            aria-label="ضبط پیام صوتی"
          >
            <i className="fas fa-microphone" aria-hidden="true" />
          </button>
        ) : (
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
        )}
      </form>
      )}
    </div>
  );
}
