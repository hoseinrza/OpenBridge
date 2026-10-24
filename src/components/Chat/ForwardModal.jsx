import { useMemo, useState } from 'react';
import Avatar from '../ui/Avatar.jsx';
import Modal from '../ui/Modal.jsx';
import { messagePreview } from '../../utils/message.js';
import './ForwardModal.css';

// The forward picker: every conversation this device knows, because forwarding
// is a choice about the destination and nothing about the open chat. The copy is
// sent through the same path as a normal message, so the destination's own
// encryption decides how it travels.
export default function ForwardModal({ message, chats, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = Array.isArray(chats) ? chats : [];
    if (!needle) return list;
    return list.filter(chat => (chat.name ?? '').toLowerCase().includes(needle));
  }, [chats, query]);

  async function pick(chat) {
    if (busyId) return;
    setBusyId(chat.id);
    const result = await onPick(chat);
    setBusyId(null);
    if (result?.ok) onClose();
  }

  return (
    <Modal onClose={onClose} labelledBy="forward-title" className="forward-modal">
      <header className="forward-head">
        <div className="forward-head-text">
          <h2 id="forward-title">فروارد پیام</h2>
          <p className="forward-preview" title={messagePreview(message)}>
            {messagePreview(message)}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="forward-search">
        <i className="fas fa-magnifying-glass" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="جستجوی گفتگو…"
          aria-label="جستجوی گفتگو"
          autoComplete="off"
        />
      </div>

      <div className="forward-list">
        {matches.length === 0 && (
          <div className="forward-state" role="status">
            <i className="fas fa-comment-slash" aria-hidden="true" />
            {query.trim() ? 'گفتگویی با این نام پیدا نشد' : 'هنوز گفتگویی نداری'}
          </div>
        )}

        {matches.map(chat => (
          <button
            key={chat.id}
            type="button"
            className="forward-row"
            onClick={() => pick(chat)}
            disabled={Boolean(busyId)}
          >
            <Avatar
              src={chat.avatar}
              name={chat.name}
              size={40}
              group={chat.kind === 'group'}
              status={chat.status}
            />
            <span className="forward-row-info">
              <span className="forward-row-name">{chat.name}</span>
              <span className="forward-row-meta">
                {chat.kind === 'group'
                  ? 'گروه'
                  : (chat.username ? `@${chat.username}` : 'گفتگو')}
              </span>
            </span>
            {busyId === chat.id
              ? <i className="fas fa-spinner fa-spin forward-row-go" aria-hidden="true" />
              : <i className="fas fa-paper-plane forward-row-go" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
