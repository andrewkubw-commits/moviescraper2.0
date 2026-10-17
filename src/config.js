'use strict';

require('dotenv').config();

const path = require('path');

const S9 = 'hdsdgfudekwoqmdzonasdiowm23r4egtynh';

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  API_BASE: 'https://api.rebamovie.com',
  // Client-side AES key used by the site for /downloadData (truncated/padded to 32 bytes)
  AES_KEY: S9.length > 32 ? S9.slice(0, 32) : S9.padEnd(32, '0'),

  // Content versions: en (original) + rn (Kinyarwanda / default locale)
  LANGS: ['en', 'rn'],
  DEFAULT_LANG: 'rn',

  DEVICE_TYPE: 'IOS',
  ANON_USER_ID: 'anonymous',
  PAGE_SIZE: 49,

  // The "locked" flag is client-side only: the API returns real sources for locked
  // titles anonymously. Set SKIP_LOCKED=true only if you *want* to ignore them.
  SKIP_LOCKED: String(process.env.SKIP_LOCKED).toLowerCase() === 'true',

  CONCURRENCY: int(process.env.CONCURRENCY, 4),
  VIDEO_BATCH: int(process.env.VIDEO_BATCH, 250),
  REQUEST_TIMEOUT: int(process.env.REQUEST_TIMEOUT, 30000),
  MAX_RETRIES: int(process.env.MAX_RETRIES, 4),
  RETRY_BASE_MS: int(process.env.RETRY_BASE_MS, 800),

  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',

  DATA_DIR: path.join(__dirname, '..', 'data'),
};
