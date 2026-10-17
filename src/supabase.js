'use strict';

const { createClient } = require('@supabase/supabase-js');
const cfg = require('./config');

const enabled = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_KEY);
const supabase = enabled
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function client() {
  if (!supabase) {
    throw new Error(
      'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (see .env.example).'
    );
  }
  return supabase;
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function getState(key) {
  const { data, error } = await client().from('scrape_state').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

async function setState(key, value) {
  const { error } = await client()
    .from('scrape_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

// Existing source_id set for a language (used to detect "seen" pages incrementally).
async function getExistingSourceIds(languageCode) {
  const ids = new Set();
  const size = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await client()
      .from('movies')
      .select('source_id')
      .eq('language_code', languageCode)
      .range(from, from + size - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(row.source_id);
    if (data.length < size) break;
    from += size;
  }
  return ids;
}

// Upsert only rows whose hash changed. Returns { written, skipped }.
async function syncRows(rows, hashField) {
  if (rows.length === 0) return { written: 0, skipped: 0 };
  const existing = new Map();
  for (const part of chunk(rows.map((r) => r.uid), 500)) {
    const { data, error } = await client().from('movies').select(`uid,${hashField}`).in('uid', part);
    if (error) throw error;
    for (const row of data || []) existing.set(row.uid, row[hashField]);
  }

  const changed = rows.filter((r) => existing.get(r.uid) !== r[hashField]);
  const now = new Date().toISOString();
  let written = 0;
  for (const part of chunk(changed, 500)) {
    const payload = part.map((r) => ({ ...r, updated_at: now }));
    const { error } = await client().from('movies').upsert(payload, { onConflict: 'uid' });
    if (error) throw error;
    written += payload.length;
  }
  return { written, skipped: rows.length - written };
}

async function getPendingMovies(limit) {
  const { data, error } = await client()
    .from('movies')
    .select('uid,source_id,language_code,title')
    .eq('video_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function countByStatus(status) {
  const { count, error } = await client()
    .from('movies')
    .select('uid', { count: 'exact', head: true })
    .eq('video_status', status);
  if (error) throw error;
  return count || 0;
}

async function countMovies() {
  const { count, error } = await client()
    .from('movies')
    .select('uid', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

module.exports = {
  enabled,
  client,
  chunk,
  getState,
  setState,
  getExistingSourceIds,
  syncRows,
  getPendingMovies,
  countByStatus,
  countMovies,
};
