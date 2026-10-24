// The browser half of a voice message: one recorder and one player.
//
// The recorder exists so a bubble can be sent with a length attached to it. That
// length is measured here, from the moment the microphone actually started,
// rather than decoded out of the file afterwards: the bytes are written by a
// platform encoder in a container this code does not parse, while the clock is a
// number the sender genuinely knows.
//
// The player is a module rather than a component. A chat can hold forty voice
// bubbles and exactly one of them is allowed to make sound, so one hidden
// <audio> element lives here and every bubble subscribes to it. The bubble that
// is playing draws its own rail from this module on every animation frame, which
// keeps the progress smooth without the whole message list re-rendering at sixty
// frames a second.
//
// Plain and encrypted voices reach the same player by different doors — a stored
// file is fetched into a blob URL, a conversation's own ciphertext is opened by
// attachments.js first — and resolution happens on the first tap rather than on
// mount, so a long history of recordings downloads nothing until someone asks to
// hear one.

const MAX_VOICE_MS = 10 * 60 * 1000;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const CACHE_MAX = 24;

// How often the microphone is measured for the picture the sent bubble keeps, and
// how many bars that picture is drawn with. The composer's live meter scrolls far
// faster because it is being watched; these numbers only have to survive into a
// shape a person recognises at a glance, and fit inside a message.
const PEAK_SAMPLE_MS = 100;
const PEAK_BARS = 40;

// The server accepts an upload only when the declared MIME type and the file's
// extension agree, and it keeps its own table of those pairs. This is the client
// side of that table for audio. Anything else the browser might write is refused
// here, before a byte leaves the device, rather than uploaded to a rejection that
// is already certain.
const VOICE_EXTENSIONS = {
  'audio/webm': 'weba',
  'audio/ogg':  'ogg',
  'audio/mp4':  'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav':  'wav',
};

/** The container a recorded blob really holds, without its codec parameters. */
export function extensionForMime(mime) {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return VOICE_EXTENSIONS[base] ?? null;
}

export function voiceRecordingSupported() {
  return typeof MediaRecorder === 'function'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Squeezes however many measurements a recording made into the bars a bubble has.
 *
 * Each bar is the loudest moment inside its slice, and every one is measured
 * against the loudest moment of the whole recording — so the shape of what was
 * said survives a quiet microphone, and the numbers that travel are whole
 * percentages a phone can read the same way a browser drew them.
 */
function downsample(levels, bars) {
  if (levels.length === 0) return null;
  const slices = [];
  let loudest = 0;
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor(i * levels.length / bars);
    const to = Math.max(from + 1, Math.floor((i + 1) * levels.length / bars));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j += 1) peak = Math.max(peak, levels[j]);
    slices.push(peak);
    if (peak > loudest) loudest = peak;
  }
  return slices.map(peak => (loudest > 0 ? Math.round((peak / loudest) * 100) : 0));
}

/**
 * Records from the microphone until the caller stops it.
 *
 * `level` and `elapsed` are read, never pushed: the composer polls them on its
 * own frame, so a recording nobody is looking at costs nothing to keep running.
 * The waveform the sent bubble draws is measured here instead, on a timer of its
 * own, because a frame loop pauses in a hidden tab and the picture would stop
 * being true of the sound.
 */
export function createVoiceRecorder() {
  let stream = null;
  let recorder = null;
  let context = null;
  let analyser = null;
  let samples = null;
  let startedAt = 0;
  let chunks = [];
  let levels = [];
  let lastLevelAt = 0;
  let levelTimer = null;

  function release() {
    clearInterval(levelTimer);
    levelTimer = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    startedAt = 0;
    analyser = null;
    samples = null;
    levels = [];
    context?.close().catch(() => {});
    context = null;
  }

  /** How loud the microphone is right now, between 0 and 1. */
  function level() {
    if (!analyser || !samples) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const deviation = (samples[i] - 128) / 128;
      sum += deviation * deviation;
    }
    return Math.min(1, Math.sqrt(sum / samples.length) * 3);
  }

  function sampleLevel() {
    const now = performance.now();
    if (now - lastLevelAt < PEAK_SAMPLE_MS) return;
    lastLevelAt = now;
    levels.push(level());
  }

  return {
    get maxMs() { return MAX_VOICE_MS; },
    get maxBytes() { return MAX_VOICE_BYTES; },

    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      recorder = new MediaRecorder(stream);
      chunks = [];
      levels = [];
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.start();

      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
      if (AudioContextCtor) {
        context = new AudioContextCtor();
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        samples = new Uint8Array(analyser.fftSize);
      }
      startedAt = performance.now();
      lastLevelAt = startedAt;
      levelTimer = setInterval(sampleLevel, PEAK_SAMPLE_MS);
    },

    level,

    elapsed() { return startedAt ? performance.now() - startedAt : 0; },

    /** Stops, and hands back the file plus the length written on the bubble. */
    async stop() {
      // The clock stops before the encoder is flushed, so the number the sender
      // sees is the time the microphone was open, not the time the bytes took.
      const durationMs = Math.round(this.elapsed());
      // The last slice of the recording is the one a timer tick can miss, and it
      // is the one the person was still speaking into.
      sampleLevel();
      const peaks = downsample(levels, PEAK_BARS);
      if (!recorder) throw new Error('ضبط شروع نشده بود');
      const { blob, mime } = await new Promise((resolve, reject) => {
        recorder.onstop = () => resolve({
          blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
          mime: '',
        });
        recorder.onerror = () => reject(new Error('ضبط صدا ناموفق بود'));
        if (recorder.state === 'inactive') recorder.onstop();
        else recorder.stop();
      });
      release();

      if (blob.size === 0) throw new Error('ضبط کوتاه‌تر از آن بود که پیامی ساخته شود');
      if (blob.size > MAX_VOICE_BYTES) throw new Error('پیام صوتی بیش از حد مجاز بزرگ شد');
      const extension = extensionForMime(mime || blob.type);
      if (!extension) throw new Error('این مرورگر قالب صوتی پشتیبانی‌شده‌ای نمی‌نویسد');

      return {
        file: new File([blob], `voice-message.${extension}`, { type: (mime || blob.type).split(';')[0] }),
        durationMs,
        peaks,
      };
    },

    cancel() { release(); },
  };
}

