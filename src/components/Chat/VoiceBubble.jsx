import { formatDuration } from '../../utils/format.js';
import { useVoicePlayback } from '../../hooks/useVoicePlayback.js';

// A sound file someone kept, listened to on this device.
//
// The bubble owns no audio element. It asks the single module player to take its
// turn, then draws what that player tells it: the label is the length the sender
// measured, which is a number this device never has to trust the container to
// supply, while the rail is the real position of the sound on this device. Those
// are two different clocks and only one of them can be wrong about a file.
//
// A recording that was never tapped is never fetched, so a history of a hundred
// voice messages costs a hundred icons and no bytes at all.
export default function VoiceBubble({ id, durationMs, resolve, download }) {
  const voice = useVoicePlayback(id, resolve, durationMs);
  const label = voice.active && voice.at > 0 ? voice.at : (durationMs ?? 0);

  return (
    <span className={`voice-bubble ${voice.active ? 'is-active' : ''} ${voice.heard ? '' : 'is-unplayed'}`}>
      <button
        type="button"
        className="voice-play"
        onClick={voice.toggle}
        aria-label={voice.playing ? 'توقف پیام صوتی' : 'پخش پیام صوتی'}
        aria-pressed={voice.playing}
        disabled={voice.loading}
      >
        <i
          className={`fas ${
            voice.loading
              ? 'fa-spinner fa-spin'
              : voice.playing
                ? 'fa-pause'
                : voice.error && voice.active
                  ? 'fa-triangle-exclamation'
                  : 'fa-play'
          }`}
          aria-hidden="true"
        />
      </button>

      <span className="voice-track">
        <input
          type="range"
          className="voice-rail"
          min="0"
          max="1000"
          step="1"
          value={Math.round(voice.ratio * 1000)}
          disabled={!voice.active}
          onChange={e => voice.seek(Number(e.target.value) / 1000)}
          aria-label="جابه‌جایی در پیام صوتی"
          style={{ '--fill': `${voice.ratio * 100}%` }}
        />
      </span>

      {/* An error here is almost always a container this device cannot decode —
          a recording written by another browser's encoder. The bytes are still
          the sender's own, so the length gives way to the file itself and the
          bubble keeps one line instead of growing a banner. */}
      {voice.error && download ? (
        <a className="voice-fallback" href={download} download>
          <i className="fas fa-download" aria-hidden="true" />
          دانلود
        </a>
      ) : (
        <time className="voice-time" dateTime={durationMs ? `PT${Math.round(durationMs / 1000)}S` : undefined}>
          {formatDuration(label)}
        </time>
      )}
      {voice.error && <span className="sr-only" role="alert">{voice.error}</span>}
      {voice.loading && <span className="sr-only" role="status">در حال آماده‌سازی پیام صوتی…</span>}
    </span>
  );
}
