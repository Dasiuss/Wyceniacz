-- ============================================================================
--  Wyceniacz - konfiguracja bazy Supabase
-- ============================================================================
--  Wklej calosc do Supabase: Dashboard -> SQL Editor -> New query -> Run.
--  Skrypt jest idempotentny - mozna go uruchomic wielokrotnie.
--
--  Tworzy:
--    - schemat "wyceniacz" (nie rusza public.meetings ani innych tabel)
--    - tabele votings / votes
--    - RLS: odczyt dla anon, brak bezposredniego zapisu (wszystko przez RPC)
--    - RPC: get_state, submit_vote, set_jira_url, reveal_voting, reset_voting
--    - trigger przycinajacy historie do 100 najnowszych glosowan
--    - publikacje Realtime dla obu tabel
--
--  UWAGA: po uruchomieniu tego skryptu trzeba jeszcze RĘCZNIE dodac schemat
--  do udostepnionych w Dashboard -> Project Settings -> API -> Exposed schemas.
--  Bez tego PostgREST (a wiec i supabase-js) nie zobaczy schematu.
-- ============================================================================

create schema if not exists wyceniacz;

-- ---------------------------------------------------------------------------
--  Tabele
-- ---------------------------------------------------------------------------

create table if not exists wyceniacz.votings (
  id          uuid primary key default gen_random_uuid(),
  jira_url    text,
  status      text not null default 'open' check (status in ('open', 'revealed')),
  created_at  timestamptz not null default now(),
  revealed_at timestamptz
);

-- Dokladnie jedno otwarte glosowanie w danym momencie.
create unique index if not exists votings_single_open
  on wyceniacz.votings (status)
  where status = 'open';

create table if not exists wyceniacz.votes (
  id         uuid primary key default gen_random_uuid(),
  voting_id  uuid not null references wyceniacz.votings (id) on delete cascade,
  voter_id   uuid not null,
  section    text not null check (section in ('be', 'fe', 'qa')),
  value      numeric(5, 2) not null check (value >= 0.5 and value <= 15),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (voting_id, voter_id, section)
);

create index if not exists votes_voting_idx on wyceniacz.votes (voting_id);

-- ---------------------------------------------------------------------------
--  RLS + uprawnienia
-- ---------------------------------------------------------------------------
--  anon moze WYLACZNIE czytac. Zapisy wyłącznie przez funkcje SECURITY DEFINER
--  ponizej, wiec z konsoli przegladarki nie da sie skasowac historii.

alter table wyceniacz.votings enable row level security;
alter table wyceniacz.votes   enable row level security;

drop policy if exists votings_select on wyceniacz.votings;
create policy votings_select on wyceniacz.votings
  for select to anon, authenticated using (true);

drop policy if exists votes_select on wyceniacz.votes;
create policy votes_select on wyceniacz.votes
  for select to anon, authenticated using (true);

grant usage on schema wyceniacz to anon, authenticated, service_role;
grant select on wyceniacz.votings to anon, authenticated, service_role;
grant select on wyceniacz.votes   to anon, authenticated, service_role;
grant all    on wyceniacz.votings to service_role;
grant all    on wyceniacz.votes   to service_role;

-- ---------------------------------------------------------------------------
--  Funkcje pomocnicze
-- ---------------------------------------------------------------------------

-- Zwraca biezace glosowanie: otwarte, a jesli takiego nie ma - ostatnie
-- ujawnione. Gdy tabela jest pusta, tworzy pierwsze otwarte glosowanie.
create or replace function wyceniacz.ensure_voting()
returns wyceniacz.votings
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  r wyceniacz.votings;
begin
  select * into r
    from wyceniacz.votings
   where status = 'open'
   order by created_at desc
   limit 1;

  if not found then
    select * into r
      from wyceniacz.votings
     order by created_at desc
     limit 1;
  end if;

  if not found then
    begin
      insert into wyceniacz.votings (status) values ('open')
      returning * into r;
    exception when unique_violation then
      -- rownolegly klient zdazyl juz utworzyc glosowanie
      select * into r
        from wyceniacz.votings
       order by created_at desc
       limit 1;
    end;
  end if;

  return r;
