import { useState } from 'react';
import './Avatar.css';

const STATUS_LABELS = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };

export default function Avatar({ src, name = '', size = 40, status, group = false, className = '' }) {
  const [failedSrc, setFailedSrc] = useState(null);

  const showImage = src && failedSrc !== src;
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <span
      className={`avatar ${group ? 'avatar-group' : ''} ${className}`}
      style={{ '--avatar-size': `${size}px` }}
    >
      {showImage ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailedSrc(src)} />
      ) : (
        <span className="avatar-fallback" aria-hidden="true">
          {group ? <i className="fas fa-users" /> : initial}
        </span>
      )}
      {status && (
        <>
          <span className={`presence presence-${status}`} aria-hidden="true" />
          <span className="sr-only">{STATUS_LABELS[status] ?? STATUS_LABELS.offline}</span>
        </>
      )}
    </span>
  );
}
