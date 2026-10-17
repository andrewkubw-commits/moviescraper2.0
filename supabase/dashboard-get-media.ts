// ============================================================================
// get-media  —  self-contained version for the Supabase Dashboard Edge editor.
// Paste this whole file into Dashboard -> Edge Functions -> get-media.
// Turn OFF "Enforce JWT verification" (same as verify_jwt = false).
//
//   POST { movieId, mode?: "watch"|"download", episodeId?, season?, episode?, quality?, userId? }
//     mode "watch"    -> { watch: { hd, mid, low }, episode }     (fresh HLS .m3u8)
//     mode "download" -> { url, expires_in_hours: 24, episode }   (fresh direct mp4)
//   The rebamovie "locked" flag is client-side only; real sources are served
//   anonymously, so locked titles are returned too (with `locked` for UI).
// ============================================================================

const API_BASE = 'https://api.rebamovie.com';
const S9 = 'hdsdgfudekwoqmdzonasdiowm23r4egtynh';
const AES_KEY = S9.length > 32 ? S9.slice(0, 32) : S9.padEnd(32, '0');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface EpisodeVideo {
  hdVideo?: string;
  midVideo?: string;
  lowVideo?: string;
}
interface RawEpisode {
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
interface CinemaData {
  isSeason?: boolean;
  data?: { seasons?: string[]; episodes?: Array<RawEpisode[] | RawEpisode> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson<T = unknown>(path: string, body: unknown, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} on ${path}`);
      lastErr = new Error(`HTTP ${res.status} on ${path}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 200);
  }
  throw lastErr;
}

const getCinemaData = (movieId: string, userId = 'anonymous') =>
  postJson<CinemaData>('/cinemaData', { MovieId: movieId, userId, deviceType: 'IOS' });

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// AES-256-CBC + PKCS7 (WebCrypto default), matching rebamovie's download flow.
async function encryptDownloadPayload(obj: unknown): Promise<{ iv: string; encrypted: string }> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(AES_KEY), { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const data = enc.encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
  return { iv: b64(iv), encrypted: b64(new Uint8Array(cipher)) };
}

async function getDownloadData(input: { url: string; server: string; name: string; time?: number }) {
  const payload = await encryptDownloadPayload({
    url: input.url,
    server: input.server,
    name: input.name,
    time: input.time ?? 1,
  });
  return postJson<{ url?: string } | string>('/downloadData', payload);
}

function flattenEpisodes(cinema: CinemaData) {
  const groups = cinema?.data?.episodes || [];
  const labels = cinema?.data?.seasons || [];
  const out: (RawEpisode & { season: number; seasonLabel?: string })[] = [];
  groups.forEach((group, si) => {
    const list = Array.isArray(group) ? group : [group];
    for (const ep of list) {
      if (!ep) continue;
      out.push({ ...ep, season: si + 1, seasonLabel: labels[si] });
    }
  });
  return out;
}

function slimEpisode(ep: RawEpisode & { season: number; seasonLabel?: string }) {
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
    size: { hd: ep.size?.hdSize || null, mid: ep.size?.midSize || null, low: ep.size?.lowSize || null },
  };
}

const QUALITY: Record<string, keyof EpisodeVideo> = { hd: 'hdVideo', mid: 'midVideo', low: 'lowVideo' };

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const movieId = body.movieId as string | undefined;
  const mode = (body.mode as string | undefined) ?? 'watch';
  const quality = (body.quality as string | undefined) ?? 'hd';
  const userId = (body.userId as string | undefined) ?? 'anonymous';

  if (!movieId) return json({ error: 'movieId is required' }, 400);
  if (!['watch', 'download'].includes(mode)) return json({ error: 'mode must be watch|download' }, 400);

  try {
    const cinema = await getCinemaData(movieId, userId);
    const episodes = flattenEpisodes(cinema);
    if (episodes.length === 0) return json({ error: 'no episodes found', movieId }, 404);

    let picked = episodes[0];
    if (body.episodeId) picked = episodes.find((e) => e.episodeId === body.episodeId) || picked;
    else if (body.season != null && body.episode != null) {
      picked = episodes.find((e) => e.season === body.season && e.episode === body.episode) || picked;
    }

    const episode = slimEpisode(picked);
    const video: EpisodeVideo = picked.video ?? {};

    if (mode === 'watch') {
      return json({
        movieId,
        mode,
        locked: episode.locked,
        watch: { hd: video.hdVideo ?? null, mid: video.midVideo ?? null, low: video.lowVideo ?? null },
        episode,
      });
    }

    const field = QUALITY[quality] ?? 'hdVideo';
    const url = video[field] ?? video.hdVideo;
    if (!url) return json({ error: 'no downloadable source for episode', movieId }, 404);

    const name = [
      episode.title || 'video',
      `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`,
      episode.part_name || '',
    ]
      .filter(Boolean)
      .join(' ');

    const result = await getDownloadData({ url, server: String(picked.server ?? 'rebamovie'), name, time: 1 });
    const downloadUrl = typeof result === 'string' ? result : result?.url;
    if (!downloadUrl) return json({ error: 'download link unavailable', movieId }, 502);

    return json({ movieId, mode, quality: field, locked: episode.locked, url: downloadUrl, expires_in_hours: 24, episode });
  } catch (err) {
    return json({ error: 'upstream failure', detail: String((err as Error)?.message ?? err) }, 502);
  }
});
