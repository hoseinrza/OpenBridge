import { useEffect, useRef } from 'react';
import MessageGroup from './MessageGroup.jsx';

export default function MessageList({ messages, activeUser, onReact, searchQuery }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="messages">
      <div className="chat-welcome">
        <img src={activeUser.avatar} alt={activeUser.name} className="welcome-avatar" />
        <h2>{activeUser.name}</h2>
        <p>شروع گفتگو با {activeUser.name}</p>
      </div>

      {!searchQuery && <div className="date-sep">امروز</div>}

      {messages.length === 0 && searchQuery && (
        <div className="no-results">
          <i className="fas fa-magnifying-glass" />
          <span>پیامی یافت نشد</span>
        </div>
      )}

      {messages.map(msg => (
        <MessageGroup
          key={msg.id}
          message={msg}
          onReact={onReact}
          searchQuery={searchQuery}
        />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}
