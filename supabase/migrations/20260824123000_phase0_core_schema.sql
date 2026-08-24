-- MarketPulse — Phase 0 core schema
--
-- Spec: Technical Requirements §2 (data model), §7 (invariants); Handover §8.
--
-- Phase 0 exists because these decisions cannot be retrofitted cheaply: every
-- one of them would otherwise require migrating historical rows or re-running
-- every past decomposition. Specifically:
--   * money as integer kobo (never float, never numeric-as-money)
--   * currency as a mandatory sibling of every amount
--   * purchase_form, so pack-size discounts do not read as price drops
--   * market_type, one of the six fields that constitute the B2B asset
--   * substitute_group, which powers the substitution narrative
--   * denormalised location ancestry, so rollups are indexed filters
--
-- Deliberately NOT in this migration:
--   * PostGIS            — a V1 dependency (map), not MVP (§1)
--   * price_aggregates   — stage 4/7, needs the rollup design settled first
--   * watchlist          — V1
--   * commodity content  — the ~60 master rows are a separate seed, owned
--                          outside engineering (§8.1)

-- ---------------------------------------------------------------------------
-- Enumerated types
--
-- Real Postgres enums rather than text-with-check: an illegal value must be
-- rejected by the database, not by whichever caller happens to remember.
-- ---------------------------------------------------------------------------

create type location_level      as enum ('country', 'state', 'lga', 'area', 'market');
create type market_type         as enum ('open_market', 'supermarket', 'other');
create type purchase_form       as enum ('loose', 'pre_packed', 'bulk');
create type capture_method      as enum ('same_day', 'recall');
create type perishability_class as enum ('high', 'semi', 'stable');
create type base_dimension      as enum ('mass', 'volume', 'count');
create type request_status      as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- locations — country > state > lga > area > market
--
-- parent_id keeps the true hierarchy; state_id/lga_id/area_id denormalise the
-- ancestor chain so every rollup and drill-down is a plain indexed filter
-- rather than a recursive CTE (§2.1). Depth is fixed at five and will not
-- grow, which is what makes the denormalisation safe: it is static reference
-- data, computed once at seed time and never recomputed.
-- ---------------------------------------------------------------------------

create table public.locations (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid references public.locations (id) on delete restrict,
  level        location_level not null,
  name         text not null,

  -- Denormalised ancestry. Null at or above the level in question.
  state_id     uuid references public.locations (id) on delete restrict,
  lga_id       uuid references public.locations (id) on delete restrict,
  area_id      uuid references public.locations (id) on delete restrict,

  -- Only meaningful for markets; enforced below.
  market_type  market_type,

  source       text not null default 'seed',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A market must declare its type: it is one of the six B2B fields and
  -- backfilling it later means manually reclassifying every location.
  constraint locations_market_type_required
    check ((level = 'market') = (market_type is not null)),

  -- Only a country may be rootless.
  constraint locations_parent_required
    check ((level = 'country') = (parent_id is null))
);

create index locations_parent_idx on public.locations (parent_id);
create index locations_state_idx  on public.locations (state_id);
create index locations_lga_idx    on public.locations (lga_id);
create index locations_area_idx   on public.locations (area_id);
create index locations_level_idx  on public.locations (level);

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- commodities — the master list. Free creation is blocked by policy (there is
-- no INSERT policy for end users); unmatched items go to commodity_requests.
-- ---------------------------------------------------------------------------

