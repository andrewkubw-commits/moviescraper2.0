'use strict';

const { sha1 } = require('./crypto');

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

function normalizeMovie(item, languageCode) {
  const md = item.movieDataId || {};
  const title = md.title || item.title || null;
  return {
    uid: `${languageCode}:${item.id}`,
    source_id: item.id,
    language_code: languageCode,
    title,
    seo_title: item.seoTitle || null,
    description: md.description || null,
    genres: arr(md.genre),
    countries: arr(md.country),
    type_full: arr(md.typeFull),
    release_year: md.rereaseDate || null,
    full_release_date: md.fullReleaseDate || null,
    interpreter: item.interpreter?.title || null,
    total_time: item.totalTime || null,
    movie_data_id: md.id || null,
    covers: {
      image: md.image || null,
      hdimage: md.hdimage || null,
      noImage: md.noImage || null,
      hdnoImage: md.hdnoImage || null,
      longCover: md.longCover || null,
      noLongCover: md.noLongCover || null,
      logo: md.logo || null,
    },
  };
}

function metadataHash(m) {
  return sha1(
    JSON.stringify([
      m.title,
      m.seo_title,
      m.description,
      m.genres,
      m.countries,
      m.type_full,
      m.release_year,
      m.full_release_date,
      m.interpreter,
      m.total_time,
      m.covers,
    ])
  );
}

// Flatten cinemaData (episodes are grouped per season) into a stable list.
// No URLs are kept: they are signed/tokenized and expire (~24h). The edge
// function resolves fresh watch/download links on demand.
function cinemaToEpisodes(cinema, fallbackTitle) {
  const data = cinema?.data || {};
  const seasonLabels = arr(data.seasons);
  const groups = arr(data.episodes);
  const episodes = [];

  groups.forEach((group, si) => {
    const list = Array.isArray(group) ? group : [group];
    list.forEach((ep) => {
      if (!ep) return;
      const md = ep.movieDataId || {};
      episodes.push({
        episode_id: ep.episodeId || null,
        server: ep.server != null ? String(ep.server) : null,
        title: md.title || ep.title || fallbackTitle || null,
        seo_title: ep.seoTitle || null,
        interpreter: ep.interpreter?.title || null,
        season: si + 1,
        season_label: seasonLabels[si] || null,
        episode: ep.episode != null ? ep.episode : 1,
        part_name: (ep.partName || '').trim(),
        type: ep.type || null,
        size: {
          hd: ep.size?.hdSize || null,
          mid: ep.size?.midSize || null,
          low: ep.size?.lowSize || null,
        },
        locked: !!ep.locked,
        adstatus: !!ep.adstatus,
        xr: !!ep.xr,
      });
    });
  });

  const isSeason = !!cinema?.isSeason;
  const allLocked = episodes.length > 0 && episodes.every((e) => e.locked);
  return { episodes, isSeason, allLocked };
}

function episodeHash(episodes) {
  const slim = episodes.map((e) => [
    e.episode_id,
    e.server,
    e.season,
    e.episode,
    e.part_name,
    e.interpreter,
    e.locked,
    e.size,
  ]);
  return sha1(JSON.stringify(slim));
}

module.exports = {
  arr,
  normalizeMovie,
  metadataHash,
  cinemaToEpisodes,
  episodeHash,
};
