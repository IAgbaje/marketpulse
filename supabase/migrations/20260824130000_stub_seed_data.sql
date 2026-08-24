-- MarketPulse — STUB seed data
--
-- This is NOT the real Phase-0 content. It exists only to unblock capture-flow
-- development and manual testing, per Technical Requirements §8.1: the real
-- ~60-item commodity master list, the unit conversion table, and the real
-- Nigeria location hierarchy are a separate deliverable requiring a named
-- owner. Do not treat this file as launch content, and do not build the
-- commodity-request queue's fallback assumptions around it.
--
-- source = 'stub' on every row, so it can be found and deleted in one query
-- (`delete from public.commodities where source = 'stub'`, etc.) whenever the
-- real content lands.

-- ---------------------------------------------------------------------------
-- Locations: Nigeria > Lagos > two LGAs > one area each > one market each.
-- Just enough depth to exercise the hierarchy, not real coverage.
-- ---------------------------------------------------------------------------

do $$
declare
  v_country_id uuid;
  v_lagos_id   uuid;
  v_mushin_lga_id uuid;
  v_ikeja_lga_id  uuid;
  v_mushin_area_id uuid;
  v_ikeja_area_id  uuid;
begin
  insert into public.locations (level, name, source)
  values ('country', 'Nigeria', 'stub')
  returning id into v_country_id;

  insert into public.locations (parent_id, level, name, source)
  values (v_country_id, 'state', 'Lagos', 'stub')
  returning id into v_lagos_id;

  insert into public.locations (parent_id, level, name, state_id, source)
  values (v_lagos_id, 'lga', 'Mushin', v_lagos_id, 'stub')
  returning id into v_mushin_lga_id;

  insert into public.locations (parent_id, level, name, state_id, source)
  values (v_lagos_id, 'lga', 'Ikeja', v_lagos_id, 'stub')
  returning id into v_ikeja_lga_id;

  insert into public.locations (parent_id, level, name, state_id, lga_id, source)
  values (v_mushin_lga_id, 'area', 'Mushin Central', v_lagos_id, v_mushin_lga_id, 'stub')
  returning id into v_mushin_area_id;

  insert into public.locations (parent_id, level, name, state_id, lga_id, source)
  values (v_ikeja_lga_id, 'area', 'Ikeja GRA', v_lagos_id, v_ikeja_lga_id, 'stub')
  returning id into v_ikeja_area_id;

  insert into public.locations (parent_id, level, name, state_id, lga_id, area_id, market_type, source)
  values
    (v_mushin_area_id, 'market', 'Mushin Market', v_lagos_id, v_mushin_lga_id, v_mushin_area_id, 'open_market', 'stub'),
    (v_ikeja_area_id, 'market', 'Ikeja City Mall', v_lagos_id, v_ikeja_lga_id, v_ikeja_area_id, 'supermarket', 'stub');
end $$;

-- ---------------------------------------------------------------------------
-- Commodities + units — covers the assessment's own worked examples
-- (fresh tomato / paste substitution) so the substitution narrative and the
-- decomposition engine both have something real to run against.
-- ---------------------------------------------------------------------------

insert into public.commodities (slug, name, category, perishability, dimension, substitute_group, source)
values
  ('fresh_tomato',   'Fresh tomato',   'vegetables', 'high',   'mass', 'tomato_group', 'stub'),
  ('tomato_paste',   'Tomato paste',   'vegetables', 'stable', 'mass', 'tomato_group', 'stub'),
  ('tinned_tomato',  'Tinned tomato',  'vegetables', 'stable', 'mass', 'tomato_group', 'stub'),
  ('pepper',         'Pepper',         'vegetables', 'high',   'mass', null,           'stub'),
  ('onion',          'Onion',          'vegetables', 'semi',   'mass', null,           'stub'),
  ('imported_rice',  'Imported rice',  'grains',     'stable', 'mass', 'rice_group',   'stub'),
  ('local_rice',     'Local rice',     'grains',     'stable', 'mass', 'rice_group',   'stub'),
  ('beans',          'Beans',          'grains',     'stable', 'mass', null,           'stub'),
  ('garri',          'Garri',         'grains',     'stable', 'mass', null,           'stub'),
  ('yam',            'Yam',            'tubers',     'semi',   'mass', null,           'stub'),
  ('palm_oil',       'Palm oil',       'oils',       'stable', 'volume', 'oil_group',  'stub'),
  ('vegetable_oil',  'Vegetable oil',  'oils',       'stable', 'volume', 'oil_group',  'stub'),
  ('frozen_fish_titus', 'Titus (frozen fish)', 'protein', 'high', 'mass', 'fish_group', 'stub'),
  ('frozen_fish_kote',  'Kote (frozen fish)',  'protein', 'high', 'mass', 'fish_group', 'stub'),
  ('eggs',           'Eggs',           'protein',    'semi',   'count', null,          'stub');

insert into public.commodity_units (commodity_id, unit_name, dimension, factor_to_base, conversion_confidence)
select id, 'kg', 'mass'::base_dimension, 1000, 1.00 from public.commodities where dimension = 'mass'
union all
select id, 'litre', 'volume'::base_dimension, 1000, 1.00 from public.commodities where dimension = 'volume'
union all
select id, 'piece', 'count'::base_dimension, 1000, 1.00 from public.commodities where dimension = 'count'
union all
select id, 'paint', 'volume'::base_dimension, 4500, 0.90 from public.commodities where slug in ('palm_oil', 'vegetable_oil')
union all
select id, 'derica', 'mass'::base_dimension, 1600, 0.70 from public.commodities where slug in ('beans', 'garri', 'imported_rice', 'local_rice');

-- Default unit = the commodity's base-dimension unit at confidence 1.00.
update public.commodities c
set default_unit_id = u.id
from public.commodity_units u
where u.commodity_id = c.id
  and u.conversion_confidence = 1.00;
