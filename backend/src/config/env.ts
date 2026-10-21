import { config } from 'dotenv';

// Nest does not load .env on its own. Load it here, before any module reads
// process.env, so local development and the production process (which gets
// real environment variables from Docker) behave the same way.
config();

export const NODE_ENV = process.env.NODE_ENV?.trim() || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const JWT_SECRET = required('JWT_SECRET');
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN?.trim() || '7d';

if (IS_PRODUCTION && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

// Express `trust proxy` setting. Set to the number of proxies in front of the
// API (for example 1 behind nginx/Render) so rate limiting sees client IPs
// instead of the proxy address.
export const TRUST_PROXY: number | false = (() => {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === '0' || raw === 'false') return false;
  if (raw === 'true') return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1) throw new Error('TRUST_PROXY must be a positive integer, true, or false');
  return hops;
})();

// Phone OTP auth. There is no SMS provider yet, so outside production the
// code is returned in the response for local testing and requestOtp refuses
// to issue codes at all in production. Once a provider is wired up, remove
// the test-mode branch and send the code through the provider instead.
export const OTP_TEST_MODE = !IS_PRODUCTION;
export const OTP_TTL_SECONDS = positiveInt('OTP_TTL_SECONDS', 300);
export const OTP_MAX_ATTEMPTS = positiveInt('OTP_MAX_ATTEMPTS', 5);

// Auth throttling: per-IP and per-phone fixed windows, reset on restart.
export const AUTH_OTP_REQUEST_LIMIT = positiveInt('AUTH_OTP_REQUEST_LIMIT', 5);
export const AUTH_OTP_REQUEST_PHONE_LIMIT = positiveInt('AUTH_OTP_REQUEST_PHONE_LIMIT', 3);
export const AUTH_OTP_VERIFY_LIMIT = positiveInt('AUTH_OTP_VERIFY_LIMIT', 10);
export const AUTH_SIGNUP_LIMIT = positiveInt('AUTH_SIGNUP_LIMIT', 10);
export const AUTH_OTP_WINDOW_SECONDS = positiveInt('AUTH_OTP_WINDOW_SECONDS', 600);

// A verified phone number gets this much time to finish the sign-up steps.
export const SIGNUP_TOKEN_TTL_SECONDS = positiveInt('SIGNUP_TOKEN_TTL_SECONDS', 900);

// Contact sync: one request can carry a whole address book, so the list length
// is capped, and the endpoint is rate limited per IP because any "does this
// number have an account?" route is an enumeration target.
export const CONTACT_MATCH_MAX_PHONES = positiveInt('CONTACT_MATCH_MAX_PHONES', 500);
export const CONTACT_MATCH_LIMIT = positiveInt('CONTACT_MATCH_LIMIT', 20);
export const CONTACT_MATCH_WINDOW_SECONDS = positiveInt('CONTACT_MATCH_WINDOW_SECONDS', 900);

// Refresh tokens are opaque and rotate on every use. Sessions expire after
// this many days regardless of activity.
export const REFRESH_TOKEN_TTL_DAYS = positiveInt('REFRESH_TOKEN_TTL_DAYS', 30);

// E2EE device registration and the public KeyPackage pool. The server only ever
// stores opaque public blobs, so the caps exist to bound storage and to keep
// the bundle endpoint from being used as a free data store.
export const E2EE_MAX_DEVICES_PER_USER = positiveInt('E2EE_MAX_DEVICES_PER_USER', 10);
export const E2EE_MAX_PACKAGES_PER_UPLOAD = positiveInt('E2EE_MAX_PACKAGES_PER_UPLOAD', 50);
export const E2EE_MAX_PACKAGES_PER_DEVICE = positiveInt('E2EE_MAX_PACKAGES_PER_DEVICE', 200);
// A suite-1 MLS KeyPackage is a few hundred bytes; base64 adds a third. The cap
// is generous but stops the pool from storing arbitrary payloads.
export const E2EE_MAX_PACKAGE_CHARS = positiveInt('E2EE_MAX_PACKAGE_CHARS', 4096);
// Handing out a KeyPackage tells the caller that the account has a registered
// device, so the endpoint is rate limited per IP like the other enumeration
// surfaces. Opening an encrypted group claims one package per device of every
// member, so the window has to cover a whole group, not just a single chat.
export const E2EE_CLAIM_LIMIT = positiveInt('E2EE_CLAIM_LIMIT', 40);
export const E2EE_CLAIM_WINDOW_SECONDS = positiveInt('E2EE_CLAIM_WINDOW_SECONDS', 60);

// An encrypted group carries every member's devices inside the Welcome that
// opens it, and one Welcome has to fit E2EE_MAX_ENVELOPE_CHARS. Measured with
// the pure provider: about 470 base64 characters per device plus ~600 of
// framing, so 16 members stays comfortably under the cap even when some of them
// have several devices. The client refuses a group whose device total would push
// the Welcome over the envelope limit before it asks the server for one.
export const E2EE_MAX_GROUP_MEMBERS = positiveInt('E2EE_MAX_GROUP_MEMBERS', 16);

// Transport for encrypted conversations: one MLS message per envelope, carried
// as base64. The cap is the existing 4000-character plaintext limit plus MLS
// framing and headroom, and it stays well under the socket packet ceiling so a
// client cannot make the delivery service buffer megabytes per message.
export const E2EE_MAX_ENVELOPE_CHARS = positiveInt('E2EE_MAX_ENVELOPE_CHARS', 16384);
// How many envelopes a reconnecting client may pull in one catch-up page.
export const E2EE_ENVELOPE_PAGE = positiveInt('E2EE_ENVELOPE_PAGE', 200);
export const E2EE_REGISTER_LIMIT = positiveInt('E2EE_REGISTER_LIMIT', 30);
export const E2EE_REGISTER_WINDOW_SECONDS = positiveInt('E2EE_REGISTER_WINDOW_SECONDS', 600);

// Comma-separated list of browser origins allowed to call the HTTP API and
// the Socket.IO endpoint. Native apps and same-origin requests send no Origin
// header and are always allowed. When unset in development we allow only
// localhost/private-LAN origins; in production no cross-origin access is
// allowed unless explicitly configured.
const DEV_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
];

const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

export function isOriginAllowed(origin?: string | null): boolean {
  if (!origin) return true;
  if (configuredOrigins.length) return configuredOrigins.includes(origin);
  if (IS_PRODUCTION) return false;
  return DEV_ORIGIN_PATTERNS.some(pattern => pattern.test(origin));
}
