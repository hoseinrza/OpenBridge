import { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_URL } from '../services/api';
import { storage } from '../services/storage';
import { useAuth } from './AuthContext';

const SocketContext = createContext({ socket: null, connected: false });

// One connection for the whole signed-in app so messages keep arriving while
// the user is on the conversation list (not only inside a single chat).
export function SocketProvider({ children }) {
  const { currentUser } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!currentUser) {
      setSocket(null);
      setConnected(false);
      return undefined;
    }

    let cancelled = false;
    let sock;

    storage.getToken().then((token) => {
      if (cancelled || !token) return;

      sock = io(SOCKET_URL, {
        auth:    { token },
        timeout: 10000,
        // Fall back to HTTP polling if the network/proxy blocks WebSocket.
      });
      sock.on('connect',       () => setConnected(true));
      sock.on('disconnect',    () => setConnected(false));
      sock.on('connect_error', () => setConnected(false));
      setSocket(sock);
    });

    return () => {
      cancelled = true;
      sock?.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [currentUser?.id]);

  return (
    <SocketContext.Provider value={{ socket, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
