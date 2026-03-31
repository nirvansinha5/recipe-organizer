/**
 * Meal Prep — recipe library, search, range filters, weekly cart, modals.
 * Supabase only; credentials come from js/config.js (MEAL_PREP_CONFIG).
 */
(function () {
  const supabase = window.mealPrepSupabase;
  const parseIng = window.ingredientMerge && window.ingredientMerge.parseIngredientElement;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let recipes = [];
  /** recipe_id -> weekly_selection row (includes target_servings when column exists) */
  let selectionByRecipeId = new Map();

  let formEquipment = [];
  /** @type {Array<{ name: string, quantity: string, unit: string }>} */
  let formIngredientRows = [];
  /** Instruction step texts (display order); serialized with numbered prefixes on save. */
  let formInstructionSteps = [];
  /** Lowercase protein type slugs (allowed set only). */
  let formProteinTypes = [];
  /** Snapshot from last openFormModal for dirty detection. */
  let formInitialSnapshot = null;
  /** Slugs removed from protein types by user; auto-detect skips until recipe name changes. */
  const proteinTypeUserRemoved = new Set();
  let lastDebouncedNameForProtein = '';
  let formNameDebounceTimer = null;
  let proteinAutoHintTimer = null;

  let asyncLoadingDepth = 0;

  /** Grouped unit options for ingredient rows (matches spec). */
  const INGREDIENT_UNIT_GROUPS = [
    { label: 'Volume — Imperial', options: ['tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'quart', 'gallon'] },
    { label: 'Volume — Metric', options: ['ml', 'l'] },
    { label: 'Weight — Imperial', options: ['oz', 'lb'] },
    { label: 'Weight — Metric', options: ['g', 'kg'] },
    {
      label: 'Count',
      options: ['whole', 'clove', 'slice', 'piece', 'sprig', 'bunch', 'handful', 'stalk', 'head', 'sheet', 'can', 'package'],
    },
    { label: 'Other', options: ['pinch', 'dash', 'drop', 'to taste', 'as needed'] },
  ];

  const PROTEIN_TYPE_ORDER = [
    'chicken',
    'beef',
    'pork',
    'fish',
    'seafood',
    'egg',
    'tofu',
    'lamb',
    'turkey',
    'veggies',
    'other',
  ];

  const PROTEIN_TYPE_ALLOWED = new Set(PROTEIN_TYPE_ORDER);

  const PROTEIN_TYPE_LABELS = {
    chicken: 'Chicken',
    beef: 'Beef',
    pork: 'Pork',
    fish: 'Fish',
    seafood: 'Seafood',
    egg: 'Egg',
    tofu: 'Tofu',
    lamb: 'Lamb',
    turkey: 'Turkey',
    veggies: 'Veggies',
    other: 'Other',
  };

  const PROTEIN_KEYWORD_RULES = [
    [/\b(chicken|hen)\b/, 'chicken'],
    [/\b(beef|steak|brisket)\b/, 'beef'],
    [/\b(pork|sausage|bacon|ham|pancetta)\b/, 'pork'],
    [/\b(salmon|tuna|cod|tilapia|fish|trout|halibut|mahi)\b/, 'fish'],
    [/\b(shrimp|prawn|lobster|crab|scallop|seafood|squid|calamari)\b/, 'seafood'],
    [/\b(egg|eggs)\b/, 'egg'],
    [/\btofu\b/, 'tofu'],
    [/\b(lamb|mutton)\b/, 'lamb'],
    [/\bturkey\b/, 'turkey'],
    [/\b(veggie|vegan|vegetarian|plant)\b/, 'veggies'],
  ];

  // --- Global async loading overlay (all Supabase calls) --------------------

  function pushAsyncLoading() {
    asyncLoadingDepth += 1;
    const el = $('#async-loading-overlay');
    if (el) {
      el.classList.add('is-visible');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function popAsyncLoading() {
    asyncLoadingDepth = Math.max(0, asyncLoadingDepth - 1);
    if (asyncLoadingDepth === 0) {
      const el = $('#async-loading-overlay');
      if (el) {
        el.classList.remove('is-visible');
        el.setAttribute('aria-hidden', 'true');
      }
    }
  }

  async function withAsyncLoading(promiseFn) {
    pushAsyncLoading();
    try {
      return await promiseFn();
    } finally {
      popAsyncLoading();
    }
  }

  // --- Toast (bottom-right): errors only -----------------------------------

  function showError(message) {
    const el = $('#toast-error');
    if (!el) return;
    el.textContent = message || 'Something went wrong. Please try again.';
    el.classList.add('is-visible');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.remove('is-visible'), 6000);
  }

  /** In-app confirm (replaces window.confirm for destructive actions). */
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

  /** Unsaved form close: Go Back = false, Continue = discard and close. */
  function showFormUnsavedConfirm() {
    return new Promise((resolve) => {
      const modal = $('#modal-form-unsaved');
      const goBack = $('#form-unsaved-go-back');
      const cont = $('#form-unsaved-continue');
      if (!modal || !goBack || !cont) {
        resolve(false);
        return;
      }
      modal.classList.add('is-open');

      function finish(stayOnForm) {
        modal.classList.remove('is-open');
        goBack.onclick = null;
        cont.onclick = null;
        modal.onclick = null;
        resolve(!stayOnForm);
      }

      goBack.onclick = () => finish(true);
      cont.onclick = () => finish(false);
      modal.onclick = (e) => {
        if (e.target === modal) finish(true);
      };
    });
  }

  function formatDisplayWords(str) {
    const s = String(str || '').trim();
    if (!s) return '';
    return s
      .split(/\s+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
      .filter(Boolean)
      .join(' ');
  }

  function formatDisplayCuisine(raw) {
    return formatDisplayWords(raw);
  }

  function formatDisplayEquipment(raw) {
    return formatDisplayWords(raw);
  }

  function formatDisplayProteinType(slug) {
    const k = String(slug || '').trim().toLowerCase();
    return PROTEIN_TYPE_LABELS[k] || formatDisplayWords(k);
  }

  function normalizeCuisineForSave(raw) {
    const t = String(raw || '').trim().toLowerCase();
    return t || null;
  }

  function normalizeProteinTypeArray(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      const k = String(x || '').trim().toLowerCase();
      if (PROTEIN_TYPE_ALLOWED.has(k) && !out.includes(k)) out.push(k);
    }
    return PROTEIN_TYPE_ORDER.filter((k) => out.includes(k));
  }

  function detectProteinTypesFromName(nameLower) {
    const out = [];
    for (const [re, type] of PROTEIN_KEYWORD_RULES) {
      if (re.test(nameLower) && !out.includes(type)) out.push(type);
    }
    return out;
  }

  function getFormState() {
    return {
      name: $('#form-name').value.trim(),
      image_url: $('#form-image').value.trim(),
      prep_time: $('#form-prep').value.trim(),
      servings: $('#form-servings').value.trim(),
      difficulty: $('#form-difficulty').value,
      cost_estimate: $('#form-cost').value,
      cuisine: $('#form-cuisine').value.trim(),
      protein_grams: $('#form-protein').value.trim(),
      equipment: [...formEquipment].map((e) => String(e).trim().toLowerCase()).filter(Boolean).sort(),
      protein_type: [...formProteinTypes].map((p) => String(p).trim().toLowerCase()).filter(Boolean).sort(),
      ingredients: formIngredientRows.map((r) => ({
        name: String(r.name || '').trim().toLowerCase(),
        quantity: String(r.quantity || '').trim(),
        unit: String(r.unit || '').trim(),
      })),
      instructions: formInstructionSteps.map((s) => String(s || '').trim()),
    };
  }

  function isFormDirty() {
    if (!formInitialSnapshot) return false;
    return JSON.stringify(getFormState()) !== JSON.stringify(formInitialSnapshot);
  }

  async function requestCloseFormModal() {
    if (!isFormDirty()) {
      formInitialSnapshot = null;
      closeModal($('#modal-form'));
      return;
    }
    const discard = await showFormUnsavedConfirm();
    if (discard) {
      formInitialSnapshot = null;
      closeModal($('#modal-form'));
    }
  }

  function hideProteinTypeSuggestions() {
    const box = $('#protein-type-suggestions');
    const inp = $('#protein-type-input');
    if (box) {
      box.classList.add('hidden');
      box.innerHTML = '';
    }
    if (inp) inp.setAttribute('aria-expanded', 'false');
  }

  function showProteinAutoHint() {
    const el = $('#protein-type-autohint');
    if (!el) return;
    el.classList.remove('hidden');
    clearTimeout(proteinAutoHintTimer);
    proteinAutoHintTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3000);
  }

  function scheduleProteinDetectFromName() {
    clearTimeout(formNameDebounceTimer);
    formNameDebounceTimer = setTimeout(() => {
      const name = $('#form-name').value;
      const nameLower = name.toLowerCase();
      if (nameLower !== lastDebouncedNameForProtein) {
        proteinTypeUserRemoved.clear();
        lastDebouncedNameForProtein = nameLower;
      }
      const detected = detectProteinTypesFromName(nameLower);
      let added = false;
      for (const t of detected) {
        if (proteinTypeUserRemoved.has(t)) continue;
        if (!formProteinTypes.includes(t)) {
          formProteinTypes.push(t);
          added = true;
        }
      }
      if (added) {
        formProteinTypes = normalizeProteinTypeArray(formProteinTypes);
        renderProteinTypeChips();
        updateProteinTypeSuggestions();
        showProteinAutoHint();
      }
    }, 600);
  }

  function renderProteinTypeChips() {
    const wrap = $('#protein-type-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    formProteinTypes.forEach((slug, idx) => {
      const span = document.createElement('span');
      span.className = 'badge badge-accent';
      span.style.cursor = 'pointer';
      span.title = 'Click to remove';
      span.textContent = `${formatDisplayProteinType(slug)} ×`;
      span.addEventListener('click', () => {
        proteinTypeUserRemoved.add(slug);
        formProteinTypes.splice(idx, 1);
        renderProteinTypeChips();
        updateProteinTypeSuggestions();
      });
      wrap.appendChild(span);
    });
  }

  function updateProteinTypeSuggestions() {
    const box = $('#protein-type-suggestions');
    const inp = $('#protein-type-input');
    if (!box || !inp) return;
    const q = inp.value.trim().toLowerCase();
    const avail = PROTEIN_TYPE_ORDER.filter((slug) => {
      if (formProteinTypes.includes(slug)) return false;
      if (!q) return true;
      const label = formatDisplayProteinType(slug).toLowerCase();
      return label.includes(q) || slug.includes(q);
    });
    box.innerHTML = '';
    avail.forEach((slug) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'protein-type-suggestion';
      btn.setAttribute('role', 'option');
      btn.textContent = formatDisplayProteinType(slug);
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        formProteinTypes = normalizeProteinTypeArray([...formProteinTypes, slug]);
        inp.value = '';
        renderProteinTypeChips();
        updateProteinTypeSuggestions();
        hideProteinTypeSuggestions();
        inp.focus();
      });
      box.appendChild(btn);
    });
    if (!avail.length) {
      box.classList.add('hidden');
      inp.setAttribute('aria-expanded', 'false');
      return;
    }
    box.classList.remove('hidden');
    inp.setAttribute('aria-expanded', 'true');
  }

  function setLibraryLoading(on) {
    const row = $('#library-loading');
    if (row) row.classList.toggle('hidden', !on);
  }

  // --- Placeholder SVG (fork + knife) --------------------------------------

  function appendImagePlaceholder(container) {
    const wrap = document.createElement('div');
    wrap.className = 'recipe-card-placeholder-svg';
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="#BBBBBB" stroke-width="1.5" width="40" height="40" aria-hidden="true">' +
      '<path d="M3 2v7c0 1.1.9 2 2 2h4v11h2V2H3z"/>' +
      '<path d="M16 2v4h-2v4h2v12h2V2h-2z"/>' +
      '</svg>';
    container.appendChild(wrap);
  }

  // --- Data load ------------------------------------------------------------

  async function loadRecipes() {
    if (!supabase) {
      showError('Supabase is not configured. Check js/config.js.');
      return;
    }
    setLibraryLoading(true);
    const { data, error } = await supabase.from('recipes').select('*').order('created_at', { ascending: false });
    setLibraryLoading(false);
    if (error) {
      console.error(error);
      showError(error.message || 'Could not load recipes.');
      return;
    }
    recipes = data || [];
    buildFilterChips();
    applyFiltersAndRender();
    const emptyLib = $('#empty-library');
    if (emptyLib) emptyLib.classList.toggle('hidden', recipes.length > 0);
  }

  async function loadWeeklySelection() {
    if (!supabase) return;
    pushAsyncLoading();
    const { data, error } = await supabase.from('weekly_selection').select('id, recipe_id, added_at, target_servings');
    popAsyncLoading();
    if (error) {
      console.error(error);
      showError(error.message || 'Could not load weekly selection.');
      return;
    }
    selectionByRecipeId = new Map();
    (data || []).forEach((row) => selectionByRecipeId.set(row.recipe_id, row));
    renderCart();
    applyFiltersAndRender();
    const detailBd = $('#modal-detail');
    if (detailBd && detailBd.classList.contains('is-open') && detailBd.dataset.recipeDetailId) {
      const dr = recipes.find((x) => x.id === detailBd.dataset.recipeDetailId);
      if (dr) wireDetailWeekButton(dr);
    }
  }

  // --- Filter chips ---------------------------------------------------------

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  function buildFilterChips() {
    const diffOrder = ['Easy', 'Medium', 'Hard'];
    const diffSet = new Set(recipes.map((r) => r.difficulty).filter(Boolean));
    const difficulties = diffOrder.filter((d) => diffSet.has(d));
    const cuisines = uniqueSorted(recipes.map((r) => r.cuisine));
    const costs = uniqueSorted(recipes.map((r) => r.cost_estimate));
    const equipSet = new Set();
    recipes.forEach((r) => (r.equipment || []).forEach((e) => equipSet.add(e)));
    const equipment = Array.from(equipSet).sort((a, b) => a.localeCompare(b));
    const proteinTypeSet = new Set();
    recipes.forEach((r) => (r.protein_type || []).forEach((p) => proteinTypeSet.add(p)));
    const proteinTypes = Array.from(proteinTypeSet).sort((a, b) => a.localeCompare(b));

    renderChipGroup('#filter-difficulty', 'diff', difficulties);
    renderChipGroup('#filter-cuisine', 'cuisine', cuisines, formatDisplayCuisine);
    renderChipGroup('#filter-cost', 'cost', costs);
    renderChipGroup('#filter-equipment', 'eq', equipment, formatDisplayEquipment);
    renderChipGroup('#filter-protein-type', 'ptype', proteinTypes, formatDisplayProteinType);
  }

  function renderChipGroup(containerSel, prefix, values, displayFn) {
    const container = $(containerSel);
    if (!container) return;
    const fmt = displayFn || ((v) => v);
    container.innerHTML = '';
    values.forEach((val, i) => {
      const id = `${prefix}-${i}-${String(val).replace(/\s+/g, '-')}`;
      const label = document.createElement('label');
      label.className = 'chip-toggle';
      label.innerHTML = `<input type="checkbox" name="${prefix}" value="${escapeAttr(val)}" id="${id}" /><span>${escapeHtml(fmt(val))}</span>`;
      container.appendChild(label);
    });
    container.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', applyFiltersAndRender));
  }

  function getCheckedValues(containerSel) {
    return $$(`${containerSel} input:checked`).map((el) => el.value);
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  /** Filter + sort pipeline: search, sliders, chips, then grid + count */
  function applyFiltersAndRender() {
    const diff = getCheckedValues('#filter-difficulty');
    const cuisine = getCheckedValues('#filter-cuisine');
    const cost = getCheckedValues('#filter-cost');
    const equip = getCheckedValues('#filter-equipment');
    const proteinType = getCheckedValues('#filter-protein-type');
    const sortVal = $('#sort-select') ? $('#sort-select').value : 'prep_asc';

    const searchEl = $('#recipe-search');
    const q = (searchEl && searchEl.value.trim().toLowerCase()) || '';

    const maxPrep = $('#slider-max-prep') ? parseInt($('#slider-max-prep').value, 10) : 120;
    const minProtein = $('#slider-min-protein') ? parseInt($('#slider-min-protein').value, 10) : 0;

    const total = recipes.length;
    let list = recipes.slice();

    if (q) list = list.filter((r) => (r.name || '').toLowerCase().includes(q));
    if (diff.length) list = list.filter((r) => diff.includes(r.difficulty));
    if (cuisine.length) list = list.filter((r) => cuisine.includes(r.cuisine));
    if (cost.length) list = list.filter((r) => cost.includes(r.cost_estimate));
    if (equip.length) {
      list = list.filter((r) => {
        const set = new Set(r.equipment || []);
        return equip.every((e) => set.has(e));
      });
    }
    if (proteinType.length) {
      list = list.filter((r) => {
        const set = new Set(r.protein_type || []);
        return proteinType.some((p) => set.has(p));
      });
    }

    list = list.filter((r) => {
      const pt = r.prep_time != null ? r.prep_time : 0;
      if (pt > maxPrep) return false;
      const pg = r.protein_grams != null ? r.protein_grams : 0;
      if (pg < minProtein) return false;
      return true;
    });

    const prepKey = (r) => (r.prep_time == null ? 99999 : r.prep_time);
    const proteinKey = (r) => (r.protein_grams == null ? -1 : r.protein_grams);

    switch (sortVal) {
      case 'prep_asc':
        list.sort((a, b) => prepKey(a) - prepKey(b));
        break;
      case 'prep_desc':
        list.sort((a, b) => prepKey(b) - prepKey(a));
        break;
      case 'protein_asc':
        list.sort((a, b) => proteinKey(a) - proteinKey(b));
        break;
      case 'protein_desc':
        list.sort((a, b) => proteinKey(b) - proteinKey(a));
        break;
      default:
        break;
    }

    const countEl = $('#grid-count');
    if (countEl) countEl.innerHTML = `Showing <strong>${list.length}</strong> of <strong>${total}</strong> recipes`;

    renderRecipeGrid(list);
  }

  function renderRecipeGrid(list) {
    const grid = $('#recipe-grid');
    if (!grid) return;
    grid.innerHTML = '';
    list.forEach((recipe) => grid.appendChild(createRecipeCard(recipe)));
  }

  function difficultyBadgeClass(d) {
    if (d === 'Easy') return 'badge badge-diff-easy';
    if (d === 'Medium') return 'badge badge-diff-medium';
    if (d === 'Hard') return 'badge badge-diff-hard';
    return 'badge badge-neutral';
  }

  function createRecipeCard(recipe) {
    const card = document.createElement('article');
    card.className = 'recipe-card';
    card.dataset.recipeId = recipe.id;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'recipe-card-image-wrap';
    if (recipe.image_url) {
      const img = document.createElement('img');
      img.src = recipe.image_url;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        appendImagePlaceholder(imgWrap);
      });
      imgWrap.appendChild(img);
    } else {
      appendImagePlaceholder(imgWrap);
    }

    const body = document.createElement('div');
    body.className = 'recipe-card-body';
    const title = document.createElement('h3');
    title.className = 'recipe-card-title';
    title.textContent = recipe.name;

    const meta = document.createElement('div');
    meta.className = 'recipe-card-meta';
    const prepLine = document.createElement('div');
    prepLine.className = 'recipe-prep-line';
    prepLine.innerHTML =
      '<span class="recipe-prep-icon" aria-hidden="true">⏱</span> ' +
      (recipe.prep_time != null ? `${recipe.prep_time} min` : 'Prep time —');
    meta.appendChild(prepLine);
    if (recipe.protein_grams != null) {
      const pl = document.createElement('div');
      pl.className = 'recipe-protein-line';
      const ic = document.createElement('span');
      ic.className = 'protein-icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = '⚡';
      pl.appendChild(ic);
      pl.appendChild(document.createTextNode(` ${recipe.protein_grams}g protein`));
      meta.appendChild(pl);
    }

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (recipe.difficulty) {
      const b = document.createElement('span');
      b.className = difficultyBadgeClass(recipe.difficulty);
      b.textContent = recipe.difficulty;
      badges.appendChild(b);
    }
    if (recipe.cuisine) {
      const b = document.createElement('span');
      b.className = 'badge badge-cuisine-outline';
      b.textContent = formatDisplayCuisine(recipe.cuisine);
      badges.appendChild(b);
    }

    const actions = document.createElement('div');
    actions.className = 'recipe-card-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm btn-add-week';
    const inCart = selectionByRecipeId.has(recipe.id);
    if (inCart) {
      addBtn.classList.add('btn-add-week--added');
      addBtn.textContent = '✓ Added';
      addBtn.disabled = true;
    } else {
      addBtn.classList.add('btn-primary');
      addBtn.textContent = 'Add to This Week';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToWeek(recipe.id);
      });
    }

    actions.appendChild(addBtn);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(badges);
    body.appendChild(actions);

    card.appendChild(imgWrap);
    card.appendChild(body);
    card.addEventListener('click', () => openDetailModal(recipe));
    return card;
  }

  // --- Cart -----------------------------------------------------------------

  function appendCartListItem(listEl, r) {
    const li = document.createElement('li');
    li.className = 'cart-item';
    const span = document.createElement('span');
    span.className = 'cart-item-name';
    span.textContent = r.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'cart-item-remove';
    rm.setAttribute('aria-label', `Remove ${r.name}`);
    rm.textContent = '×';
    rm.addEventListener('click', () => removeFromWeek(r.id));
    li.appendChild(span);
    li.appendChild(rm);
    listEl.appendChild(li);
  }

  function renderCart() {
    const listEl = $('#cart-list');
    const mobileList = $('#mobile-cart-list');
    const emptyEl = $('#cart-empty');
    const mobileEmpty = $('#mobile-cart-empty');
    const btnGrocery = $('#btn-grocery');
    const mobileGrocery = $('#mobile-btn-grocery');
    const badge = $('#cart-count-badge');
    const btnClear = $('#btn-clear-week');
    const mobileClear = $('#mobile-btn-clear-week');
    const fab = $('#mobile-cart-fab');
    const fabBadge = $('#mobile-cart-fab-badge');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (mobileList) mobileList.innerHTML = '';

    const selectedRecipes = recipes.filter((r) => selectionByRecipeId.has(r.id));
    selectedRecipes.forEach((r) => {
      appendCartListItem(listEl, r);
      if (mobileList) appendCartListItem(mobileList, r);
    });

    const n = selectedRecipes.length;
    const hasItems = n > 0;
    if (emptyEl) emptyEl.classList.toggle('hidden', hasItems);
    if (mobileEmpty) mobileEmpty.classList.toggle('hidden', hasItems);
    if (btnGrocery) btnGrocery.disabled = !hasItems;
    if (mobileGrocery) mobileGrocery.disabled = !hasItems;
    if (badge) {
      badge.textContent = String(n);
      badge.classList.toggle('is-hidden', n === 0);
    }
    if (btnClear) btnClear.classList.toggle('is-hidden', !hasItems);
    if (mobileClear) mobileClear.classList.toggle('is-hidden', !hasItems);
    if (fab) fab.classList.toggle('is-hidden', n === 0);
    if (fabBadge) {
      fabBadge.textContent = String(n);
      fabBadge.classList.toggle('is-hidden', n === 0);
    }
  }

  async function addToWeek(recipeId) {
    if (selectionByRecipeId.has(recipeId)) return;
    if (!supabase) return;
    const recipe = recipes.find((r) => r.id === recipeId);
    const base = recipe && recipe.servings != null ? parseInt(recipe.servings, 10) : 4;
    const target = Number.isFinite(base) && base >= 1 ? base : 4;

    pushAsyncLoading();
    const { error } = await supabase.from('weekly_selection').insert({ recipe_id: recipeId, target_servings: target });
    popAsyncLoading();
    if (error) {
      console.error(error);
      showError(error.message || 'Could not add recipe to this week.');
      return;
    }
    await loadWeeklySelection();
  }

  async function removeFromWeek(recipeId) {
    if (!supabase) return;
    pushAsyncLoading();
    const { error } = await supabase.from('weekly_selection').delete().eq('recipe_id', recipeId);
    popAsyncLoading();
    if (error) {
      console.error(error);
      showError(error.message || 'Could not remove recipe.');
      return;
    }
    await loadWeeklySelection();
  }

  async function clearThisWeek() {
    if (!(await showConfirm('Clear all recipes from this week? This cannot be undone.'))) return;
    if (!supabase) return;
    pushAsyncLoading();
    const { data: rows, error: selErr } = await supabase.from('weekly_selection').select('id');
    if (selErr) {
      popAsyncLoading();
      showError(selErr.message || 'Could not clear selection.');
      return;
    }
    for (const r of rows || []) {
      const { error } = await supabase.from('weekly_selection').delete().eq('id', r.id);
      if (error) {
        popAsyncLoading();
        showError(error.message || 'Could not clear selection.');
        return;
      }
    }
    popAsyncLoading();
    await loadWeeklySelection();
  }

  // --- Sidebar: expanded = › (close), collapsed = ‹ (open) ------------------

  function setupSidebar() {
    const shell = $('#app-shell');
    const toggle = $('#cart-toggle');
    const icon = $('#cart-toggle-icon');
    if (!shell || !toggle || !icon) return;

    function sync() {
      const expanded = shell.classList.contains('sidebar-expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      icon.textContent = expanded ? '›' : '‹';
    }

    toggle.addEventListener('click', () => {
      shell.classList.toggle('sidebar-expanded');
      sync();
    });
    sync();
  }

  // --- Detail modal: ingredients from JSON or legacy string ----------------

  function formatIngredientDisplayLine(raw) {
    if (!parseIng) return String(raw);
    const ing = parseIng(raw);
    if (!ing) return String(raw);
    if (ing.quantity || ing.unit) {
      const q = ing.quantity ? `${ing.quantity} ` : '';
      const u = ing.unit ? `${ing.unit} ` : '';
      return `${q}${u}${ing.name}`.trim();
    }
    return ing.name;
  }

  function openDetailModal(recipe) {
    const backdrop = $('#modal-detail');
    if (!backdrop) return;
    backdrop.dataset.recipeDetailId = recipe.id;
    $('#detail-title').textContent = recipe.name;
    const body = $('#detail-body');

    let heroHtml = '';
    if (recipe.image_url) {
      heroHtml = `<div class="detail-hero"><img src="${escapeAttr(recipe.image_url)}" alt="" /></div>`;
    } else {
      heroHtml =
        '<div class="detail-hero" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#ecece8,#e0e0dc)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#BBBBBB" stroke-width="1.5" width="40" height="40" aria-hidden="true">' +
        '<path d="M3 2v7c0 1.1.9 2 2 2h4v11h2V2H3z"/><path d="M16 2v4h-2v4h2v12h2V2h-2z"/></svg></div>';
    }

    const equipBadges = (recipe.equipment || [])
      .map((e) => `<span class="badge badge-equipment-detail">${escapeHtml(formatDisplayEquipment(e))}</span>`)
      .join(' ');

    const ingredients = (recipe.ingredients || [])
      .map((line) => `<li>${escapeHtml(formatIngredientDisplayLine(line))}</li>`)
      .join('');

    const serv = recipe.servings != null ? recipe.servings : 4;
    const prepLine =
      recipe.prep_time != null ? `<div class="detail-prep-line"><span aria-hidden="true">⏱</span> ${recipe.prep_time} min</div>` : '';
    const proteinLine =
      recipe.protein_grams != null
        ? `<div class="detail-protein-line"><span aria-hidden="true">⚡</span> ${recipe.protein_grams}g protein</div>`
        : '';
    const metaBits = [
      recipe.difficulty ? escapeHtml(recipe.difficulty) : '',
      recipe.cost_estimate ? escapeHtml(recipe.cost_estimate) : '',
      recipe.cuisine ? escapeHtml(formatDisplayCuisine(recipe.cuisine)) : '',
      `${escapeHtml(String(serv))} servings (base)`,
    ]
      .filter(Boolean)
      .join(' · ');

    const ptList = normalizeProteinTypeArray(recipe.protein_type || []);
    const proteinTypeBlock =
      ptList.length > 0
        ? `<div class="detail-protein-types-block">
        <span class="detail-protein-types-label">Protein type</span>
        <div class="badges">${ptList.map((p) => `<span class="badge badge-diff-easy">${escapeHtml(formatDisplayProteinType(p))}</span>`).join(' ')}</div>
      </div>`
        : '';

    body.innerHTML = `
      ${heroHtml}
      <div class="detail-meta-block">
        ${prepLine}
        ${metaBits ? `<p class="detail-meta-secondary">${metaBits}</p>` : ''}
        ${proteinLine}
        ${proteinTypeBlock}
      </div>
      <div class="detail-section">
        <h3>Equipment</h3>
        <div class="badges">${equipBadges || '<span class="badge">—</span>'}</div>
      </div>
      <div class="detail-section">
        <h3>Ingredients</h3>
        <ul class="detail-list">${ingredients || '<li>—</li>'}</ul>
      </div>
      <div class="detail-section">
        <h3>Instructions</h3>
        <div class="detail-instructions">${escapeHtml(recipe.instructions || '—')}</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="detail-edit">Edit Recipe</button>
        <button type="button" class="btn btn-danger" id="detail-delete">Delete Recipe</button>
        <button type="button" class="btn btn-primary" id="detail-add-week">Add to This Week</button>
      </div>
    `;

    $('#detail-edit').onclick = () => {
      closeModal(backdrop);
      openFormModal(recipe);
    };
    $('#detail-delete').onclick = () => confirmDeleteRecipe(recipe);
    wireDetailWeekButton(recipe);

    backdrop.classList.add('is-open');
  }

  function wireDetailWeekButton(recipe) {
    const btn = $('#detail-add-week');
    if (!btn) return;
    const inCart = selectionByRecipeId.has(recipe.id);
    btn.onclick = null;
    if (inCart) {
      btn.disabled = true;
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-detail-added');
      btn.textContent = '✓ Added to This Week';
      return;
    }
    btn.disabled = false;
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-detail-added');
    btn.textContent = 'Add to This Week';
    btn.onclick = async (e) => {
      e.preventDefault();
      await addToWeek(recipe.id);
      wireDetailWeekButton(recipe);
    };
  }

  function closeModal(backdrop) {
    if (backdrop) backdrop.classList.remove('is-open');
  }

  async function confirmDeleteRecipe(recipe) {
    if (!(await showConfirm(`Delete “${recipe.name}”? This cannot be undone.`))) return;
    if (!supabase) return;
    pushAsyncLoading();
    const { error } = await supabase.from('recipes').delete().eq('id', recipe.id);
    popAsyncLoading();
    if (error) {
      console.error(error);
      showError(error.message || 'Could not delete recipe.');
      return;
    }
    closeModal($('#modal-detail'));
    await loadRecipes();
    await loadWeeklySelection();
  }

  // --- Unit <select> factory -------------------------------------------------

  function createUnitSelect(value) {
    const sel = document.createElement('select');
    sel.className = 'ing-unit';
    INGREDIENT_UNIT_GROUPS.forEach((g) => {
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    const v = value || 'whole';
    if ([...sel.options].some((o) => o.value === v)) sel.value = v;
    else {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
      sel.value = v;
    }
    return sel;
  }

  function qtyDisabledForUnit(unit) {
    const u = String(unit || '').toLowerCase();
    return u === 'to taste' || u === 'as needed';
  }

  function syncIngredientRowQtyState(rowEl, qtyInput, unitSelect) {
    const dis = qtyDisabledForUnit(unitSelect.value);
    qtyInput.disabled = dis;
    qtyInput.classList.toggle('field-error', false);
    if (dis) qtyInput.value = '';
  }

  /** Split stored instructions on newlines and strip leading "1. ", "2. ", etc. */
  function parseInstructionsFromDb(raw) {
    const t = String(raw || '').trim();
    if (!t) return [''];
    return t.split('\n').map((line) => line.replace(/^\s*\d+\.\s*/, '').trimEnd());
  }

  /** Non-empty steps only; each line saved as "N. text" joined by \n. */
  function serializeInstructionSteps(steps) {
    const texts = steps.map((s) => String(s || '').trim()).filter(Boolean);
    if (!texts.length) return null;
    return texts.map((text, i) => `${i + 1}. ${text}`).join('\n');
  }

  function renderInstructionSteps() {
    const wrap = $('#instruction-steps');
    if (!wrap) return;
    wrap.innerHTML = '';
    formInstructionSteps.forEach((text, idx) => {
      const row = document.createElement('div');
      row.className = 'instruction-step-row';

      const num = document.createElement('span');
      num.className = 'instruction-step-num';
      num.textContent = `${idx + 1}.`;

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'instruction-step-input';
      inp.placeholder = 'Describe this step...';
      inp.value = text;
      inp.addEventListener('input', () => {
        formInstructionSteps[idx] = inp.value;
      });

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'instruction-step-remove';
      rm.setAttribute('aria-label', 'Remove step');
      rm.textContent = '×';
      rm.disabled = formInstructionSteps.length <= 1;
      rm.addEventListener('click', () => {
        if (formInstructionSteps.length <= 1) return;
        formInstructionSteps.splice(idx, 1);
        renderInstructionSteps();
      });

      row.appendChild(num);
      row.appendChild(inp);
      row.appendChild(rm);
      wrap.appendChild(row);
    });
  }

  // --- Form modal -----------------------------------------------------------

  function openFormModal(recipe) {
    const backdrop = $('#modal-form');
    if (!backdrop) return;
    const isEdit = Boolean(recipe && recipe.id);
    $('#form-title').textContent = isEdit ? 'Edit Recipe' : 'Add Recipe';
    $('#form-recipe-id').value = isEdit ? recipe.id : '';
    $('#form-name').value = isEdit ? recipe.name || '' : '';
    $('#form-image').value = isEdit ? recipe.image_url || '' : '';
    $('#form-prep').value = isEdit && recipe.prep_time != null ? recipe.prep_time : '';
    $('#form-servings').value = isEdit && recipe.servings != null ? recipe.servings : 4;
    $('#form-difficulty').value = isEdit ? recipe.difficulty || 'Easy' : 'Easy';
    $('#form-cost').value = isEdit ? recipe.cost_estimate || 'Low' : 'Low';
    $('#form-cuisine').value = isEdit ? formatDisplayCuisine(recipe.cuisine) : '';
    $('#form-protein').value = isEdit && recipe.protein_grams != null ? recipe.protein_grams : '';

    formInstructionSteps = parseInstructionsFromDb(isEdit ? recipe.instructions : '');
    if (!formInstructionSteps.length) formInstructionSteps = [''];

    formProteinTypes = isEdit ? normalizeProteinTypeArray(recipe.protein_type) : [];
    proteinTypeUserRemoved.clear();
    clearTimeout(proteinAutoHintTimer);
    const pHint = $('#protein-type-autohint');
    if (pHint) pHint.classList.add('hidden');
    const ptInpOpen = $('#protein-type-input');
    if (ptInpOpen) ptInpOpen.value = '';

    const summary = $('#form-error-summary');
    if (summary) {
      summary.classList.add('hidden');
      summary.innerHTML = '';
    }
    $$('#recipe-form .field-error').forEach((el) => el.classList.remove('field-error'));

    formEquipment = isEdit
      ? (recipe.equipment || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : [];

    formIngredientRows = [];
    if (isEdit && (recipe.ingredients || []).length) {
      (recipe.ingredients || []).forEach((raw) => {
        if (parseIng) {
          const ing = parseIng(raw);
          if (ing && ing.name) {
            formIngredientRows.push({
              name: ing.name,
              quantity: ing.quantity || '',
              unit: ing.unit || 'whole',
            });
          }
        } else {
          formIngredientRows.push({ name: String(raw).trim(), quantity: '', unit: 'whole' });
        }
      });
    }
    if (!formIngredientRows.length) formIngredientRows.push({ name: '', quantity: '', unit: 'whole' });

    updateNameCharCount();
    renderEquipmentChips();
    renderIngredientRows();
    renderInstructionSteps();
    renderProteinTypeChips();
    hideProteinTypeSuggestions();
    lastDebouncedNameForProtein = $('#form-name').value.trim().toLowerCase();

    formInitialSnapshot = getFormState();
    backdrop.classList.add('is-open');
  }

  function updateNameCharCount() {
    const inp = $('#form-name');
    const cc = $('#form-name-count');
    if (!inp || !cc) return;
    cc.textContent = `${inp.value.length} / 60`;
    cc.classList.toggle('char-count--warn', inp.value.length >= 50);
  }

  function renderEquipmentChips() {
    const wrap = $('#equipment-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    formEquipment.forEach((tag, idx) => {
      const span = document.createElement('span');
      span.className = 'badge badge-accent';
      span.style.cursor = 'pointer';
      span.title = 'Click to remove';
      span.textContent = `${formatDisplayEquipment(tag)} ×`;
      span.addEventListener('click', () => {
        formEquipment.splice(idx, 1);
        renderEquipmentChips();
      });
      wrap.appendChild(span);
    });
  }

  function renderIngredientRows() {
    const wrap = $('#ingredient-rows');
    if (!wrap) return;
    wrap.innerHTML = '';
    formIngredientRows.forEach((row, idx) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'ingredient-row-form';

      const nameInp = document.createElement('input');
      nameInp.type = 'text';
      nameInp.className = 'ing-name';
      nameInp.placeholder = 'Ingredient name';
      nameInp.value = row.name;
      nameInp.addEventListener('input', () => {
        formIngredientRows[idx].name = nameInp.value;
      });

      const qtyInp = document.createElement('input');
      qtyInp.type = 'text';
      qtyInp.className = 'ing-qty';
      qtyInp.placeholder = 'Qty';
      qtyInp.value = row.quantity;
      qtyInp.addEventListener('input', () => {
        formIngredientRows[idx].quantity = qtyInp.value;
      });

      const unitSel = createUnitSelect(row.unit);
      unitSel.addEventListener('change', () => {
        formIngredientRows[idx].unit = unitSel.value;
        syncIngredientRowQtyState(rowEl, qtyInp, unitSel);
      });
      formIngredientRows[idx].unit = unitSel.value;

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ing-remove';
      rm.setAttribute('aria-label', 'Remove ingredient');
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        formIngredientRows.splice(idx, 1);
        if (!formIngredientRows.length) formIngredientRows.push({ name: '', quantity: '', unit: 'whole' });
        renderIngredientRows();
      });

      rowEl.appendChild(nameInp);
      rowEl.appendChild(qtyInp);
      rowEl.appendChild(unitSel);
      rowEl.appendChild(rm);
      wrap.appendChild(rowEl);

      syncIngredientRowQtyState(rowEl, qtyInp, unitSel);
    });
  }

  function validateRecipeForm() {
    const errors = [];
    const name = $('#form-name').value.trim();
    const prep = $('#form-prep').value.trim();
    const servings = $('#form-servings').value.trim();

    $$('#recipe-form .field-error').forEach((el) => el.classList.remove('field-error'));

    if (!name) errors.push('Recipe name is required.');
    if (name.length > 60) errors.push('Recipe name must be 60 characters or fewer.');

    const prepN = parseInt(prep, 10);
    if (!prep || !Number.isFinite(prepN) || prepN < 1) errors.push('Prep time must be a positive integer (minutes).');

    const servN = parseInt(servings, 10);
    if (!servings || !Number.isFinite(servN) || servN < 1) errors.push('Base servings must be a positive integer.');

    if (!$('#form-difficulty').value) errors.push('Difficulty is required.');

    const namedIngs = formIngredientRows.filter((r) => r.name && String(r.name).trim());
    if (!namedIngs.length) errors.push('Add at least one ingredient with a name.');

    if (errors.length) {
      if (!name) $('#form-name').classList.add('field-error');
      if (!prep || !Number.isFinite(prepN) || prepN < 1) $('#form-prep').classList.add('field-error');
      if (!servings || !Number.isFinite(servN) || servN < 1) $('#form-servings').classList.add('field-error');
      if (!$('#form-difficulty').value) $('#form-difficulty').classList.add('field-error');
      if (!namedIngs.length) $$('.ing-name').forEach((el) => el.classList.add('field-error'));

      const summary = $('#form-error-summary');
      if (summary) {
        summary.classList.remove('hidden');
        summary.innerHTML = `<strong>Please fix the following:</strong><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
      }
    }

    return errors;
  }

  async function submitRecipeForm(e) {
    e.preventDefault();
    if (!supabase) return;

    const saveBtn = $('#form-save');
    const errs = validateRecipeForm();
    if (errs.length) return;

    const id = $('#form-recipe-id').value.trim();
    const ingredientsJson = formIngredientRows
      .filter((r) => r.name && String(r.name).trim())
      .map((r) => {
        const nm = String(r.name).trim().toLowerCase();
        const qty = qtyDisabledForUnit(r.unit) ? '' : String(r.quantity || '').trim();
        const unit = String(r.unit || '').trim();
        return JSON.stringify({ name: nm, quantity: qty, unit });
      });

    const equipLower = [...new Set(formEquipment.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );

    const payload = {
      name: $('#form-name').value.trim(),
      image_url: $('#form-image').value.trim() || null,
      prep_time: parseInt($('#form-prep').value, 10),
      servings: parseInt($('#form-servings').value, 10),
      difficulty: $('#form-difficulty').value,
      cost_estimate: $('#form-cost').value,
      cuisine: normalizeCuisineForSave($('#form-cuisine').value),
      protein_grams: $('#form-protein').value === '' ? null : parseInt($('#form-protein').value, 10),
      protein_type: normalizeProteinTypeArray(formProteinTypes),
      equipment: equipLower,
      ingredients: ingredientsJson,
      instructions: serializeInstructionSteps(formInstructionSteps),
    };

    if (saveBtn) saveBtn.disabled = true;
    pushAsyncLoading();
    let error;
    if (id) {
      const res = await supabase.from('recipes').update(payload).eq('id', id);
      error = res.error;
    } else {
      const res = await supabase.from('recipes').insert(payload);
      error = res.error;
    }
    popAsyncLoading();
    if (saveBtn) saveBtn.disabled = false;

    if (error) {
      console.error(error);
      showError(error.message || 'Could not save recipe.');
      return;
    }
    formInitialSnapshot = null;
    closeModal($('#modal-form'));
    await loadRecipes();
    await loadWeeklySelection();
  }

  // --- Search UI ------------------------------------------------------------

  function setupSearch() {
    const inp = $('#recipe-search');
    const clr = $('#recipe-search-clear');
    if (!inp) return;

    function syncClear() {
      if (clr) clr.classList.toggle('hidden', !inp.value.trim());
    }

    inp.addEventListener('input', () => {
      syncClear();
      applyFiltersAndRender();
    });
    if (clr) {
      clr.addEventListener('click', () => {
        inp.value = '';
        syncClear();
        applyFiltersAndRender();
        inp.focus();
      });
    }
    syncClear();
  }

  function updateRangeFill(range) {
    if (!range) return;
    const min = Number(range.min);
    const max = Number(range.max);
    const val = Number(range.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 100;
    range.style.setProperty('--range-pct', `${pct}%`);
  }

  function setupSliders() {
    const prep = $('#slider-max-prep');
    const prepVal = $('#slider-max-prep-val');
    const prot = $('#slider-min-protein');
    const protVal = $('#slider-min-protein-val');
    if (prep && prepVal) {
      updateRangeFill(prep);
      prep.addEventListener('input', () => {
        prepVal.textContent = prep.value;
        updateRangeFill(prep);
        applyFiltersAndRender();
      });
    }
    if (prot && protVal) {
      updateRangeFill(prot);
      prot.addEventListener('input', () => {
        protVal.textContent = prot.value;
        updateRangeFill(prot);
        applyFiltersAndRender();
      });
    }
  }

  function openMobileCartDrawer() {
    const d = $('#mobile-cart-drawer');
    const b = $('#mobile-cart-backdrop');
    if (d) {
      d.classList.add('is-open');
      d.setAttribute('aria-hidden', 'false');
    }
    if (b) {
      b.classList.remove('hidden');
      b.setAttribute('aria-hidden', 'false');
    }
  }

  function closeMobileCartDrawer() {
    const d = $('#mobile-cart-drawer');
    const b = $('#mobile-cart-backdrop');
    if (d) {
      d.classList.remove('is-open');
      d.setAttribute('aria-hidden', 'true');
    }
    if (b) {
      b.classList.add('hidden');
      b.setAttribute('aria-hidden', 'true');
    }
  }

  function setupMobileCart() {
    const fab = $('#mobile-cart-fab');
    const backdrop = $('#mobile-cart-backdrop');
    const closeBtn = $('#mobile-cart-close');
    const btnG = $('#mobile-btn-grocery');
    const btnClr = $('#mobile-btn-clear-week');

    if (fab) fab.addEventListener('click', openMobileCartDrawer);
    if (backdrop) backdrop.addEventListener('click', closeMobileCartDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeMobileCartDrawer);
    if (btnG) {
      btnG.addEventListener('click', () => {
        closeMobileCartDrawer();
        window.location.href = 'grocery.html';
      });
    }
    if (btnClr) {
      btnClr.addEventListener('click', async () => {
        await clearThisWeek();
        closeMobileCartDrawer();
      });
    }
  }

  // --- Init -----------------------------------------------------------------

  function init() {
    if (!$('#app-shell')) return;

    setupSidebar();
    setupSearch();
    setupSliders();
    setupMobileCart();

    const sortEl = $('#sort-select');
    if (sortEl) sortEl.addEventListener('change', applyFiltersAndRender);

    $('#btn-add-recipe').addEventListener('click', () => openFormModal(null));

    $('#detail-close').addEventListener('click', () => {
      const m = $('#modal-detail');
      if (m) delete m.dataset.recipeDetailId;
      closeModal($('#modal-detail'));
    });
    $('#modal-detail').addEventListener('click', (e) => {
      if (e.target === $('#modal-detail')) {
        const m = $('#modal-detail');
        if (m) delete m.dataset.recipeDetailId;
        closeModal($('#modal-detail'));
      }
    });

    const confirmPanel = $('#modal-confirm .modal-panel');
    if (confirmPanel) confirmPanel.addEventListener('click', (e) => e.stopPropagation());

    const formUnsavedPanel = $('#modal-form-unsaved .modal-panel');
    if (formUnsavedPanel) formUnsavedPanel.addEventListener('click', (e) => e.stopPropagation());

    $('#form-close').addEventListener('click', () => void requestCloseFormModal());
    $('#form-cancel').addEventListener('click', () => void requestCloseFormModal());
    $('#modal-form').addEventListener('click', (e) => {
      if (e.target === $('#modal-form')) void requestCloseFormModal();
    });

    $('#recipe-form').addEventListener('submit', submitRecipeForm);

    const nameInp = $('#form-name');
    if (nameInp) {
      nameInp.addEventListener('input', () => {
        updateNameCharCount();
        scheduleProteinDetectFromName();
      });
    }

    const ptInp = $('#protein-type-input');
    const ptBox = $('#protein-type-suggestions');
    if (ptInp && ptBox) {
      ptInp.addEventListener('focus', () => {
        ptBox.classList.remove('hidden');
        updateProteinTypeSuggestions();
      });
      ptInp.addEventListener('input', () => updateProteinTypeSuggestions());
      ptInp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = ptBox.querySelector('.protein-type-suggestion');
        if (first) first.click();
      });
      document.addEventListener('click', (e) => {
        const wrap = $('.protein-type-input-wrap');
        if (!wrap || wrap.contains(e.target)) return;
        if (ptBox.classList.contains('hidden')) return;
        hideProteinTypeSuggestions();
      });
    }

    $('#equipment-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = $('#equipment-input').value.trim().toLowerCase();
      if (!v) return;
      if (!formEquipment.some((x) => x === v)) formEquipment.push(v);
      $('#equipment-input').value = '';
      renderEquipmentChips();
    });

    $('#btn-add-ingredient').addEventListener('click', () => {
      formIngredientRows.push({ name: '', quantity: '', unit: 'whole' });
      renderIngredientRows();
    });

    const btnAddStep = $('#btn-add-step');
    if (btnAddStep) {
      btnAddStep.addEventListener('click', () => {
        formInstructionSteps.push('');
        renderInstructionSteps();
      });
    }

    $('#btn-grocery').addEventListener('click', () => {
      window.location.href = 'grocery.html';
    });

    const btnClearWeek = $('#btn-clear-week');
    if (btnClearWeek) btnClearWeek.addEventListener('click', clearThisWeek);

    async function boot() {
      await loadRecipes();
      await loadWeeklySelection();
    }
    boot();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
