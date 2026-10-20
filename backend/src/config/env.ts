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

// Auth throttling: per-IP and per-username fixed windows, reset on restart.
export const AUTH_LOGIN_LIMIT = positiveInt('AUTH_LOGIN_LIMIT', 10);
export const AUTH_LOGIN_USERNAME_LIMIT = positiveInt('AUTH_LOGIN_USERNAME_LIMIT', 5);
export const AUTH_LOGIN_WINDOW_SECONDS = positiveInt('AUTH_LOGIN_WINDOW_SECONDS', 900);
export const AUTH_REGISTER_LIMIT = positiveInt('AUTH_REGISTER_LIMIT', 5);
export const AUTH_REGISTER_WINDOW_SECONDS = positiveInt('AUTH_REGISTER_WINDOW_SECONDS', 3600);

// Refresh tokens are opaque and rotate on every use. Sessions expire after
// this many days regardless of activity.
export const REFRESH_TOKEN_TTL_DAYS = positiveInt('REFRESH_TOKEN_TTL_DAYS', 30);

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
