import { useEffect, useRef, useState } from 'react';
import { searchUsers, createGroup, normalizeUser } from '../../services/api.js';
import './NewChatModal.css';

export default function NewChatModal({ onClose, onSelect, onGroupCreated }) {
  const [mode,     setMode]     = useState('direct');
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [groupName, setGroupName] = useState('');
  const [selected,  setSelected]  = useState([]);
  const [creating,  setCreating]  = useState(false);
  const [createError, setCreateError] = useState('');
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
        .then(list => { setResults(list.map(normalizeUser).filter(Boolean)); setError(''); })
        .catch(() => setError('جستجو ناموفق بود'))
        .finally(() => setLoading(false));
    }, 350);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function switchMode(next) {
    setMode(next);
    setCreateError('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function toggleMember(user) {
    setCreateError('');
    setSelected(prev => prev.some(s => s.id === user.id)
      ? prev.filter(s => s.id !== user.id)
      : [...prev, user]);
  }

  function removeMember(userId) {
    setSelected(prev => prev.filter(s => s.id !== userId));
  }

  async function handleCreate() {
    if (creating) return;
    const name = groupName.trim();
    if (name.length < 2) {
      setCreateError('نام گروه باید حداقل ۲ کاراکتر باشد');
      return;
    }
    if (selected.length === 0) {
      setCreateError('حداقل یک عضو دیگر انتخاب کنید');
      return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const conversation = await createGroup(name, selected.map(s => s.id));
      onGroupCreated?.(conversation);
    } catch (err) {
      setCreateError(err.message || 'ساخت گروه ناموفق بود');
    } finally {
      setCreating(false);
    }
  }

  const emptyText = mode === 'group'
    ? 'برای افزودن عضو، نام نمایشی یا نام کاربری او را جستجو کن'
    : 'نام نمایشی یا نام کاربری شخص مورد نظر را وارد کن تا گفتگوی جدید را شروع کنی';

  return (
    <div className="newchat-overlay" onClick={onClose}>
      <div className="newchat-modal" onClick={e => e.stopPropagation()}>
        <div className="newchat-header">
          <span>{mode === 'group' ? 'ساخت گروه جدید' : 'گفتگوی جدید'}</span>
          <button className="newchat-close" onClick={onClose}>
            <i className="fas fa-xmark" />
          </button>
        </div>

        <div className="newchat-tabs">
          <button
            className={mode === 'direct' ? 'active' : ''}
            onClick={() => switchMode('direct')}
          >
            <i className="fas fa-user" /> چت خصوصی
          </button>
          <button
            className={mode === 'group' ? 'active' : ''}
            onClick={() => switchMode('group')}
          >
            <i className="fas fa-users" /> گروه جدید
          </button>
        </div>

        {mode === 'group' && (
          <div className="newchat-group">
            <input
              className="newchat-group-name"
              value={groupName}
              onChange={e => { setGroupName(e.target.value); setCreateError(''); }}
              placeholder="نام گروه (مثلاً تیم طراحی)"
              maxLength={60}
            />
            {selected.length > 0 && (
              <div className="newchat-chips">
                {selected.map(user => (
                  <span key={user.id} className="newchat-chip">
                    <img src={user.avatar} alt="" />
                    <span>{user.name}</span>
                    <button onClick={() => removeMember(user.id)} title="حذف عضو">
                      <i className="fas fa-xmark" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="newchat-search">
          <i className="fas fa-magnifying-glass" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={mode === 'group' ? 'جستجوی عضو برای افزودن...' : 'نام نمایشی یا نام کاربری را جستجو کن...'}
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
              {emptyText}
            </div>
          )}

          {!loading && !error && query.trim() && results.length === 0 && (
            <div className="newchat-state"><i className="fas fa-user-slash" />کاربری با این نام پیدا نشد</div>
          )}

          {!loading && results.map(user => {
            const isSelected = mode === 'group' && selected.some(s => s.id === user.id);
            return (
              <button
                key={user.id}
                className={`newchat-result ${isSelected ? 'selected' : ''}`}
                onClick={() => mode === 'group' ? toggleMember(user) : onSelect(user)}
              >
                <div className="user-avatar">
                  <img src={user.avatar} alt={user.name} />
                  <span className={`status ${user.status}`} />
                </div>
                <div className="newchat-result-info">
                  <span className="newchat-result-name">{user.name}</span>
                  <span className="newchat-result-username" dir="ltr">@{user.username}</span>
                  {user.bio && <span className="newchat-result-bio">{user.bio}</span>}
                </div>
                {mode === 'group' ? (
                  <span className={`newchat-check ${isSelected ? 'on' : ''}`}>
                    <i className={isSelected ? 'fas fa-circle-check' : 'far fa-circle'} />
                  </span>
                ) : (
                  <i className="fas fa-arrow-left newchat-result-go" />
                )}
              </button>
            );
          })}
        </div>

        {mode === 'group' && (
          <div className="newchat-footer">
            {createError && (
              <div className="newchat-create-error">
                <i className="fas fa-triangle-exclamation" />{createError}
              </div>
            )}
            <button className="newchat-create" onClick={handleCreate} disabled={creating}>
              {creating
                ? <><i className="fas fa-spinner fa-spin" /> در حال ساخت...</>
                : <><i className="fas fa-user-group" /> ساخت گروه{selected.length > 0 ? ` (${selected.length} عضو)` : ''}</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
