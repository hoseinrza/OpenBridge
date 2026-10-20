import { useState } from 'react';
import './Avatar.css';

const STATUS_LABELS = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };

const PALETTE = [
  ['#E5484D', '#B0243A'],
  ['#F76808', '#D24A1B'],
  ['#FFB22E', '#E8830C'],
  ['#46A758', '#1F7A4C'],
  ['#12A594', '#0B6E77'],
  ['#3E96E6', '#1B5FBF'],
  ['#8E66E0', '#5B3BA8'],
  ['#D6409F', '#9C2A77'],
];

// An account without an uploaded photo is drawn from its own name: the first
// letter, plus the first letter of the family name when there is one.
function initialsOf(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0];
  if (words.length === 1) return first.toUpperCase();
  return (first + Array.from(words[words.length - 1])[0]).toUpperCase();
}

function paletteOf(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export default function Avatar({ src, name = '', size = 40, status, group = false, className = '' }) {
  const [failedSrc, setFailedSrc] = useState(null);

  const showImage = src && failedSrc !== src;
  const initials = initialsOf(name);
  const [from, to] = paletteOf(name || initials);

  return (
    <span
      className={`avatar ${group ? 'avatar-group' : ''} ${className}`}
      style={{ '--avatar-size': `${size}px` }}
    >
      {showImage ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailedSrc(src)} />
      ) : (
        <span
          className={`avatar-fallback ${group ? '' : 'avatar-initials'}`}
          aria-hidden="true"
          style={group ? undefined : {
            backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
            fontSize: `${Math.round(size * (initials.length > 1 ? 0.32 : 0.42))}px`,
          }}
        >
          {group ? <i className="fas fa-users" /> : initials}
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
