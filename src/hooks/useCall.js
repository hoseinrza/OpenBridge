import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track } from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { apiCall } from '../services/api.js';
import { connectSocket, emitWithAck } from '../services/socket.js';
import { exportCallKey } from '../services/e2ee.js';

const RING_BACKSTOP_MS = 60_000;
const SOCKET_LOSS_GRACE_MS = 12_000;
const END_NOTICE_MS = 3_200;
const CALL_PHASES = new Set(['outgoing', 'incoming', 'connecting', 'active']);

function newCallId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('این مرورگر شناسهٔ امن برای تماس نمی‌سازد');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function reasonText(payload, info) {
  switch (payload?.reason) {
    case 'rejected':
      return 'طرف مقابل تماس را رد کرد';
    case 'cancelled':
      return 'تماس‌گیرنده منصرف شد';
    case 'timeout':
      return 'پاسخی داده نشد';
    case 'hangup':
      return info?.kind === 'group' ? 'این تماس گروهی پایان یافت' : 'تماس پایان یافت';
    case 'participant-left':
      return 'طرف مقابل تماس را ترک کرد';
    case 'unavailable':
      return 'کاربر در دسترس نبود';
    case 'busy':
      return 'کاربر در تماس دیگری است';
    case 'caller-disconnected':
    case 'disconnected':
      return 'اتصال طرف تماس قطع شد';
    case 'empty':
      return 'همهٔ اعضا تماس را ترک کردند';
    case 'room-finished':
      return 'تماس پایان یافت';
    case 'max-duration':
      return 'مدت مجاز این تماس به پایان رسید';
    case 'shutdown':
      return 'سرور تماس را بست';
    case 'failed':
      return 'تماس با خطا مواجه شد';
    default:
      return 'تماس پایان یافت';
  }
}

/**
 * One-to-one and group calls over LiveKit.
 *
 * Security shape:
 * - The server decides who may ring, accept and receive a room token.
 * - In an encrypted chat the media key is derived locally from the MLS group's
 *   exporter secret. Only its SHA-256 fingerprint is sent, so the server can
 *   reject a mismatched epoch but never learns the key.
 * - If a call is expected to be encrypted and the key cannot be derived or the
 *   remote side does not confirm encryption, the client refuses to continue.
 */
