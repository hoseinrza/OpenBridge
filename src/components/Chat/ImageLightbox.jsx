import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { openAttachment } from '../../services/attachments.js';
import { formatDayLabel } from '../../utils/time.js';

// A swipe has to be deliberate: shorter than this and it is a tap that fell
// short of the edge, which would otherwise jump pictures by accident.
const SWIPE_MIN = 56;

const fa = value => value.toLocaleString('fa-IR');

// The thread reads right-to-left, so "the next picture" is the one entering from
// the left: the arrows, the arrow keys and the drag all move that way.
export default function ImageLightbox({ items, index, onIndex, onClose }) {
  const item = items[index];
  const total = items.length;
  const blob = item?.attachment?.blob ?? null;
  // Pictures this device can address are shown straight from their own address;
  // an encrypted one is opened here and kept until the viewer closes, so walking
  // back through a thread never fetches the same bytes twice.
  const [opened, setOpened] = useState(() => new Map());
  const holdsRef = useRef(new Map());
  const closedRef = useRef(false);
  const dragRef = useRef(null);
  const [drift, setDrift] = useState(0);

  const addr = item?.src
    ? { status: 'ready', url: item.src }
    : blob
      ? (opened.get(blob) ?? { status: 'loading' })
      : { status: 'error' };

  useEffect(() => {
    if (!blob || item.src || holdsRef.current.has(blob)) return undefined;
    holdsRef.current.set(blob, null); // claimed first, so a re-render cannot fetch twice
    openAttachment(item.attachment).then(
      openedFile => {
        // Closed while the bytes were still arriving: hand back what was taken.
        if (closedRef.current) {
          openedFile.release();
          return;
        }
        holdsRef.current.set(blob, openedFile.release);
        setOpened(prev => new Map(prev).set(blob, { status: 'ready', url: openedFile.url }));
      },
      () => setOpened(prev => new Map(prev).set(blob, { status: 'error' })),
    );
  }, [blob, item]);

  useEffect(() => {
    const holds = holdsRef.current;
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      holds.forEach(release => release?.());
      holds.clear();
    };
  }, []);

  useEffect(() => {
    if (total < 2) return undefined;
    function onKeyDown(e) {
      const delta = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = index + delta;
      if (next >= 0 && next < total) onIndex(next);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index, total, onIndex]);

  function step(delta) {
    const next = index + delta;
    if (next >= 0 && next < total) onIndex(next);
  }

  function onPointerDown(e) {
    dragRef.current = { x: e.clientX, id: e.pointerId };
    setDrift(0);
  }

  function onPointerMove(e) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.id) return;
    setDrift(e.clientX - drag.x);
  }

  function onPointerUp(e) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDrift(0);
    if (!drag) return;
    const distance = e.clientX - drag.x;
    if (Math.abs(distance) < SWIPE_MIN) {
      // The dark area around the picture is the backdrop; the picture is not.
      if (e.target === e.currentTarget) onClose();
      return;
    }
    if (total > 1) step(distance < 0 ? 1 : -1);
  }

  const ready = addr.status === 'ready';

  return (
    <Modal onClose={onClose} labelledBy="image-viewer-title" className="image-viewer">
      <h2 id="image-viewer-title" className="sr-only">نمایش تصویر در اندازه کامل</h2>

      <header className="viewer-head">
        <span className="viewer-counter">{fa(index + 1)} از {fa(total)}</span>
        <button type="button" className="viewer-close" onClick={onClose} aria-label="بستن تصویر">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div
        className="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; setDrift(0); }}
      >
        {ready && (
          <img
            src={addr.url}
            alt={item.text || 'تصویر ارسالی'}
            className="viewer-image"
            draggable={false}
            style={{ transform: `translateX(${drift}px)` }}
          />
        )}
        {addr.status === 'loading' && (
          <span className="viewer-state" role="status">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            در حال بارگذاری تصویر…
          </span>
        )}
        {addr.status === 'error' && (
          <span className="viewer-state is-error" role="alert">تصویر باز نشد</span>
        )}
      </div>

      {total > 1 && index > 0 && (
        <button type="button" className="viewer-nav is-prev" onClick={() => step(-1)} aria-label="تصویر قبلی">
          <i className="fas fa-chevron-right" aria-hidden="true" />
        </button>
      )}
      {total > 1 && index < total - 1 && (
        <button type="button" className="viewer-nav is-next" onClick={() => step(1)} aria-label="تصویر بعدی">
          <i className="fas fa-chevron-left" aria-hidden="true" />
        </button>
      )}

      <footer className="viewer-foot">
        <div className="viewer-info">
          <p className="viewer-meta">
            {item.side === 'mine' ? 'شما' : (item.sender || 'کاربر')} · {formatDayLabel(item.createdAt)}
          </p>
          {!!item.text && <p className="viewer-caption">{item.text}</p>}
        </div>

        {ready && (
          <a
            className="viewer-download"
            href={addr.url}
            download={item.name || 'image'}
            target="_blank"
            rel="noopener noreferrer"
            title="دانلود تصویر"
            aria-label="دانلود تصویر"
          >
            <i className="fas fa-download" aria-hidden="true" />
          </a>
        )}
      </footer>
    </Modal>
  );
}
