export default function TypingIndicator({ isTyping, user }) {
  return (
    <div className="typing-area">
      {isTyping && (
        <>
          <img src={user.avatar} alt={user.name} />
          <div className="typing-dots">
            <span /><span /><span />
          </div>
          <span>{user.name} در حال تایپ است...</span>
        </>
      )}
    </div>
  );
}
