import { useEffect, useRef, useState } from 'react';
import { searchUsers, normalizeUser } from '../../services/api.js';
import './NewChatModal.css';

export default function NewChatModal({ onClose, onSelect }) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const inputRef    = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); setLoading(false); setError(''); return; }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      searchUsers(q)
        .then(list => { setResults(list.map(normalizeUser)); setError(''); })
        .catch(() => setError('جستجو ناموفق بود'))
        .finally(() => setLoading(false));
    }, 350);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  return (
    <div className="newchat-overlay" onClick={onClose}>
      <div className="newchat-modal" onClick={e => e.stopPropagation()}>
        <div className="newchat-header">
          <span>گفتگوی جدید</span>
          <button className="newchat-close" onClick={onClose}>
            <i className="fas fa-xmark" />
          </button>
        </div>

        <div className="newchat-search">
          <i className="fas fa-magnifying-glass" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="نام کاربری را جستجو کن..."
          />
        </div>

        <div className="newchat-results">
          {loading && (
            <div className="newchat-state"><i className="fas fa-spinner fa-spin" />در حال جستجو...</div>
          )}

          {!loading && error && (
            <div className="newchat-state error"><i className="fas fa-triangle-exclamation" />{error}</div>
          )}

          {!loading && !error && !query.trim() && (
            <div className="newchat-state">
              <i className="fas fa-magnifying-glass" />
              نام کاربری شخص مورد نظر را وارد کن تا گفتگوی جدید را شروع کنی
            </div>
          )}

          {!loading && !error && query.trim() && results.length === 0 && (
            <div className="newchat-state"><i className="fas fa-user-slash" />کاربری با این نام پیدا نشد</div>
          )}

          {!loading && results.map(user => (
            <button key={user.id} className="newchat-result" onClick={() => onSelect(user)}>
              <div className="user-avatar">
                <img src={user.avatar} alt={user.name} />
                <span className={`status ${user.status}`} />
              </div>
              <div className="newchat-result-info">
                <span className="newchat-result-name">{user.name}</span>
                {user.bio && <span className="newchat-result-bio">{user.bio}</span>}
              </div>
              <i className="fas fa-arrow-left newchat-result-go" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
