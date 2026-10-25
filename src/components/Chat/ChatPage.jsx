import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '../../hooks/useChat.js';
import {
  apiCall, fetchUser, fetchConversations, fetchGroups, normalizeUser, normalizeGroup,
  listSecurityEvents, acknowledgeSecurityEvents,
} from '../../services/api.js';
import { initE2ee } from '../../services/e2ee.js';
import Sidebar from '../Sidebar/Sidebar.jsx';
import ChatHeader from './ChatHeader.jsx';
import MessageList from './MessageList.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import InputArea from './InputArea.jsx';
import ProfileModal from '../Profile/ProfileModal.jsx';
import SessionsModal from '../Profile/SessionsModal.jsx';
import ChatProfilePanel from '../Profile/ChatProfilePanel.jsx';
import NewChatModal from '../NewChat/NewChatModal.jsx';
import ForwardModal from './ForwardModal.jsx';
import CallLayer from '../Call/CallLayer.jsx';
import { useCall } from '../../hooks/useCall.js';
import { messagePreview } from '../../utils/message.js';
import './Chat.css';

function previewFromServer(lastMessage, myId) {
  if (!lastMessage) return null;
  return {
    type:       (lastMessage.type ?? 'TEXT').toLowerCase(),
    text:       lastMessage.text ?? '',
    fileName:   lastMessage.fileName ?? null,
    senderName: lastMessage.sender?.id === myId ? 'شما' : (lastMessage.sender?.name ?? null),
    // Used to pick between this preview and one built from the legacy MLS
    // history: a mixed chat can have both, and the newer message wins.
    at:         lastMessage.createdAt ? new Date(lastMessage.createdAt).getTime() : 0,
  };
}

function previewFromEncrypted(message, chat, myId) {
  if (!message) return null;
  const attachment = message.attachment ?? null;
  const mime = attachment?.mime ?? '';
  return {
    // The sender wrote the MIME type into its own descriptor, so the row can
    // say what arrived instead of reciting the filename the recorder chose —
    // except for a recording, whose MIME is the same as a song's. Only the
    // sender's own microphone flag knows the difference.
    type: attachment
      ? (attachment.voice ? 'voice'
        : mime.startsWith('image/') ? 'image'
        : mime.startsWith('audio/') ? 'audio'
        : mime.startsWith('video/') ? 'video'
        : 'file')
      : 'text',
    text:       message.text ?? '',
    fileName:   attachment?.name ?? null,
    senderName: message.mine || message.senderId === myId
      ? 'شما'
      : (chat.participants?.find(p => p.id === message.senderId)?.name ?? null),
    at:         message.at ? new Date(message.at).getTime() : 0,
  };
}

function alertWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
}

async function directConversationId(peerId, cache) {
  if (cache.has(peerId)) return cache.get(peerId);
  try {
    const state = await apiCall(`messages/e2ee/direct/${peerId}`);
    if (state?.conversationId) cache.set(peerId, state.conversationId);
    return state?.conversationId ?? null;
  } catch {
    return null;
  }
}

// A chat that once used MLS keeps its older messages only in this device's own
// decrypted history, so its newest line can be newer than anything the server
// has. Direct chats get their conversation id from the same read-only probe the
// chat itself uses.
async function addEncryptedPreviews(chats, myId, idCache) {
  if (!chats.some(chat => chat.encrypted)) return chats;
  const client = await initE2ee({ id: myId }).catch(() => null);
  if (!client) return chats;
  return Promise.all(chats.map(async (chat) => {
    if (!chat.encrypted) return chat;
    const conversationId = chat.kind === 'group'
      ? chat.id
      : await directConversationId(chat.id, idCache);
    if (!conversationId) return chat;
    const last = await client.lastMessage(conversationId).catch(() => null);
    if (!last) return chat;
    // The server now previews newer messages from the same chat. Keep whichever
    // message is more recent instead of letting the local history always win.
    const local = previewFromEncrypted(last, chat, myId);
    if (chat.preview?.at && local?.at && chat.preview.at > local.at) return chat;
    return { ...chat, preview: local };
  }));
}

