import { createAudioPlayer } from 'expo-audio';

// The phone half of listening to a voice message: exactly one sound at a time.
//
// A chat can hold forty bubbles and only one of them may be playing, so the
// player is a module-level object every bubble subscribes to, the same way the
// web app keeps one hidden <audio> element. A bubble asks the player to take its
// turn and draws whatever the player reports back; it never owns the sound.
//
// The bytes are streamed from the server rather than copied to storage first: a
// recording is a few hundred kilobytes, and an audio player that reads a URL
// needs neither a download prompt nor a file to clean up afterwards.

const listeners = new Set();

let player = null;
let currentId = null;
let unsubscribe = null;

let state = { id: null, loading: false, playing: false, error: '', at: 0, total: 0 };

function emit(patch) {
  state = { ...state, ...patch };
  for (const listen of listeners) listen(state);
}

/** Releases whatever is playing; the next tap builds a new player. */
function release() {
  unsubscribe?.();
  unsubscribe = null;
  player?.remove();
  player = null;
  currentId = null;
  state = { ...state, id: null, loading: false, playing: false, error: '', at: 0, total: 0 };
  for (const listen of listeners) listen(state);
}

/** Subscribes to the single player; the listener is called once, immediately. */
export function subscribeVoice(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/**
 * Plays this bubble, pauses it when it is already the sound on screen, or takes
 * over the speaker from whichever bubble was playing before.
 */
export function playVoice(id, uri) {
  if (!uri) return;
  if (currentId === id && player) {
    if (player.playing) player.pause();
    else player.play();
    return;
  }

  release();
  currentId = id;
  emit({ id, loading: true, playing: false, error: '', at: 0, total: 0 });

  try {
    player = createAudioPlayer({ uri });
    unsubscribe = player.addListener('playbackStatusUpdate', (status) => {
      emit({
        loading: !status.isLoaded && !status.error,
        playing: status.playing,
        error: status.error ?? '',
        at: (status.currentTime ?? 0) * 1000,
        total: (status.duration ?? 0) * 1000,
      });
      if (status.didJustFinish) {
        // The listen is over: the bubble goes back to its own length and the
        // speaker is handed back, so the next tap starts from the beginning.
        release();
      }
    });
    player.play();
  } catch (err) {
    // The player is gone but the id stays: a bubble can only show the failure
    // if the player still names it, and a second tap builds a fresh player.
    unsubscribe?.();
    unsubscribe = null;
    player?.remove();
    player = null;
    emit({ loading: false, playing: false, at: 0, total: 0, error: err?.message ?? 'پخش پیام صوتی ناموفق بود' });
  }
}

/** Stops the player when the bubble it is holding leaves the screen. */
export function stopVoice(id) {
  if (currentId === id) release();
}
