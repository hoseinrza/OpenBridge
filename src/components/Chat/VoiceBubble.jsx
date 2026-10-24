import { useEffect, useState } from 'react';
import { formatDuration } from '../../utils/format.js';
import {
  playVoice, seekVoice, stopVoice, subscribeVoice, voicePosition,
} from '../../services/voice.js';

// One recording, listened to on this device.
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
  const [player, setPlayer] = useState({ id: null, loading: false, playing: false, error: '' });
  const [rail, setRail] = useState({ at: 0, ratio: 0 });
  const [heard, setHeard] = useState(false);
  const active = player.id === id;

  useEffect(() => subscribeVoice(setPlayer), []);

  // Leaving the screen while this bubble holds the speaker would otherwise let
  // the sound play on under a component that no longer exists to show it.
  useEffect(() => () => stopVoice(id), [id]);

  // Once it has been heard it stays heard, even after the recording finishes and
  // the player moves on: the mark answers «has this been listened to here», and a
  // finished voice message going back to looking unheard would be a lie.
  useEffect(() => {
    if (active && player.playing) setHeard(true);
  }, [active, player.playing]);

  // The active bubble follows its own position closely; the others do not poll
  // at all. A change too small to see leaves the state identical, and React skips
  // the render instead of repainting the bubble sixty times a second.
  useEffect(() => {
    if (!active) { setRail({ at: 0, ratio: 0 }); return undefined; }
    let frame = requestAnimationFrame(function tick() {
      const { at, total } = voicePosition();
      const ratio = total > 0 ? Math.min(1, at / total) : 0;
      setRail(prev => (Math.abs(prev.ratio - ratio) > 0.004 || Math.abs(prev.at - at) > 400 ? { at, ratio } : prev));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const playing = active && player.playing;
  const label = active && rail.at > 0 ? rail.at : (durationMs ?? 0);

  async function handlePlay() {
    await playVoice(id, resolve);
  }

  return (
    <span className={`voice-bubble ${active ? 'is-active' : ''} ${heard ? '' : 'is-unplayed'}`}>
      <button
        type="button"
        className="voice-play"
        onClick={handlePlay}
        aria-label={playing ? 'توقف پیام صوتی' : 'پخش پیام صوتی'}
        aria-pressed={playing}
        disabled={active && player.loading}
      >
        <i
          className={`fas ${
            active && player.loading
              ? 'fa-spinner fa-spin'
              : playing
                ? 'fa-pause'
                : player.error && active
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
          value={Math.round(rail.ratio * 1000)}
          disabled={!active}
          onChange={e => {
            const ratio = Number(e.target.value) / 1000;
            seekVoice(id, ratio);
            setRail({ at: ratio * (durationMs ?? 0), ratio });
          }}
          aria-label="جابه‌جایی در پیام صوتی"
          style={{ '--fill': `${rail.ratio * 100}%` }}
        />
      </span>

      {/* An error here is almost always a container this device cannot decode —
          a recording written by another browser's encoder. The bytes are still
          the sender's own, so the length gives way to the file itself and the
          bubble keeps one line instead of growing a banner. */}
      {active && player.error && download ? (
        <a className="voice-fallback" href={download} download>
          <i className="fas fa-download" aria-hidden="true" />
          دانلود
        </a>
      ) : (
        <time className="voice-time" dateTime={durationMs ? `PT${Math.round(durationMs / 1000)}S` : undefined}>
          {formatDuration(label)}
        </time>
      )}
      {active && player.error && <span className="sr-only" role="alert">{player.error}</span>}
      {active && player.loading && <span className="sr-only" role="status">در حال آماده‌سازی پیام صوتی…</span>}
    </span>
  );
}
