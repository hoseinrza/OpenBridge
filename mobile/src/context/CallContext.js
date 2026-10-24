import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';
import { fetchCallToken } from '../services/api';

const CallContext = createContext(null);

const ACTIVE_PHASES = new Set(['outgoing', 'incoming', 'connecting', 'active']);
const INITIAL = {
  phase: 'idle',
  info: null,
  token: null,
  url: null,
  error: '',
  notice: '',
};

function emitAck(socket, event, payload, timeout = 12000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (err, response) => {
      if (err) return reject(new Error('پاسخی از سرور دریافت نشد؛ اتصال را بررسی کن'));
      if (!response?.ok) return reject(new Error(response?.error ?? 'عملیات تماس ناموفق بود'));
      resolve(response);
    });
  });
}

function reasonText(payload, info) {
  switch (payload?.reason) {
    case 'rejected': return 'طرف مقابل تماس را رد کرد';
    case 'cancelled': return 'تماس‌گیرنده منصرف شد';
    case 'timeout': return 'پاسخی داده نشد';
    case 'hangup': return info?.kind === 'group' ? 'این تماس گروهی پایان یافت' : 'تماس پایان یافت';
    case 'participant-left': return 'طرف مقابل تماس را ترک کرد';
    case 'unavailable': return 'کاربر در دسترس نبود';
    case 'busy': return 'کاربر در تماس دیگری است';
    case 'caller-disconnected':
    case 'disconnected': return 'اتصال طرف تماس قطع شد';
    case 'empty': return 'همهٔ اعضا تماس را ترک کردند';
    case 'max-duration': return 'مدت مجاز این تماس به پایان رسید';
    case 'shutdown': return 'سرور تماس را بست';
    case 'failed': return 'تماس با خطا مواجه شد';
    default: return 'تماس پایان یافت';
  }
}

/**
 * Mobile call lifecycle.
 *
 * Mobile has no MLS client state, so it cannot derive the media key an encrypted
 * web call uses. Rather than join such a call without encryption, this provider
 * rejects it and says why. Plaintext chats can call, and the UI labels those
 * calls as lacking end-to-end encryption.
 */