create table public.commodities (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  category            text not null,
  perishability       perishability_class not null,
  dimension           base_dimension not null,

  -- Powers the substitution narrative (§7.2 of the Handover). Nullable: most
  -- commodities are not substitutes for anything.
  substitute_group    text,

  default_unit_id     uuid,  -- FK added after commodity_units exists
  source              text not null default 'seed',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index commodities_substitute_group_idx
  on public.commodities (substitute_group)
  where substitute_group is not null;
create index commodities_category_idx on public.commodities (category);

create trigger commodities_set_updated_at
  before update on public.commodities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- commodity_units — loosely-matched market units with explicit conversion
-- confidence. "Paint of oil ~ 4.5L" is high confidence; "medium bag of pepper
-- ~ 25kg" is not, and that uncertainty must propagate to aggregate confidence
-- rather than silently corrupt the data (Handover §8.4).
-- ---------------------------------------------------------------------------

create table public.commodity_units (
  id                    uuid primary key default gen_random_uuid(),
  commodity_id          uuid not null references public.commodities (id) on delete cascade,
  unit_name             text not null,
  dimension             base_dimension not null,

  -- Multiply a user-entered quantity by this to reach base units
  -- (grams / millilitres / pieces x 1000).
  factor_to_base        numeric(20, 6) not null check (factor_to_base > 0),
  conversion_confidence numeric(3, 2) not null default 1.00
                          check (conversion_confidence >= 0 and conversion_confidence <= 1),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (commodity_id, unit_name)
);

create index commodity_units_commodity_idx on public.commodity_units (commodity_id);

create trigger commodity_units_set_updated_at
  before update on public.commodity_units
  for each row execute function public.set_updated_at();

alter table public.commodities
  add constraint commodities_default_unit_fk
  foreign key (default_unit_id) references public.commodity_units (id) on delete set null;

-- ---------------------------------------------------------------------------
-- users — profile attached to auth.users. Anonymous sessions are real users
-- here from first launch (§9.2): the row exists before any capture, which is
-- what makes sync-for-durability possible without a registration flow.
-- ---------------------------------------------------------------------------

create table public.users (
  id                 uuid primary key references auth.users (id) on delete cascade,
  primary_location_id uuid references public.locations (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- shopping_trips
--
-- server_received_at is the conflict-resolution ordering key. Device clocks on
-- low-end Android drift and are frequently wrong outright, so they must never
-- order writes (§9.2). client_updated_at is retained only so the "edited on
-- another device" UI can show the user which edit was theirs-first — it is
-- evidence for a human, never an ordering input.
-- ---------------------------------------------------------------------------

create table public.shopping_trips (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users (id) on delete cascade,
  location_id        uuid references public.locations (id) on delete restrict,

  trip_date          date not null,
  currency           text not null default 'NGN' check (char_length(currency) = 3),
  capture_method     capture_method not null,

  server_received_at timestamptz not null default now(),
  client_updated_at  timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Lets purchase_lines carry a composite FK, making a currency mismatch
  -- between a trip and its own lines unrepresentable rather than merely
  -- discouraged.
  unique (id, currency)
);

create index shopping_trips_user_date_idx on public.shopping_trips (user_id, trip_date desc);
create index shopping_trips_location_idx  on public.shopping_trips (location_id);

create trigger shopping_trips_set_updated_at
  before update on public.shopping_trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- purchase_lines — THE atomic record. Every price observation in the system
-- originates here.
--
-- Money is integer kobo. unit_price_normalized is computed at write time for
-- display, comparison and the outlier guard — it is NEVER an input to the
-- decomposition sums, which operate on exact rationals over paid_price_kobo
-- and qty_in_base_unit (§3.1).
--
-- user_id is denormalised from the trip so RLS is a cheap indexed predicate
-- rather than a subquery on every row.
-- ---------------------------------------------------------------------------

create table public.purchase_lines (
  id                    uuid primary key default gen_random_uuid(),
  trip_id               uuid not null,
  user_id               uuid not null references public.users (id) on delete cascade,
  commodity_id          uuid not null references public.commodities (id) on delete restrict,
  unit_id               uuid not null references public.commodity_units (id) on delete restrict,

  -- Mandatory. Integer minor units, never float.
  paid_price_kobo       bigint not null check (paid_price_kobo > 0),
  -- Optional secondary prompt; splitting both into mandatory fields would
  -- double capture friction for little gain.
  asking_price_kobo     bigint check (asking_price_kobo > 0),
  -- Mandatory sibling of every amount, even while NGN-only.
  currency              text not null default 'NGN' check (char_length(currency) = 3),

  quantity              numeric(20, 6) not null check (quantity > 0),
  qty_in_base_unit      bigint not null check (qty_in_base_unit > 0),
  purchase_form         purchase_form not null,

  -- Display and comparison only. See the note above.
  unit_price_normalized numeric(20, 6) not null check (unit_price_normalized > 0),

  raw_text              text,
  mapping_confidence    numeric(3, 2) check (mapping_confidence >= 0 and mapping_confidence <= 1),
  user_confirmed        boolean not null default false,
  -- Set by the outlier guard (>3x the user's trailing median). An unconfirmed
  -- flagged line is excluded from the decomposition and disclosed (§3.2).
  outlier_flagged       boolean not null default false,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Composite FK: a line cannot disagree with its trip about currency.
  constraint purchase_lines_trip_currency_fk
    foreign key (trip_id, currency)
    references public.shopping_trips (id, currency)
    on delete cascade
);

create index purchase_lines_trip_idx      on public.purchase_lines (trip_id);
create index purchase_lines_user_idx      on public.purchase_lines (user_id);
create index purchase_lines_commodity_idx on public.purchase_lines (commodity_id);
create index purchase_lines_unit_price_idx
  on public.purchase_lines (commodity_id, unit_price_normalized);

create trigger purchase_lines_set_updated_at
  before update on public.purchase_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_budgets — monthly targets, optionally per category.
-- ---------------------------------------------------------------------------

create table public.user_budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  period_month  date not null,  -- first day of the month
  category      text,           -- null = whole-basket budget
  amount_kobo   bigint not null check (amount_kobo > 0),
  currency      text not null default 'NGN' check (char_length(currency) = 3),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (user_id, period_month, category)
);

create index user_budgets_user_month_idx on public.user_budgets (user_id, period_month desc);

create trigger user_budgets_set_updated_at
  before update on public.user_budgets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- commodity_requests — free creation of commodities is blocked because it
-- destroys the aggregation layer. Unmatched items queue here instead, so the
-- user's trip is never blocked (screen 16).
-- ---------------------------------------------------------------------------

create table public.commodity_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  raw_text     text not null,
  status       request_status not null default 'pending',
  resolved_commodity_id uuid references public.commodities (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index commodity_requests_status_idx on public.commodity_requests (status, created_at);
create index commodity_requests_user_idx   on public.commodity_requests (user_id);

create trigger commodity_requests_set_updated_at
  before update on public.commodity_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Every policy is written against auth.uid(), never auth.role(): an anonymous
-- session and the permanent account it later upgrades into share the same uid,
-- so uid-based policies survive the upgrade unchanged. A role-based policy
-- would change behaviour at exactly that boundary (§2.3).
-- ---------------------------------------------------------------------------

alter table public.users              enable row level security;
alter table public.shopping_trips     enable row level security;
alter table public.purchase_lines     enable row level security;
alter table public.user_budgets       enable row level security;
alter table public.commodity_requests enable row level security;

-- Reference data: readable by everyone, writable by no one through the API.
alter table public.locations       enable row level security;
alter table public.commodities     enable row level security;
alter table public.commodity_units enable row level security;

create policy locations_read       on public.locations       for select using (true);
create policy commodities_read     on public.commodities     for select using (true);
create policy commodity_units_read on public.commodity_units for select using (true);

create policy users_own on public.users
  for all using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy shopping_trips_own on public.shopping_trips
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy purchase_lines_own on public.purchase_lines
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy user_budgets_own on public.user_budgets
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Requests are insert-and-read-own: a user may raise one and watch it, but
-- never approve their own into the master list.
create policy commodity_requests_insert on public.commodity_requests
  for insert with check (user_id = (select auth.uid()));
create policy commodity_requests_read on public.commodity_requests
  for select using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Profile provisioning: create the public.users row the moment an auth user
-- exists, anonymous ones included. Without this the first write of a silent
-- anonymous session would fail its own foreign key.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
