'use strict';

const { createClient } = require('@supabase/supabase-js');
const cfg = require('./config');

const enabled = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_KEY);

function assertConfig() {
  if (!cfg.SUPABASE_URL) throw new Error('SUPABASE_URL is empty');
  if (!/^https?:\/\//i.test(cfg.SUPABASE_URL)) {
    throw new Error(`SUPABASE_URL must start with https:// (got "${cfg.SUPABASE_URL.slice(0, 20)}...")`);
  }
  if (!cfg.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is empty');
  if (/\s/.test(cfg.SUPABASE_SERVICE_KEY)) {
    throw new Error('SUPABASE_SERVICE_KEY contains whitespace/newline — re-paste the secret cleanly');
  }
}

const supabase = enabled
  ? (() => {
      assertConfig();
      return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    })()
  : null;

function client() {
  if (!supabase) {
    throw new Error(
      'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (see .env.example).'
    );
  }
  return supabase;
}

function describeError(err) {
  const cause = err?.cause;
  const extra = cause ? ` [cause: ${cause.code || cause.name || 'err'}: ${cause.message}]` : '';
  return `${err?.message || String(err)}${extra}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry network-level failures (supabase-js throws on fetch errors; HTTP errors come back as {error}).
async function withRetry(label, fn, retries = cfg.MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  throw new Error(`${label}: ${describeError(lastErr)}`);
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function ping() {
  const res = await withRetry('ping', () =>
    client().from('movies').select('uid', { count: 'exact', head: true })
  );
  if (res.error) throw new Error(`HTTP ${res.status || ''} ${res.error.message}`.trim());
  return { ok: true, url: cfg.SUPABASE_URL, count: res.count ?? null };
}

async function getState(key) {
  const { data, error } = await withRetry('getState', () =>
    client().from('scrape_state').select('value').eq('key', key).maybeSingle()
  );
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

async function setState(key, value) {
  const { error } = await withRetry('setState', () =>
    client()
      .from('scrape_state')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  );
  if (error) throw new Error(error.message);
}

async function getExistingSourceIds(languageCode) {
  const ids = new Set();
  const size = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await withRetry('getExistingSourceIds', () =>
      client().from('movies').select('source_id').eq('language_code', languageCode).range(from, from + size - 1)
    );
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(row.source_id);
    if (data.length < size) break;
    from += size;
  }
  return ids;
}

async function syncRows(rows, hashField) {
  if (rows.length === 0) return { written: 0, skipped: 0 };
  const existing = new Map();
  for (const part of chunk(rows.map((r) => r.uid), 500)) {
    const { data, error } = await withRetry('syncRows.select', () =>
      client().from('movies').select(`uid,${hashField}`).in('uid', part)
    );
    if (error) throw new Error(error.message);
    for (const row of data || []) existing.set(row.uid, row[hashField]);
  }

  const changed = rows.filter((r) => existing.get(r.uid) !== r[hashField]);
  const now = new Date().toISOString();
  let written = 0;
  for (const part of chunk(changed, 500)) {
    const payload = part.map((r) => ({ ...r, updated_at: now }));
    const { error } = await withRetry('syncRows.upsert', () =>
      client().from('movies').upsert(payload, { onConflict: 'uid' })
    );
    if (error) throw new Error(error.message);
    written += payload.length;
  }
  return { written, skipped: rows.length - written };
}

async function getPendingMovies(limit) {
  const { data, error } = await withRetry('getPendingMovies', () =>
    client()
      .from('movies')
      .select('uid,source_id,language_code,title')
      .eq('video_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit)
  );
  if (error) throw new Error(error.message);
  return data || [];
}

async function countByStatus(status) {
  const { count, error } = await withRetry('countByStatus', () =>
    client().from('movies').select('uid', { count: 'exact', head: true }).eq('video_status', status)
  );
  if (error) throw new Error(error.message);
  return count || 0;
}

async function countMovies() {
  const { count, error } = await withRetry('countMovies', () =>
    client().from('movies').select('uid', { count: 'exact', head: true })
  );
  if (error) throw new Error(error.message);
  return count || 0;
}

module.exports = {
  enabled,
  client,
  chunk,
  describeError,
  ping,
  getState,
  setState,
  getExistingSourceIds,
  syncRows,
  getPendingMovies,
  countByStatus,
  countMovies,
};
