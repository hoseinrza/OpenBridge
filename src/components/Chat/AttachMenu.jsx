import { useEffect, useRef } from 'react';

// Two kinds because that is what the composer can actually send: a picture that
// renders in the thread, and anything else that renders as a file row. A photo
// chosen under «فایل» stays a file row, which is the whole point of asking.
const CHOICES = [
  { kind: 'image', icon: 'fa-image',      label: 'تصویر', accept: 'image/*' },
  { kind: 'file',  icon: 'fa-file-lines', label: 'فایل',  accept: '*/*' },
];

export default function AttachMenu({ onPick, onClose, ignoreRef }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector('.attach-opt')?.focus();

    function onPointerDown(e) {
      if (ref.current?.contains(e.target) || ignoreRef?.current?.contains(e.target)) return;
      onCloseRef.current();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onCloseRef.current();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ignoreRef]);

  return (
    <div className="attach-menu" ref={ref} role="dialog" aria-label="انتخاب نوع محتوا">
      {CHOICES.map(choice => (
        <button
          key={choice.kind}
          type="button"
          className="attach-opt"
          onClick={() => onPick(choice)}
        >
          <i className={`fas ${choice.icon}`} aria-hidden="true" />
          <span>{choice.label}</span>
        </button>
      ))}
    </div>
  );
}
