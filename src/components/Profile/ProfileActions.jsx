import './ProfileActions.css';

// The row of things you can do to a conversation from inside its own profile.
//
// Only actions that work here are offered. The reference screen this layout was
// read from carries five of them, and two of those — mute and the overflow menu —
// have no counterpart in this app at all, so they are left out rather than drawn
// as buttons that do nothing.
export default function ProfileActions({ onStartCall, callsEnabled, callBusy, onSearch }) {
  const callBlocked = !callsEnabled
    ? 'تماس روی این سرور فعال نیست'
    : callBusy ? 'در تماس دیگری هستید' : null;

  return (
    <div className="profile-actions">
      {onStartCall && (
        <>
          <button
            type="button"
            className="profile-action"
            onClick={() => onStartCall('audio')}
            disabled={!callsEnabled || callBusy}
            title={callBlocked ?? 'تماس صوتی'}
            aria-label="تماس صوتی"
          >
            <i className="fas fa-phone" aria-hidden="true" />
            <span>تماس</span>
          </button>
          <button
            type="button"
            className="profile-action"
            onClick={() => onStartCall('video')}
            disabled={!callsEnabled || callBusy}
            title={callBlocked ?? 'تماس ویدیویی'}
            aria-label="تماس ویدیویی"
          >
            <i className="fas fa-video" aria-hidden="true" />
            <span>تصویری</span>
          </button>
        </>
      )}
      {onSearch && (
        <button
          type="button"
          className="profile-action"
          onClick={onSearch}
          title="جستجو در پیام‌های این گفتگو"
          aria-label="جستجو در پیام‌های این گفتگو"
        >
          <i className="fas fa-magnifying-glass" aria-hidden="true" />
          <span>جستجو</span>
        </button>
      )}
    </div>
  );
}
