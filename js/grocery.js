/**
 * Grocery page: servings per selected recipe, scaled merged list, Supabase persistence.
 * Errors use toast (bottom-right); async work uses a full-page loading overlay.
 */
(function () {
  const supabase = window.mealPrepSupabase;
  const merge = window.ingredientMerge;
  const $ = (sel, root = document) => root.querySelector(sel);

  let recipes = [];
  /** @type {Array<{ id: string, recipe_id: string, target_servings?: number }>} */
  let weeklyRows = [];
  /** Last non-suppressed merged count (for empty-ingredient message) */
  let lastMergedCount = 0;

  let asyncDepth = 0;

  function pushAsyncLoading() {
    asyncDepth += 1;
    const el = $('#async-loading-overlay');
    if (el) {
      el.classList.add('is-visible');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function popAsyncLoading() {
    asyncDepth = Math.max(0, asyncDepth - 1);
    if (asyncDepth === 0) {
      const el = $('#async-loading-overlay');
      if (el) {
        el.classList.remove('is-visible');
        el.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function showError(message) {
    const el = $('#toast-error');
    if (!el) return;
    el.textContent = message || 'Something went wrong.';
    el.classList.add('is-visible');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.remove('is-visible'), 6000);
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      const modal = $('#modal-confirm');
      const msg = $('#confirm-message');
      const ok = $('#confirm-ok');
      const cancel = $('#confirm-cancel');
      if (!modal || !msg || !ok || !cancel) {
        resolve(false);
        return;
      }
      msg.textContent = message;
      modal.classList.add('is-open');
      function finish(v) {
        modal.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        modal.onclick = null;
        resolve(v);
      }
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      modal.onclick = (e) => {
        if (e.target === modal) finish(false);
      };
    });
  }

  async function clearAllSuppressed() {
    const { data: rows } = await supabase.from('grocery_suppressed_keys').select('match_key');
    for (const r of rows || []) {
      await supabase.from('grocery_suppressed_keys').delete().eq('match_key', r.match_key);
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function baseServings(recipe) {
    const n = recipe && recipe.servings != null ? parseInt(recipe.servings, 10) : 4;
    return Number.isFinite(n) && n >= 1 ? n : 4;
  }

  function rowTargetServings(row, recipe) {
    const t = row.target_servings != null ? parseInt(row.target_servings, 10) : baseServings(recipe);
    return Number.isFinite(t) && t >= 1 ? t : baseServings(recipe);
  }

  /** Initial load: recipes + weekly rows, then reconcile list */
  async function loadData() {
    pushAsyncLoading();
    const { data: r, error: e1 } = await supabase.from('recipes').select('*').order('name');
    if (e1) {
      popAsyncLoading();
      console.error(e1);
      showError(e1.message);
      return;
    }
    recipes = r || [];

    const { data: sel, error: e2 } = await supabase.from('weekly_selection').select('id, recipe_id, target_servings');
    if (e2) {
      popAsyncLoading();
      console.error(e2);
      showError(e2.message);
      return;
    }
    weeklyRows = sel || [];

    popAsyncLoading();
    renderRecipeSection();
    await reconcileGroceryList();
    const pl = $('#page-loading');
    if (pl) pl.classList.add('hidden');
  }

  function renderRecipeSection() {
    const list = $('#recipe-pick-list');
    const emptyMsg = $('#recipes-empty-msg');
    if (!list || !emptyMsg) return;

    list.innerHTML = '';

    if (!weeklyRows.length) {
      emptyMsg.classList.remove('hidden');
      list.classList.add('hidden');
      return;
    }

    emptyMsg.classList.add('hidden');
    list.classList.remove('hidden');

    weeklyRows.forEach((row) => {
      const recipe = recipes.find((x) => x.id === row.recipe_id);
      if (!recipe) return;

      const rowEl = document.createElement('div');
      rowEl.className = 'recipe-pick-row';

      const name = document.createElement('span');
      name.className = 'recipe-pick-name';
      name.textContent = recipe.name;

      const stepper = document.createElement('div');
      stepper.className = 'servings-stepper';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'btn btn-secondary btn-sm btn-icon-square';
      minus.textContent = '−';
      minus.setAttribute('aria-label', 'Decrease servings');

      const label = document.createElement('span');
      label.className = 'servings-label';
      const ts = rowTargetServings(row, recipe);
      label.textContent = `${ts} servings`;

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'btn btn-secondary btn-sm btn-icon-square';
      plus.textContent = '+';
      plus.setAttribute('aria-label', 'Increase servings');

      minus.addEventListener('click', () => adjustServings(row.id, recipe, -1, label));
      plus.addEventListener('click', () => adjustServings(row.id, recipe, 1, label));

      stepper.appendChild(minus);
      stepper.appendChild(label);
      stepper.appendChild(plus);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-secondary btn-sm';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => removeRecipeFromWeek(row.recipe_id));

      rowEl.appendChild(name);
      rowEl.appendChild(stepper);
      rowEl.appendChild(rm);
      list.appendChild(rowEl);
    });
  }

  async function adjustServings(rowId, recipe, delta, labelEl) {
    const row = weeklyRows.find((w) => w.id === rowId);
    if (!row) return;
    const current = rowTargetServings(row, recipe);
    const next = Math.max(1, current + delta);
    pushAsyncLoading();
    const { error } = await supabase.from('weekly_selection').update({ target_servings: next }).eq('id', rowId);
    popAsyncLoading();
    if (error) {
      showError(error.message);
      return;
    }
    row.target_servings = next;
    if (labelEl) labelEl.textContent = `${next} servings`;
    // Servings changes recalc quantities; keep suppression table as-is
    await reconcileGroceryList();
  }

  async function removeRecipeFromWeek(recipeId) {
    pushAsyncLoading();
    const { error } = await supabase.from('weekly_selection').delete().eq('recipe_id', recipeId);
    popAsyncLoading();
    if (error) {
      showError(error.message);
      return;
    }
    weeklyRows = weeklyRows.filter((w) => w.recipe_id !== recipeId);
    await clearAllSuppressed();
    renderRecipeSection();
    await reconcileGroceryList();
  }

  /**
   * Rebuild merged lines from recipes + servings, sync grocery_list_lines (and source_tag).
   */
  async function reconcileGroceryList() {
    const emptyIngredients = $('#grocery-empty-ingredients');
    const toolbar = $('#grocery-toolbar');

    const selectedRecipes = weeklyRows
      .map((w) => recipes.find((r) => r.id === w.recipe_id))
      .filter(Boolean);

    const selections = weeklyRows
      .map((w) => {
        const recipe = recipes.find((r) => r.id === w.recipe_id);
        if (!recipe) return null;
        return { recipe, targetServings: rowTargetServings(w, recipe) };
      })
      .filter(Boolean);

    const merged = merge.mergeScaledForGrocery(selections);

    const { data: suppressedRows } = await supabase.from('grocery_suppressed_keys').select('match_key');
    const suppressed = new Set((suppressedRows || []).map((x) => x.match_key));
    const visibleMerged = merged.filter((m) => !suppressed.has(m.matchKey));
    lastMergedCount = visibleMerged.length;

    const { data: existingLines, error: lineErr } = await supabase
      .from('grocery_list_lines')
      .select('*')
      .order('sort_order', { ascending: true });
    if (lineErr) {
      console.error(lineErr);
      showError(lineErr.message);
      return;
    }
    const existing = existingLines || [];

    if (!weeklyRows.length) {
      const toRemove = existing.filter((l) => !l.is_custom).map((l) => l.id);
      pushAsyncLoading();
      for (const id of toRemove) {
        await supabase.from('grocery_list_lines').delete().eq('id', id);
      }
      popAsyncLoading();
      if (emptyIngredients) emptyIngredients.classList.add('hidden');
      if (toolbar) toolbar.classList.add('hidden');
      await renderGroceryLines();
      return;
    }

    const custom = existing.filter((l) => l.is_custom);
    const nonCustom = existing.filter((l) => !l.is_custom);

    const keptNonCustomIds = [];
    let sortOrder = 0;

    pushAsyncLoading();
    for (const m of visibleMerged) {
      let row = nonCustom.find((l) => l.match_key === m.matchKey);
      if (row) {
        await supabase
          .from('grocery_list_lines')
          .update({
            sort_order: sortOrder,
            line_text: m.displayText,
            source_tag: m.sourceTag || null,
            servings_multiplier: m.servings_multiplier ?? 1,
          })
          .eq('id', row.id);
        keptNonCustomIds.push(row.id);
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from('grocery_list_lines')
          .insert({
            match_key: m.matchKey,
            line_text: m.displayText,
            source_tag: m.sourceTag || null,
            is_checked: false,
            sort_order: sortOrder,
            is_custom: false,
            servings_multiplier: m.servings_multiplier ?? 1,
          })
          .select('id')
          .single();
        if (insErr) {
          popAsyncLoading();
          console.error(insErr);
          showError(insErr.message);
          return;
        }
        keptNonCustomIds.push(inserted.id);
      }
      sortOrder += 1;
    }

    for (const row of nonCustom) {
      if (!keptNonCustomIds.includes(row.id)) {
        await supabase.from('grocery_list_lines').delete().eq('id', row.id);
      }
    }

    for (const row of custom) {
      await supabase.from('grocery_list_lines').update({ sort_order: sortOrder }).eq('id', row.id);
      sortOrder += 1;
    }
    popAsyncLoading();

    const customOnly = custom.length;
    const showIngredientEmpty = visibleMerged.length === 0 && customOnly === 0;
    if (emptyIngredients) emptyIngredients.classList.toggle('hidden', !showIngredientEmpty);
    if (toolbar) toolbar.classList.remove('hidden');

    await renderGroceryLines();
  }

  async function renderGroceryLines() {
    const { data: lines, error } = await supabase.from('grocery_list_lines').select('*');
    if (error) {
      showError(error.message);
      return;
    }

    const arr = lines || [];
    const sorted = arr.slice().sort((a, b) => {
      if (a.is_checked === b.is_checked) return (a.sort_order || 0) - (b.sort_order || 0);
      return a.is_checked ? 1 : -1;
    });

    const wrap = $('#grocery-lines');
    if (wrap) wrap.innerHTML = '';

    const anyChecked = arr.some((l) => l.is_checked);
    const btnClr = $('#btn-clear-checked');
    if (btnClr) btnClr.classList.toggle('hidden', !anyChecked);

    sorted.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'grocery-line' + (line.is_checked ? ' is-checked' : '');
      row.dataset.lineId = line.id;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = line.is_checked;
      cb.addEventListener('change', async () => {
        pushAsyncLoading();
        await supabase.from('grocery_list_lines').update({ is_checked: cb.checked }).eq('id', line.id);
        popAsyncLoading();
        await renderGroceryLines();
      });

      const main = document.createElement('div');
      main.className = 'grocery-line-main';

      const text = document.createElement('input');
      text.type = 'text';
      text.className = 'line-display';
      text.value = line.line_text;
      text.setAttribute('aria-label', 'Ingredient line');
      let debounce;
      text.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          pushAsyncLoading();
          await supabase.from('grocery_list_lines').update({ line_text: text.value }).eq('id', line.id);
          popAsyncLoading();
        }, 400);
      });

      main.appendChild(text);
      if (line.source_tag && String(line.source_tag).includes('recipes')) {
        const tag = document.createElement('span');
        tag.className = 'source-tag';
        tag.textContent = line.source_tag;
        main.appendChild(tag);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-icon';
      del.setAttribute('aria-label', 'Remove item');
      del.textContent = '×';
      del.addEventListener('click', () => deleteLine(line));

      row.appendChild(cb);
      row.appendChild(main);
      row.appendChild(del);
      if (wrap) wrap.appendChild(row);
    });
  }

  async function deleteLine(line) {
    pushAsyncLoading();
    if (line.is_custom) {
      await supabase.from('grocery_list_lines').delete().eq('id', line.id);
    } else if (line.match_key) {
      await supabase.from('grocery_suppressed_keys').upsert({ match_key: line.match_key }, { onConflict: 'match_key' });
      await supabase.from('grocery_list_lines').delete().eq('id', line.id);
    } else {
      await supabase.from('grocery_list_lines').delete().eq('id', line.id);
    }
    popAsyncLoading();
    await reconcileGroceryList();
  }

  async function addCustomLine() {
    const inp = $('#input-custom-item');
    const v = inp && inp.value.trim();
    if (!v) return;

    pushAsyncLoading();
    const { data: lines } = await supabase
      .from('grocery_list_lines')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1);
    const nextOrder = lines && lines.length ? lines[0].sort_order + 1 : 0;

    const { error } = await supabase.from('grocery_list_lines').insert({
      match_key: null,
      line_text: v,
      is_checked: false,
      sort_order: nextOrder,
      is_custom: true,
      source_tag: null,
    });
    popAsyncLoading();
    if (error) {
      showError(error.message);
      return;
    }
    inp.value = '';
    const emptyIng = $('#grocery-empty-ingredients');
    if (emptyIng) emptyIng.classList.add('hidden');
    await renderGroceryLines();
  }

  async function clearCheckedItems() {
    pushAsyncLoading();
    const { data: rows } = await supabase.from('grocery_list_lines').select('id').eq('is_checked', true);
    for (const r of rows || []) {
      await supabase.from('grocery_list_lines').delete().eq('id', r.id);
    }
    popAsyncLoading();
    await renderGroceryLines();
  }

  async function clearAllGrocery() {
    if (!(await showConfirm('Clear the entire grocery list? This cannot be undone.'))) return;
    pushAsyncLoading();
    const { data: all } = await supabase.from('grocery_list_lines').select('id');
    for (const r of all || []) {
      await supabase.from('grocery_list_lines').delete().eq('id', r.id);
    }
    await clearAllSuppressed();
    popAsyncLoading();
    await reconcileGroceryList();
  }

  function init() {
    if (!supabase) {
      showError('Supabase is not configured.');
      return;
    }
    if (!merge || !merge.mergeScaledForGrocery) {
      showError('ingredientMerge.js failed to load.');
      return;
    }

    $('#btn-back').addEventListener('click', () => {
      window.location.href = 'index.html';
    });

    $('#btn-add-custom').addEventListener('click', addCustomLine);
    const inp = $('#input-custom-item');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addCustomLine();
        }
      });
    }

    const btnChk = $('#btn-clear-checked');
    if (btnChk) btnChk.addEventListener('click', clearCheckedItems);

    const btnAll = $('#btn-clear-all');
    if (btnAll) btnAll.addEventListener('click', clearAllGrocery);

    const confirmPanel = $('#modal-confirm .modal-panel');
    if (confirmPanel) confirmPanel.addEventListener('click', (e) => e.stopPropagation());

    loadData();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
