import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TAPBACKS = ['👍', '❤️', '😂', '😮', '😢'];
const EDGE = 8;
const GAP = 8;

// Copy has two roads: the async clipboard API, and — when the page is not a
// secure context or the browser refuses a promise it did not expect — a
// throwaway textarea selected and copied the old way. Neither road may throw
// out of here, because the only answer the caller needs is whether it worked.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = 'position:fixed;top:0;inset-inline-start:0;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// A zero-size anchor at the pointer and the bubble's own rect are the same thing
// to this component: a place the menu hangs itself on.
export default function MessageActionsMenu({
  anchor, message, chatEncrypted, held, onReact, onReply, onForward, onEdit, onDelete, onToast, onClose,
}) {
  const [step, setStep] = useState('actions'); // actions | delete
  const [placed, setPlaced] = useState(null);
  const panelRef = useRef(null);
  const titleId  = `msg-actions-${message.id}`;

  const isMine = message.side === 'mine';
  // An encrypted row has no server-side row to rewrite, so edit and
  // delete-for-everyone travel as control envelopes instead. The permissions
  // are still the sender's: the message's own sequence is what a control
  // addresses, and the client refuses one aimed at somebody else's message.
  const canEdit = isMine && message.type === 'text'
    && (message.encrypted ? Number.isInteger(message.seq) : !chatEncrypted);
  const canDeleteForEveryone = isMine && (!message.encrypted || Number.isInteger(message.seq));
  const canReact = !message.encrypted;
  // An encrypted attachment only decrypts inside its own conversation, so a
  // forward would arrive as bytes the destination cannot open.
  const canForward = !(message.encrypted && message.attachment);
  const hasText = Boolean(message.text);

  // Measured after the panel exists, before the browser paints: a menu that
  // appeared at the wrong place for one frame would shove the conversation
  // sideways for exactly as long as it takes to notice.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE),
      Math.max(EDGE, window.innerWidth - width - EDGE),
    );
    // Below the anchor while there is room, above it when there is not; a
    // window too short for either gets the nearest legal edge.
    const below = anchor.top + anchor.height + GAP;
    const top   = window.innerHeight - below >= height + GAP
      ? below
      : anchor.top - height - GAP;
    setPlaced({ left, top: Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE)) });
  }, [anchor, step]);

  // The menu is a leaf: it closes for anything that happens outside it, for any
  // scroll that would leave it behind, and as soon as one of its own actions
  // starts — a retry always begins from a closed menu.
  useEffect(() => {
    function onPointerDown(event) {
      if (!panelRef.current?.contains(event.target)) onClose();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      // In a right-to-left menu the row of tapbacks runs right to left, so the
      // horizontal arrow that means "next" is the one that points left here.
      const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
      const forward = event.key === 'ArrowDown' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
      const back    = event.key === 'ArrowUp'   || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
      if (!forward && !back) return;
      const items = [...panelRef.current?.querySelectorAll('[data-menu-item]') ?? []]
        .filter(el => !el.disabled);
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement);
      const next = at < 0
        ? (forward ? 0 : items.length - 1)
        : (at + (forward ? 1 : -1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }
    function dismiss() { onClose(); }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  // Every step opens with its first item focused: the keyboard never has to
  // guess where the pointer left off. The focus must not scroll: the panel is
  // placed one layout pass before this runs, and a scroll caused by focusing
  // would reach the menu's own dismiss-on-scroll listener and close it.
  useEffect(() => {
    panelRef.current?.querySelector('[data-menu-item]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [step]);

  // An action takes the menu away with it; the delete step's own cancel is the
  // one entry that keeps it open, because it only steps back to the list.
  function run(action, stay = false) {
    if (!stay) onClose();
    action?.();
  }

  const items = step === 'delete'
    ? [
      ...(canDeleteForEveryone
        ? [{ key: 'everyone', icon: 'fa-user-xmark', label: 'حذف برای همه', danger: true, onSelect: () => onDelete('everyone') }]
        : []),
      { key: 'me', icon: 'fa-user', label: 'حذف برای من', danger: true, onSelect: () => onDelete('me') },
      { key: 'cancel', icon: 'fa-xmark', label: 'انصراف', stay: true, onSelect: () => setStep('actions') },
    ]
    : [
      { key: 'reply', icon: 'fa-reply', label: 'پاسخ', onSelect: () => onReply?.() },
      ...(hasText
        ? [{
          key: 'copy',
          icon: 'fa-copy',
          label: 'کپی',
          onSelect: async () => {
            const ok = await copyText(message.text);
            onToast?.(ok ? 'کپی شد' : 'کپی ناموفق بود');
          },
        }]
        : []),
      ...(canForward
        ? [{ key: 'forward', icon: 'fa-share', label: 'فروارد', onSelect: () => onForward?.() }]
        : []),
      ...(canEdit
        ? [{ key: 'edit', icon: 'fa-pen-to-square', label: 'ویرایش', onSelect: () => onEdit({ id: message.id, text: message.text }) }]
        : []),
      { key: 'delete', icon: 'fa-trash-can', label: 'حذف', danger: true, stay: true, onSelect: () => setStep('delete') },
    ];

  return createPortal(
    <div
      ref={panelRef}
      className="msg-actions"
      role="menu"
      aria-labelledby={step === 'delete' ? titleId : undefined}
      style={placed ? { top: placed.top, left: placed.left } : { top: -9999, left: -9999 }}
    >
      {step === 'actions' && canReact && (
        <>
          <div className="msg-actions-tapbacks" role="group" aria-label="واکنش‌ها">
            {TAPBACKS.map(emoji => (
              <button
                key={emoji}
                type="button"
                data-menu-item
                role="menuitemcheckbox"
                aria-checked={held.includes(emoji)}
                className={`msg-actions-emoji${held.includes(emoji) ? ' active' : ''}`}
                aria-label={held.includes(emoji) ? `برداشتن واکنش ${emoji}` : `افزودن واکنش ${emoji}`}
                title={held.includes(emoji) ? 'برای برداشتن واکنش دوباره بزن' : 'واکنش نشان بده'}
                onClick={() => run(() => onReact(emoji))}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="msg-actions-sep" role="separator" />
        </>
      )}

      {step === 'delete' && (
        <p className="msg-actions-title" id={titleId}>حذف پیام</p>
      )}

      {items.map(({ key, icon, label, danger, stay, onSelect }) => (
        <button
          key={key}
          type="button"
          data-menu-item
          role="menuitem"
          className={`msg-actions-item${danger ? ' is-danger' : ''}`}
          onClick={() => run(() => onSelect(), stay)}
        >
          <i className={`fas ${icon}`} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