end;
$$;

-- ---------------------------------------------------------------------------
--  Trigger: historia trzyma maksymalnie 100 glosowan z glosami
-- ---------------------------------------------------------------------------

create or replace function wyceniacz.prune_history()
returns trigger
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
begin
  -- Porzucone ujawnione glosowania bez glosow (poza wlasnie ujawnionym).
  delete from wyceniacz.votings v
   where v.status = 'revealed'
     and v.id <> new.id
     and not exists (
       select 1 from wyceniacz.votes x where x.voting_id = v.id
     );

  -- Zostaw 100 najnowszych ujawnionych glosowan, ktore maja glosy.
  delete from wyceniacz.votings
   where id in (
     select v.id
       from wyceniacz.votings v
      where v.status = 'revealed'
        and exists (select 1 from wyceniacz.votes x where x.voting_id = v.id)
      order by v.revealed_at desc nulls last, v.created_at desc
      offset 100
   );

  return null;
end;
$$;

revoke execute on function wyceniacz.prune_history() from public;

drop trigger if exists trg_prune_history on wyceniacz.votings;
create trigger trg_prune_history
  after update on wyceniacz.votings
  for each row
  when (new.status = 'revealed' and old.status is distinct from 'revealed')
  execute function wyceniacz.prune_history();

-- ---------------------------------------------------------------------------
--  API dla klienta (RPC)
-- ---------------------------------------------------------------------------

-- Biezace glosowanie + jego glosy. Wolane przy kazdym evencie Realtime,
-- dlatego celowo NIE zawiera historii.
create or replace function wyceniacz.get_state()
returns jsonb
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  v_voting wyceniacz.votings;
begin
  v_voting := wyceniacz.ensure_voting();

  return jsonb_build_object(
    'voting', to_jsonb(v_voting),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'voter_id', vt.voter_id,
               'section',  vt.section,
               'value',    vt.value))
        from wyceniacz.votes vt
       where vt.voting_id = v_voting.id), '[]'::jsonb)
  );
end;
$$;

-- Historia: do 100 ostatnich ujawnionych glosowan, tylko te z glosami.
-- Wolane raz przy starcie i po zmianie w tabeli votings (odkrycie/reset/link).
create or replace function wyceniacz.get_history()
returns jsonb
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
begin
  return coalesce((
    select jsonb_agg(h)
      from (
        select jsonb_build_object(
                 'id',          v.id,
                 'jira_url',    v.jira_url,
                 'created_at',  v.created_at,
                 'revealed_at', v.revealed_at,
                 'votes', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'voter_id', y.voter_id,
                            'section',  y.section,
                            'value',    y.value))
                     from wyceniacz.votes y
                    where y.voting_id = v.id), '[]'::jsonb)
               ) as h
          from wyceniacz.votings v
         where v.status = 'revealed'
           and exists (select 1 from wyceniacz.votes z where z.voting_id = v.id)
         order by v.revealed_at desc nulls last, v.created_at desc
         limit 100
      ) s), '[]'::jsonb);
end;
$$;

-- Zapis / zmiana wlasnego glosu. Dozwolone tylko gdy glosowanie jest otwarte.
--
-- Limity chronia baze przed nabiciem danych przez skrypt z publicznym kluczem:
--   c_max_per_section - maksymalna liczba glosow w jednej sekcji jednego
--                       glosowania (3 sekcje x 10 = 30 wierszy na glosowanie,
--                       a historia jest przycinana do 100 glosowan, czyli
--                       calosc nigdy nie przekroczy ~3000 wierszy).
create or replace function wyceniacz.submit_vote(
  p_voter_id uuid,
  p_section  text,
  p_value    numeric
)
returns void
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  c_max_per_section constant int := 10;
  r          wyceniacz.votings;
  v_existing boolean;
  v_count    int;
