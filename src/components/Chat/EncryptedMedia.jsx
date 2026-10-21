import { useCallback, useEffect, useRef, useState } from 'react';
import { openAttachment } from '../../services/attachments.js';
import { formatSize } from '../../utils/format.js';
import './EncryptedMedia.css';

// Renders one attachment whose bytes the server cannot open.
//
// A decrypted file has no address, so it can only be shown from an object URL
// this component makes and then gives back. That is also why the loading rules
// live here: an image is opened when it nears the viewport rather than for
// every message in a long history, and a bigger file is only fetched when the
// person watching it asks for it. If authentication fails the promise rejects
// and nothing is ever displayed — a changed file has no other rendering path.

const LOCKED_NOTE = 'این پیام فقط روی دستگاه شما و طرف مقابل رمزگشایی می‌شود';
const FAILED_NOTE = 'بازکردن فایل ناموفق بود';

export default function EncryptedMedia({ attachment, kind, name, size, onOpen }) {
  const [state, setState] = useState('idle');
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  const boxRef = useRef(null);
  const held = useRef(null);
  const dead = useRef(false);

  useEffect(() => {
    dead.current = false;
    return () => {
      dead.current = true;
      held.current?.();
      held.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    if (held.current) return;
    setState('loading');
    setError('');
    try {
      const opened = await openAttachment(attachment);
      if (dead.current) {
        opened.release();
        return;
      }
      held.current = opened.release;
      setUrl(opened.url);
      setState('ready');
      return opened.url;
    } catch (err) {
      setState('error');
      setError(err?.message || FAILED_NOTE);
      return null;
    }
  }, [attachment]);

  // A picture in a bubble is only opened once it is worth opening: the history
  // can hold far more of them than this screen shows at once.
  useEffect(() => {
    if (kind !== 'image' || state !== 'idle') return undefined;
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver !== 'function') {
      load();
      return undefined;
    }
    const observer = new IntersectionObserver(
      entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [kind, state, load]);

  async function handleFile() {
    const target = url ?? (await load());
    if (!target) return;
    const link = document.createElement('a');
    link.href = target;
    link.download = name || 'file';
    link.click();
  }

  if (kind === 'file') {
    return (
      <div className="enc-media" ref={boxRef}>
        <button
          type="button"
          className="bubble-file-link"
          onClick={handleFile}
          aria-label={`دانلود ${name || 'فایل'}`}
          disabled={state === 'loading'}
        >
          <span className="bubble-file-icon" aria-hidden="true">
            <i className={`fas ${state === 'loading' ? 'fa-spinner fa-spin' : 'fa-file-arrow-down'}`} />
          </span>
          <span className="bubble-file-info">
            <span className="bubble-file-name" title={name}>{name || 'فایل'}</span>
            <span className="bubble-file-size">
              {state === 'error' ? FAILED_NOTE : `${formatSize(size)} · رمزنگاری سرتاسری`}
            </span>
          </span>
          <i className="fas fa-lock bubble-file-dl" aria-hidden="true" />
        </button>
        {state === 'error' && <span className="sr-only" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <div className="enc-media" ref={boxRef}>
      {state === 'ready' ? (
        <button
          type="button"
          className="msg-image-btn"
          onClick={() => onOpen?.(url)}
          aria-label="بازکردن تصویر در اندازه کامل"
        >
          <img src={url} alt={name || 'تصویر ارسالی'} className="msg-image" />
        </button>
      ) : (
        <div className={`enc-media-state ${state === 'error' ? 'is-error' : ''}`}
             role={state === 'error' ? 'alert' : 'status'}>
          <i className={`fas ${state === 'error' ? 'fa-triangle-exclamation' : 'fa-lock'}`} aria-hidden="true" />
          <span>{state === 'error' ? error : LOCKED_NOTE}</span>
          {state === 'error' && (
            <button type="button" className="enc-media-retry" onClick={load}>تلاش دوباره</button>
          )}
        </div>
      )}
    </div>
  );
}
