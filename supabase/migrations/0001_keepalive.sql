create table if not exists public._keepalive (
  id boolean primary key default true,
  pinged_at timestamptz not null default now(),
  constraint _keepalive_singleton check (id)
);

alter table public._keepalive enable row level security;

insert into public._keepalive (id) values (true)
on conflict (id) do nothing;
