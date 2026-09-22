-- Split — server side. Paste the whole file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → Run). Safe to run twice.
--
-- The design in one line: one table of records, reachable only through two
-- functions, both of which demand the ledger's join code.
--
-- The code is the only credential. Anyone holding it can read and write
-- that one ledger and nothing else; without it, no row is reachable at all,
-- so the table cannot be trawled. That is the same bargain as a shareable
-- document link, and it is worth knowing before you paste a code into a
-- group chat.

create table if not exists public.split_records (
  code        text   not null,
  kind        text   not null,          -- ledger | person | expense | settlement
  id          text   not null,
  payload     jsonb  not null,
  updated_at  bigint not null,          -- the editing phone's clock, for last-write-wins
  device      text   not null default '',
  seq         bigint not null,          -- this server's own order, for pulling
  primary key (code, kind, id)
);

-- Pulling walks this index in order, so it stays quick as a group grows.
create index if not exists split_records_code_seq on public.split_records (code, seq);

create sequence if not exists public.split_seq;

-- No direct access for anyone holding the publishable key. The functions below are
-- the only way in, and they are security definer, so they reach the table
-- on the caller's behalf after checking the code.
alter table public.split_records enable row level security;
revoke all on public.split_records from anon, authenticated;

-- Hand over everything this ledger has seen since the caller last asked.
-- Ordering by the server's own sequence rather than by the phones' clocks
-- means a slow or skewed phone still cannot cause a record to be skipped.
create or replace function public.split_pull(p_code text, p_since bigint)
returns table (kind text, id text, payload jsonb, updated_at bigint, device text, seq bigint)
language sql
security definer
set search_path = public
as $$
  select r.kind, r.id, r.payload, r.updated_at, r.device, r.seq
  from public.split_records r
  where r.code = p_code
    and r.seq > coalesce(p_since, 0)
  order by r.seq
  limit 5000;
$$;

-- Take a batch of records. A record only lands if it is genuinely newer
-- than what is already stored; the device id breaks a tie on the same
-- millisecond so every phone reaches the same verdict. Rows that lose are
-- left untouched, which also leaves seq alone, so a rejected write does not
-- travel back out to everyone as fresh news.
create or replace function public.split_push(p_code text, p_device text, p_records jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record jsonb;
begin
  if p_code is null or length(p_code) < 8 then
    raise exception 'bad code';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception 'records must be an array';
  end if;
  if jsonb_array_length(p_records) > 2000 then
    raise exception 'too many records in one push';
  end if;

  for v_record in select * from jsonb_array_elements(p_records)
  loop
    insert into public.split_records (code, kind, id, payload, updated_at, device, seq)
    values (
      p_code,
      v_record ->> 'kind',
      v_record ->> 'id',
      v_record -> 'payload',
      -- Deliberately stored as the phone gave it. Clamping this to server
      -- time was tried and reverted: the server would hold the clamped
      -- value while the phone kept its own, and the two would disagree
      -- forever. Whatever decides a conflict has to be a number every copy
      -- can see, so it has to be the one that travelled with the record.
      -- The cost is that a phone whose clock is badly wrong wins arguments
      -- it should lose, until someone edits the record again.
      (v_record ->> 'updatedAt')::bigint,
      coalesce(v_record ->> 'device', p_device, ''),
      nextval('public.split_seq')
    )
    on conflict (code, kind, id) do update
      set payload    = excluded.payload,
          updated_at = excluded.updated_at,
          device     = excluded.device,
          seq        = nextval('public.split_seq')
      where excluded.updated_at > public.split_records.updated_at
         or (excluded.updated_at = public.split_records.updated_at
             and excluded.device > public.split_records.device);
  end loop;

  return (extract(epoch from now()) * 1000)::bigint;
end;
$$;

grant execute on function public.split_pull(text, bigint) to anon, authenticated;
grant execute on function public.split_push(text, text, jsonb) to anon, authenticated;
