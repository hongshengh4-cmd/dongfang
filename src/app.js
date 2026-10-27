const STAGE_W = 1280;
const STAGE_H = 720;
const SAVE_KEY = "touhou-mystias-replica-v1";
const DATA_URL = "./data/runtime/game-data.json";
const SPRITES_URL = "./data/runtime/sprite-index.json";
const TEXT_INDEX_URL = "./data/text-index.json";

const frame = document.getElementById("stage-frame");
const stage = document.getElementById("stage");
const screen = document.getElementById("screen");
const toastEl = document.getElementById("toast");
const fatalEl = document.getElementById("fatal");

let gameData;
let phraseMap = new Map();
let sprites = [];
let spritesByName = new Map();
let textIndex = [];
let cookTimeout = null;
let toastTimeout = null;
let savedProgress = null;

function newState() {
  return {
    phase: "title",
    day: 1,
    money: 0,
    reputation: 0,
    menuFoods: [0],
    menuBeverages: [0],
    selectedRecipeFoodId: 0,
    selectedCookFoodId: 0,
    selectedGuestIndex: 0,
    selectedReadyFoodIndex: null,
    selectedDrinkId: 0,
    readyFoods: [],
    cooking: null,
    guests: [],
    dayRevenue: 0,
    roundResults: [],
    servedCount: 0,
    runSeed: Date.now() >>> 0
  };
}

let state = newState();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function phrase(key, vars = {}) {
  let value = phraseMap.get(key) ?? "";
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.replaceAll(`$${name}`, String(replacement));
  }
  return value;
}

function tableRows(name) {
  return gameData?.localization?.[name]?.rows ?? [];
}

function makeNumberMap(name, key, value) {
  const map = new Map();
  for (const row of tableRows(name)) {
    const id = Number(row[key]);
    if (Number.isFinite(id)) map.set(id, row[value] ?? "");
  }
  return map;
}

function getAsset(name, bundleHint = "") {
  const list = spritesByName.get(String(name)) ?? [];
  return list.find(item => bundleHint && item.bundle.includes(bundleHint)) ?? list[0] ?? null;
}

function img(name, className = "", width = null, height = null, bundleHint = "") {
  const asset = getAsset(name, bundleHint);
  if (!asset) return "";
  const w = width ?? asset.width;
  const h = height ?? asset.height;
  return `<img class="no-drag ${escapeHTML(className)}" src="${escapeHTML(asset.src)}" width="${w}" height="${h}" alt="" draggable="false">`;
}

function imgUrl(name, bundleHint = "") {
  return getAsset(name, bundleHint)?.src ?? "";
}

function itemName(kind, id) {
  const number = Number(id);
  if (kind === "food") return foodNames.get(number) ?? String(id);
  if (kind === "drink") return drinkNames.get(number) ?? String(id);
  if (kind === "ingredient") return ingredientNames.get(number) ?? String(id);
  return String(id);
}

function recipeForFood(foodId) {
  return recipeByFood.get(Number(foodId)) ?? null;
}

function imageForItem(kind, id, className = "item-icon") {
  const prefix = kind === "food" ? "Foods_" : kind === "drink" ? "Beverages_" : kind === "ingredient" ? "Ingredients_" : "Cookers_";
  return img(`${prefix}${id}`, className);
}

function saveProgress() {
  if (state.phase === "title") return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    savedProgress = structuredClone(state);
  } catch (_) {
    // The game remains playable when storage is disabled.
  }
}

function readSavedProgress() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !["prep", "night", "result"].includes(parsed.phase)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function fitStage() {
  const doc = document.documentElement;
  const viewportWidth = Number(window.visualViewport?.width)
    || Number(window.innerWidth)
    || Number(doc?.clientWidth)
    || STAGE_W;
  const viewportHeight = Number(window.visualViewport?.height)
    || Number(window.innerHeight)
    || Number(doc?.clientHeight)
    || STAGE_H;
  const rawScale = Math.min(viewportWidth / STAGE_W, viewportHeight / STAGE_H);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  frame.style.width = `${STAGE_W * scale}px`;
  frame.style.height = `${STAGE_H * scale}px`;
  stage.style.transform = `scale(${scale})`;
}

function showToast(text, duration = 2600) {
  if (!text) return;
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove("show"), duration);
}

