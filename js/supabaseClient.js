/**
 * Shared Supabase client singleton (loaded after config + CDN script).
 */
(function () {
  const cfg = window.MEAL_PREP_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error('MEAL_PREP_CONFIG missing supabaseUrl or supabaseAnonKey');
    window.mealPrepSupabase = null;
    return;
  }
  window.mealPrepSupabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
})();
