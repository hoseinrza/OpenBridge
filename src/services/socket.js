import { io } from 'socket.io-client';

// Empty/relative → same-origin (nginx reverse-proxies /socket.io to the API).
export const SOCKET_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/api\/?$/, '') || undefined;

// One shape of connection for every consumer in the app. The token is read on
// each (re)connect so a rotated access token is used instead of the one
// captured at mount, and Socket.IO may fall back to HTTP polling when
// WebSocket is blocked (some mobile networks and outer proxies do that).
export function connectSocket() {
  return io(SOCKET_URL, {
    auth: (callback) => callback({ token: localStorage.getItem('chatapp_token') ?? '' }),
    timeout: 10000,
  });
}

/** Emit and wait for the server's ack, so "sent" means the server took it. */
export function emitWithAck(socket, event, payload, timeout = 12000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (err, response) => {
      if (err) return reject(new Error('پاسخی از سرور دریافت نشد؛ اتصال را بررسی کن'));
      if (!response?.ok) return reject(new Error(response?.error ?? 'ارسال ناموفق بود'));
      resolve(response);
    });
  });
}
