import Avatar from '../ui/Avatar.jsx';

export default function TypingIndicator({ isTyping, user }) {
  return (
    <div className="typing-area" role="status" aria-live="polite">
      {isTyping && user && (
        <>
          <Avatar src={user.avatar} name={user.name} size={20} />
          <span className="typing-dots" aria-hidden="true">
            <span /><span /><span />
          </span>
          <span className="typing-text">{user.name} در حال نوشتن است…</span>
        </>
      )}
    </div>
  );
}