function roundMoney(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function formatSeconds(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pickWeighted(entries, random) {
  const valid = (entries ?? []).filter(entry => Number(entry.weight) > 0);
  if (!valid.length) return null;
  const total = valid.reduce((sum, entry) => sum + Number(entry.weight), 0);
  let cursor = random() * total;
  for (const entry of valid) {
    cursor -= Number(entry.weight);
    if (cursor <= 0) return entry;
  }
  return valid[valid.length - 1];
}

function seededRandom(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function bestLikedItem(ids, profileMap, likedTags, random) {
  const candidates = ids.map(id => profileMap.get(Number(id))).filter(Boolean);
  if (!candidates.length) return null;
  const tags = new Set((likedTags ?? []).map(Number));
  const scored = candidates.map(item => ({
    item,
    score: (item.tags ?? []).reduce((sum, tag) => sum + (tags.has(Number(tag)) ? 1 : 0), 0)
  }));
  const best = Math.max(...scored.map(entry => entry.score));
  const bestItems = scored.filter(entry => entry.score === best).map(entry => entry.item);
  return bestItems[Math.floor(random() * bestItems.length)] ?? candidates[0];
}

function generateGuests() {
  const shop = gameData.profiles.IzakayaProfile.izakayas.find(item => Number(item.id) === 0);
  const normalProfiles = gameData.profiles.NormalGuestProfile.normalGuests;
  const foodMenu = [...state.menuFoods];
  const drinkMenu = [...state.menuBeverages];
  const random = seededRandom((state.runSeed + state.day * 2654435761) >>> 0);
  const foodBase = new Map(gameData.profiles.FoodProfile.sellables.map(item => [Number(item.id), item]));
  const drinkBase = new Map(gameData.profiles.BeverageProfile.sellables.map(item => [Number(item.id), item]));
  const minFund = Number(shop?.baseFundRange?.x ?? 40);
  const maxFund = Number(shop?.baseFundRange?.y ?? 70);
  const tableCount = Math.max(1, Number(shop?.guestTableCount ?? 3));
  const ids = [];
  let guard = 0;
  while (ids.length < tableCount && guard++ < 40) {
    const pool = pickWeighted(shop?.normalGuestPool ?? [], random);
    const group = (pool?.data ?? []).map(Number);
    for (const id of group) {
      if (ids.length < tableCount) ids.push(id);
    }
  }
  while (ids.length < tableCount) ids.push(0);

  return ids.map((id, index) => {
    const profile = normalProfiles.find(item => Number(item.id) === id) ?? normalProfiles[0];
    const lang = guestNames.get(id) ?? "";
    const fundMultiplier = Number(profile?.fundMultiplier ?? 1);
    const budget = (minFund + random() * (maxFund - minFund)) * fundMultiplier;
    const affordableFoods = foodMenu.filter(foodId => Number(foodBase.get(Number(foodId))?.baseValue ?? 0) <= budget);
    const affordableDrinks = drinkMenu.filter(drinkId => Number(drinkBase.get(Number(drinkId))?.baseValue ?? 0) <= budget);
    const chosenFood = bestLikedItem(affordableFoods.length ? affordableFoods : foodMenu, foodBase, profile?.likeFoodTag ?? [], random);
    const chosenDrink = bestLikedItem(affordableDrinks.length ? affordableDrinks : drinkMenu, drinkBase, profile?.likeBevTag ?? [], random);
    return {
      type: "normal",
      guestId: id,
      name: lang,
      evaluationId: Number(profile?.evaluation ?? 0),
      fundMultiplier,
      likeFoodTag: profile?.likeFoodTag ?? [],
      likeBevTag: profile?.likeBevTag ?? [],
      budget: roundMoney(budget),
      order: {
        foodId: chosenFood ? Number(chosenFood.id) : Number(foodMenu[0] ?? 0),
        drinkId: chosenDrink ? Number(chosenDrink.id) : Number(drinkMenu[0] ?? 0)
      },
      deliveredFoodId: null,
      deliveredDrinkId: null,
      foodDone: false,
      drinkDone: false,
      done: false,
      earned: 0,
      feedback: "",
      slot: index + 1
    };
  });
}

function currentGuest() {
  return state.guests[state.selectedGuestIndex] ?? null;
}

function activeGuestIndex() {
  return state.guests.findIndex(guest => !guest.done);
}

function getNormFeedback(guest, correctCount) {
  const rows = tableRows("NormEvalLang");
  const row = rows.find(item => Number(item.id) === Number(guest.evaluationId)) ?? rows[0] ?? {};
  const key = correctCount >= 2 ? "good" : correctCount === 1 ? "norm" : "bad";
  return row[key] ?? row.norm ?? "";
}

function maybeFinishGuest(guest) {
  if (!guest || guest.done || guest.deliveredFoodId === null || guest.deliveredDrinkId === null) return false;
  const foodCorrect = Number(guest.deliveredFoodId) === Number(guest.order.foodId);
  const drinkCorrect = Number(guest.deliveredDrinkId) === Number(guest.order.drinkId);
  const correctCount = Number(foodCorrect) + Number(drinkCorrect);
  const foodItem = foodById.get(Number(guest.deliveredFoodId));
  const drinkItem = drinkById.get(Number(guest.deliveredDrinkId));
  const rawEarned = (foodCorrect ? Number(foodItem?.baseValue ?? 0) : 0) + (drinkCorrect ? Number(drinkItem?.baseValue ?? 0) : 0);
  const earned = roundMoney(rawEarned * Number(guest.fundMultiplier ?? 1));
  const feedback = getNormFeedback(guest, correctCount);
  guest.done = true;
  guest.earned = earned;
  guest.feedback = feedback;
  guest.foodDone = true;
  guest.drinkDone = true;
  state.money += earned;
  state.dayRevenue += earned;
  state.reputation += correctCount;
  state.servedCount += 1;
  state.roundResults.push({
    name: guest.name,
    feedback,
    earned,
    correctCount,
    foodCorrect,
    drinkCorrect
  });
  const next = activeGuestIndex();
  if (next < 0) {
    state.phase = "result";
  } else {
    state.selectedGuestIndex = next;
  }
  saveProgress();
  render();
  if (feedback) showToast(`${guest.name}：${feedback}`, 3300);
  return true;
}

function startNight() {
  if (!state.menuFoods.length) {
    showToast(phrase("IZAKAYA_CONFIG_REQUIRE_RECIPE"));
    return;
  }
  if (!state.menuBeverages.length) {
    showToast(phrase("IZAKAYA_CONFIG_REQUIRE_BEVERAGE") || phrase("IZKAYA_CONFIG_BEVERAGE_REQ") || phrase("WORK_STORAGE_BEVERAGE"));
    return;
  }
  state.runSeed = (Date.now() ^ (state.day * 2654435761)) >>> 0;
  state.guests = generateGuests();
  state.selectedGuestIndex = 0;
  state.readyFoods = [];
  state.selectedReadyFoodIndex = null;
  state.selectedCookFoodId = state.menuFoods[0];
  state.selectedDrinkId = state.menuBeverages[0];
  state.cooking = null;
  state.dayRevenue = 0;
  state.servedCount = 0;
  state.roundResults = [];
  state.phase = "night";
  saveProgress();
  render();
}

function startCooking() {
  const foodId = Number(state.selectedCookFoodId);
  const recipe = recipeForFood(foodId);
  if (!recipe) {
    showToast(phrase("IZKAYA_CONFIG_RECIPE_COOKER") || phrase("COMMON_COOKER"));
    return;
  }
  if (state.cooking) {
    showToast(phrase("PARTNERSTATUS_COOKING"));
    return;
  }
  const duration = Math.max(1200, Number(recipe.cookTime ?? 1) * 1000);
  const startedAt = Date.now();
  state.cooking = {
    foodId,
    recipeId: Number(recipe.id),
    startedAt,
    endAt: startedAt + duration,
    duration
  };
  saveProgress();
  render();
  scheduleCookingCompletion();
  showToast(phrase("TUTORIAL_WORK_BASE_4_1"), 3800);
}

function scheduleCookingCompletion() {
  clearTimeout(cookTimeout);
  if (!state.cooking) return;
  const remaining = Math.max(0, Number(state.cooking.endAt) - Date.now());
  cookTimeout = setTimeout(() => {
    if (!state.cooking) return;
    const foodId = Number(state.cooking.foodId);
    state.readyFoods.push(foodId);
    state.cooking = null;
    state.selectedReadyFoodIndex = state.readyFoods.length - 1;
    saveProgress();
    render();
    showToast(phrase("TUTORIAL_WORK_BASE_5_1"), 3200);
  }, remaining);
}

function deliverFood() {
  const guest = currentGuest();
  if (!guest) return;
  if (guest.foodDone || guest.deliveredFoodId !== null) {
    showToast(phrase("MISSION_FINISHED"));
    return;
  }
  const index = Number(state.selectedReadyFoodIndex);
  if (!Number.isInteger(index) || index < 0 || index >= state.readyFoods.length) {
    showToast(phrase("TUTORIAL_WORK_BASE_5_1"));
    return;
  }
  const [foodId] = state.readyFoods.splice(index, 1);
  state.selectedReadyFoodIndex = null;
  guest.deliveredFoodId = Number(foodId);
  guest.foodDone = true;
  saveProgress();
  if (!maybeFinishGuest(guest)) render();
}

function deliverDrink() {
  const guest = currentGuest();
  if (!guest) return;
  if (guest.drinkDone || guest.deliveredDrinkId !== null) {
    showToast(phrase("MISSION_FINISHED"));
    return;
  }
  const drinkId = Number(state.selectedDrinkId);
  if (!state.menuBeverages.includes(drinkId)) {
    showToast(phrase("TUTORIAL_WORK_BASE_6_1"));
    return;
  }
  guest.deliveredDrinkId = drinkId;
  guest.drinkDone = true;
  saveProgress();
  if (!maybeFinishGuest(guest)) render();
}

function beginNewGame() {
  state = newState();
  state.phase = "prep";
  saveProgress();
  render();
}

function continueSavedGame() {
  if (!savedProgress) return beginNewGame();
  state = { ...newState(), ...savedProgress };
  if (!Array.isArray(state.menuFoods) || !state.menuFoods.length) state.menuFoods = [0];
  if (!Array.isArray(state.menuBeverages) || !state.menuBeverages.length) state.menuBeverages = [0];
  if (state.phase === "title") state.phase = "prep";
  render();
  scheduleCookingCompletion();
  saveProgress();
}

function nextDay() {
  state.day += 1;
  state.phase = "prep";
  state.guests = [];
  state.readyFoods = [];
  state.selectedReadyFoodIndex = null;
  state.cooking = null;
  state.selectedGuestIndex = 0;
  state.dayRevenue = 0;
  state.servedCount = 0;
  state.roundResults = [];
  if (!state.menuFoods.length) state.menuFoods = [0];
  if (!state.menuBeverages.length) state.menuBeverages = [0];
  state.selectedRecipeFoodId = state.menuFoods[0];
  state.selectedCookFoodId = state.menuFoods[0];
  state.selectedDrinkId = state.menuBeverages[0];
  saveProgress();
  render();
}

function renderTitle() {
  const continueLabel = phrase("MAIN_CONTINUE") || phrase("INPUTHELPER_CONFIRM");
  const hasSave = Boolean(savedProgress);
  const rightAction = hasSave
    ? `<button class="game-button secondary" data-action="resume">${escapeHTML(continueLabel)}</button>`
    : "";
  screen.innerHTML = `
    <section class="scene title-scene">
      ${img("Shop_BG", "scene-backdrop")}
      <div class="scene-shade"></div>
      <div class="title-art">${img("MainMenuCD", "", 808, 720)}</div>
      <div class="title-panel">
        <h1 class="title-heading">${escapeHTML(phrase("IZAKAYA_THEME"))}</h1>
        <div class="title-version">v4.4.0e</div>
        <div class="title-character-wrap">${img("米斯蒂娅 高兴", "title-character", 172, 280)}</div>
        <div class="title-actions">
          <button class="game-button" data-action="new-game">${escapeHTML(phrase("MAIN_NEWGAME"))}</button>
          ${rightAction}
        </div>
        <p class="title-note">${escapeHTML(phrase("WORK_DAILYMENU"))} · ${escapeHTML(phrase("COMMON_FOOD"))} · ${escapeHTML(phrase("WORK_STORAGE_BEVERAGE"))}</p>
      </div>
    </section>`;
}

function renderFoodCard(food) {
  const id = Number(food.id);
  const recipe = recipeForFood(id);
  const selected = state.menuFoods.includes(id);
  const name = itemName("food", id);
  const meta = recipe ? `${formatSeconds(recipe.cookTime)} s` : "";
  return `<button class="food-select-card ${selected ? "selected" : ""}" data-action="toggle-food" data-id="${id}" aria-pressed="${selected}">
    ${imageForItem("food", id)}
    <span class="card-copy"><span class="card-name">${escapeHTML(name)}</span><span class="card-meta">${escapeHTML(meta)}</span></span>
    ${selected ? `<span class="card-check">✓</span>` : ""}
  </button>`;
}

function renderDrinkCard(drink) {
  const id = Number(drink.id);
  const selected = state.menuBeverages.includes(id);
  return `<button class="drink-select-card ${selected ? "selected" : ""}" data-action="toggle-drink" data-id="${id}" aria-pressed="${selected}">
    ${imageForItem("drink", id)}
    <span class="card-copy"><span class="card-name">${escapeHTML(itemName("drink", id))}</span><span class="card-meta">¥${roundMoney(drink.baseValue)}</span></span>
    ${selected ? `<span class="card-check">✓</span>` : ""}
  </button>`;
}

function renderRecipeDetails() {
  const recipe = recipeForFood(state.selectedRecipeFoodId) ?? recipeForFood(state.menuFoods[0]) ?? levelOneRecipes[0];
  if (!recipe) return `<div class="recipe-details"></div>`;
  const foodId = Number(recipe.foodID);
  const cooker = standardCookers[Number(recipe.cookerType)]?.Name ?? phrase("COMMON_COOKER");
  const ingredients = (recipe.ingredients ?? []).map(id => `<span class="ingredient-token">${imageForItem("ingredient", id, "")}<span>${escapeHTML(itemName("ingredient", id))}</span></span>`).join("");
  return `<div class="recipe-details">
    <div><div class="recipe-detail-title">${escapeHTML(itemName("food", foodId))}</div><div class="recipe-detail-meta">${escapeHTML(phrase("NOTE_RECIPE_COOKTIME"))}${formatSeconds(recipe.cookTime)} s　·　${escapeHTML(cooker)}</div></div>
    <div class="ingredient-strip">${ingredients}</div>
    <div>${imageForItem("cooker", Number(recipe.cookerType) - 1, "item-icon")}</div>
    <button class="game-button compact" data-action="start-night">${escapeHTML(phrase("IZAKYA_SELECTOR_START"))}</button>
  </div>`;
}

function renderPrep() {
  const dayText = phrase("DAY", { a: state.day });
  const selectedCount = `${phrase("COMMON_FOOD")} ${state.menuFoods.length}　/　${phrase("WORK_STORAGE_BEVERAGE")} ${state.menuBeverages.length}`;
  const missingRecipe = state.menuFoods.length === 0 ? phrase("IZAKAYA_CONFIG_REQUIRE_RECIPE") : "";
  const foodCards = levelOneFoods.map(renderFoodCard).join("");
  const drinkCards = levelOneDrinks.map(renderDrinkCard).join("");
  screen.innerHTML = `
    <section class="scene prep-scene">
      ${img("DaycookBoard", "scene-backdrop")}
      <div class="scene-shade"></div>
      ${img("DailyMenu_Board", "prep-board-art")}
      <div class="prep-topbar"><span class="location">${escapeHTML(shopName)}</span><span class="day-label">${escapeHTML(dayText)}</span></div>
      <div class="prep-content">
        <div class="prep-title-row"><h2 class="panel-heading">${escapeHTML(phrase("WORK_DAILYMENU"))}</h2><span class="menu-count">${escapeHTML(phrase("COMMON_FOOD"))}　${selectedCount}</span></div>
        <div class="prep-grid">
          <section class="prep-section">
            <div class="prep-section-header"><h3 class="panel-heading">${escapeHTML(phrase("COMMON_FOOD"))}</h3></div>
            <div class="select-grid">${foodCards}</div>
          </section>
          <section class="prep-section">
            <div class="prep-section-header"><h3 class="panel-heading">${escapeHTML(phrase("WORK_STORAGE_BEVERAGE"))}</h3></div>
            <div class="drink-grid">${drinkCards}</div>
          </section>
        </div>
        ${missingRecipe ? `<div class="prep-warning">${escapeHTML(missingRecipe)}</div>` : ""}
        ${renderRecipeDetails()}
      </div>
    </section>`;
}

function guestIcon(name) {
  const initial = String(name ?? "").trim().slice(0, 1);
  return `<span class="guest-portrait-frame">${img("CharacterBG", "", 42, 42)}${img("CharacterFrame", "", 42, 42)}<span class="guest-initial">${escapeHTML(initial)}</span></span>`;
}

function guestStatus(guest) {
  if (guest.done) return phrase("MISSION_FINISHED");
  const delivered = Number(Boolean(guest.foodDone)) + Number(Boolean(guest.drinkDone));
  if (delivered > 0) return `${delivered}/2`;
  return "";
}

function renderGuestCard(guest, index) {
  const active = Number(state.selectedGuestIndex) === index;
  const foodText = itemName("food", guest.order.foodId);
  const drinkText = itemName("drink", guest.order.drinkId);
  return `<button class="guest-card ${active ? "active" : ""} ${guest.done ? "done" : ""}" data-action="select-guest" data-index="${index}" aria-pressed="${active}">
    ${guestIcon(guest.name)}
    <span class="guest-copy"><span class="guest-name">${escapeHTML(guest.name)}</span><span class="guest-order-line">${escapeHTML(foodText)} · ${escapeHTML(drinkText)}</span><span class="guest-status">${escapeHTML(guestStatus(guest))}</span></span>
  </button>`;
}

function renderNightRecipe(food) {
  const foodId = Number(food.id);
  const recipe = recipeForFood(foodId);
  const active = Number(state.selectedCookFoodId) === foodId;
  return `<button class="night-recipe ${active ? "active" : ""}" data-action="select-cook-food" data-id="${foodId}" aria-pressed="${active}">
    ${imageForItem("food", foodId, "")}
    <span class="recipe-copy"><span class="card-name">${escapeHTML(itemName("food", foodId))}</span><span class="card-meta">${formatSeconds(recipe?.cookTime ?? 0)} s</span></span>
  </button>`;
}

function renderCookProgress() {
  if (!state.cooking) return `<div class="cook-slot-content"><div class="selected-recipe-name">${escapeHTML(phrase("TUTORIAL_WORK_BASE_3_2"))}</div><div class="cook-hint">${escapeHTML(phrase("TUTORIAL_WORK_BASE_4_1"))}</div></div>`;
  const now = Date.now();
  const duration = Math.max(1, Number(state.cooking.duration) || 1);
  const elapsed = Math.min(duration, Math.max(0, now - Number(state.cooking.startedAt)));
  const remaining = Math.max(0, Number(state.cooking.endAt) - now);
  const percent = Math.min(100, Math.round(elapsed / duration * 100));
  const recipe = recipeForFood(state.cooking.foodId);
  return `<div class="cook-slot-content">
    <div class="selected-recipe-name">${escapeHTML(itemName("food", state.cooking.foodId))}　·　${escapeHTML(phrase("PARTNERSTATUS_COOKING"))}</div>
    <div class="cook-progress"><i class="cook-progress-fill" style="--progress:${percent}%;--remaining:${remaining}ms"></i></div>
    <div class="cook-hint">${escapeHTML(phrase("TUTORIAL_WORK_BASE_4_1"))}　${formatSeconds(recipe?.cookTime ?? 0)} s</div>
  </div>`;
}

function renderNight() {
  const guest = currentGuest();
  const selectedFoodId = Number(state.selectedCookFoodId ?? state.menuFoods[0] ?? 0);
  const recipe = recipeForFood(selectedFoodId);
  const cookerName = recipe ? (standardCookers[Number(recipe.cookerType)]?.Name ?? phrase("COMMON_COOKER")) : phrase("COMMON_COOKER");
  const ingredients = (recipe?.ingredients ?? []).map(id => `<span class="ingredient-token">${imageForItem("ingredient", id, "")}<span>${escapeHTML(itemName("ingredient", id))}</span></span>`).join("");
  const guestRows = state.guests.map(renderGuestCard).join("");
  const readyItems = state.readyFoods.map((id, index) => `<button class="shelf-item ${Number(state.selectedReadyFoodIndex) === index ? "selected" : ""}" data-action="select-ready-food" data-index="${index}" title="${escapeHTML(itemName("food", id))}">${imageForItem("food", id, "")}<span class="shelf-count">${index + 1}</span></button>`).join("");
  const drinkItems = state.menuBeverages.map(id => `<button class="shelf-item ${Number(state.selectedDrinkId) === Number(id) ? "selected" : ""}" data-action="select-drink" data-id="${Number(id)}" title="${escapeHTML(itemName("drink", id))}">${imageForItem("drink", id, "")}</button>`).join("");
  const orderFoodName = guest ? itemName("food", guest.order.foodId) : "";
  const orderDrinkName = guest ? itemName("drink", guest.order.drinkId) : "";
  const currentGuestInfo = guest ? `<div class="order-current">${guestIcon(guest.name)}<span class="order-current-name">${escapeHTML(guest.name)}</span></div>` : "";
  const foodOrderItem = guest ? `<div class="order-item">${imageForItem("food", guest.order.foodId, "")}<div class="order-item-copy"><small>${escapeHTML(phrase("COMMON_FOOD"))}</small>${escapeHTML(orderFoodName)}${guest.foodDone ? `　✓` : ""}</div></div>` : "";
  const drinkOrderItem = guest ? `<div class="order-item">${imageForItem("drink", guest.order.drinkId, "")}<div class="order-item-copy"><small>${escapeHTML(phrase("WORK_STORAGE_BEVERAGE"))}</small>${escapeHTML(orderDrinkName)}${guest.drinkDone ? `　✓` : ""}</div></div>` : "";
  const cookButtonText = phrase("INPUTHELPER_COOKINGMODULE_SELECT") || phrase("COMMON_SELECT");
  const canServeFood = Boolean(guest && !guest.foodDone && state.selectedReadyFoodIndex !== null && state.selectedReadyFoodIndex < state.readyFoods.length);
  const canServeDrink = Boolean(guest && !guest.drinkDone && state.menuBeverages.includes(Number(state.selectedDrinkId)));
  const dayText = phrase("DAY", { a: state.day });

  screen.innerHTML = `
    <section class="scene night-scene">
      ${img("Night_Frame", "scene-backdrop")}
      <div class="scene-shade"></div>
      ${img("Night_FrontDesk", "night-frontdesk")}
      <header class="night-topbar">
        <div class="top-title">${escapeHTML(phrase("IZAKAYA_THEME"))}</div>
        <div class="top-spacer"></div>
        <div class="top-chip">${escapeHTML(shopName)}</div>
        <div class="top-chip">${escapeHTML(dayText)}</div>
        <div class="top-chip">¥ <strong>${roundMoney(state.money)}</strong></div>
      </header>
      <div class="night-layout">
        <section class="guest-panel lacquer">
          <h2 class="panel-heading">${escapeHTML(phrase("COMMON_IZAKAYA_GUESTTABLE"))}</h2>
          <div class="guest-list">${guestRows}</div>
        </section>
        <section class="cook-panel lacquer">
          ${img("0_cook", "cook-backdrop", 828, 548, "core_944c")}
          <div class="cook-overlay">
            <div class="cook-header"><h2 class="panel-heading">${escapeHTML(phrase("COMMON_COOKER"))}</h2><div class="cooker-chip">${imageForItem("cooker", Number(recipe?.cookerType ?? 1) - 1, "")}${escapeHTML(cookerName)}</div></div>
            <div class="night-recipe-list">${state.menuFoods.map(id => foodById.get(Number(id))).filter(Boolean).map(renderNightRecipe).join("")}</div>
            <div class="selected-recipe-info"><div><div class="selected-recipe-name">${escapeHTML(itemName("food", selectedFoodId))}</div><div class="selected-recipe-sub">${escapeHTML(phrase("NOTE_RECIPE_COOKTIME"))}${formatSeconds(recipe?.cookTime ?? 0)} s</div></div><div>${imageForItem("cooker", Number(recipe?.cookerType ?? 1) - 1, "item-icon")}</div><div class="selected-recipe-ingredients">${ingredients}</div></div>
            <div class="cook-slot">${img("CookSlot_bg", "cook-slot-art", 560, 128)}${renderCookProgress()}</div>
            <div class="cook-controls"><button class="game-button compact" data-action="start-cook" ${state.cooking ? "disabled" : ""}>${escapeHTML(cookButtonText)}</button><span class="cook-hint">${escapeHTML(phrase("TUTORIAL_WORK_BASE_5_1"))}</span></div>
          </div>
        </section>
        <section class="order-panel lacquer">
          <h2 class="panel-heading">${escapeHTML(phrase("TUTORIAL_ORDER_1").split("\\n")[0])}</h2>
          ${currentGuestInfo}
          <p class="order-note">${escapeHTML(phrase("TUTORIAL_WORK_BASE_9_1"))}</p>
          ${foodOrderItem}${drinkOrderItem}
          <div class="order-actions">
            <button class="game-button compact" data-action="serve-food" ${canServeFood ? "" : "disabled"}>${escapeHTML(phrase("INPUTHELPER_CONFIRM"))} · ${escapeHTML(phrase("COMMON_FOOD"))}</button>
            <button class="game-button secondary compact" data-action="serve-drink" ${canServeDrink ? "" : "disabled"}>${escapeHTML(phrase("INPUTHELPER_CONFIRM"))} · ${escapeHTML(phrase("WORK_STORAGE_BEVERAGE"))}</button>
          </div>
        </section>
      </div>
      <div class="shelf-row">
        <section class="shelf-box"><h3 class="shelf-title">${escapeHTML(phrase("WORK_STORAGE_FOOD"))}</h3><div class="shelf-items">${readyItems || `<span class="shelf-empty">${escapeHTML(phrase("TUTORIAL_WORK_BASE_5_1"))}</span>`}</div></section>
        <section class="shelf-box"><h3 class="shelf-title">${escapeHTML(phrase("WORK_STORAGE_BEVERAGE"))}</h3><div class="shelf-items">${drinkItems}</div></section>
      </div>
    </section>`;
  if (state.cooking) scheduleCookingCompletion();
}

function renderResult() {
  const total = state.guests.length;
  const normalCount = state.guests.filter(guest => guest.type === "normal").length;
  const specialCount = state.guests.filter(guest => guest.type === "special").length;
  const rows = state.roundResults.map(result => `<div class="result-row"><strong>${escapeHTML(result.name)}</strong><span class="result-line">${escapeHTML(result.feedback)}</span><span class="earned">¥${roundMoney(result.earned)}</span></div>`).join("");
  const dayText = phrase("DAY", { a: state.day });
  screen.innerHTML = `
    <section class="scene result-scene">
      ${img("Night_Frame", "scene-backdrop")}
      <div class="scene-shade"></div>
      ${img("Night_FrontDesk", "night-frontdesk")}
      <div class="result-board">
        <h2 class="panel-heading">${escapeHTML(dayText)}</h2>
        <div class="result-stats">
          <div class="result-stat"><div class="result-stat-label">${escapeHTML(phrase("RESULT_COUNT_GUEST_TOTAL", { a: total }))}</div><div class="result-stat-value">${total}</div></div>
          <div class="result-stat"><div class="result-stat-label">${escapeHTML(phrase("RESULT_COUNT_GUEST_NORMAL", { a: normalCount }))}</div><div class="result-stat-value">${normalCount}</div></div>
          <div class="result-stat"><div class="result-stat-label">¥</div><div class="result-stat-value">${roundMoney(state.dayRevenue)}</div></div>
        </div>
        <div class="result-list">${rows}</div>
        <div class="result-actions"><button class="game-button" data-action="next-day">${escapeHTML(phrase("INPUTHELPER_CONFIRM"))}</button></div>
      </div>
    </section>`;
}

function renderLoading() {
  screen.innerHTML = `<section class="scene loading-scene"><div class="loading-mark">${escapeHTML(phrase("IZAKAYA_THEME") || "…")}</div></section>`;
}

function render() {
  if (!gameData) return renderLoading();
  if (state.phase === "title") renderTitle();
  else if (state.phase === "prep") renderPrep();
  else if (state.phase === "night") renderNight();
  else renderResult();
}

function handleAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  const id = Number(target.dataset.id);
  const index = Number(target.dataset.index);

  if (action === "new-game") return beginNewGame();
  if (action === "resume") return continueSavedGame();
  if (action === "toggle-food") {
    state.selectedRecipeFoodId = id;
    state.menuFoods = state.menuFoods.includes(id) ? state.menuFoods.filter(item => item !== id) : [...state.menuFoods, id];
    if (!state.menuFoods.length) state.selectedCookFoodId = null;
    else if (!state.menuFoods.includes(Number(state.selectedCookFoodId))) state.selectedCookFoodId = state.menuFoods[0];
    saveProgress(); render(); return;
  }
  if (action === "toggle-drink") {
    state.menuBeverages = state.menuBeverages.includes(id) ? state.menuBeverages.filter(item => item !== id) : [...state.menuBeverages, id];
    if (!state.menuBeverages.includes(Number(state.selectedDrinkId))) state.selectedDrinkId = state.menuBeverages[0] ?? null;
    saveProgress(); render(); return;
  }
  if (action === "start-night") return startNight();
  if (action === "select-guest") {
    if (Number.isInteger(index) && state.guests[index] && !state.guests[index].done) {
      state.selectedGuestIndex = index; saveProgress(); render();
    }
    return;
  }
  if (action === "select-cook-food") {
    if (state.menuFoods.includes(id)) { state.selectedCookFoodId = id; saveProgress(); render(); }
    return;
  }
  if (action === "start-cook") return startCooking();
  if (action === "select-ready-food") {
    if (Number.isInteger(index) && index >= 0 && index < state.readyFoods.length) {
      state.selectedReadyFoodIndex = index; saveProgress(); render();
    }
    return;
  }
  if (action === "select-drink") {
    if (state.menuBeverages.includes(id)) { state.selectedDrinkId = id; saveProgress(); render(); }
    return;
  }
  if (action === "serve-food") return deliverFood();
  if (action === "serve-drink") return deliverDrink();
  if (action === "next-day") return nextDay();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function fetchRawLocalization(name) {
  const item = textIndex.find(entry => entry.name === name);
  if (!item) return [];
  const response = await fetch(item.src, { cache: "no-store" });
  if (!response.ok) return [];
  const text = (await response.text()).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const cols = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, cols[index] ?? ""]));
  });
}

