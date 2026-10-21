const BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');

const ORIGIN = BASE.replace(/\/api\/?$/, '');

// Resolves a relative backend path to an absolute URL. Uploads live behind
// the authenticated API prefix, so they resolve against BASE rather than the
// bare origin.
export function resolveUrl(path) {
  if (!path) return path;
  if (path.startsWith('http')) return path;
  if (path.startsWith('/uploads/')) return `${BASE}${path.slice('/uploads'.length)}`;
  return `${ORIGIN}${path}`;
}

// Strips the API origin/query from a (signed) upload URL so it can be stored
// in the database as a plain "/uploads/<file>" path.
export function uploadPath(url) {
  if (!url) return url;
  const match = url.split('?')[0].match(/\/uploads\/[A-Za-z0-9._-]+$/);
  return match ? match[0] : url;
}

// Converts a backend user record ({ username, displayName, online, ... }) to the frontend's user shape
export function normalizeUser(u) {
  if (!u) return null;
  return {
    kind:      'user',
    id:        u.id,
    name:      u.displayName || u.username,
    username:  u.username,
    // No avatar means the UI renders the user's initials instead of a stock image.
    avatar:    u.avatar || null,
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
      avatar: user.avatar || null,
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
function refreshToken() { return localStorage.getItem('chatapp_refresh') ?? ''; }

function auth() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` };
}

function storeSession(data) {
  const accessToken = data.token ?? data.accessToken;
  if (accessToken) localStorage.setItem('chatapp_token', accessToken);
  if (data.refreshToken) localStorage.setItem('chatapp_refresh', data.refreshToken);
}

function clearSession() {
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_refresh');
  localStorage.removeItem('chatapp_user');
}

function handleUnauthorized(path) {
  if (path.startsWith('/auth/')) return;
  clearSession();
  window.location.reload();
}

let refreshPromise = null;

// Single-flight refresh: concurrent 401s share one rotation, otherwise the
// second request would present a token that was already rotated.
function refreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const current = refreshToken();
    if (!current) throw new Error('no refresh token');
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? 'نشست منقضی شده');
    storeSession(data);
    return data;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function request(method, path, body, retry = true) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: auth(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
      return request(method, path, body, false);
    } catch {
      handleUnauthorized(path);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message ?? `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// The MLS client core is platform-agnostic, so it spells endpoints relative to
// the API root and without a leading slash ("e2ee/devices"). This is the single
// place that turns that spelling into this app's prefixed, authorised call.
export function apiCall(path, { method = 'GET', body } = {}) {
  return request(method, `/${String(path).replace(/^\/+/, '')}`, body);
}

// ── Auth ─────────────────────────────────────────────
export function requestOtp(phone) {
  return request('POST', '/auth/otp/request', { phone });
}

// A verified number either signs an existing account in or hands back a
// short-lived token for the remaining sign-up steps.
export async function verifyOtp(phone, code) {
  const data = await request('POST', '/auth/otp/verify', { phone, code });
  if (data.requiresSignup) {
    return {
      requiresSignup: true,
      signupToken: data.signupToken,
      signupExpiresInSeconds: data.signupExpiresInSeconds,
    };
  }
  storeSession(data);
  return { user: data.user };
}

export async function completeSignup(signupToken, { username, firstName, lastName }) {
  const data = await request('POST', '/auth/signup', {
    signupToken,
    username,
    firstName,
    lastName: lastName || undefined,
  });
  storeSession(data);
  return data.user;
}

export function logout() {
  // Capture the bearer before clearing storage, then revoke the session
  // server-side. The local session is cleared even if the request fails.
  const headers = auth();
  clearSession();
  fetch(`${BASE}/auth/logout`, { method: 'POST', headers }).catch(() => {});
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

// Contact sync. Only numbers the device already holds are sent; the reply maps
// input positions to accounts, so no phone number comes back from the server.
export function matchContacts(phones) {
  return request('POST', '/users/contacts/match', { phones });
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
  const send = () => fetch(`${BASE}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });

  let res = await send();
  if (res.status === 401) {
    try {
      await refreshSession();
      res = await send();
    } catch {
      handleUnauthorized('/uploads');
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'آپلود ناموفق');
  return data; // { url, name, size, type }
}
