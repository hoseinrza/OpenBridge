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
