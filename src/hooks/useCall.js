import { useState, useRef, useCallback, useEffect } from 'react';
import { isMockUser } from './useChat.js';

const SOCKET_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api').replace('/api', '');
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Manages a 1-to-1 WebRTC call (video or audio): signaling over the chat
// socket, peer connection lifecycle and local/remote media streams.
export function useCall(currentUser) {
  const [callState, setCallState]       = useState('idle'); // idle | outgoing | incoming | connecting | active
  const [callType, setCallType]         = useState(null);   // 'video' | 'audio'
  const [peer, setPeer]                 = useState(null);   // { id, name, avatar }
  const [localStream, setLocalStream]   = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [micOn, setMicOn]               = useState(true);
  const [camOn, setCamOn]               = useState(true);
  const [seconds, setSeconds]           = useState(0);
  const [error, setError]               = useState('');

  const apiRef         = useRef({});
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  // Call duration timer, runs only while connected
  useEffect(() => {
    if (callState !== 'active') { setSeconds(0); return; }
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [callState]);

  // Errors are surfaced as transient toasts
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(id);
  }, [error]);

  const timerLabel = String(Math.floor(seconds / 60)).padStart(2, '0')
    + ':' + String(seconds % 60).padStart(2, '0');

  // ── socket connection + WebRTC session lifecycle ─────
  useEffect(() => {
    const token = localStorage.getItem('chatapp_token');
    if (!token || !currentUser || isMockUser(currentUser)) { apiRef.current = {}; return; }

    let socket;
    let cancelled = false;

    // Mutable session state shared by every handler in this closure
    let pc           = null;
    let localMedia   = null;
    let remoteTracks = [];
    let pendingIce   = [];
    let phase        = 'idle';
    let activePeer   = null;
    let activeType   = null;

    const setPhase = (p) => { phase = p; setCallState(p); };

    function reset() {
      pc?.close(); pc = null;
      localMedia?.getTracks().forEach(t => t.stop()); localMedia = null;
      remoteTracks = []; pendingIce = [];
      activePeer = null; activeType = null;
      setLocalStream(null); setRemoteStream(null);
      setPeer(null); setCallType(null);
      setMicOn(true); setCamOn(true);
      setPhase('idle');
    }

    function fail(message) {
      setError(message);
      if (activePeer && phase !== 'idle') socket?.emit('call:end', { toId: activePeer.id });
      reset();
    }

    async function getMedia(kind) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === 'video' ? { width: 640, height: 480 } : false,
      });
      localMedia = stream;
      setLocalStream(stream);
      setMicOn(true);
      setCamOn(kind === 'video');
      return stream;
    }

    function createPeerConnection(toId) {
      const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      conn.onicecandidate = (e) => {
        if (e.candidate) socket.emit('call:ice-candidate', { toId, candidate: e.candidate });
      };
      conn.ontrack = (e) => {
        remoteTracks = [...remoteTracks.filter(t => t.kind !== e.track.kind), e.track];
        setRemoteStream(new MediaStream(remoteTracks));
      };
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === 'connected' && phase === 'connecting') setPhase('active');
        if (conn.connectionState === 'failed' && phase !== 'idle') fail('اتصال تماس قطع شد');
      };
      pc = conn;
      return conn;
    }

    async function flushPendingIce() {
      const queued = pendingIce;
      pendingIce = [];
      for (const candidate of queued) {
        try { await pc.addIceCandidate(candidate); } catch { /* ignore stale candidates */ }
      }
    }

    // ── outgoing call ──
    async function startCall(targetUser, kind) {
      if (phase !== 'idle' || !socket || !targetUser?.id) return;
      setError('');
      activePeer = targetUser; activeType = kind;
      setPeer(targetUser); setCallType(kind);
      try {
        await getMedia(kind);
      } catch {
        setError('دسترسی به دوربین/میکروفون ممکن نشد');
        activePeer = null; activeType = null;
        setPeer(null); setCallType(null);
        return;
      }
      setPhase('outgoing');
      const me = currentUserRef.current;
      socket.emit('call:invite', {
        toId: targetUser.id,
        callType: kind,
        caller: { id: me.id, name: me.name, avatar: me.avatar },
      });
    }

    function cancelCall() {
      if (phase !== 'outgoing') return;
      socket.emit('call:cancel', { toId: activePeer?.id });
      reset();
    }

    // ── incoming call ──
    async function acceptCall() {
      if (phase !== 'incoming') return;
      const target = activePeer, kind = activeType;
      setError('');
      try {
        await getMedia(kind);
      } catch {
        setError('دسترسی به دوربین/میکروفون ممکن نشد');
        socket.emit('call:reject', { toId: target?.id });
        reset();
        return;
      }
      setPhase('connecting');
      socket.emit('call:accept', { toId: target?.id });
    }

    function rejectCall() {
      if (phase !== 'incoming') return;
      socket.emit('call:reject', { toId: activePeer?.id });
      reset();
    }

    function hangUp() {
      if (phase === 'idle') return;
      socket.emit('call:end', { toId: activePeer?.id });
      reset();
    }

    function toggleMic() {
      setMicOn(prev => {
        const next = !prev;
        localMedia?.getAudioTracks().forEach(t => { t.enabled = next; });
        return next;
      });
    }

    function toggleCam() {
      setCamOn(prev => {
        const next = !prev;
        localMedia?.getVideoTracks().forEach(t => { t.enabled = next; });
        return next;
      });
    }

    apiRef.current = { startCall, cancelCall, acceptCall, rejectCall, hangUp, toggleMic, toggleCam };

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket'], timeout: 4000 });

      socket.on('call:incoming', ({ fromId, callType: kind, caller }) => {
        if (phase !== 'idle') { socket.emit('call:reject', { toId: fromId }); return; }
        activePeer = caller ?? { id: fromId, name: 'کاربر', avatar: '/images/user.png' };
        activeType = kind;
        setError('');
        setPeer(activePeer); setCallType(kind);
        setPhase('incoming');
      });

      // Callee accepted our invite → build the peer connection and send the offer
      socket.on('call:accepted', async ({ fromId }) => {
        if (phase !== 'outgoing' || activePeer?.id !== fromId || !localMedia) return;
        const conn = createPeerConnection(fromId);
        localMedia.getTracks().forEach(track => conn.addTrack(track, localMedia));
        setPhase('connecting');
        try {
          const offer = await conn.createOffer();
          await conn.setLocalDescription(offer);
          socket.emit('call:offer', { toId: fromId, sdp: offer });
        } catch { fail('برقراری تماس با خطا مواجه شد'); }
      });

      // We accepted, caller's offer arrived → build peer connection and answer
      socket.on('call:offer', async ({ fromId, sdp }) => {
        if (activePeer?.id !== fromId || !localMedia) return;
        const conn = createPeerConnection(fromId);
        localMedia.getTracks().forEach(track => conn.addTrack(track, localMedia));
        try {
          await conn.setRemoteDescription(sdp);
          await flushPendingIce();
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          socket.emit('call:answer', { toId: fromId, sdp: answer });
        } catch { fail('برقراری تماس با خطا مواجه شد'); }
      });

      socket.on('call:answer', async ({ fromId, sdp }) => {
        if (activePeer?.id !== fromId || !pc) return;
        try {
          await pc.setRemoteDescription(sdp);
          await flushPendingIce();
        } catch { fail('برقراری تماس با خطا مواجه شد'); }
      });

      socket.on('call:ice-candidate', async ({ fromId, candidate }) => {
        if (activePeer?.id !== fromId || !candidate) return;
        if (pc?.remoteDescription) {
          try { await pc.addIceCandidate(candidate); } catch { /* ignore */ }
        } else {
          pendingIce.push(candidate);
        }
      });

      socket.on('call:rejected', ({ fromId }) => {
        if (phase === 'outgoing' && activePeer?.id === fromId) { setError('طرف مقابل تماس را رد کرد'); reset(); }
      });
      socket.on('call:cancelled', ({ fromId }) => {
        if (phase === 'incoming' && activePeer?.id === fromId) reset();
      });
      socket.on('call:ended', ({ fromId }) => {
        if (phase !== 'idle' && activePeer?.id === fromId) reset();
      });
    }).catch(() => {});

    return () => {
      cancelled = true;
      if (phase !== 'idle' && socket && activePeer) {
        try { socket.emit('call:end', { toId: activePeer.id }); } catch { /* ignore */ }
      }
      reset();
      socket?.disconnect();
      apiRef.current = {};
    };
  }, [currentUser?.id]);

  const startCall  = useCallback((user, kind) => apiRef.current.startCall?.(user, kind), []);
  const cancelCall = useCallback(() => apiRef.current.cancelCall?.(), []);
  const acceptCall = useCallback(() => apiRef.current.acceptCall?.(), []);
  const rejectCall = useCallback(() => apiRef.current.rejectCall?.(), []);
  const hangUp     = useCallback(() => apiRef.current.hangUp?.(), []);
  const toggleMic  = useCallback(() => apiRef.current.toggleMic?.(), []);
  const toggleCam  = useCallback(() => apiRef.current.toggleCam?.(), []);

  return {
    callState, callType, peer, localStream, remoteStream,
    micOn, camOn, timerLabel, error,
    startCall, cancelCall, acceptCall, rejectCall, hangUp, toggleMic, toggleCam,
  };
}
