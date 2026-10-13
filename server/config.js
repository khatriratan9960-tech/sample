/**
 * Central configuration. Every value can be overridden by a .env file.
 * Copy .env.example to .env and edit.
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
  dbName: process.env.DB_NAME || 'dpboss',
  // Per-instance connection pool cap. Serverless instances each hold their
  // own pool, so keep it small (Vercel + Atlas free tier friendly).
  mongoMaxPool: Number(process.env.MONGO_MAX_POOL || 10),

  // In production a real JWT secret is REQUIRED. In dev we generate a
  // random one per boot so tokens never survive a restart.
  jwtSecret: process.env.JWT_SECRET || (isProd ? '' : crypto.randomBytes(32).toString('hex')),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  // Bootstrap admin, created on first run only.
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  // Upstream paid result API. Leave blank to run on mock data.
  provider: {
    baseUrl: process.env.PROVIDER_BASE_URL || '',
    apiKey: process.env.PROVIDER_API_KEY || '',
    // Poll interval for syncing upstream results.
    syncMs: Number(process.env.PROVIDER_SYNC_MS || 5 * 60 * 1000),
    // Keep well under Vercel's ~10s hobby-function limit so a slow upstream
    // fails fast instead of timing out the whole invocation (which the
    // frontend would show as endless "Loading...").
    timeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS || 7000),
  },

  // Matka trial (matkaapi.com). Trial keys are domain-locked: the upstream
  // only answers when we send the exact registered domain alongside the key.
  // Defaults below are YOUR trial credentials for clone-git-main-ratan18,
  // so Vercel works right after `git push` with zero env setup. Override
  // with MATKA_DOMAIN_KEY / MATKA_DOMAIN env vars when the key is renewed.
  matka: {
    domainKey: process.env.MATKA_DOMAIN_KEY || '5e3ccd445deac2c892fb84a7a9988340',
    domain: process.env.MATKA_DOMAIN || 'clone-git-main-ratan18.vercel.app',
    baseUrl: process.env.MATKA_BASE_URL || 'https://www.matkaapi.com/mapi',
    cacheMs: Number(process.env.MATKA_CACHE_MS || 45_000),
    timeoutMs: Number(process.env.MATKA_TIMEOUT_MS || process.env.PROVIDER_TIMEOUT_MS || 7000),
  },
};

if (isProd && !config.jwtSecret) {
  // Do NOT throw here: on Vercel an import-time throw turns EVERY /api/*
  // route (including /api/health) into an opaque 500 with no message.
  // Instead the API boots, /api/health reports the missing vars as JSON,
  // and only auth routes refuse to work until JWT_SECRET is set.
  console.error('[config] JWT_SECRET must be set in production - auth routes will fail until it is');
}

/** Missing required env vars (production only). Empty = ready to serve. */
export function missingEnv() {
  if (!isProd) return [];
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.MONGO_URL) missing.push('MONGO_URL (defaults to localhost, unreachable from Vercel)');
  return missing;
}
