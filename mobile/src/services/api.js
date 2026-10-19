import { storage } from './storage';

// EXPO_PUBLIC_-prefixed vars are inlined at build time (same idea as Vite's
// VITE_ prefix on the web app). Set this in mobile/.env — see .env.example.
const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api';

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
  return path.startsWith('http') ? path : `${ORIGIN}${path}`;
}

// Converts a backend user record ({ username, online, ... }) to the app's user shape
export function normalizeUser(u) {
  if (!u) return null;
  return {
    id:        u.id,
    name:      u.username,
    avatar:    resolveUrl(u.avatar),
    bio:       u.bio ?? '',
    status:    u.online ? 'online' : 'offline',
    createdAt: u.createdAt,
    unread:    0,
  };
}

async function authHeaders() {
  const token = await storage.getToken();
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    await storage.removeToken();
    await storage.removeUser();
    unauthorizedHandler?.();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

// ── Auth ─────────────────────────────────────────────
export async function register(username, password) {
  const { user, token } = await request('POST', '/auth/register', { username, password });
  await storage.setToken(token);
  return user;
}

export async function login(username, password) {
  const { user, token } = await request('POST', '/auth/login', { username, password });
  await storage.setToken(token);
  return user;
}

export async function logout() {
  await storage.removeToken();
  await storage.removeUser();
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

// People the current user has actually chatted with — new accounts get an
// empty list; conversations are started on demand via username search.
export function fetchConversations() {
  return request('GET', '/messages/conversations');
}

// ── Upload (wired up in Phase 6) ───────────────────────
export async function uploadFile(file) {
  // file: { uri, name, type } — the shape expo-image-picker/document-picker return.
  const form = new FormData();
  form.append('file', file);
  const token = await storage.getToken();
  const res = await fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status === 401) {
    await storage.removeToken();
    await storage.removeUser();
    unauthorizedHandler?.();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'آپلود ناموفق');
  return data;
}
