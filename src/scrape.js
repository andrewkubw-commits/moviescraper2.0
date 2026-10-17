'use strict';

const fs = require('fs-extra');
const path = require('path');
const cfg = require('./config');
const api = require('./api');
const sb = require('./supabase');
const {
  normalizeMovie,
  metadataHash,
  cinemaToEpisodes,
  episodeHash,
} = require('./transform');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a.includes('=')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v;
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts[k] = next;
        i++;
      } else {
        opts[k] = true;
      }
    }
  }
  return opts;
}

async function dump(name, rows) {
  await fs.ensureDir(cfg.DATA_DIR);
  const file = path.join(cfg.DATA_DIR, name);
  await fs.writeJson(file, rows, { spaces: 2 });
  console.log(`  wrote ${rows.length} rows -> ${path.relative(process.cwd(), file)}`);
}

async function runMetadata({ langs, fullRefresh }) {
  const summary = {};
  for (const lang of langs) {
    console.log(`\n[metadata] language=${lang} full_refresh=${fullRefresh}`);
    const known = fullRefresh ? new Set() : await sb.getExistingSourceIds(lang);
    console.log(`  known source_ids: ${known.size}`);

    const collected = [];
    let page = 0;
    let stop = false;
    let totalWritten = 0;
    let totalSkipped = 0;
    const flush = async () => {
      if (collected.length === 0) return;
      for (const row of collected) row.metadata_hash = metadataHash(row);
      const { written, skipped } = await sb.syncRows(collected, 'metadata_hash');
      totalWritten += written;
      totalSkipped += skipped;
      collected.length = 0;
    };

    while (!stop) {
      const res = await api.getMovies(lang, page);
      const all = res?.allMovies || {};
      const items = all.items || [];
      if (items.length === 0) break;

      let newOnPage = 0;
      for (const item of items) {
        if (!known.has(item.id)) newOnPage++;
        known.add(item.id);
        collected.push(normalizeMovie(item, lang));
      }
      console.log(
        `  page ${page}/${all.totalPages ?? '?'} items=${items.length} new=${newOnPage} total=${all.totalCount ?? '?'}`
      );

      // Flush periodically so a later network failure doesn't lose all fetched pages.
      if (collected.length >= 500) await flush();

      page++;
      if (!fullRefresh && page > 0 && newOnPage === 0) {
        console.log('  full page already known -> stopping (incremental)');
        stop = true;
      }
      if (all.totalPages && page >= all.totalPages) stop = true;
      if (page > 1000) stop = true;
    }

    await flush();
    console.log(`  written=${totalWritten} skipped(unchanged)=${totalSkipped}`);
    summary[lang] = { written: totalWritten, skipped: totalSkipped };
  }
  return summary;
}

async function runEpisodes({ limit }) {
  console.log(`\n[episodes] batch_limit=${limit} concurrency=${cfg.CONCURRENCY}`);
  const pending = await sb.getPendingMovies(limit);
  console.log(`  pending fetched: ${pending.length}`);
  if (pending.length === 0) return { processed: 0, done: 0, locked: 0, failed: 0 };

  const counters = { done: 0, locked: 0, failed: 0 };
  const rows = await api.mapLimit(pending, cfg.CONCURRENCY, async (m) => {
    try {
      const cinema = await api.getCinemaData(m.source_id);
      const { episodes, isSeason, allLocked } = cinemaToEpisodes(cinema, m.title);
      // "locked" is client-side only — sources are real and fetchable. We only
      // honor it when SKIP_LOCKED is explicitly enabled.
      const status = cfg.SKIP_LOCKED && allLocked ? 'locked' : 'done';
      counters[status === 'locked' ? 'locked' : 'done']++;
      return {
        uid: m.uid,
        source_id: m.source_id,
        language_code: m.language_code,
        title: m.title,
        is_season: isSeason,
        episode_count: episodes.length,
        episodes,
        video_status: status,
        episode_hash: episodeHash(episodes),
      };
    } catch (err) {
      counters.failed++;
      console.warn(`  ! ${m.uid} (${m.source_id}): ${err.message}`);
      return { uid: m.uid, video_status: 'error', episode_hash: `error:${Date.now()}` };
    }
  });

  const toWrite = rows.filter((r) => r.video_status !== 'error');
  const { written, skipped } = await sb.syncRows(toWrite, 'episode_hash');

  // Flag failures so they don't poison the queue; visible via count.
  const failed = rows.filter((r) => r.video_status === 'error');
  for (const r of failed) {
    await sb.client().from('movies').update({ video_status: 'error' }).eq('uid', r.uid);
  }

  const result = { processed: rows.length, written, skipped, ...counters };
  console.log(`  ${JSON.stringify(result)}`);
  await dump(`episodes-${Date.now()}.json`, toWrite);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = String(opts.mode || 'full');
  const limit = parseInt(opts.limit, 10) || cfg.VIDEO_BATCH;
  const langs = opts.lang ? [String(opts.lang)] : cfg.LANGS;
  const fullRefresh = Boolean(opts['full-refresh']);

  console.log(`reba-scraper mode=${mode} langs=${langs.join(',')} supabase=${sb.enabled ? 'on' : 'OFF'}`);

  const needsSupabase = ['metadata', 'episodes', 'full', 'stats', 'check'].includes(mode);
  if (needsSupabase && !sb.enabled) {
    console.error('\nSupabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_KEY, or use `npm run sample`.');
    process.exit(1);
  }

  if (sb.enabled) {
    try {
      const info = await sb.ping();
      console.log(`supabase connectivity OK (url=${info.url}, movies=${info.count ?? '?'})`);
    } catch (err) {
      console.error(`\nSupabase preflight FAILED: ${sb.describeError(err)}`);
      console.error('Most common cause: a trailing space/newline in the SUPABASE_URL or SUPABASE_SERVICE_KEY secret.');
      process.exit(1);
    }
  }
  if (mode === 'check') {
    console.log('\n[check] raw request probes:');
    await sb.diagnose();
    console.log('check done');
    return;
  }

  const started = Date.now();
  const result = { started_at: new Date(started).toISOString(), mode, langs };
  if (mode === 'metadata' || mode === 'full') {
    result.metadata = await runMetadata({ langs, fullRefresh });
  }
  if (mode === 'episodes' || mode === 'full') {
    result.episodes = await runEpisodes({ limit });
  }
  if (mode === 'stats') {
    result.total = await sb.countMovies();
    result.pending = await sb.countByStatus('pending');
    result.done = await sb.countByStatus('done');
    result.locked = await sb.countByStatus('locked');
    result.error = await sb.countByStatus('error');
    console.log(JSON.stringify(result, null, 2));
  }

  result.duration_ms = Date.now() - started;
  await sb.setState('last_run', result);
  console.log(`\ndone in ${(result.duration_ms / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('FATAL:', sb.describeError ? sb.describeError(err) : err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
