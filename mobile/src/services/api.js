import { storage } from './storage';

// EXPO_PUBLIC_-prefixed vars are inlined at build time (same idea as Vite's
// VITE_ prefix on the web app). Set this in mobile/.env — see .env.example.
const BASE = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api').replace(/\/$/, '');

const ORIGIN = BASE.replace(/\/api\/?$/, '');

// Socket.IO runs on the API origin (not under /api) — nginx proxies
// /socket.io to the backend container.
export const SOCKET_URL = ORIGIN;

let unauthorizedHandler = null;

// AuthContext registers this so an expired/invalid token sends the user
// back to the login screen instead of leaving a silently dead session.
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

// Resolves a relative backend path (e.g. "/uploads/x.png") to an absolute
// URL — unlike the web app, RN has no same-origin relative-URL resolution.
export function resolveUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  // Private uploads are served under the API prefix with a signed URL.
  if (path.startsWith('/uploads/')) return `${BASE}${path.slice('/uploads'.length)}`;
  return `${ORIGIN}${path}`;
}

// Converts a backend user record ({ username, displayName, online, ... }) to the app's user shape
export function normalizeUser(u) {
  if (!u) return null;
  return {
    id:        u.id,
    kind:      'direct',
    name:      u.displayName || u.username,
    username:  u.username,
    avatar:    resolveUrl(u.avatar),
    bio:       u.bio ?? '',
    status:    u.online ? 'online' : 'offline',
    createdAt: u.createdAt,
    unread:    0,
  };
}

export function normalizeGroup(g) {
  if (!g) return null;
  return {
    id:           g.id,
    kind:         'group',
    name:         g.name,
    avatar:       resolveUrl(g.avatar),
    memberCount:  g.participants?.length ?? 0,
    participants: (g.participants ?? []).map(normalizeUser).filter(Boolean),
    unread:       g.unread ?? 0,
    updatedAt:    g.updatedAt,
    status:       'group',
  };
}

async function authHeaders() {
  const token = await storage.getToken();
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function storeSession(data) {
  const accessToken = data.token ?? data.accessToken;
  if (accessToken) await storage.setToken(accessToken);
  if (data.refreshToken) await storage.setRefreshToken(data.refreshToken);
}

async function clearSession() {
  await storage.removeToken();
  await storage.removeRefreshToken();
  await storage.removeUser();
}

let refreshPromise = null;

// Concurrent 401s must share one rotation; otherwise the second request
// presents a refresh token that was already replaced.
function refreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const current = await storage.getRefreshToken();
    if (!current) throw new Error('no refresh token');
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? 'نشست منقضی شده');
    await storeSession(data);
    return data;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function request(method, path, body, retry = true) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
      return request(method, path, body, false);
    } catch {
      await clearSession();
      unauthorizedHandler?.();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

// ── Auth ─────────────────────────────────────────────
export async function register(username, displayName, password) {
  const data = await request('POST', '/auth/register', { username, displayName, password });
  await storeSession(data);
  return data.user;
}

export async function login(username, password) {
  const data = await request('POST', '/auth/login', { username, password });
  await storeSession(data);
  return data.user;
}

export async function logout() {
  // Revoke server-side with the current access token, then clear locally even
  // if the network call fails.
  const token = await storage.getToken();
  await clearSession();
  if (!token) return;
  await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

// ── Users ─────────────────────────────────────────────
export function fetchUsers() {
  return request('GET', '/users');
}

export function fetchUser(id) {
  return request('GET', `/users/${id}`);
}

export function searchUsers(query) {
  return request('GET', `/users/search?q=${encodeURIComponent(query)}`);
}

export function updateProfile(data) {
  return request('PATCH', '/users/me', data);
}

// ── Messages ──────────────────────────────────────────
export function fetchMessages(targetUserId, skip = 0) {
  return request('GET', `/messages/${targetUserId}?take=50&skip=${skip}`);
}

export function fetchGroupMessages(conversationId, skip = 0) {
  return request('GET', `/messages/groups/${conversationId}?take=50&skip=${skip}`);
}

// People the current user has actually chatted with — new accounts get an
// empty list; conversations are started on demand via username search.
export function fetchConversations() {
  return request('GET', '/messages/conversations');
}

export function fetchGroups() {
  return request('GET', '/messages/groups');
}

export function createGroup(name, memberIds) {
  return request('POST', '/messages/groups', { name, memberIds });
}

// ── Upload (wired up in Phase 6) ───────────────────────
export async function uploadFile(file) {
  // file: { uri, name, type } — the shape expo-image-picker/document-picker return.
  const form = new FormData();
  form.append('file', file);
  const send = async () => fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await storage.getToken()}` },
    body: form,
  });

  let res = await send();
  if (res.status === 401) {
    try {
      await refreshSession();
      res = await send();
    } catch {
      await clearSession();
      unauthorizedHandler?.();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'آپلود ناموفق');
  return data;
}
