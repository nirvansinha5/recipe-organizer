-- Meal Prep Recipe Organizer — database schema
-- Run in Supabase SQL Editor. For existing projects, run the MIGRATION block below first if tables already exist.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- recipes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  image_url text,
  prep_time integer,
  difficulty text CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
  cost_estimate text CHECK (cost_estimate IN ('Low', 'Medium', 'High')),
  cuisine text,
  protein_grams integer,
  equipment text[] DEFAULT '{}',
  -- Each element is a JSON string: {"name":"olive oil","quantity":"2","unit":"tbsp"}
  ingredients text[] DEFAULT '{}',
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  servings integer NOT NULL DEFAULT 4
);

-- ---------------------------------------------------------------------------
-- weekly_selection (target_servings = planned servings for grocery scaling)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.weekly_selection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES public.recipes (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  target_servings integer NOT NULL DEFAULT 4,
  UNIQUE (recipe_id)
);

-- ---------------------------------------------------------------------------
-- grocery_list_lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.grocery_list_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key text,
  line_text text NOT NULL,
  is_checked boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_custom boolean NOT NULL DEFAULT false,
  servings_multiplier numeric NOT NULL DEFAULT 1.0,
  source_tag text
);

CREATE INDEX IF NOT EXISTS idx_grocery_list_lines_sort ON public.grocery_list_lines (sort_order);

-- ---------------------------------------------------------------------------
-- grocery_suppressed_keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.grocery_suppressed_keys (
  match_key text PRIMARY KEY
);

-- ---------------------------------------------------------------------------
-- MIGRATION: safe adds for databases created before this revision
-- ---------------------------------------------------------------------------
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS servings integer NOT NULL DEFAULT 4;
ALTER TABLE public.weekly_selection ADD COLUMN IF NOT EXISTS target_servings integer NOT NULL DEFAULT 4;
ALTER TABLE public.grocery_list_lines ADD COLUMN IF NOT EXISTS servings_multiplier numeric NOT NULL DEFAULT 1.0;
ALTER TABLE public.grocery_list_lines ADD COLUMN IF NOT EXISTS source_tag text;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_list_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_suppressed_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recipes_anon_all" ON public.recipes;
CREATE POLICY "recipes_anon_all" ON public.recipes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "weekly_selection_anon_all" ON public.weekly_selection;
CREATE POLICY "weekly_selection_anon_all" ON public.weekly_selection FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "grocery_list_lines_anon_all" ON public.grocery_list_lines;
CREATE POLICY "grocery_list_lines_anon_all" ON public.grocery_list_lines FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "grocery_suppressed_keys_anon_all" ON public.grocery_suppressed_keys;
CREATE POLICY "grocery_suppressed_keys_anon_all" ON public.grocery_suppressed_keys FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Seed / refresh starter recipes (fixed UUIDs)
-- ---------------------------------------------------------------------------
INSERT INTO public.recipes (
  id, name, image_url, prep_time, difficulty, cost_estimate, cuisine, protein_grams,
  equipment, ingredients, instructions, servings
) VALUES
(
  'a1000000-0000-4000-8000-000000000001',
  'Shawarma Chicken Rice Bowl',
  NULL,
  35,
  'Easy',
  'Low',
  'Middle Eastern',
  42,
  ARRAY['Pan']::text[],
  ARRAY[
    '{"name":"chicken thighs","quantity":"1.5","unit":"lb"}',
    '{"name":"shawarma spice blend","quantity":"2","unit":"tbsp"}',
    '{"name":"garlic","quantity":"4","unit":"clove"}',
    '{"name":"olive oil","quantity":"3","unit":"tbsp"}',
    '{"name":"basmati rice","quantity":"2","unit":"cup"}',
    '{"name":"cucumber","quantity":"1","unit":"whole"}',
    '{"name":"tomato","quantity":"2","unit":"whole"}',
    '{"name":"tahini sauce","quantity":"0.25","unit":"cup"}',
    '{"name":"pita bread","quantity":"4","unit":"whole"}'
  ]::text[],
  '1. Marinate chicken thighs with shawarma spice, garlic, and olive oil for at least 30 minutes (or overnight).
2. Pan-sear chicken until cooked through and lightly charred; rest and slice.
3. Cook basmati rice according to package directions.
4. Dice cucumber and tomato for a fresh salad.
5. Warm pita if desired. Assemble bowls with rice, chicken, vegetables, and drizzle tahini sauce.',
  4
),
(
  'a1000000-0000-4000-8000-000000000002',
  'Teriyaki Chicken Broccoli Rice Bowl',
  NULL,
  30,
  'Easy',
  'Low',
  'Japanese',
  38,
  ARRAY['Pan', 'Wok']::text[],
  ARRAY[
    '{"name":"chicken breast","quantity":"1.5","unit":"lb"}',
    '{"name":"teriyaki sauce","quantity":"0.33","unit":"cup"}',
    '{"name":"broccoli","quantity":"3","unit":"cup"}',
    '{"name":"jasmine rice","quantity":"2","unit":"cup"}',
    '{"name":"sesame seeds","quantity":"1","unit":"tbsp"}',
    '{"name":"soy sauce","quantity":"2","unit":"tbsp"}',
    '{"name":"ginger","quantity":"1","unit":"tsp"}',
    '{"name":"garlic","quantity":"3","unit":"clove"}'
  ]::text[],
  '1. Cut chicken breast into bite-sized pieces; stir-fry in a pan or wok until golden.
2. Add ginger and garlic; cook briefly until fragrant.
3. Add broccoli and a splash of water; cover and steam until tender-crisp.
4. Pour in teriyaki sauce and soy sauce; simmer until chicken is glazed.
5. Serve over cooked jasmine rice and sprinkle with sesame seeds.',
  4
),
(
  'a1000000-0000-4000-8000-000000000003',
  'Red Sauce Pasta with Sausage',
  NULL,
  25,
  'Easy',
  'Low',
  'Italian',
  35,
  ARRAY['Pan', 'Pot']::text[],
  ARRAY[
    '{"name":"pork sausage","quantity":"1","unit":"lb"}',
    '{"name":"rigatoni pasta","quantity":"12","unit":"oz"}',
    '{"name":"crushed tomatoes","quantity":"28","unit":"oz"}',
    '{"name":"garlic","quantity":"4","unit":"clove"}',
    '{"name":"onion","quantity":"1","unit":"whole"}',
    '{"name":"olive oil","quantity":"2","unit":"tbsp"}',
    '{"name":"basil","quantity":"0.25","unit":"cup"}',
    '{"name":"parmesan","quantity":"0.5","unit":"cup"}'
  ]::text[],
  '1. Boil rigatoni in salted water until al dente; reserve a little pasta water.
2. In a pan, brown crumbled pork sausage; set aside.
3. Sauté onion and garlic in olive oil; add crushed tomatoes and simmer 15 minutes.
4. Stir in basil and sausage; loosen with pasta water if needed.
5. Toss with drained pasta and finish with grated parmesan.',
  4
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  image_url = EXCLUDED.image_url,
  prep_time = EXCLUDED.prep_time,
  difficulty = EXCLUDED.difficulty,
  cost_estimate = EXCLUDED.cost_estimate,
  cuisine = EXCLUDED.cuisine,
  protein_grams = EXCLUDED.protein_grams,
  equipment = EXCLUDED.equipment,
  ingredients = EXCLUDED.ingredients,
  instructions = EXCLUDED.instructions,
  servings = EXCLUDED.servings;
