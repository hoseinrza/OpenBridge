import { useCallback, useEffect, useState } from 'react';
import { USERS } from '../../data/users.js';
import { useChat, isMockUser } from '../../hooks/useChat.js';
import { fetchConversations, normalizeUser } from '../../services/api.js';
import Sidebar from '../Sidebar/Sidebar.jsx';
import ChatHeader from './ChatHeader.jsx';
import MessageList from './MessageList.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import InputArea from './InputArea.jsx';
import ProfileModal from '../Profile/ProfileModal.jsx';
import NewChatModal from '../NewChat/NewChatModal.jsx';
import './Chat.css';

export default function ChatPage({ currentUser, onLogout, onProfileUpdate }) {
  const mock = isMockUser(currentUser);

  const [users, setUsers]                 = useState(mock ? USERS : []);
  const [activeUser, setActiveUser]       = useState(mock ? USERS[0] : null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [profileTarget, setProfileTarget] = useState(null); // { user, isOwn } | null
  const [newChatOpen, setNewChatOpen]     = useState(false);

  // New accounts start with an empty conversation list — people only show up
  // here once a message has actually been exchanged with them. Conversations
  // are started on demand by searching for a username (see NewChatModal).
  const loadConversations = useCallback(() => {
    if (mock) return;
    fetchConversations()
      .then(list => {
        const fromServer = list.map(c => ({ ...normalizeUser(c.user), unread: c.unread }));
        setUsers(prev => {
          // Keep conversations the user just started locally (no messages sent
          // yet) so they don't vanish from the list before the first message.
          const stillPending = prev.filter(u => u.pending && !fromServer.some(s => s.id === u.id));
          return [...stillPending, ...fromServer];
        });
      })
      .catch(() => {});
  }, [mock]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Refresh the list whenever any message arrives (covers new incoming
  // conversations and keeps unread counters / ordering in sync)
  const handleIncoming = useCallback(() => { loadConversations(); }, [loadConversations]);

  const { messages, isTyping, sendMessage, notifyTyping, addReaction, clearMessages } =
    useChat(activeUser, currentUser, handleIncoming);

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
        page="chat"
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

            {searchQuery && (
              <div className="search-results-bar">
                <i className="fas fa-magnifying-glass" />
                {filteredMessages.length} نتیجه برای «{searchQuery}»
              </div>
            )}

            <MessageList
              messages={filteredMessages}
              activeUser={activeUser}
              onReact={addReaction}
              searchQuery={searchQuery}
            />

            <TypingIndicator isTyping={isTyping} user={activeUser} />

            <InputArea onSend={sendMessage} onTyping={notifyTyping} />
          </>
        ) : (
          <div className="empty-chat">
            <i className="fas fa-comments" />
            {mock || users.length > 0 ? (
              <p>یک گفتگو را از فهرست انتخاب کن یا با دکمهٔ «گفتگوی جدید» یک گفتگوی تازه بساز.</p>
            ) : (
              <>
                <p>هنوز گفتگویی نداری. با جستجوی یوزرنیم یک نفر را پیدا کن و گفتگو را شروع کن.</p>
                <button className="empty-chat-btn" onClick={() => setNewChatOpen(true)}>
                  <i className="fas fa-magnifying-glass" /> شروع گفتگوی جدید
                </button>
              </>
            )}
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
        />
      )}
    </div>
  );
}
