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

// postgrest-js swallows undici network errors into { error: { message: 'TypeError: fetch failed' } }
// instead of throwing, so we must detect them by message and retry/treat as transient.
const TRANSIENT_RE =
  /fetch failed|network|socket hang up|other side closed|terminated|aborted|und_err|econnreset|econnrefused|etimedout|enotfound|eai_again|bad gateway|gateway time|service unavailable|too many requests|payload too large|uri too long|request entity too large|premature close/i;

async function withRetry(label, fn, retries = cfg.MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fn();
      const msg = res?.error?.message;
      if (msg && TRANSIENT_RE.test(msg)) throw new Error(msg);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  throw new Error(`${label}: ${describeError(lastErr)}`);
}

// Max items per `.in()` filter and per upsert batch. Keeps request URLs well under
// Cloudflare's ~16KB limit and request bodies well under Supabase's payload limit.
const IN_CHUNK = 100;
const UPSERT_CHUNK = 200;

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
  for (const part of chunk(rows.map((r) => r.uid), IN_CHUNK)) {
    const { data, error } = await withRetry('syncRows.select', () =>
      client().from('movies').select(`uid,${hashField}`).in('uid', part)
    );
    if (error) throw new Error(error.message);
    for (const row of data || []) existing.set(row.uid, row[hashField]);
  }

  const changed = rows.filter((r) => existing.get(r.uid) !== r[hashField]);
  const now = new Date().toISOString();
  let written = 0;
  for (const part of chunk(changed, UPSERT_CHUNK)) {
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

// Raw-fetch probe using the global error (incl. err.cause) that postgrest-js hides.
// Reproduces the `.in()` query shapes so we can see exactly which request size breaks.
async function diagnose() {
  const base = cfg.SUPABASE_URL.replace(/\/+$/, '');
  const key = cfg.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const uuid = '00000000-0000-0000-0000-000000000000';
  const cases = [
    ['GET select=uid&limit=1', `${base}/rest/v1/movies?select=uid&limit=1`],
    ['GET in(50)', `${base}/rest/v1/movies?select=uid&uid=in.(${Array(50).fill(uuid).join(',')})`],
    ['GET in(500)', `${base}/rest/v1/movies?select=uid&uid=in.(${Array(500).fill(uuid).join(',')})`],
    ['DELETE noop (write path)', `${base}/rest/v1/movies?uid=eq.__diagnostic_probe__`],
  ];
  for (const [label, url] of cases) {
    const method = label.startsWith('DELETE') ? 'DELETE' : 'GET';
    try {
      const r = await fetch(url, { method, headers: { ...headers, Prefer: 'return=minimal' } });
      const text = await r.text();
      console.log(`  ${label}: ${r.status} url_len=${url.length}${text ? ` body=${text.slice(0, 120)}` : ''}`);
    } catch (err) {
      console.log(`  ${label}: FAILED url_len=${url.length} -> ${describeError(err)}`);
    }
  }
}

module.exports = {
  enabled,
  client,
  chunk,
  describeError,
  ping,
  diagnose,
  getState,
  setState,
  getExistingSourceIds,
  syncRows,
  getPendingMovies,
  countByStatus,
  countMovies,
};