export function useCall(currentUser) {
  const [phase, setPhase] = useState('idle'); // idle | preparing | outgoing | incoming | connecting | active | ended
  const [callInfo, setCallInfo] = useState(null);
  const [keyReady, setKeyReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [encryptionState, setEncryptionState] = useState('none'); // none | pending | verified | failed
  const [room, setRoom] = useState(null);
  const [roomTick, setRoomTick] = useState(0);
  const [audioDevices, setAudioDevices] = useState([]);
  const [activeAudioDevice, setActiveAudioDevice] = useState('');
  const [callsConfigured, setCallsConfigured] = useState(true);

  const mountedRef = useRef(true);
  const socketRef = useRef(null);
  const phaseRef = useRef('idle');
  const infoRef = useRef(null);
  const keyRef = useRef(null);
  const keyReadyRef = useRef(false);
  const roomRef = useRef(null);
  const workerRef = useRef(null);
  const keyProviderRef = useRef(null);
  const roomListenersRef = useRef([]);
  const timerRef = useRef(null);
  const ringTimerRef = useRef(null);
  const verifyTimerRef = useRef(null);
  const endTimerRef = useRef(null);
  const socketTimerRef = useRef(null);
  const connectingRef = useRef(false);
  const endingRef = useRef(false);
  const verifiedRef = useRef(false);
  const busyRef = useRef(false);
  const micRef = useRef(true);
  const camRef = useRef(false);
  const screenRef = useRef(false);
  const incomingGenRef = useRef(0);
  const startGenRef = useRef(0);
  const handlersRef = useRef({});

  const changePhase = useCallback((next) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setInfo = useCallback((next) => {
    infoRef.current = next;
    setCallInfo(next);
  }, []);

  const markBusy = useCallback((next) => {
    busyRef.current = next;
    setBusy(next);
  }, []);

  const setMic = useCallback((next) => {
    micRef.current = next;
    setMicOn(next);
  }, []);

  const setCam = useCallback((next) => {
    camRef.current = next;
    setCamOn(next);
  }, []);

  const setScreen = useCallback((next) => {
    screenRef.current = next;
    setScreenOn(next);
  }, []);

  const clearRing = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
  }, []);

  const clearEndTimer = useCallback(() => {
    clearTimeout(endTimerRef.current);
    endTimerRef.current = null;
  }, []);

  const removeRoomListeners = useCallback(() => {
    for (const [event, handler] of roomListenersRef.current) {
      roomRef.current?.off(event, handler);
    }
    roomListenersRef.current = [];
  }, []);

  const cleanupRoom = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = null;

    const r = roomRef.current;
    roomRef.current = null;
    removeRoomListeners();
    if (r) {
      try { r.disconnect(); } catch { /* already gone */ }
    }
    try { workerRef.current?.terminate(); } catch { /* worker already gone */ }
    workerRef.current = null;
    keyProviderRef.current = null;

    setRoom(null);
    setRoomTick((value) => value + 1);
    setConnectionState('disconnected');
    setEncryptionState('none');
    setSeconds(0);
    setMic(true);
    setCam(false);
    setScreen(false);
    setAudioDevices([]);
    setActiveAudioDevice('');
  }, [removeRoomListeners, setCam, setMic, setScreen]);

  const disposeAll = useCallback(() => {
    clearRing();
    clearTimeout(verifyTimerRef.current);
    clearTimeout(endTimerRef.current);
    clearTimeout(socketTimerRef.current);
    verifyTimerRef.current = null;
    endTimerRef.current = null;
    socketTimerRef.current = null;
    cleanupRoom();
  }, [clearRing, cleanupRoom]);

  const scheduleIdle = useCallback((ms = END_NOTICE_MS) => {
    clearEndTimer();
    endTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || phaseRef.current !== 'ended') return;
      changePhase('idle');
      setInfo(null);
      setNotice('');
      setError('');
      markBusy(false);
    }, ms);
  }, [changePhase, clearEndTimer, markBusy, setInfo]);

  const finishWithNotice = useCallback((text, { isError = false, ms = END_NOTICE_MS } = {}) => {
    clearRing();
    clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = null;
    cleanupRoom();
    keyRef.current = null;
    keyReadyRef.current = false;
    setKeyReady(false);
    verifiedRef.current = false;
    connectingRef.current = false;
    endingRef.current = false;
    markBusy(false);
    setNotice(text);
    setError(isError ? text : '');
    changePhase('ended');
    scheduleIdle(ms);
  }, [changePhase, cleanupRoom, clearRing, markBusy, scheduleIdle]);

  const failCall = useCallback((text) => {
    if (phaseRef.current === 'ended' || phaseRef.current === 'idle') return;
    const info = infoRef.current;
    if (info?.callId && socketRef.current) {
      socketRef.current.emit('call:end', { callId: info.callId });
    }
    endingRef.current = true;
    finishWithNotice(text, { isError: true, ms: 3_600 });
  }, [finishWithNotice]);

  const resetToIdle = useCallback(() => {
    clearRing();
    clearEndTimer();
    cleanupRoom();
    keyRef.current = null;
    keyReadyRef.current = false;
    setKeyReady(false);
    verifiedRef.current = false;
    connectingRef.current = false;
    endingRef.current = false;
    markBusy(false);
    setNotice('');
    setError('');
    changePhase('idle');
    setInfo(null);
  }, [changePhase, cleanupRoom, clearEndTimer, clearRing, markBusy, setInfo]);

  const startTimer = useCallback(() => {
    clearInterval(timerRef.current);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      if (mountedRef.current) setSeconds((value) => value + 1);
    }, 1000);
  }, []);

  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await Room.getLocalDevices('audiooutput');
      if (!mountedRef.current) return;
      setAudioDevices(devices);
      const active = roomRef.current?.getActiveDevice('audiooutput') || devices[0]?.deviceId || '';
      setActiveAudioDevice(active);
    } catch {
      if (mountedRef.current) setAudioDevices([]);
    }
  }, []);

  const evaluateEncryption = useCallback(() => {
    const r = roomRef.current;
    const info = infoRef.current;
    if (!r || !info) return;
    if (!info.e2ee) {
      setEncryptionState('none');
      return;
    }
    if (!r.isE2EEEnabled) {
      setEncryptionState('pending');
      return;
    }
    const remotes = [...r.remoteParticipants.values()];
    const everyone = remotes.length > 0 && remotes.every((participant) => participant.isEncrypted);
    if (everyone) {
      verifiedRef.current = true;
      clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
      setEncryptionState('verified');
      return;
    }
    if (verifiedRef.current && remotes.some((participant) => !participant.isEncrypted)) {
      setEncryptionState('failed');
      failCall('رمزنگاری سرتاسری یکی از طرف‌ها خاموش شد؛ تماس بسته شد');
      return;
    }
    setEncryptionState('pending');
  }, [failCall]);

  const scheduleEncryptionCheck = useCallback(() => {
    clearTimeout(verifyTimerRef.current);
    const info = infoRef.current;
    if (!info?.e2ee) return;
    const limit = info.kind === 'group' ? 45_000 : 25_000;
    verifyTimerRef.current = setTimeout(() => {
      const r = roomRef.current;
      if (!r || phaseRef.current !== 'active' || infoRef.current?.callId !== info.callId) return;
      const remotes = [...r.remoteParticipants.values()];
      const verified = r.isE2EEEnabled
        && remotes.length > 0
        && remotes.every((participant) => participant.isEncrypted);
      if (!verified) failCall('رمزنگاری سرتاسری این تماس تأیید نشد؛ تماس بسته شد');
    }, limit);
  }, [failCall]);

  const bindRoom = useCallback((r) => {
    const tick = () => {
      if (mountedRef.current) setRoomTick((value) => value + 1);
    };
    const on = (event, handler) => {
      r.on(event, handler);
      roomListenersRef.current.push([event, handler]);
    };

    on(RoomEvent.ParticipantConnected, () => { tick(); evaluateEncryption(); });
    on(RoomEvent.ParticipantDisconnected, tick);
    on(RoomEvent.TrackSubscribed, tick);
    on(RoomEvent.TrackUnsubscribed, tick);
    on(RoomEvent.TrackMuted, tick);
    on(RoomEvent.TrackUnmuted, tick);
    on(RoomEvent.LocalTrackPublished, tick);
    on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication?.source === Track.Source.ScreenShare) setScreen(false);
      tick();
    });
    on(RoomEvent.ActiveSpeakersChanged, tick);
    on(RoomEvent.AudioPlaybackStatusChanged, tick);
    on(RoomEvent.ParticipantEncryptionStatusChanged, () => { tick(); evaluateEncryption(); });
    on(RoomEvent.Reconnecting, () => setConnectionState('reconnecting'));
    on(RoomEvent.Reconnected, () => setConnectionState('connected'));
    on(RoomEvent.ConnectionStateChanged, (state) => setConnectionState(String(state).toLowerCase()));
    on(RoomEvent.EncryptionError, () => failCall('رمزنگاری سرتاسری این تماس با خطا مواجه شد'));
    on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== r || endingRef.current) return;
      failCall('اتصال تماس قطع شد');
    });
  }, [evaluateEncryption, failCall, setScreen]);

  const connectToRoom = useCallback(async () => {
    const info = infoRef.current;
    const socket = socketRef.current;
    if (!info || !socket || connectingRef.current || roomRef.current) return;
    if (phaseRef.current === 'active') return;

    connectingRef.current = true;
    markBusy(true);
    changePhase('connecting');

    try {
      const key = keyRef.current;
      const issued = await apiCall(`calls/${info.callId}/token`, {
        method: 'POST',
        body: { client: 'web', keyFingerprint: key?.fingerprint },
      });
      if (!mountedRef.current) return;
      if (Boolean(issued?.e2ee) !== info.e2ee) {
        throw new Error('وضعیت رمزنگاری این تماس با سرور هم‌خوان نیست؛ تماس بسته شد');
      }

      let keyProvider = null;
      let worker = null;
      if (key) {
        keyProvider = new ExternalE2EEKeyProvider();
        // The shared passphrase is the base64 MLS-derived key. The provider
        // derives the actual AES key locally; no secret crosses the network.
        await keyProvider.setKey(key.key);
        worker = new E2EEWorker();
        keyProviderRef.current = keyProvider;
        workerRef.current = worker;
      }

      const options = { adaptiveStream: true, dynacast: true };
      if (keyProvider) options.encryption = { keyProvider, worker };
      const r = new Room(options);
      roomRef.current = r;
      setRoom(r);
      bindRoom(r);

      await r.connect(issued.url, issued.token);
      if (!mountedRef.current || roomRef.current !== r) return;

      if (keyProvider) {
        try {
          await r.setE2EEEnabled(true);
        } catch {
          throw new Error('رمزنگاری سرتاسری این تماس فعال نشد؛ تماس بسته شد');
        }
      }

      changePhase('active');
      setConnectionState('connected');
      markBusy(false);
      startTimer();

      try {
        await r.localParticipant.setMicrophoneEnabled(true);
        setMic(true);
      } catch {
        throw new Error('دسترسی به میکروفون ممکن نشد؛ تماس بسته شد');
      }

      if (info.type === 'video') {
        try {
          await r.localParticipant.setCameraEnabled(true);
          setCam(true);
        } catch {
          setCam(false);
          setNotice('دسترسی به دوربین ممکن نشد؛ تماس صوتی ادامه دارد');
        }
      }

      if (info.e2ee) {
        setEncryptionState('pending');
        scheduleEncryptionCheck();
      } else {
        setEncryptionState('none');
      }
      setRoomTick((value) => value + 1);
      void refreshAudioDevices();
    } catch (err) {
      if (mountedRef.current) failCall(err?.message || 'برقراری تماس ناموفق بود');
    } finally {
      connectingRef.current = false;
      if (mountedRef.current) markBusy(false);
    }
  }, [bindRoom, changePhase, failCall, markBusy, refreshAudioDevices, scheduleEncryptionCheck, setCam, setMic, startTimer]);

  const scheduleRingBackstop = useCallback(() => {
    clearRing();
    ringTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (phaseRef.current === 'outgoing' || phaseRef.current === 'incoming') {
        finishWithNotice('پاسخی داده نشد', { ms: 2_800 });
      }
    }, RING_BACKSTOP_MS);
  }, [clearRing, finishWithNotice]);

  // ── Incoming / accepted / ended ────────────────────────────────

  async function handleIncoming(payload) {
    if (!payload?.callId) return;
    if (phaseRef.current !== 'idle') {
      socketRef.current?.emit('call:reject', { callId: payload.callId });
      return;
    }

    const kind = payload.kind === 'group' ? 'group' : 'direct';
    if (kind === 'group' && !payload.conversationId) return;
    const info = {
      callId: payload.callId,
      conversationId: payload.conversationId ?? null,
      type: payload.type === 'video' ? 'video' : 'audio',
      kind,
      peer: kind === 'direct' ? (payload.from ?? null) : null,
      from: payload.from ?? null,
      group: kind === 'group' ? (payload.group ?? null) : null,
      e2ee: payload.e2ee === true,
      keyFingerprint: payload.keyFingerprint ?? null,
    };

    clearEndTimer();
    setInfo(info);
    keyRef.current = null;
    keyReadyRef.current = !info.e2ee;
    setKeyReady(!info.e2ee);
    setError('');
    setNotice('');
    markBusy(false);
    setEncryptionState(info.e2ee ? 'pending' : 'none');
    changePhase('incoming');
    scheduleRingBackstop();

    if (!info.e2ee) return;

    const generation = incomingGenRef.current + 1;
    incomingGenRef.current = generation;
    try {
      const chat = kind === 'group'
        ? { kind: 'group', id: info.conversationId }
        : { kind: 'user', id: payload.from?.id };
      if (!chat.id) throw new Error('طرف این تماس مشخص نیست');
      const key = await exportCallKey(currentUser, chat, info.callId);
      if (generation !== incomingGenRef.current || phaseRef.current !== 'incoming') return;
      if (!key) throw new Error('این گفتگو روی این دستگاه کلید رمزنگاری ندارد');
      if (!info.keyFingerprint || key.fingerprint !== info.keyFingerprint) {
        throw new Error('کلید رمزنگاری این تماس با دستگاه شما هم‌خوان نیست');
      }
      keyRef.current = key;
      keyReadyRef.current = true;
      setKeyReady(true);
    } catch (err) {
      if (generation !== incomingGenRef.current) return;
      if (phaseRef.current !== 'incoming') return;
      socketRef.current?.emit('call:reject', { callId: info.callId });
      finishWithNotice(err?.message || 'کلید رمزنگاری این تماس در دسترس نیست', { isError: true, ms: 3_600 });
    }
  }

  function handleAccepted(payload) {
    const info = infoRef.current;
    if (!info || payload?.callId !== info.callId) return;
    clearRing();

    if (info.kind === 'direct') {
      // Our own accept echo, or a second tab of the same account. The tab that
      // is still ringing closes; the accepting tab is already connecting.
      if (payload.userId === currentUser.id) {
        if (phaseRef.current === 'incoming') {
          finishWithNotice('این تماس در تب دیگری پاسخ داده شد', { ms: 2_800 });
        }
        return;
      }
      if (phaseRef.current !== 'outgoing') return;
      if (info.e2ee) {
        if (!keyRef.current || payload.keyFingerprint !== keyRef.current.fingerprint) {
          failCall('کلید رمزنگاری طرف مقابل با این تماس هم‌خوان نیست؛ تماس بسته شد');
          return;
        }
      }
      void connectToRoom();
      return;
    }

    if (payload.userId === currentUser.id) {
      if (phaseRef.current === 'incoming') {
        finishWithNotice('این تماس در تب دیگری پاسخ داده شد', { ms: 2_800 });
      }
      return;
    }

    // A group member joined; only the initiator still needs to open its room.
    setRoomTick((value) => value + 1);
    if (phaseRef.current !== 'outgoing') return;
    if (info.e2ee) {
      if (!keyRef.current || payload.keyFingerprint !== keyRef.current.fingerprint) {
        failCall('کلید رمزنگاری یکی از اعضا با این تماس هم‌خوان نیست؛ تماس بسته شد');
        return;
      }
    }
    void connectToRoom();
  }

  function handleEnded(payload) {
    const info = infoRef.current;
    if (!info || payload?.callId !== info.callId) return;
    if (phaseRef.current === 'ended' || phaseRef.current === 'idle') return;
    clearRing();
    cleanupRoom();
    keyRef.current = null;
    keyReadyRef.current = false;
    setKeyReady(false);
    verifiedRef.current = false;
    markBusy(false);
    setNotice(reasonText(payload, info));
    setError('');
    changePhase('ended');
    scheduleIdle(payload?.reason === 'hangup' ? 2_200 : END_NOTICE_MS);
  }

  function handleParticipantLeft(payload) {
    const info = infoRef.current;
    if (!info || payload?.callId !== info.callId) return;
    if (payload.userId === currentUser.id) {
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') {
        finishWithNotice('این تماس در تب دیگری قطع شد', { ms: 2_800 });
      }
      return;
    }
    setRoomTick((value) => value + 1);
    setNotice(payload.reason === 'rejected' ? 'یکی از اعضا تماس را رد کرد' : 'یکی از اعضا تماس را ترک کرد');
    setTimeout(() => { if (mountedRef.current) setNotice(''); }, 2_500);
  }

  // The socket listeners are registered once; this table keeps them pointed at
  // the newest handlers without tearing the connection down on every render.
  useEffect(() => {
    handlersRef.current = {
      incoming: handleIncoming,
      accepted: handleAccepted,
      ended: handleEnded,
      left: handleParticipantLeft,
      fail: failCall,
    };
  });

  // ── Socket lifecycle ───────────────────────────────────────────

  useEffect(() => {
    if (!currentUser?.id) return undefined;

    const socket = connectSocket();
    socketRef.current = socket;

    const onIncoming = (payload) => { void handlersRef.current.incoming?.(payload); };
    const onAccepted = (payload) => handlersRef.current.accepted?.(payload);
    const onEnded = (payload) => handlersRef.current.ended?.(payload);
    const onLeft = (payload) => handlersRef.current.left?.(payload);
    const onConnect = () => {
      clearTimeout(socketTimerRef.current);
      socketTimerRef.current = null;
    };
    const onDisconnect = () => {
      clearTimeout(socketTimerRef.current);
      socketTimerRef.current = setTimeout(() => {
        if (!socket.connected && CALL_PHASES.has(phaseRef.current)) {
          handlersRef.current.fail?.('اتصال به سرور قطع شد؛ تماس بسته شد');
        }
      }, SOCKET_LOSS_GRACE_MS);
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:ended', onEnded);
    socket.on('call:participant-left', onLeft);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:ended', onEnded);
      socket.off('call:participant-left', onLeft);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);

      const info = infoRef.current;
      if (info?.callId && CALL_PHASES.has(phaseRef.current)) {
        socket.emit('call:end', { callId: info.callId });
      }
      disposeAll();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [currentUser?.id, disposeAll]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Whether the server has a media backend configured. Kept advisory: a call
  // attempt still fails closed if this lookup was stale.
  useEffect(() => {
    if (!currentUser?.id) return undefined;
    let active = true;
    apiCall('calls/status')
      .then((data) => { if (active && data && data.configured === false) setCallsConfigured(false); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [currentUser?.id]);

  // ── User actions ───────────────────────────────────────────────

  async function startCall(chat, type) {
    if (!chat || (type !== 'audio' && type !== 'video')) return;
    if (phaseRef.current !== 'idle' || busyRef.current) return;
    if (!callsConfigured) {
      setError('تماس روی این سرور فعال نشده است');
      setNotice('تماس روی این سرور فعال نشده است');
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError('اتصال به سرور برقرار نیست');
      setNotice('اتصال به سرور برقرار نیست؛ چند لحظه بعد دوباره تلاش کنید');
      return;
    }

    let callId;
    try {
      callId = newCallId();
    } catch (err) {
      setError(err.message);
      setNotice(err.message);
      return;
    }

    const kind = chat.kind === 'group' ? 'group' : 'direct';
    const encrypted = chat.encrypted === true;
    const startGen = startGenRef.current + 1;
    startGenRef.current = startGen;
    const base = {
      callId,
      conversationId: kind === 'group' ? chat.id : null,
      type,
      kind,
      peer: kind === 'direct' ? chat : null,
      group: kind === 'group' ? chat : null,
      e2ee: encrypted,
      keyFingerprint: null,
    };

    clearEndTimer();
    setInfo(base);
    changePhase('preparing');
    markBusy(true);
    setKeyReady(false);
    setError('');
    setNotice('');

    try {
      let key = null;
      if (encrypted) {
        key = await exportCallKey(currentUser, chat, callId);
        if (startGen !== startGenRef.current) return;
        if (!key) throw new Error('کلید رمزنگاری این گفتگو در دسترس نیست؛ تماس بسته ماند');
      }
      if (startGen !== startGenRef.current) return;
      keyRef.current = key;
      keyReadyRef.current = true;
      setKeyReady(true);

      const next = { ...base, keyFingerprint: key?.fingerprint ?? null };
      setInfo(next);

      const payload = kind === 'group'
        ? { callId, conversationId: chat.id, type, keyFingerprint: next.keyFingerprint ?? undefined }
        : { callId, toId: chat.id, type, keyFingerprint: next.keyFingerprint ?? undefined };
      const ack = await emitWithAck(
        socket,
        kind === 'group' ? 'call:group-start' : 'call:invite',
        payload,
        15_000,
      );
      if (!mountedRef.current) return;
      if (startGen !== startGenRef.current) {
        // The user cancelled while the server was creating the ring.
        socket.emit('call:cancel', { callId });
        return;
      }
      if (encrypted && ack?.e2ee !== true) {
        throw new Error('وضعیت رمزنگاری این گفتگو با سرور هم‌خوان نیست؛ تماس بسته شد');
      }

      setInfo({ ...next, conversationId: ack?.conversationId ?? next.conversationId, e2ee: ack?.e2ee === true });
      changePhase('outgoing');
      scheduleRingBackstop();
      if (kind === 'group' && ack?.reachable === 0) {
        setNotice('هیچ‌کدام از اعضا آنلاین نیستند؛ تماس در انتظار پاسخ است');
      }
    } catch (err) {
      if (startGen !== startGenRef.current) return;
      keyRef.current = null;
      keyReadyRef.current = false;
      setKeyReady(false);
      if (socket.connected && infoRef.current?.callId) {
        socket.emit('call:end', { callId: infoRef.current.callId });
      }
      finishWithNotice(err?.message || 'شروع تماس ناموفق بود', { isError: true, ms: 3_600 });
    } finally {
      if (startGen === startGenRef.current) markBusy(false);
    }
  }

  async function acceptCall() {
    const info = infoRef.current;
    const socket = socketRef.current;
    if (!info || phaseRef.current !== 'incoming' || busyRef.current) return;
    if (info.e2ee && !keyRef.current) {
      setError('کلید رمزنگاری این تماس هنوز آماده نیست');
      return;
    }
    if (!socket?.connected) {
      failCall('اتصال به سرور برقرار نیست');
      return;
    }

    clearRing();
    markBusy(true);
    changePhase('connecting');
    try {
      await emitWithAck(socket, 'call:accept', {
        callId: info.callId,
        keyFingerprint: keyRef.current?.fingerprint,
      }, 12_000);
      if (!mountedRef.current) return;
      await connectToRoom();
    } catch (err) {
      failCall(err?.message || 'پاسخ به تماس ناموفق بود');
    } finally {
      markBusy(false);
    }
  }

  function rejectCall() {
    const info = infoRef.current;
    if (!info) return;
    socketRef.current?.emit('call:reject', { callId: info.callId });
    resetToIdle();
  }

  function cancelCall() {
    const info = infoRef.current;
    if (!info) return;
    startGenRef.current += 1;
    socketRef.current?.emit('call:cancel', { callId: info.callId });
    resetToIdle();
  }

  function hangUp() {
    const info = infoRef.current;
    if (!info) return;
    socketRef.current?.emit('call:end', { callId: info.callId });
    finishWithNotice(info.kind === 'group' ? 'از تماس خارج شدید' : 'تماس پایان یافت', { ms: 2_200 });
  }

  async function toggleMic() {
    const r = roomRef.current;
    if (!r) return;
    const next = !micRef.current;
    try {
      await r.localParticipant.setMicrophoneEnabled(next);
      setMic(next);
    } catch {
      setNotice('تغییر وضعیت میکروفون ممکن نشد');
    }
  }

  async function toggleCam() {
    const r = roomRef.current;
    if (!r) return;
    const next = !camRef.current;
    try {
      await r.localParticipant.setCameraEnabled(next);
      setCam(next);
    } catch {
      setNotice('تغییر وضعیت دوربین ممکن نشد');
    }
  }

  async function toggleScreen() {
    const r = roomRef.current;
    if (!r) return;
    const next = !screenRef.current;
    try {
      await r.localParticipant.setScreenShareEnabled(next);
      setScreen(next);
    } catch {
      setNotice('اشتراک صفحه ممکن نشد');
    }
  }

  async function switchAudioDevice(deviceId) {
    const r = roomRef.current;
    if (!r || !deviceId) return;
    try {
      await r.switchActiveDevice('audiooutput', deviceId);
      setActiveAudioDevice(deviceId);
    } catch {
      setNotice('تغییر خروجی صدا ممکن نشد');
    }
  }

  async function startAudio() {
    try { await roomRef.current?.startAudio(); } catch { /* browser still blocking */ }
  }

  const timerLabel = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return {
    phase,
    callInfo,
    peer: callInfo?.peer ?? null,
    group: callInfo?.group ?? null,
    keyReady,
    busy,
    error,
    notice,
    timerLabel,
    seconds,
    micOn,
    camOn,
    screenOn,
    connectionState,
    encryptionState,
    room,
    roomTick,
    audioDevices,
    activeAudioDevice,
    callsConfigured,
    startCall,
    acceptCall,
    rejectCall,
    cancelCall,
    hangUp,
    toggleMic,
    toggleCam,
    toggleScreen,
    switchAudioDevice,
    startAudio,
    refreshAudioDevices,
    dismiss: resetToIdle,
  };
}