export default function ChatPage({ currentUser, onLogout, onProfileUpdate }) {
  const [users, setUsers]                 = useState([]);
  const [activeUser, setActiveUser]       = useState(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchOpen, setSearchOpen]       = useState(false);
  const [profileTarget, setProfileTarget] = useState(null); // { user, isOwn } | null
  const [profileOpen, setProfileOpen]     = useState(false);
  const [sessionsOpen, setSessionsOpen]   = useState(false);
  // Sessions that signed in after this device last acknowledged the list.
  const [securityAlerts, setSecurityAlerts] = useState([]);
  const [newChatOpen, setNewChatOpen]     = useState(false);
  const [chatsLoading, setChatsLoading]   = useState(true);
  const [chatsError, setChatsError]       = useState(false);
  // The message the composer is currently correcting, and the one-line notice
  // that says what just happened to a message (copied, or failed to be).
  const [editing, setEditing]             = useState(null); // { id, text } | null
  // What the composer is answering, and the message the forward picker is
  // holding. Both belong to the open chat, so leaving it drops them.
  const [replying, setReplying]           = useState(null); // { id, senderName, preview } | null
  const [forwarding, setForwarding]       = useState(null); // message | null
  const [toast, setToast]                 = useState('');
  const toastTimer = useRef(null);

  // A list refresh that is in flight when a message arrives can come back with
  // an unread count for the chat that is on screen, because marking it read is
  // a separate round trip. The chat being looked at is always read.
  const activeUserIdRef = useRef(null);
  const directConversationIds = useRef(new Map());

  useEffect(() => { activeUserIdRef.current = activeUser?.id ?? null; }, [activeUser?.id]);

  // Security alerts are polled rather than pushed: the chat socket is owned by
  // the chat hook, and an alert that arrives a minute late is still an alert.
  // Reconnecting or returning to the tab checks immediately.
  const refreshSecurityAlerts = useCallback(async () => {
    try {
      setSecurityAlerts(await listSecurityEvents());
    } catch {
      // A failed check must never take the conversation down with it.
    }
  }, []);

  useEffect(() => {
    const kickoff = setTimeout(refreshSecurityAlerts, 0);
    const timer = setInterval(refreshSecurityAlerts, 60_000);
    const onFocus = () => refreshSecurityAlerts();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSecurityAlerts();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSecurityAlerts]);

  async function dismissSecurityAlerts() {
    setSecurityAlerts([]);
    try {
      await acknowledgeSecurityEvents();
    } catch {
      // If the acknowledgement did not reach the server, the next poll puts
      // the alert back instead of letting it disappear silently.
    }
  }

  // New accounts start with an empty conversation list — people only show up
  // here once a message has actually been exchanged with them. Conversations
  // are started on demand by searching for a username (see NewChatModal).
  const loadChats = useCallback(async () => {
    try {
      const [directList, groupList] = await Promise.all([fetchConversations(), fetchGroups()]);
      const directs = directList
        .filter(c => c.user)
        .map(c => ({
          ...normalizeUser(c.user),
          unread: c.unread ?? 0,
          updatedAt: c.updatedAt,
          // The server only says whether a conversation accepts envelopes;
          // whether this device can read it is the chat hook's question.
          encrypted: c.e2ee === true,
          preview: previewFromServer(c.lastMessage, currentUser.id),
        }))
        .filter(u => u.id);
      const groups = groupList
        .map(normalizeGroup)
        .filter(Boolean)
        .map(group => ({ ...group, preview: previewFromServer(group.lastMessage, currentUser.id) }));

      const chats = await addEncryptedPreviews(
        [...groups, ...directs],
        currentUser.id,
        directConversationIds.current,
      );

      setUsers(prev => {
        // Keep conversations the user just started locally (no messages sent
        // yet) so they don't vanish from the list before the first message.
        const stillPending = prev.filter(u => u.pending && !chats.some(d => d.id === u.id));
        const ordered = chats
          .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0))
          .map(chat => (chat.id === activeUserIdRef.current ? { ...chat, unread: 0 } : chat));
        return [...stillPending, ...ordered];
      });
      setChatsError(false);
    } catch {
      setChatsError(true);
    } finally {
      setChatsLoading(false);
    }
  }, [currentUser.id]);

  useEffect(() => { loadChats(); }, [loadChats]);

  // Refresh the list whenever any message arrives (covers new incoming
  // conversations/groups and keeps unread counters / ordering in sync)
  const handleIncoming = useCallback(() => { loadChats(); }, [loadChats]);

  // A group's name, photo and bio are server metadata, so an edit made on any
  // member's device arrives as the whole row and is applied to both the list and
  // the chat on screen — no reload, and a preview the row did not carry stays
  // the one this device already has.
  const handleGroupUpdated = useCallback((wire) => {
    const group = normalizeGroup(wire);
    if (!group?.id) return;
    const preview = previewFromServer(group.lastMessage, currentUser.id);
    setUsers(prev => prev.map(u => (
      u.id === group.id ? { ...u, ...group, preview: preview ?? u.preview } : u
    )));
    setActiveUser(prev => (prev && prev.id === group.id
      ? { ...prev, ...group, preview: preview ?? prev.preview }
      : prev));
  }, [currentUser.id]);

  const {
    messages, isTyping, typingPeer, connected,
    historyState, historyError, retryHistory,
    encrypted, secureMode,
    sendMessage, forwardMessage, notifyTyping, toggleReaction, editMessage, deleteMessage, clearMessages,
  } = useChat(activeUser, currentUser, handleIncoming, handleGroupUpdated);

  // Calls are mounted for the whole signed-in page, not per chat: an incoming
  // ring must reach a user who is reading a different conversation.
  const call = useCall(currentUser);

  // A toast is the only answer some actions get: nothing on screen changes for
  // a copy, and a failure that leaves the message as it was has nowhere else to
  // be said. It says itself once and then goes away on its own.
  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const saveEdit = useCallback(async (text) => {
    if (!editing) return { ok: false, error: 'ویرایش پیام ناموفق بود' };
    const result = await editMessage(editing.id, text);
    if (result.ok) setEditing(null);
    return result;
  }, [editing, editMessage]);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const startEdit = useCallback((target) => {
    setEditing(target);
    setReplying(null);
  }, []);

  // A reply is a snapshot of the message the user pointed at: the quote travels
  // with the answer, so it still reads correctly after the original is edited,
  // deleted, or the chat is opened on another device.
  const startReply = useCallback((message) => {
    if (!message || message.leaving) return;
    setEditing(null);
    setReplying({
      id: message.id,
      senderName: message.side === 'mine'
        ? (currentUser?.name || 'شما')
        : (message.sender || 'کاربر'),
      preview: messagePreview(message),
      type: message.type,
    });
  }, [currentUser.name]);

  const cancelReply = useCallback(() => setReplying(null), []);

  // The composer sends through here so a successful send is also the end of
  // the reply state; a failed one leaves the bar in place to try again.
  const sendFromComposer = useCallback(async (payload) => {
    const result = await sendMessage(payload);
    if (result?.ok) setReplying(null);
    return result;
  }, [sendMessage]);

  const submitForward = useCallback(async (target) => {
    if (!forwarding) return { ok: false, error: 'پیامی برای فروارد نیست' };
    const result = await forwardMessage(forwarding, target);
    if (result.ok) showToast('فروارد شد');
    else if (result.error) showToast(result.error);
    return result;
  }, [forwarding, forwardMessage, showToast]);

  // A delete that the server refuses leaves the message exactly where it was,
  // so the refusal itself is the only thing the screen can say about it.
  const handleDelete = useCallback(async (messageId, scope) => {
    const result = await deleteMessage(messageId, scope);
    if (!result.ok) showToast(result.error || 'حذف پیام ناموفق بود');
    return result;
  }, [deleteMessage, showToast]);

  // Catch up on chats that changed while the socket was disconnected.
  useEffect(() => {
    if (connected) loadChats();
  }, [connected, loadChats]);

  // A correction belongs to the chat it started in: leaving that chat ends it,
  // so nothing can be saved into a conversation nobody is looking at.
  function handleSelectUser(user) {
    if (user.id === activeUser?.id) return;
    setActiveUser(user);
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, unread: 0 } : u));
    clearMessages();
    setEditing(null);
    setReplying(null);
    setForwarding(null);
    setSearchQuery('');
    setSearchOpen(false);
    setProfileOpen(false);
  }

  function handleStartConversation(user) {
    setNewChatOpen(false);
    setUsers(prev => prev.some(u => u.id === user.id)
      ? prev
      : [{ ...user, unread: 0, pending: true }, ...prev]);
    setActiveUser(user);
    clearMessages();
    setEditing(null);
    setReplying(null);
    setForwarding(null);
    setSearchQuery('');
    setSearchOpen(false);
    setProfileOpen(false);
  }

  function handleGroupCreated(conversation) {
    const group = normalizeGroup(conversation);
    if (!group) return;
    setNewChatOpen(false);
    setUsers(prev => [group, ...prev.filter(c => c.id !== group.id)]);
    setActiveUser(group);
    clearMessages();
    setEditing(null);
    setReplying(null);
    setForwarding(null);
    setSearchQuery('');
    setSearchOpen(false);
    setProfileOpen(false);
  }

  // The header's search field unmounts with the chat, so its open flag has to go
  // back with it — otherwise the next chat opens straight into a search box.
  function handleBackToList() {
    setActiveUser(null); setProfileOpen(false); setEditing(null);
    setReplying(null); setForwarding(null);
    setSearchQuery(''); setSearchOpen(false);
  }

  function openOwnProfile()       { setProfileTarget({ user: currentUser, isOwn: true }); }
  function openChatProfile()      { setProfileOpen(true); }
  // The list avatar opens a profile, but the panel reads the active conversation,
  // so the chat is selected first.
  function openProfileFromList(user) {
    handleSelectUser(user);
    setProfileOpen(true);
  }
  function closeProfile()         { setProfileTarget(null); }
  function handleProfileSaved(patch) { onProfileUpdate?.(patch); }

  // A person's profile opens with the name and face the row already carries, so
  // the tap is answered on the spot, and the server's record is poured into the
  // same sheet when it arrives. A slow or failed lookup therefore shows a profile
  // with less in it rather than a spinner where a face already was.
  function openUserProfile(seed) {
    const isOwn = seed.id === currentUser?.id;
    setProfileTarget({ user: isOwn ? currentUser : seed, isOwn });
    if (isOwn) return;
    fetchUser(seed.id)
      .then(wire => {
        const full = normalizeUser(wire);
        if (!full) return;
        setProfileTarget(prev => (
          prev && !prev.isOwn && prev.user.id === full.id
            ? { user: { ...seed, ...full }, isOwn: false }
            : prev
        ));
      })
      .catch(() => {});
  }

  // The sheet's own way out of a group: writing to somebody starts the direct
  // chat you would have to search for otherwise. Starting it again while it is
  // already on screen would only clear a transcript nobody asked to reload.
  function handleMessageFromProfile(user) {
    closeProfile();
    if (activeUser?.id === user.id) return;
    handleStartConversation(user);
  }

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
        onOpenChatProfile={openProfileFromList}
        onNewChat={() => setNewChatOpen(true)}
        loading={chatsLoading}
        error={chatsError}
        onRetry={loadChats}
      />

      <div className="chat-main">
        {securityAlerts.length > 0 && (
          <div className="conn-banner session-alert" role="alert">
            <i className="fas fa-shield-halved" aria-hidden="true" />
            <div className="session-alert-copy">
              <strong>دستگاه جدیدی وارد حساب شد</strong>
              <span>
                {securityAlerts[0].ip ?? 'IP نامشخص'} — {alertWhen(securityAlerts[0].createdAt)}
                {securityAlerts.length > 1
                  && ` — و ${securityAlerts.length.toLocaleString('fa-IR')} مورد دیگر`}
              </span>
            </div>
            <button
              type="button"
              className="session-alert-action"
              onClick={() => { dismissSecurityAlerts(); setSessionsOpen(true); }}
            >
              مدیریت دستگاه‌ها
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={dismissSecurityAlerts}
              aria-label="بستن هشدار ورود"
            >
              <i className="fas fa-xmark" aria-hidden="true" />
            </button>
          </div>
        )}

        {activeUser ? (
          <>
            <ChatHeader
              user={activeUser}
              encrypted={encrypted}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              onOpenProfile={openChatProfile}
              onBack={handleBackToList}
              onStartCall={(type) => call.startCall(activeUser, type)}
              callsEnabled={call.callsConfigured}
              callBusy={call.phase !== 'idle'}
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
              onReact={toggleReaction}
              onReply={startReply}
              onForward={setForwarding}
              onEdit={startEdit}
              onDelete={handleDelete}
              onToast={showToast}
              searchQuery={searchQuery}
              encrypted={encrypted}
              secureMode={secureMode}
              historyState={historyState}
              historyError={historyError}
              onRetryHistory={retryHistory}
              onOpenProfile={openUserProfile}
            />

            <TypingIndicator isTyping={isTyping} user={typingPeer ?? activeUser} />

            <InputArea
              onSend={sendFromComposer}
              onTyping={notifyTyping}
              connected={connected}
              editing={editing}
              onSaveEdit={saveEdit}
              onCancelEdit={cancelEdit}
              replying={replying}
              onCancelReply={cancelReply}
            />

            {toast && (
              <div className="chat-toast" role="status">
                <span>{toast}</span>
              </div>
            )}
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

      {profileOpen && activeUser && (
        <ChatProfilePanel
          key={activeUser.id}
          chat={activeUser}
          currentUser={currentUser}
          encrypted={encrypted}
          messages={messages}
          onClose={() => setProfileOpen(false)}
          onUpdated={handleGroupUpdated}
          onOpenUser={openUserProfile}
          onCall={(type) => call.startCall(activeUser, type)}
          callsEnabled={call.callsConfigured}
          callBusy={call.phase !== 'idle'}
          // Searching happens in the transcript, so the panel steps aside rather
          // than covering the very thing it just asked for.
          onSearch={() => { setProfileOpen(false); setSearchOpen(true); }}
        />
      )}

      {profileTarget && (
        <ProfileModal
          key={profileTarget.user.id}
          user={profileTarget.isOwn ? currentUser : profileTarget.user}
          isOwn={profileTarget.isOwn}
          onMessage={handleMessageFromProfile}
          onSessions={profileTarget.isOwn
            ? () => { setProfileTarget(null); setSessionsOpen(true); }
            : undefined}
          onClose={closeProfile}
          onSaved={handleProfileSaved}
        />
      )}

      {sessionsOpen && (
        <SessionsModal
          onClose={() => setSessionsOpen(false)}
          onRevoked={refreshSecurityAlerts}
        />
      )}

      {newChatOpen && (
        <NewChatModal
          onClose={() => setNewChatOpen(false)}
          onSelect={handleStartConversation}
          onGroupCreated={handleGroupCreated}
        />
      )}

      {forwarding && (
        <ForwardModal
          message={forwarding}
          chats={users}
          onPick={submitForward}
          onClose={() => setForwarding(null)}
        />
      )}

      <CallLayer call={call} currentUser={currentUser} />
    </div>
  );
}