async function preloadOriginalArt(names) {
  const urls = [...new Set(names.map(name => imgUrl(name)).filter(Boolean))];
  await Promise.all(urls.map(url => new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
    if (image.decode) image.decode().then(resolve).catch(() => resolve());
  })));
}

function makeIndexes() {
  phraseMap = new Map(tableRows("CommonPhrasesLang").map(row => [row.PhraseName, row.Name]));
  spritesByName = new Map();
  for (const sprite of sprites) {
    if (!spritesByName.has(sprite.name)) spritesByName.set(sprite.name, []);
    spritesByName.get(sprite.name).push(sprite);
  }
  for (const list of spritesByName.values()) list.sort((a, b) => a.bundle.localeCompare(b.bundle));
}

let foodNames = new Map();
let drinkNames = new Map();
let ingredientNames = new Map();
let guestNames = new Map();
let foodById = new Map();
let drinkById = new Map();
let ingredientById = new Map();
let recipeByFood = new Map();
let standardCookers = [];
let levelOneFoods = [];
let levelOneDrinks = [];
let levelOneRecipes = [];
let shopName = "";

async function init() {
  fitStage();
  renderLoading();
  try {
    [gameData, sprites, textIndex] = await Promise.all([
      fetchJson(DATA_URL),
      fetchJson(SPRITES_URL),
      fetchJson(TEXT_INDEX_URL)
    ]);
    makeIndexes();
    foodNames = makeNumberMap("FoodsLang", "id", "name");
    drinkNames = makeNumberMap("BeveragesLang", "id", "name");
    ingredientNames = makeNumberMap("IngredientsLang", "id", "name");
    guestNames = makeNumberMap("NormGuestLang", "ID", "NAME");
    const profile = gameData.profiles;
    foodById = new Map(profile.FoodProfile.sellables.map(item => [Number(item.id), item]));
    drinkById = new Map(profile.BeverageProfile.sellables.map(item => [Number(item.id), item]));
    ingredientById = new Map(profile.IngredientProfile.ingredients.map(item => [Number(item.id), item]));
    for (const recipe of profile.RecipeProfile.recipes) recipeByFood.set(Number(recipe.foodID), recipe);
    standardCookers = tableRows("StandardCookersLang");
    levelOneFoods = profile.FoodProfile.sellables
      .filter(item => Number(item.id) >= 0 && Number(item.level) <= 1 && recipeByFood.has(Number(item.id)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    levelOneRecipes = levelOneFoods.map(item => recipeByFood.get(Number(item.id))).filter(Boolean);
    levelOneDrinks = profile.BeverageProfile.sellables
      .filter(item => Number(item.level) <= 1)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const izakaya = profile.IzakayaProfile.izakayas.find(item => Number(item.id) === 0);
    shopName = tableRows("IzakayaLang").find(row => Number(row.ID) === 0)?.Name ?? "";
    if (izakaya && !shopName) shopName = String(izakaya.id);

    const selectedNames = [
      "Shop_BG", "MainMenuCD", "米斯蒂娅 高兴", "DaycookBoard", "DailyMenu_Board",
      "Night_Frame", "Night_FrontDesk", "0_cook", "0_BeverageShelf", "CookSlot_bg",
      "CharacterBG", "CharacterFrame", "Night_FrontDesk_Tray", "Button_DailyMenu"
    ];
    for (const item of levelOneFoods) selectedNames.push(`Foods_${item.id}`);
    for (const item of levelOneDrinks) selectedNames.push(`Beverages_${item.id}`);
    for (const recipe of levelOneRecipes) for (const id of recipe.ingredients ?? []) selectedNames.push(`Ingredients_${id}`);
    await Promise.all([
      preloadOriginalArt(selectedNames),
      fetchRawLocalization("SpecFoodTagLang"),
      fetchRawLocalization("SpecBevTagLang")
    ]);

    savedProgress = readSavedProgress();
    if (savedProgress && savedProgress.cooking && Date.now() >= Number(savedProgress.cooking.endAt)) {
      savedProgress.readyFoods = [...(savedProgress.readyFoods ?? []), Number(savedProgress.cooking.foodId)];
      savedProgress.cooking = null;
    }
    state = newState();
    if (savedProgress) state.phase = "title";
    render();
  } catch (error) {
    fatalEl.hidden = false;
    fatalEl.textContent = `原始游戏数据或美术资源载入失败。\n${String(error?.message ?? error)}`;
  }
}

stage.addEventListener("click", handleAction);
window.addEventListener("resize", fitStage, { passive: true });
init();
