const BASE = import.meta.env.VITE_API_URL ?? 'https://openbridge-api.onrender.com/api';

const ORIGIN = BASE.replace(/\/api\/?$/, '');

// Resolves a relative backend path (e.g. "/uploads/x.png") to an absolute URL
export function resolveUrl(path) {
  if (!path) return path;
  return path.startsWith('http') ? path : `${ORIGIN}${path}`;
}

// Converts a backend user record ({ username, online, ... }) to the frontend's user shape
export function normalizeUser(u) {
  return {
    id:        u.id,
    name:      u.username,
    avatar:    u.avatar || '/images/user.png',
    bio:       u.bio ?? '',
    status:    u.online ? 'online' : 'offline',
    createdAt: u.createdAt,
    unread:    0,
  };
}

function token() { return localStorage.getItem('chatapp_token') ?? ''; }

function auth() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` };
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: auth(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

// ── Auth ─────────────────────────────────────────────
export async function register(username, password) {
  const { user, token: t } = await request('POST', '/auth/register', { username, password });
  localStorage.setItem('chatapp_token', t);
  return user;
}

export async function login(username, password) {
  const { user, token: t } = await request('POST', '/auth/login', { username, password });
  localStorage.setItem('chatapp_token', t);
  return user;
}

export function logout() {
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_user');
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

// ── Upload ────────────────────────────────────────────
export async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'آپلود ناموفق');
  return data; // { url, name, size, type }
}