begin
  if p_voter_id is null then
    raise exception 'Brak identyfikatora glosujacego';
  end if;

  if p_section not in ('be', 'fe', 'qa') then
    raise exception 'Nieznana sekcja: %', p_section;
  end if;

  if p_value is null or p_value < 0.5 or p_value > 15 then
    raise exception 'Wycena poza zakresem 0.5-15 MD';
  end if;

  r := wyceniacz.ensure_voting();

  if r.status <> 'open' then
    raise exception 'Glosowanie jest juz odkryte';
  end if;

  select exists(
    select 1 from wyceniacz.votes
     where voting_id = r.id and voter_id = p_voter_id and section = p_section
  ) into v_existing;

  if not v_existing then
    select count(*) into v_count
      from wyceniacz.votes
     where voting_id = r.id and section = p_section;

    if v_count >= c_max_per_section then
      raise exception 'Limit % glosow w tej sekcji zostal osiagniety', c_max_per_section;
    end if;
  end if;

  insert into wyceniacz.votes (voting_id, voter_id, section, value)
  values (r.id, p_voter_id, p_section, round(p_value, 2))
  on conflict (voting_id, voter_id, section)
  do update set value = excluded.value, updated_at = now();
end;
$$;

-- Link do Jiry - edytowalny zawsze, takze po odkryciu. Ucinamy do 500 znakow.
create or replace function wyceniacz.set_jira_url(p_url text)
returns void
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  r wyceniacz.votings;
begin
  r := wyceniacz.ensure_voting();

  update wyceniacz.votings
     set jira_url = nullif(left(btrim(coalesce(p_url, '')), 500), '')
   where id = r.id;
end;
$$;

-- Odkrycie glosow. Trigger przy okazji przycina historie.
create or replace function wyceniacz.reveal_voting()
returns void
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  r wyceniacz.votings;
begin
  r := wyceniacz.ensure_voting();

  if r.status = 'open' then
    update wyceniacz.votings
       set status = 'revealed', revealed_at = now()
     where id = r.id;
  end if;
end;
$$;

-- Reset: biezace otwarte glosowanie znika razem z glosami (bez wpisu w
-- historii), startuje nowe, puste glosowanie.
create or replace function wyceniacz.reset_voting()
returns wyceniacz.votings
language plpgsql
security definer
set search_path = wyceniacz, pg_temp
as $$
declare
  r wyceniacz.votings;
begin
  delete from wyceniacz.votings where status = 'open';

  insert into wyceniacz.votings (status) values ('open')
  returning * into r;

  return r;
end;
$$;

revoke execute on function wyceniacz.get_state()            from public;
revoke execute on function wyceniacz.get_history()          from public;
revoke execute on function wyceniacz.submit_vote(uuid, text, numeric) from public;
revoke execute on function wyceniacz.set_jira_url(text)     from public;
revoke execute on function wyceniacz.reveal_voting()        from public;
revoke execute on function wyceniacz.reset_voting()         from public;

grant execute on function wyceniacz.get_state()            to anon, authenticated, service_role;
grant execute on function wyceniacz.get_history()          to anon, authenticated, service_role;
grant execute on function wyceniacz.submit_vote(uuid, text, numeric) to anon, authenticated, service_role;
grant execute on function wyceniacz.set_jira_url(text)     to anon, authenticated, service_role;
grant execute on function wyceniacz.reveal_voting()        to anon, authenticated, service_role;
grant execute on function wyceniacz.reset_voting()         to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
--  Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    alter publication supabase_realtime add table wyceniacz.votings;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table wyceniacz.votes;
  exception when duplicate_object then null;
  end;
end;
$$;

-- ============================================================================
--  KONIEC
-- ============================================================================
