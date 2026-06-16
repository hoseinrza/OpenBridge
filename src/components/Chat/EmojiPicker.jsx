import { useEffect, useRef } from 'react';

const SECTIONS = [
  { label: 'خوشحال',   emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😎'] },
  { label: 'احساسات', emojis: ['😢','😭','😤','😠','😡','🤬','😞','😟','😣','🥺','😩','😫','😮','😱','🤯'] },
  { label: 'متفکر',   emojis: ['🤔','🤨','😐','😑','🙄','😏','😒','🤦','🤷','😬','🫡','💀'] },
  { label: 'دیگر',    emojis: ['👍','👎','👏','🙏','💪','🤝','❤️','🔥','✅','🎉','💯','👀','⭐','🎊','💬','🫶'] },
];

export default function EmojiPicker({ onSelect, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function down(e) {
      if (!ref.current?.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref}>
      {SECTIONS.map(({ label, emojis }) => (
        <div key={label} className="emoji-section">
          <div className="emoji-section-label">{label}</div>
          <div className="emoji-grid">
            {emojis.map(e => (
              <button key={e} className="emoji-opt" onClick={() => onSelect(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
