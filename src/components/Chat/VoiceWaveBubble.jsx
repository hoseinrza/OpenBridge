import { formatDuration } from '../../utils/format.js';
import { useVoicePlayback } from '../../hooks/useVoicePlayback.js';

// A recording from a microphone, drawn as the shape it made.
//
// The bars come from the sender: the composer measures its own microphone while
// the recording is open and writes the loudest moment of each slice into the
// message, so a bubble is drawn before a single byte of sound is fetched. That is
// also why they cannot be asked how long the recording is, or how far it has got —
// the clock stays with the player, and only the numbers underneath it are true.
//
// A recording whose sender kept no measurements — one sent before bars were
// carried, or from a device that has not started — gets a pattern drawn from the
// message's own id. It is decoration with a rule: the same message keeps the same
// picture on every reload and on every device that reads that id, and it is hidden
// from a screen reader, which is told the length out loud instead.
const PATTERN_BARS = 40;

function patternFor(id) {
  // FNV-1a over the id, then xorshift: no second copy of the message, no storage,
  // and nothing that changes when the list re-renders.
  let h = 2166136261;
  const text = String(id ?? '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars = [];
  for (let i = 0; i < PATTERN_BARS; i += 1) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    bars.push(14 + (Math.abs(h) % 86));
  }
  return bars;
}

export default function VoiceWaveBubble({ id, durationMs, peaks, resolve, download }) {
  const voice = useVoicePlayback(id, resolve, durationMs);
  const bars = peaks?.length >= 2 ? peaks : patternFor(id);
  const played = Math.round(voice.ratio * bars.length);
  const label = voice.active && voice.at > 0 ? voice.at : (durationMs ?? 0);

  return (
    <span className={`voice-bubble voice-wave-bubble ${voice.active ? 'is-active' : ''} ${voice.heard ? '' : 'is-unplayed'}`}>
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

      <span className="voice-wave-main">
        <span className="voice-wave-track">
          <span className="voice-wave-bars" aria-hidden="true">
            {bars.map((peak, index) => (
              <b
                key={index}
                className={index < played ? 'is-heard' : ''}
                style={{ '--peak': String(peak) }}
              />
            ))}
          </span>

          {/* The scrubber is the bars themselves: one transparent range input over
              them, so a keyboard reaches the middle of a recording and a screen
              reader is told what moving it means, exactly as the rail does. */}
          <input
            type="range"
            className="voice-wave-scrub"
            min="0"
            max="1000"
            step="1"
            value={Math.round(voice.ratio * 1000)}
            disabled={!voice.active}
            onChange={e => voice.seek(Number(e.target.value) / 1000)}
            aria-label="جابه‌جایی در پیام صوتی"
          />
        </span>

        {voice.error && download ? (
          <a className="voice-fallback" href={download} download>
            <i className="fas fa-download" aria-hidden="true" />
            دانلود
          </a>
        ) : (
          <time className="voice-time voice-wave-time"
                dateTime={durationMs ? `PT${Math.round(durationMs / 1000)}S` : undefined}>
            {formatDuration(label)}
          </time>
        )}
      </span>

      {voice.error && <span className="sr-only" role="alert">{voice.error}</span>}
      {voice.loading && <span className="sr-only" role="status">در حال آماده‌سازی پیام صوتی…</span>}
    </span>
  );
}