export function CallProvider({ children }) {
  const { currentUser } = useAuth();
  const { socket, connected } = useSocket();
  const stateRef = useRef(INITIAL);
  const [, setVersion] = useState(0);
  const currentUserRef = useRef(currentUser);
  const endTimerRef = useRef(null);
  const ringTimerRef = useRef(null);
  const endingRef = useRef(false);

  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  const apply = useCallback((patch) => {
    const next = typeof patch === 'function' ? patch(stateRef.current) : patch;
    stateRef.current = { ...stateRef.current, ...next };
    setVersion((value) => value + 1);
  }, []);

  const clearEndTimer = useCallback(() => {
    clearTimeout(endTimerRef.current);
    endTimerRef.current = null;
  }, []);

  const clearRing = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearEndTimer();
    clearRing();
    endingRef.current = false;
    apply({ ...INITIAL });
  }, [apply, clearEndTimer, clearRing]);

  const scheduleReset = useCallback((ms = 3400) => {
    clearEndTimer();
    endTimerRef.current = setTimeout(() => {
      if (stateRef.current.phase === 'ended') reset();
    }, ms);
  }, [clearEndTimer, reset]);

  const finish = useCallback((text, { isError = false, ms = 3400 } = {}) => {
    clearRing();
    apply({
      phase: 'ended',
      token: null,
      url: null,
      notice: text,
      error: isError ? text : '',
    });
    scheduleReset(ms);
  }, [apply, clearRing, scheduleReset]);

  const fail = useCallback((text) => {
    const info = stateRef.current.info;
    if (info?.callId && socket?.connected) socket.emit('call:end', { callId: info.callId });
    endingRef.current = true;
    finish(text, { isError: true, ms: 3800 });
  }, [finish, socket]);

  // A local backstop for a ring whose server event was lost. It uses the same
  // 60s ceiling as the web client; the server's 45s timer normally wins.
  const armRing = useCallback(() => {
    clearRing();
    ringTimerRef.current = setTimeout(() => {
      const current = stateRef.current;
      if (current.phase !== 'incoming' && current.phase !== 'outgoing') return;
      const callId = current.info?.callId;
      if (callId && socket?.connected) {
        socket.emit(current.phase === 'incoming' ? 'call:reject' : 'call:cancel', { callId });
      }
      finish('پاسخی داده نشد', { ms: 2800 });
    }, 60000);
  }, [clearRing, finish, socket]);

  const join = useCallback(async (info) => {
    const issued = await fetchCallToken(info.callId, { client: 'mobile' });
    if (issued?.e2ee) {
      throw new Error('این تماس رمزنگاری‌شده است و نسخهٔ موبایل کلید آن را ندارد');
    }
    apply({ phase: 'active', token: issued.token, url: issued.url, error: '', notice: '' });
  }, [apply]);

  // ── Socket events ─────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return undefined;

    const onIncoming = (payload) => {
      if (!payload?.callId) return;
      if (payload.e2ee === true) {
        // Fail closed: no MLS key exists on this build, so this call must not
        // become a plaintext one behind the caller's back.
        socket.emit('call:reject', { callId: payload.callId });
        if (ACTIVE_PHASES.has(stateRef.current.phase)) return;
        Alert.alert(
          'تماس رمزنگاری‌شده',
          'این تماس سرتاسری رمزنگاری شده است، اما نسخهٔ موبایل هنوز کلید آن را ندارد. برای حفظ امنیت، تماس رد شد. از نسخهٔ وب پاسخ دهید.',
        );
        return;
      }
      if (ACTIVE_PHASES.has(stateRef.current.phase)) {
        socket.emit('call:reject', { callId: payload.callId });
        return;
      }

      const kind = payload.kind === 'group' ? 'group' : 'direct';
      const info = {
        callId: payload.callId,
        conversationId: payload.conversationId ?? null,
        type: payload.type === 'video' ? 'video' : 'audio',
        kind,
        peer: kind === 'direct' ? (payload.from ?? null) : null,
        from: payload.from ?? null,
        group: kind === 'group' ? (payload.group ?? null) : null,
        e2ee: false,
      };
      clearEndTimer();
      apply({ phase: 'incoming', info, token: null, url: null, error: '', notice: '' });
      armRing();
    };

    const onAccepted = async (payload) => {
      const current = stateRef.current;
      const info = current.info;
      if (!info || payload?.callId !== info.callId) return;
      clearRing();

      if (info.kind === 'direct') {
        if (payload.userId === currentUserRef.current?.id) return;
        if (current.phase !== 'outgoing') return;
      } else if (payload.userId === currentUserRef.current?.id) {
        if (current.phase === 'incoming') {
          finish('این تماس در دستگاه دیگری پاسخ داده شد', { ms: 2600 });
        }
        return;
      } else if (current.phase !== 'outgoing') {
        return;
      }

      try {
        await join(info);
      } catch (error) {
        fail(error.message ?? 'ورود به اتاق تماس ناموفق بود');
      }
    };

    const onEnded = (payload) => {
      const info = stateRef.current.info;
      if (!info || payload?.callId !== info.callId) return;
      if (stateRef.current.phase === 'idle' || stateRef.current.phase === 'ended') return;
      endingRef.current = true;
      finish(reasonText(payload, info));
    };

    const onLeft = (payload) => {
      const info = stateRef.current.info;
      if (!info || payload?.callId !== info.callId) return;
      if (payload.userId === currentUserRef.current?.id) {
        if (stateRef.current.phase !== 'idle' && stateRef.current.phase !== 'ended') {
          finish('این تماس در دستگاه دیگری قطع شد', { ms: 2600 });
        }
      }
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:ended', onEnded);
    socket.on('call:participant-left', onLeft);

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:ended', onEnded);
      socket.off('call:participant-left', onLeft);

      const info = stateRef.current.info;
      if (info?.callId && ACTIVE_PHASES.has(stateRef.current.phase) && socket.connected) {
        socket.emit('call:end', { callId: info.callId });
      }
      clearEndTimer();
      clearRing();
    };
  }, [socket, apply, armRing, clearEndTimer, clearRing, fail, finish, join]);

  // If signaling stays away, the media room must not outlive the authorization
  // path that created it. A short grace matches the web client.
  useEffect(() => {
    if (connected || !ACTIVE_PHASES.has(stateRef.current.phase)) return undefined;
    const timer = setTimeout(() => {
      if (!connected && ACTIVE_PHASES.has(stateRef.current.phase)) {
        fail('اتصال به سرور قطع شد؛ تماس بسته شد');
      }
    }, 12000);
    return () => clearTimeout(timer);
  }, [connected, fail]);

  // ── Actions ───────────────────────────────────────────────────

  const startCall = useCallback(async (chat, type) => {
    if (!chat || (type !== 'audio' && type !== 'video')) return;
    if (stateRef.current.phase !== 'idle') return;
    if (chat.encrypted === true) {
      Alert.alert(
        'تماس رمزنگاری‌شده',
        'این گفتگو سرتاسری رمزنگاری شده است و نسخهٔ موبایل هنوز کلید تماس را ندارد. برای حفظ امنیت، تماس از موبایل آغاز نمی‌شود؛ از نسخهٔ وب تماس بگیرید.',
      );
      return;
    }
    if (!socket?.connected) {
      Alert.alert('اتصال برقرار نیست', 'برای تماس باید به سرور متصل باشید.');
      return;
    }

    let callId;
    try {
      callId = Crypto.randomUUID();
    } catch {
      Alert.alert('خطا', 'ساخت شناسهٔ تماس در این دستگاه ممکن نشد.');
      return;
    }

    const kind = chat.kind === 'group' ? 'group' : 'direct';
    const info = {
      callId,
      conversationId: kind === 'group' ? chat.id : null,
      type,
      kind,
      peer: kind === 'direct' ? chat : null,
      group: kind === 'group' ? chat : null,
      e2ee: false,
    };

    clearEndTimer();
    endingRef.current = false;
    apply({ phase: 'outgoing', info, token: null, url: null, error: '', notice: '' });
    armRing();

    try {
      const payload = kind === 'group'
        ? { callId, conversationId: chat.id, type }
        : { callId, toId: chat.id, type };
      const ack = await emitAck(socket, kind === 'group' ? 'call:group-start' : 'call:invite', payload, 15000);
      if (ack.e2ee === true) {
        throw new Error('این گفتگو روی سرور رمزنگاری‌شده است؛ تماس موبایل ممکن نیست');
      }
      apply({ info: { ...info, conversationId: ack.conversationId ?? info.conversationId } });
    } catch (error) {
      if (socket.connected && stateRef.current.info?.callId) {
        socket.emit('call:end', { callId: stateRef.current.info.callId });
      }
      finish(error.message ?? 'شروع تماس ناموفق بود', { isError: true });
    }
  }, [apply, armRing, clearEndTimer, finish, socket]);

  const acceptCall = useCallback(async () => {
    const current = stateRef.current;
    const info = current.info;
    if (!info || current.phase !== 'incoming') return;
    if (info.e2ee === true) {
      socket?.emit('call:reject', { callId: info.callId });
      reset();
      return;
    }
    if (!socket?.connected) {
      fail('اتصال به سرور برقرار نیست');
      return;
    }

    apply({ phase: 'connecting', error: '', notice: '' });
    clearRing();
    try {
      await emitAck(socket, 'call:accept', { callId: info.callId });
      await join(info);
    } catch (error) {
      fail(error.message ?? 'پاسخ به تماس ناموفق بود');
    }
  }, [apply, clearRing, fail, join, reset, socket]);

  const rejectCall = useCallback(() => {
    const info = stateRef.current.info;
    if (info?.callId) socket?.emit('call:reject', { callId: info.callId });
    reset();
  }, [reset, socket]);

  const cancelCall = useCallback(() => {
    const info = stateRef.current.info;
    if (info?.callId) socket?.emit('call:cancel', { callId: info.callId });
    reset();
  }, [reset, socket]);

  const hangUp = useCallback(() => {
    const info = stateRef.current.info;
    if (info?.callId) socket?.emit('call:end', { callId: info.callId });
    endingRef.current = true;
    reset();
  }, [reset, socket]);

  const value = {
    ...stateRef.current,
    connected,
    startCall,
    acceptCall,
    rejectCall,
    cancelCall,
    hangUp,
    fail,
    dismiss: reset,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

const IDLE_CALL = {
  ...INITIAL,
  connected: false,
  startCall: () => {},
  acceptCall: () => {},
  rejectCall: () => {},
  cancelCall: () => {},
  hangUp: () => {},
  fail: () => {},
  dismiss: () => {},
};

export function useCall() {
  // A screen can be rendered outside the provider in isolation (tests, or a
  // future preview surface). Calls are simply unavailable there.
  return useContext(CallContext) ?? IDLE_CALL;
}
