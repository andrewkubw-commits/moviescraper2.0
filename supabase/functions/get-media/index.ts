// get-media edge function
// Resolves fresh, signed rebamovie URLs on demand (they expire ~24h, so we never store them).
//
//   POST { movieId, mode?: "watch"|"download", episodeId?, season?, episode?, quality?, userId? }
//     mode "watch"    -> { watch: { hd, mid, low }, episode }          (fresh HLS .m3u8 for your player)
//     mode "download" -> { url, expires_in_hours: 24, episode }        (fresh direct mp4)
//   Note: the rebamovie "locked" flag is client-side only; real sources are served
//   anonymously, so locked titles are returned too (with `locked` for UI display).

import { corsHeaders, json } from '../_shared/cors.ts';
import {
  getCinemaData,
  getDownloadData,
  flattenEpisodes,
  pickEpisode,
  slimEpisode,
  type EpisodeVideo,
} from '../_shared/reba.ts';

const QUALITY: Record<string, keyof EpisodeVideo> = {
  hd: 'hdVideo',
  mid: 'midVideo',
  low: 'lowVideo',
};

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

    const picked = pickEpisode(episodes, {
      episodeId: body.episodeId as string | undefined,
      season: body.season as number | undefined,
      episode: body.episode as number | undefined,
    });
    if (!picked) return json({ error: 'episode not found', movieId }, 404);

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

    // download
    const field = QUALITY[quality] ?? 'hdVideo';
    const url = video[field] ?? video.hdVideo;
    if (!url) return json({ error: 'no downloadable source for episode', movieId }, 404);

    const name = [
      episode.title || 'video',
      cinema.isSeason || episode.season ? `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}` : '',
      episode.part_name || '',
    ]
      .filter(Boolean)
      .join(' ');

    const result = await getDownloadData({
      url,
      server: String(picked.server ?? 'rebamovie'),
      name,
      time: 1,
    });
    const downloadUrl = typeof result === 'string' ? result : result?.url;
    if (!downloadUrl) return json({ error: 'download link unavailable', movieId }, 502);

    return json({ movieId, mode, quality: field, locked: episode.locked, url: downloadUrl, expires_in_hours: 24, episode });
  } catch (err) {
    return json({ error: 'upstream failure', detail: String((err as Error)?.message ?? err) }, 502);
  }
});
