'use strict';

const axios = require('axios');
const cfg = require('./config');
const { encryptDownloadPayload } = require('./crypto');

const http = axios.create({
  baseURL: cfg.API_BASE,
  timeout: cfg.REQUEST_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) rebamovie/1.0',
  },
  // We throw on non-2xx ourselves so retries cover 5xx too.
  validateStatus: (s) => s >= 200 && s < 500,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(pathname, body, { retries = cfg.MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await http.post(pathname, body);
      if (res.status >= 200 && res.status < 300) return res.data;
      // 4xx (other than 429) are not retryable
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`HTTP ${res.status} on ${pathname}: ${JSON.stringify(res.data).slice(0, 200)}`);
      }
      lastErr = new Error(`HTTP ${res.status} on ${pathname}`);
    } catch (err) {
      lastErr = err;
    }
    const backoff = cfg.RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
    if (attempt < retries) await sleep(backoff);
  }
  throw lastErr;
}

async function getMovies(languageCode, pageNumber = 0) {
  return request('/movies', {
    pageNumber,
    languageCode,
    deviceType: cfg.DEVICE_TYPE,
  });
}

async function getMovieTitles(languageCode = cfg.DEFAULT_LANG) {
  const data = await request('/movieTitles', { languageCode });
  const titles = Array.isArray(data) ? data : data?.titles || [];
  return titles
    .filter((t) => t != null)
    .map((t) => String(t).trim())
    .filter(Boolean);
}

async function getSearchFilters(languageCode = cfg.DEFAULT_LANG) {
  return request('/searchFilters', { languageCode });
}

async function searchAlgorithm(searchTerm, languageCode, pageNumber = 0) {
  return request('/searchAlgorithm', { searchTerm, languageCode, pageNumber });
}

async function getCinemaData(movieId, userId = cfg.ANON_USER_ID) {
  return request('/cinemaData', {
    MovieId: movieId,
    userId,
    deviceType: cfg.DEVICE_TYPE,
  });
}

// Scrape-time helper (optional, not used by the backfill). The edge function owns
// the on-demand path; this is here so `sample --with-download` can validate crypto.
async function getDownloadData({ url, server, name, time = 1 }) {
  const payload = encryptDownloadPayload({ url, server, name, time });
  return request('/downloadData', payload);
}

// Bounded-concurrency map.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  getMovies,
  getMovieTitles,
  getSearchFilters,
  searchAlgorithm,
  getCinemaData,
  getDownloadData,
  mapLimit,
  sleep,
};
