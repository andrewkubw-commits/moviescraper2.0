// Shared helpers for the get-media edge function.
// Mirrors the rebamovie web client: signed URLs are fetched fresh on demand.

const API_BASE = 'https://api.rebamovie.com';
const S9 = 'hdsdgfudekwoqmdzonasdiowm23r4egtynh';
const AES_KEY = S9.length > 32 ? S9.slice(0, 32) : S9.padEnd(32, '0');

export interface EpisodeVideo {
  hdVideo?: string;
  midVideo?: string;
  lowVideo?: string;
}

export interface RawEpisode {
  episodeId?: string;
  server?: string | number;
  title?: string;
  seoTitle?: string;
  interpreter?: { title?: string };
  episode?: number;
  partName?: string;
  locked?: boolean;
  movieDataId?: { title?: string };
  size?: { hdSize?: string; midSize?: string; lowSize?: string };
  video?: EpisodeVideo;
}

export interface CinemaData {
  isSeason?: boolean;
  ads?: string[];
  data?: {
    seasons?: string[];
    episodes?: Array<RawEpisode[] | RawEpisode>;
  };
}

export interface FlatEpisode extends RawEpisode {
  season: number;
  seasonLabel?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postJson<T = unknown>(path: string, body: unknown, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status} on ${path}`);
      }
      lastErr = new Error(`HTTP ${res.status} on ${path}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 200);
  }
  throw lastErr;
}

export function getCinemaData(movieId: string, userId = 'anonymous'): Promise<CinemaData> {
  return postJson<CinemaData>('/cinemaData', {
    MovieId: movieId,
    userId,
    deviceType: 'IOS',
  });
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// AES-256-CBC + PKCS7 (WebCrypto default), matching the site's download flow.
export async function encryptDownloadPayload(obj: unknown): Promise<{ iv: string; encrypted: string }> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(AES_KEY), { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const data = enc.encode(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
  return { iv: b64(iv), encrypted: b64(new Uint8Array(cipher)) };
}

export async function getDownloadData(input: {
  url: string;
  server: string;
  name: string;
  time?: number;
}): Promise<{ url?: string } | string> {
  const payload = await encryptDownloadPayload({
    url: input.url,
    server: input.server,
    name: input.name,
    time: input.time ?? 1,
  });
  return postJson<{ url?: string } | string>('/downloadData', payload);
}

export function flattenEpisodes(cinema: CinemaData): FlatEpisode[] {
  const groups = cinema?.data?.episodes || [];
  const labels = cinema?.data?.seasons || [];
  const out: FlatEpisode[] = [];
  groups.forEach((group, si) => {
    const list = Array.isArray(group) ? group : [group];
    for (const ep of list) {
      if (!ep) continue;
      out.push({ ...ep, season: si + 1, seasonLabel: labels[si] });
    }
  });
  return out;
}

export function pickEpisode(
  episodes: FlatEpisode[],
  sel: { episodeId?: string; season?: number; episode?: number }
): FlatEpisode | undefined {
  if (sel.episodeId) return episodes.find((e) => e.episodeId === sel.episodeId);
  if (sel.season != null && sel.episode != null) {
    return episodes.find((e) => e.season === sel.season && e.episode === sel.episode);
  }
  return episodes[0];
}

export function slimEpisode(ep: FlatEpisode) {
  return {
    episode_id: ep.episodeId ?? null,
    server: ep.server != null ? String(ep.server) : null,
    title: ep.movieDataId?.title || ep.title || null,
    seo_title: ep.seoTitle || null,
    interpreter: ep.interpreter?.title || null,
    season: ep.season,
    season_label: ep.seasonLabel ?? null,
    episode: ep.episode ?? 1,
    part_name: (ep.partName || '').trim(),
    locked: !!ep.locked,
    size: {
      hd: ep.size?.hdSize || null,
      mid: ep.size?.midSize || null,
      low: ep.size?.lowSize || null,
    },
  };
}
