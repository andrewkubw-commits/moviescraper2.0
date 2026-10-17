-- RebaMovie scraper schema (Supabase / Postgres)
-- Run in Supabase SQL editor (or `supabase db push`).

create table if not exists public.movies (
  uid               text primary key,              -- "<language_code>:<source_id>"
  source_id         text not null,                 -- rebamovie movie id
  language_code     text not null,                 -- 'en' | 'rn'
  title             text,
  seo_title         text,
  description       text,
  genres            text[] default '{}',
  countries         text[] default '{}',
  type_full         text[] default '{}',
  release_year      text,
  full_release_date text,
  interpreter       text,                          -- dub artist / VJ
  total_time        text,
  movie_data_id     text,
  covers            jsonb default '{}'::jsonb,     -- { image, hdimage, noImage, hdnoImage, longCover, noLongCover, logo }
  is_season         boolean,
  episode_count     integer,
  -- Stable episode metadata only. NO watch/download URLs are stored:
  -- they are signed and expire (~24h) and are resolved live by the get-media edge function.
  episodes          jsonb,
  video_status      text not null default 'pending',  -- pending | done | error (| locked if SKIP_LOCKED=true)
  metadata_hash     text,
  episode_hash      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists movies_lang_idx on public.movies (language_code);
create index if not exists movies_status_idx on public.movies (video_status);
create index if not exists movies_interpreter_idx on public.movies (interpreter);
create index if not exists movies_release_year_idx on public.movies (release_year);
create index if not exists movies_title_trgm_idx on public.movies using gin (to_tsvector('simple', coalesce(title, '')));
create index if not exists movies_genres_idx on public.movies using gin (genres);

-- Small key/value store for cursors and run stats.
create table if not exists public.scrape_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists movies_touch on public.movies;
create trigger movies_touch before update on public.movies
  for each row execute function public.touch_updated_at();

-- RLS: movies are publicly readable (for the app); scrape_state is service-role only.
alter table public.movies enable row level security;
alter table public.scrape_state enable row level security;

drop policy if exists "movies public read" on public.movies;
create policy "movies public read" on public.movies for select using (true);
-- writes only via the service role key (bypasses RLS)
