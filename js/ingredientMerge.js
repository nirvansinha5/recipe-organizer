/**
 * Grocery list: parse structured recipe ingredients (JSON strings), scale by servings,
 * merge by lowercase name + normalized unit, format display quantities.
 */
(function (global) {
  /** Units that never scale with servings; listed once when merged. */
  const NO_SCALE_UNITS = new Set(['to taste', 'as needed']);

  function normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUnitKey(unit) {
    const u = String(unit || '').toLowerCase().trim();
    if (!u) return 'each';
    if (/^tbsp|^tablespoon/.test(u)) return 'tbsp';
    if (/^tsp|^teaspoon/.test(u)) return 'tsp';
    if (u === 'fl oz' || u === 'floz') return 'fl oz';
    if (/^cup/.test(u)) return 'cup';
    if (/^pint/.test(u)) return 'pint';
    if (/^quart/.test(u)) return 'quart';
    if (/^gallon/.test(u)) return 'gallon';
    if (/^ml$/.test(u)) return 'ml';
    if (/^l$/.test(u) || /^liter/.test(u)) return 'l';
    if (/^g$|^gram/.test(u)) return 'g';
    if (/^kg/.test(u)) return 'kg';
    if (/^oz/.test(u)) return 'oz';
    if (/^lb|^pound/.test(u)) return 'lb';
    return u;
  }

  /** Display unit label (sentence-style). */
  function displayUnit(unit) {
    const u = String(unit || '').trim();
    return u || '';
  }

  /**
   * Parse quantity string: decimals, fractions like 1/2, empty -> null.
   */
  function parseQuantityString(q) {
    if (q == null) return null;
    const s = String(q).trim();
    if (!s) return null;
    if (s.includes('/')) {
      const [a, b] = s.split('/').map((x) => parseFloat(String(x).trim()));
      if (b && !Number.isNaN(a) && !Number.isNaN(b)) return a / b;
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Round to 2 decimals, trim trailing zeros (1.50 -> 1.5, 2.00 -> 2).
   */
  function formatQuantityTrim(n) {
    if (n == null || Number.isNaN(n)) return '';
    const r = Math.round(n * 100) / 100;
    if (Math.abs(r - Math.round(r)) < 1e-6) return String(Math.round(r));
    const s = r.toFixed(2);
    return s.replace(/\.?0+$/, '');
  }

  /**
   * Parse one ingredients[] entry: JSON string or legacy plain string.
   * @returns {{ name: string, quantity: string|null, unit: string }|null}
   */
  function parseIngredientElement(el) {
    if (el == null) return null;
    const raw = String(el).trim();
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && o.name) {
        return {
          name: normalizeName(o.name),
          quantity: o.quantity != null ? String(o.quantity) : '',
          unit: o.unit != null ? String(o.unit).trim() : '',
        };
      }
    } catch {
      /* legacy plain string */
    }
    return { name: normalizeName(raw), quantity: '', unit: '' };
  }

  function mergeKey(name, unitKey) {
    return `${name}||${unitKey}`;
  }

  /**
   * Build merged grocery rows from weekly selections with per-recipe target servings.
   * @param {Array<{ recipe: object, targetServings: number }>} selections
   * @returns {Array<{ matchKey: string, displayText: string, sourceTag: string, servings_multiplier: number }>}
   */
  function mergeScaledForGrocery(selections) {
    /** @type {Map<string, { qtySum: number|null, unitKey: string, displayUnit: string, names: Set<string>, noScale: boolean }>} */
    const map = new Map();

    for (const { recipe, targetServings } of selections) {
      if (!recipe) continue;
      const baseServings = Math.max(1, parseInt(recipe.servings, 10) || 4);
      const target = Math.max(1, parseInt(targetServings, 10) || baseServings);
      const factor = target / baseServings;
      const recipeTitle = recipe.name || 'Recipe';

      const arr = recipe.ingredients || [];
      for (const el of arr) {
        const ing = parseIngredientElement(el);
        if (!ing || !ing.name) continue;

        const unitLower = ing.unit.toLowerCase();
        const unitKey = normalizeUnitKey(ing.unit);
        const noScale = NO_SCALE_UNITS.has(unitLower);

        const key = mergeKey(ing.name, noScale ? `__ns__${unitKey}` : unitKey);

        const qtyNum = parseQuantityString(ing.quantity);
        const scaled = noScale ? null : qtyNum != null ? qtyNum * factor : null;

        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            qtySum: scaled,
            unitKey,
            displayUnit: displayUnit(ing.unit) || unitKey,
            names: new Set([recipeTitle]),
            noScale,
            bareName: ing.name,
          });
        } else {
          existing.names.add(recipeTitle);
          if (!noScale && scaled != null) {
            existing.qtySum = (existing.qtySum || 0) + scaled;
          }
        }
      }
    }

    const rows = [];
    for (const [, v] of map) {
      const n = v.names.size;
      // Only surface a source hint when the same line merged from multiple recipes
      const sourceTag = n > 1 ? `from ${n} recipes` : '';

      let displayText = '';
      if (v.noScale) {
        displayText = `${v.bareName} (${v.displayUnit})`;
      } else if (v.qtySum != null && v.displayUnit) {
        displayText = `${formatQuantityTrim(v.qtySum)} ${v.displayUnit} ${v.bareName}`.trim();
      } else if (v.qtySum != null) {
        displayText = `${formatQuantityTrim(v.qtySum)} ${v.bareName}`.trim();
      } else {
        displayText = v.bareName;
      }

      const matchKey = mergeKey(v.bareName, v.noScale ? `__ns__${v.unitKey}` : v.unitKey);
      rows.push({
        matchKey,
        displayText,
        sourceTag,
        servings_multiplier: 1.0,
      });
    }

    rows.sort((a, b) => a.displayText.localeCompare(b.displayText));
    return rows;
  }

  /**
   * Legacy: merge plain-string ingredient lines (no scaling). Used if older callers exist.
   */
  function mergeIngredientStrings(lines) {
    const map = new Map();
    for (const line of lines) {
      const ing = parseIngredientElement(line);
      if (!ing || !ing.name) continue;
      const qty = parseQuantityString(ing.quantity);
      const unitKey = normalizeUnitKey(ing.unit);
      const key = mergeKey(ing.name, unitKey);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          qtySum: qty,
          unitKey,
          displayUnit: displayUnit(ing.unit) || unitKey,
          bareName: ing.name,
        });
      } else if (qty != null) {
        existing.qtySum = (existing.qtySum || 0) + qty;
      }
    }
    return Array.from(map.values()).map((v) => ({
      matchKey: mergeKey(v.bareName, v.unitKey),
      displayText:
        v.qtySum != null && v.displayUnit
          ? `${formatQuantityTrim(v.qtySum)} ${v.displayUnit} ${v.bareName}`.trim()
          : v.bareName,
      sourceTag: '',
      servings_multiplier: 1.0,
    }));
  }

  global.ingredientMerge = {
    normalizeName,
    normalizeUnitKey,
    parseQuantityString,
    formatQuantityTrim,
    parseIngredientElement,
    mergeScaledForGrocery,
    mergeIngredientStrings,
    NO_SCALE_UNITS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
