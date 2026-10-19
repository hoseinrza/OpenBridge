const BASE = import.meta.env.VITE_API_URL ?? '/api';

const ORIGIN = BASE.replace(/\/api\/?$/, '');

// Resolves a relative backend path (e.g. "/uploads/x.png") to an absolute URL
export function resolveUrl(path) {
  if (!path) return path;
  return path.startsWith('http') ? path : `${ORIGIN}${path}`;
}

// Converts a backend user record ({ username, displayName, online, ... }) to the frontend's user shape
export function normalizeUser(u) {
  if (!u) return null;
  return {
    kind:      'user',
    id:        u.id,
    name:      u.displayName || u.username,
    username:  u.username,
    avatar:    u.avatar || '/images/user.png',
    bio:       u.bio ?? '',
    status:    u.online ? 'online' : 'offline',
    createdAt: u.createdAt,
    unread:    0,
  };
}

export function normalizeGroup(group) {
  if (!group) return null;
  // Group creation responses nest each participant as `{ user }`; the list
  // endpoint returns the user fields directly.
  const participants = (group.participants ?? []).map(p => {
    const user = p.user ?? p;
    return {
      id:     user.id,
      name:   user.displayName || user.username,
      avatar: user.avatar || '/images/user.png',
    };
  });
  return {
    kind:         'group',
    id:           group.id,
    name:         group.name || 'گروه بدون نام',
    avatar:       group.avatar || null,
    participants,
    memberCount:  participants.length,
    unread:       group.unread ?? 0,
    updatedAt:    group.updatedAt,
  };
}

function token() { return localStorage.getItem('chatapp_token') ?? ''; }

function auth() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` };
}

function handleUnauthorized(path) {
  if (path.startsWith('/auth/')) return;
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_user');
  window.location.reload();
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: auth(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) handleUnauthorized(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

// ── Auth ─────────────────────────────────────────────
export async function register(username, displayName, password) {
  const { user, token: t } = await request('POST', '/auth/register', { username, displayName, password });
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

// ── Groups ────────────────────────────────────────────
export function fetchGroups() {
  return request('GET', '/messages/groups');
}

export function createGroup(name, memberIds) {
  return request('POST', '/messages/groups', { name, memberIds });
}

export function fetchGroupMessages(conversationId, skip = 0) {
  return request('GET', `/messages/groups/${conversationId}?take=50&skip=${skip}`);
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
  if (res.status === 401) handleUnauthorized('/uploads');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'آپلود ناموفق');
  return data; // { url, name, size, type }
}
