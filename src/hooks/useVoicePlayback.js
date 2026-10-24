import { useEffect, useState } from 'react';
import {
  playVoice, seekVoice, stopVoice, subscribeVoice, voicePosition,
} from '../services/voice.js';

/**
 * Where one voice bubble stands with the single player this device owns.
 *
 * A chat can hold forty recordings and exactly one of them may make sound, so the
 * player lives in a module and every bubble only reads it. Both shapes a voice
 * message can be drawn in — the rail and the waveform — ask the same questions of
 * that player and get the same answers here: is this mine, is it playing, how far
 * has it got, has anyone listened to it on this device.
 *
 * The position is polled, not pushed. A change too small to see leaves the state
 * identical, so React skips the render instead of repainting a bubble sixty times
 * a second, and a bubble that is not the one playing never polls at all.
 */
export function useVoicePlayback(id, resolve, durationMs) {
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

  return {
    active,
    loading: active && player.loading,
    playing: active && player.playing,
    error: active ? player.error : '',
    heard,
    at: rail.at,
    ratio: rail.ratio,
    toggle: () => playVoice(id, resolve),
    seek: (ratio) => {
      seekVoice(id, ratio);
      setRail({ at: ratio * (durationMs ?? 0), ratio });
    },
  };
}
