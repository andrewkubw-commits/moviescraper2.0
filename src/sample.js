'use strict';

const fs = require('fs-extra');
const path = require('path');
const cfg = require('./config');
const api = require('./api');
const { normalizeMovie, cinemaToEpisodes } = require('./transform');

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const count = parseInt(opts.count, 10) || 2;
  const langs = opts.lang ? [String(opts.lang)] : cfg.LANGS;
  const withDownload = Boolean(opts['with-download']);

  console.log(`reba-scraper SAMPLE count=${count} langs=${langs.join(',')} with_download=${withDownload}`);
  const output = { generated_at: new Date().toISOString(), langs, movies: [] };

  for (const lang of langs) {
    console.log(`\n[${lang}] fetching first page...`);
    const res = await api.getMovies(lang, 0);
    const all = res?.allMovies || {};
    console.log(
      `  totalCount=${all.totalCount} totalPages=${all.totalPages} pageSize=${all.pageSize} items=${(all.items || []).length}`
    );
    const picked = (all.items || []).slice(0, count);

    for (const item of picked) {
      const movie = normalizeMovie(item, lang);
      const cinema = await api.getCinemaData(movie.source_id);
      const { episodes, isSeason, allLocked } = cinemaToEpisodes(cinema, movie.title);

      const record = {
        ...movie,
        is_season: isSeason,
        episode_count: episodes.length,
        video_status: cfg.SKIP_LOCKED && allLocked ? 'locked' : 'done',
        episodes,
      };
      output.movies.push(record);

      console.log(
        `  - ${movie.title} [${lang}] id=${movie.source_id} season=${isSeason} eps=${episodes.length} locked=${allLocked}`
      );
      console.log(
        `      interpreter=${movie.interpreter || '-'} genres=${(movie.genres || []).join('|') || '-'} covers.image=${
          movie.covers.image ? 'yes' : 'no'
        }`
      );
      if (episodes[0]) {
        console.log(
          `      ep1: S${episodes[0].season}E${episodes[0].episode} part="${episodes[0].part_name}" hd=${episodes[0].size.hd} locked=${episodes[0].locked}`
        );
      }

      if (withDownload) {
        const raw = (cinema.data?.episodes || []).flat?.() || [];
        const firstEp = raw.find((e) => e && e.video?.hdVideo && !e.locked) || raw[0];
        if (firstEp?.video?.hdVideo) {
          try {
            const dl = await api.getDownloadData({
              url: firstEp.video.hdVideo,
              server: firstEp.server || 'rebamovie',
              name: `${movie.title}`,
              time: 1,
            });
            const host = dl?.url ? new URL(dl.url).host : 'n/a';
            console.log(`      download OK -> host=${host} url_len=${dl?.url?.length ?? 0}`);
          } catch (e) {
            console.log(`      download FAILED: ${e.message}`);
          }
        } else {
          console.log('      download skipped (no unlocked hdVideo)');
        }
      }
    }
  }

  await fs.ensureDir(cfg.DATA_DIR);
  const file = path.join(cfg.DATA_DIR, 'sample.json');
  await fs.writeJson(file, output, { spaces: 2 });
  console.log(`\nwrote ${output.movies.length} movies -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
