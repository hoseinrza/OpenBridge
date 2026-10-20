import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export default function Modal({ onClose, labelledBy, className = '', children, initialFocus = true }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const restoreRef = useRef(null);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;

    if (initialFocus) {
      const first = panel?.querySelector(FOCUSABLE);
      (first ?? panel)?.focus();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [initialFocus]);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current?.(); }}
    >
      <div
        ref={panelRef}
        className={`modal-panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
