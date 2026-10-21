import { useEffect, useRef, useState } from 'react';
import { searchUsers, createGroup, normalizeUser } from '../../services/api.js';
import { createEncryptedGroup } from '../../services/e2ee.js';
import Avatar from '../ui/Avatar.jsx';
import Modal from '../ui/Modal.jsx';
import ContactsPanel from './ContactsPanel.jsx';
import './NewChatModal.css';

export default function NewChatModal({ currentUser, onClose, onSelect, onGroupCreated }) {
  const [mode,     setMode]     = useState('direct');
  const [source,   setSource]   = useState('search');
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [groupName, setGroupName] = useState('');
  const [selected,  setSelected]  = useState([]);
  const [secureGroup, setSecureGroup] = useState(false);
  const [creating,  setCreating]  = useState(false);
  const [createError, setCreateError] = useState('');
  const inputRef    = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode, source]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) return undefined;

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      searchUsers(q)
        .then(list => { setResults(list.map(normalizeUser).filter(Boolean)); setError(''); })
        .catch(() => setError('جستجو ناموفق بود؛ اتصال را بررسی کن'))
        .finally(() => setLoading(false));
    }, 350);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function handleQueryChange(value) {
    setQuery(value);
    if (value.trim()) return;
    clearTimeout(debounceRef.current);
    setResults([]);
    setLoading(false);
    setError('');
  }

  function switchMode(next) {
    setMode(next);
    setCreateError('');
    setQuery('');
    setResults([]);
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
      setCreateError('حداقل یک عضو دیگر انتخاب کن');
      return;
    }

    if (secureGroup && !currentUser?.id) {
      setCreateError('برای رمزنگاری باید وارد حساب خود شده باشی');
      return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const memberIds = selected.map(s => s.id);
      const conversation = secureGroup
        ? await createEncryptedGroup({ id: currentUser.id }, name, memberIds)
        : await createGroup(name, memberIds);
      onGroupCreated?.(conversation);
    } catch (err) {
      setCreateError(err.message || 'ساخت گروه ناموفق بود');
    } finally {
      setCreating(false);
    }
  }

  const title = mode === 'group' ? 'گروه جدید' : 'گفتگوی جدید';
  const emptyText = mode === 'group'
    ? 'نام نمایشی یا نام کاربری عضو را جستجو کن'
    : 'نام نمایشی یا نام کاربری شخص را جستجو کن تا گفتگو شروع شود';

  return (
    <Modal onClose={onClose} labelledBy="newchat-title" className="newchat-modal" initialFocus={false}>
      <header className="newchat-head">
        <div>
          <h2 id="newchat-title">{title}</h2>
          <p>{mode === 'group' ? 'یک گروه بساز و اعضا را انتخاب کن' : 'با جستجوی نام کاربری گفتگو را شروع کن'}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="newchat-tabs" role="group" aria-label="نوع گفتگوی جدید">
        <button
          type="button"
          aria-pressed={mode === 'direct'}
          className={mode === 'direct' ? 'active' : ''}
          onClick={() => switchMode('direct')}
        >
          <i className="fas fa-user" aria-hidden="true" />
          گفتگوی خصوصی
        </button>
        <button
          type="button"
          aria-pressed={mode === 'group'}
          className={mode === 'group' ? 'active' : ''}
          onClick={() => switchMode('group')}
        >
          <i className="fas fa-users" aria-hidden="true" />
          گروه جدید
        </button>
      </div>

      <div className="newchat-panel">
        {mode === 'group' && (
          <div className="newchat-group">
            <label htmlFor="group-name" className="sr-only">نام گروه</label>
            <input
              id="group-name"
              className="field-input"
              value={groupName}
              onChange={e => { setGroupName(e.target.value); setCreateError(''); }}
              placeholder="نام گروه (مثلاً تیم طراحی)"
              maxLength={60}
            />
            {selected.length > 0 && (
              <div className="newchat-chips" aria-label="اعضای انتخاب‌شده">
                {selected.map(user => (
                  <span key={user.id} className="newchat-chip">
                    <Avatar src={user.avatar} name={user.name} size={20} />
                    <span className="newchat-chip-name">{user.name}</span>
                    <button
                      type="button"
                      onClick={() => removeMember(user.id)}
                      aria-label={`حذف ${user.name}`}
                    >
                      <i className="fas fa-xmark" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <label className={`newchat-secure ${secureGroup ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                checked={secureGroup}
                onChange={e => { setSecureGroup(e.target.checked); setCreateError(''); }}
                disabled={creating}
              />
              <span className="newchat-secure-icon" aria-hidden="true">
                <i className={`fas ${secureGroup ? 'fa-lock' : 'fa-lock-open'}`} />
              </span>
              <span className="newchat-secure-text">
                <span className="newchat-secure-title">رمزنگاری سرتاسری</span>
                <span className="newchat-secure-note">
                  پیام‌ها فقط روی دستگاه اعضا رمزگشایی می‌شوند. عضوی که هنوز روی وب کلید نساخته، یا نسخهٔ موبایل، نمی‌تواند این گروه را باز کند.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="newchat-sources" role="group" aria-label="نحوهٔ پیدا کردن فرد">
          <button
            type="button"
            aria-pressed={source === 'search'}
            className={source === 'search' ? 'active' : ''}
            onClick={() => setSource('search')}
          >
            <i className="fas fa-magnifying-glass" aria-hidden="true" />
            جستجوی نام
          </button>
          <button
            type="button"
            aria-pressed={source === 'contacts'}
            className={source === 'contacts' ? 'active' : ''}
            onClick={() => setSource('contacts')}
          >
            <i className="fas fa-address-book" aria-hidden="true" />
            مخاطبین
          </button>
        </div>

        {source === 'contacts' && (
          <ContactsPanel
            mode={mode}
            selected={selected}
            onToggle={toggleMember}
            onSelect={onSelect}
          />
        )}

        {source === 'search' && (
        <div className="newchat-search">
          <i className="fas fa-magnifying-glass" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            placeholder={mode === 'group' ? 'جستجوی عضو…' : 'جستجوی نام نمایشی یا نام کاربری…'}
            aria-label={mode === 'group' ? 'جستجوی عضو برای افزودن' : 'جستجوی کاربر'}
            autoComplete="off"
          />
        </div>
        )}

        {source === 'search' && (
        <div className="newchat-results">
          {loading && (
            <div className="newchat-state" role="status">
              <i className="fas fa-spinner fa-spin" aria-hidden="true" />
              در حال جستجو…
            </div>
          )}

          {!loading && error && (
            <div className="newchat-state error" role="alert">
              <i className="fas fa-triangle-exclamation" aria-hidden="true" />
              {error}
            </div>
          )}

          {!loading && !error && !query.trim() && (
            <div className="newchat-state">
              <i className="fas fa-magnifying-glass" aria-hidden="true" />
              {emptyText}
            </div>
          )}

          {!loading && !error && query.trim() && results.length === 0 && (
            <div className="newchat-state">
              <i className="fas fa-user-slash" aria-hidden="true" />
              کاربری با این نام پیدا نشد
            </div>
          )}

          {!loading && results.map(user => {
            const isSelected = mode === 'group' && selected.some(s => s.id === user.id);
            return (
              <button
                key={user.id}
                type="button"
                className={`newchat-result ${isSelected ? 'selected' : ''}`}
                onClick={() => mode === 'group' ? toggleMember(user) : onSelect(user)}
                aria-pressed={mode === 'group' ? isSelected : undefined}
              >
                <Avatar src={user.avatar} name={user.name} size={38} status={user.status} />
                <span className="newchat-result-info">
                  <span className="newchat-result-name">{user.name}</span>
                  {user.username && <span className="newchat-result-username" dir="ltr">@{user.username}</span>}
                  {user.bio && <span className="newchat-result-bio">{user.bio}</span>}
                </span>
                {mode === 'group' ? (
                  <span className={`newchat-check ${isSelected ? 'on' : ''}`} aria-hidden="true">
                    <i className={isSelected ? 'fas fa-circle-check' : 'far fa-circle'} />
                  </span>
                ) : (
                  <i className="fas fa-arrow-left newchat-result-go" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
        )}
      </div>

      {mode === 'group' && (
        <footer className="newchat-footer">
          {createError && (
            <div className="newchat-error" role="alert">
              <i className="fas fa-triangle-exclamation" aria-hidden="true" />
              {createError}
            </div>
          )}
          <button type="button" className="btn btn-primary newchat-create" onClick={handleCreate} disabled={creating}>
            {creating ? (
              <><i className="fas fa-spinner fa-spin" aria-hidden="true" /> در حال ساخت…</>
            ) : (
              <>
                <i className="fas fa-user-group" aria-hidden="true" />
                ساخت گروه
                {selected.length > 0 && <span className="newchat-count">({selected.length.toLocaleString('fa-IR')} عضو)</span>}
              </>
            )}
          </button>
        </footer>
      )}
    </Modal>
  );
}
