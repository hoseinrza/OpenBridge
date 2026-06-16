import { useState, useRef } from 'react';
import EmojiPicker from './EmojiPicker.jsx';

export default function InputArea({ onSend, onTyping }) {
  const [text, setText]           = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const inputRef = useRef(null);
  const fileRef  = useRef(null);

  function handleSend() {
    if (!text.trim()) return;
    onSend({ type: 'text', text: text.trim() });
    setText('');
    setShowEmoji(false);
    inputRef.current?.focus();
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleEmoji(emoji) {
    setText(prev => prev + emoji);
    inputRef.current?.focus();
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const type = file.type.startsWith('image/') ? 'image' : 'file';
    onSend({ type, src: URL.createObjectURL(file), name: file.name, size: file.size, text: '', _file: file });
  }

  return (
    <div className="input-area">
      {showEmoji && (
        <EmojiPicker onSelect={handleEmoji} onClose={() => setShowEmoji(false)} />
      )}

      <input ref={fileRef} type="file" accept="image/*,*/*" hidden onChange={handleFile} />

      <button className="icon-btn" title="پیوست فایل" onClick={() => fileRef.current?.click()}>
        <i className="fas fa-circle-plus" />
      </button>

      <div className="input-wrap">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={e => { setText(e.target.value); onTyping?.(); }}
          onKeyDown={handleKey}
          placeholder="پیام بنویسید..."
          autoComplete="off"
        />
        <button
          className={`icon-btn emoji ${showEmoji ? 'active' : ''}`}
          title="ایموجی"
          onClick={() => setShowEmoji(v => !v)}
        >
          <i className="far fa-face-smile" />
        </button>
      </div>

      <button className="send-btn" onClick={handleSend} title="ارسال">
        <i className="fas fa-paper-plane" />
      </button>
    </div>
  );
}
