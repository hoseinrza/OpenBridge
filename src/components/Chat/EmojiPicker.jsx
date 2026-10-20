import { useEffect, useRef } from 'react';

const SECTIONS = [
  { label: 'خوشحال',   emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😎'] },
  { label: 'احساسات', emojis: ['😢','😭','😤','😠','😡','🤬','😞','😟','😣','🥺','😩','😫','😮','😱','🤯'] },
  { label: 'متفکر',   emojis: ['🤔','🤨','😐','😑','🙄','😏','😒','🤦','🤷','😬','🫡','💀'] },
  { label: 'دیگر',    emojis: ['👍','👎','👏','🙏','💪','🤝','❤️','🔥','✅','🎉','💯','👀','⭐','🎊','💬','🫶'] },
];

export default function EmojiPicker({ onSelect, onClose, onDismiss }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onCloseRef.current = onClose;
    onDismissRef.current = onDismiss;
  }, [onClose, onDismiss]);

  useEffect(() => {
    ref.current?.querySelector('.emoji-opt')?.focus();

    function onPointerDown(e) {
      if (!ref.current?.contains(e.target)) onCloseRef.current();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') (onDismissRef.current ?? onCloseRef.current)();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div
      className="emoji-picker"
      ref={ref}
      role="dialog"
      aria-label="انتخاب ایموجی"
    >
      <div className="emoji-picker-head">
        <span>انتخاب ایموجی</span>
        <button type="button" className="icon-btn" onClick={onDismiss ?? onClose} aria-label="بستن انتخاب ایموجی">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </div>

      {SECTIONS.map(({ label, emojis }) => (
        <section key={label} className="emoji-section">
          <h3 className="emoji-section-label">{label}</h3>
          <div className="emoji-grid">
            {emojis.map(emoji => (
              <button
                key={emoji}
                type="button"
                className="emoji-opt"
                onClick={() => onSelect(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
