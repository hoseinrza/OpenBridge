import { useCallback, useEffect, useState } from 'react';
import { useChat } from '../../hooks/useChat.js';
import { fetchConversations, fetchGroups, normalizeUser, normalizeGroup } from '../../services/api.js';
import Sidebar from '../Sidebar/Sidebar.jsx';
import ChatHeader from './ChatHeader.jsx';
import MessageList from './MessageList.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import InputArea from './InputArea.jsx';
import ProfileModal from '../Profile/ProfileModal.jsx';
import NewChatModal from '../NewChat/NewChatModal.jsx';
import './Chat.css';

export default function ChatPage({ currentUser, onLogout, onProfileUpdate }) {
  const [users, setUsers]                 = useState([]);
  const [activeUser, setActiveUser]       = useState(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [profileTarget, setProfileTarget] = useState(null); // { user, isOwn } | null
  const [newChatOpen, setNewChatOpen]     = useState(false);
  const [chatsLoading, setChatsLoading]   = useState(true);
  const [chatsError, setChatsError]       = useState(false);

  // New accounts start with an empty conversation list — people only show up
  // here once a message has actually been exchanged with them. Conversations
  // are started on demand by searching for a username (see NewChatModal).
  const loadChats = useCallback(() => {
    Promise.all([fetchConversations(), fetchGroups()])
      .then(([directList, groupList]) => {
        const directs = directList
          .filter(c => c.user)
          .map(c => ({ ...normalizeUser(c.user), unread: c.unread ?? 0, updatedAt: c.updatedAt }))
          .filter(u => u.id);
        const groups = groupList.map(normalizeGroup).filter(Boolean);

        setUsers(prev => {
          // Keep conversations the user just started locally (no messages sent
          // yet) so they don't vanish from the list before the first message.
          const stillPending = prev.filter(u => u.pending && !directs.some(d => d.id === u.id));
          const chats = [...groups, ...directs]
            .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
          return [...stillPending, ...chats];
        });
        setChatsError(false);
      })
      .catch(() => setChatsError(true))
      .finally(() => setChatsLoading(false));
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);

  // Refresh the list whenever any message arrives (covers new incoming
  // conversations/groups and keeps unread counters / ordering in sync)
  const handleIncoming = useCallback(() => { loadChats(); }, [loadChats]);

  const {
    messages, isTyping, typingPeer, connected,
    historyState, historyError, retryHistory,
    sendMessage, notifyTyping, addReaction, clearMessages,
  } = useChat(activeUser, currentUser, handleIncoming);

  // Catch up on chats that changed while the socket was disconnected.
  useEffect(() => {
    if (connected) loadChats();
  }, [connected, loadChats]);

  function handleSelectUser(user) {
    if (user.id === activeUser?.id) return;
    setActiveUser(user);
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, unread: 0 } : u));
    clearMessages();
    setSearchQuery('');
  }

  function handleStartConversation(user) {
    setNewChatOpen(false);
    setUsers(prev => prev.some(u => u.id === user.id)
      ? prev
      : [{ ...user, unread: 0, pending: true }, ...prev]);
    setActiveUser(user);
    clearMessages();
    setSearchQuery('');
  }

  function handleGroupCreated(conversation) {
    const group = normalizeGroup(conversation);
    if (!group) return;
    setNewChatOpen(false);
    setUsers(prev => [group, ...prev.filter(c => c.id !== group.id)]);
    setActiveUser(group);
    clearMessages();
    setSearchQuery('');
  }

  function handleBackToList() { setActiveUser(null); }

  function openOwnProfile()       { setProfileTarget({ user: currentUser, isOwn: true }); }
  function openPeerProfile(user)  { setProfileTarget({ user, isOwn: false }); }
  function closeProfile()         { setProfileTarget(null); }
  function handleProfileSaved(patch) { onProfileUpdate?.(patch); }

  const filteredMessages = searchQuery.trim()
    ? messages.filter(m => m.text?.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;

  return (
    <div className={`app-layout ${activeUser ? 'detail-open' : ''}`}>
      <Sidebar
        users={users}
        activeUserId={activeUser?.id}
        onSelectUser={handleSelectUser}
        currentUser={currentUser}
        onLogout={onLogout}
        onOpenProfile={openOwnProfile}
        onNewChat={() => setNewChatOpen(true)}
        loading={chatsLoading}
        error={chatsError}
        onRetry={loadChats}
      />

      <div className="chat-main">
        {activeUser ? (
          <>
            <ChatHeader
              user={activeUser}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onOpenProfile={openPeerProfile}
              onBack={handleBackToList}
            />

            {!connected && (
              <div className="conn-banner" role="status">
                <i className="fas fa-plug-circle-xmark" aria-hidden="true" />
                اتصال به سرور برقرار نیست — در حال تلاش برای اتصال مجدد…
              </div>
            )}

            {searchQuery && (
              <div className="search-results-bar" role="status">
                <i className="fas fa-magnifying-glass" aria-hidden="true" />
                {filteredMessages.length.toLocaleString('fa-IR')} نتیجه برای «{searchQuery}»
              </div>
            )}

            <MessageList
              key={activeUser.id}
              messages={filteredMessages}
              activeUser={activeUser}
              onReact={addReaction}
              searchQuery={searchQuery}
              historyState={historyState}
              historyError={historyError}
              onRetryHistory={retryHistory}
            />

            <TypingIndicator isTyping={isTyping} user={typingPeer ?? activeUser} />

            <InputArea onSend={sendMessage} onTyping={notifyTyping} connected={connected} />
          </>
        ) : (
          <div className="empty-chat">
            <div className="empty-chat-icon" aria-hidden="true">
              <i className="far fa-comments" />
            </div>
            <h2>گفتگویی باز نشده</h2>
            {users.length > 0 ? (
              <p>یک گفتگو یا گروه را از فهرست کنار انتخاب کن، یا یک گفتگوی تازه شروع کن.</p>
            ) : (
              <p>هنوز گفتگویی نداری. با جستجوی نام نمایشی یا نام کاربری یک نفر را پیدا کن یا یک گروه بساز.</p>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setNewChatOpen(true)}>
              <i className="fas fa-pen-to-square" aria-hidden="true" />
              گفتگوی جدید
            </button>
          </div>
        )}
      </div>

      {profileTarget && (
        <ProfileModal
          user={profileTarget.isOwn ? currentUser : profileTarget.user}
          isOwn={profileTarget.isOwn}
          onClose={closeProfile}
          onSaved={handleProfileSaved}
        />
      )}

      {newChatOpen && (
        <NewChatModal
          onClose={() => setNewChatOpen(false)}
          onSelect={handleStartConversation}
          onGroupCreated={handleGroupCreated}
        />
      )}
    </div>
  );
}