// ── The one player ────────────────────────────────────────────────────

const blobUrls = new Map();
const listeners = new Set();
let heldRelease = null;
let state = { id: null, loading: false, playing: false, error: '' };

const element = typeof Audio === 'function' ? new Audio() : null;
// A container written by a recorder sometimes carries no length of its own, and
// asking for a position far past the end is what makes a browser measure it.
let coaxed = false;

if (element) {
  element.preload = 'auto';
  element.addEventListener('loadedmetadata', () => {
    // The bytes are here and the container opened: from this frame the bubble
    // draws a pause, not a spinner, whatever the length turns out to be.
    emit({ loading: false });
    if (!Number.isFinite(element.duration) && !coaxed) {
      coaxed = true;
      element.currentTime = 1e7;
    }
  });
  element.addEventListener('play',  () => emit({ playing: true, loading: false }));
  element.addEventListener('pause', () => emit({ playing: false }));
  element.addEventListener('ended', () => { emit({ playing: false }); reset(); });
  element.addEventListener('error', () => emit({
    playing: false,
    loading: false,
    error: 'پخش این پیام صوتی در این دستگاه ممکن نیست؛ می‌توانید آن را دانلود کنید',
  }));
}

function emit(patch) {
  state = { ...state, ...patch };
  for (const listen of listeners) listen(state);
}

function reset() {
  heldRelease?.();
  heldRelease = null;
  if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
  coaxed = false;
  state = { ...state, id: null, loading: false, playing: false };
  for (const listen of listeners) listen(state);
}

/** Subscribes to the single player; the listener is called once, immediately. */
export function subscribeVoice(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Where the active recording stands, in milliseconds, with its real length. */
export function voicePosition() {
  if (!element || !state.id) return { at: 0, total: 0 };
  const total = Number.isFinite(element.duration) ? element.duration * 1000 : 0;
  return { at: element.currentTime * 1000, total };
}

/** Moves the active recording. A bubble that is not the one playing is ignored. */
export function seekVoice(id, ratio) {
  if (!element || state.id !== id || !Number.isFinite(element.duration)) return;
  element.currentTime = Math.min(0.999, Math.max(0, ratio)) * element.duration;
}

/**
 * Plays one voice bubble, or stops it when it is already the sound on screen.
 * `resolve` is what makes the two kinds of attachment one call: it hands back a
 * playable URL plus the way to give the bytes back when the listen is over.
 */
export async function playVoice(id, resolve) {
  if (!element) return;
  if (state.id === id) {
    if (state.playing) element.pause();
    else if (element.src) element.play().catch(() => {});
    return;
  }

  reset();
  emit({ id, loading: true, error: '' });
  try {
    const opened = await resolve();
    // Somebody else took the speaker while these bytes were coming.
    if (state.id !== id) { opened.release(); return; }
    element.src = opened.url;
    heldRelease = opened.release;
    await element.play();
  } catch (err) {
    reset();
    emit({ error: err?.message || 'پخش پیام صوتی ناموفق بود' });
  }
}

/** Stops the player when the bubble it is playing leaves the screen. */
export function stopVoice(id) {
  if (element && state.id === id) reset();
}

/** Fetches a stored file once and keeps its object URL for the next listen. */
export async function playableFromSrc(src) {
  const cached = blobUrls.get(src);
  if (cached) return { url: cached, release: () => {} };

  const res = await fetch(src);
  if (!res.ok) throw new Error('دریافت پیام صوتی ناموفق بود');
  const url = URL.createObjectURL(await res.blob());
  blobUrls.set(src, url);
  if (blobUrls.size > CACHE_MAX) {
    for (const [key, value] of blobUrls) {
      // The URL now on the element cannot be given back, or the sound being
      // heard dies mid-word.
      if (element && value === element.src) continue;
      URL.revokeObjectURL(value);
      blobUrls.delete(key);
      break;
    }
  }
  // The cache owns the URL, not the bubble, so replaying costs nothing.
  return { url, release: () => {} };
}
