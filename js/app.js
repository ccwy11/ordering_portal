function brandTitle() { return brand === 'KURO' ? 'KURO 黑釜' : 'SEVENS 七道'; }
function dayStamp(d) { d = d || new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function mondayStamp() { return dayStamp(dateForSlot(0)); }
// ===== LIVE MASTER DATA (admin → /api/master). Embedded DATA above = last-resort fallback =====
let CATS = ['蔬菜', '肉類', '凍肉', '豆製品', '調味', '乾貨', '湯料', '清潔', '其他'];
function applyMaster(m) {
  DATA = m.brands; SUPPLIER_META = m.suppliers;
  if (Array.isArray(m.categories) && m.categories.length) CATS = m.categories;
  Object.values(DATA).flat().forEach(i => {
    if (i.default_qty === '' || i.default_qty === undefined) i.default_qty = null;
    i.active = i.active !== false; i.unit = i.unit || ''; i.notes = i.notes || '';
  });
}
function _fetchT(url, ms) {
  return Promise.race([
    fetch(url, { cache: 'no-store' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || SHEET_FETCH_TIMEOUT))
  ]);
}
async function fetchSheetMaster() {
  const [ir, sr] = await Promise.all([_fetchT(SHEET_ITEMS_URL), _fetchT(SHEET_SUPPLIERS_URL)]);
  if (!ir.ok || !sr.ok) throw new Error('sheet HTTP ' + ir.status + '/' + sr.status);
  const ib = buildItemsFromCSV(parseCSV(await ir.text()));
  if (ib.error) throw new Error(ib.error);
  if (!ib.items.length) throw new Error('items sheet empty');
  const sb = buildSuppliersFromCSV(parseCSV(await sr.text()));
  if (sb.error) throw new Error(sb.error);
  const brands = {};
  ib.items.forEach(({ brand, item }) => { (brands[brand] = brands[brand] || []).push(item); });
  const warnings = ib.warnings.concat(sb.warnings);
  if (warnings.length) console.warn('sheet warnings:', warnings);
  return { brands, suppliers: sb.suppliers };
}

function markSrc(src) {
  try {
    localStorage.setItem('sevens_master_src', src);
    localStorage.setItem('sevens_master_src_ts', String(Date.now()));
  } catch (e) { }
}
function dataSourceInfo() {
  let s = 'embedded', ts = 0;
  try {
    s = localStorage.getItem('sevens_master_src') || 'embedded';
    ts = +localStorage.getItem('sevens_master_src_ts') || 0;
  } catch (e) { }
  const label = { sheet: 'Google Sheet 🟢', live: 'API', cache: '本機快取', embedded: '內置資料' }[s] || s;
  const time = ts ? new Date(ts).toLocaleString('zh-HK', { hour12: false }) : '—';
  return `v${VERSION} · 資料來源：${label} · 上次更新：${time}`;
}

async function loadMaster() {
  // 1) Google Sheet — live catalog
  try {
    const m = await fetchSheetMaster();
    applyMaster(m);
    try { localStorage.setItem('sevens_master_cache', JSON.stringify({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS })); } catch (e) { }
    markSrc('sheet');
    return 'sheet';
  } catch (e) { console.warn('sheet fetch failed → fallback:', e && e.message); }
  // 2) JSON endpoints (future backend)
  for (const url of ['/api/master', '/master.json']) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const m = await r.json();
      if (m && m.brands && m.suppliers) {
        applyMaster(m);
        try { localStorage.setItem('sevens_master_cache', JSON.stringify(m)); } catch (e) { }
        markSrc('live');
        return 'live';
      }
    } catch (e) { }
  }
  // 3) last successful load
  try {
    const c = JSON.parse(localStorage.getItem('sevens_master_cache') || 'null');
    if (c && c.brands) { applyMaster(c); markSrc('cache'); return 'cache'; }
  } catch (e) { }
  // 4) embedded data in this file (always works)
  markSrc('embedded');
  return 'embedded';
}

/** Manual refresh from the data panel: re-read the Sheet, re-sync states, re-render */
async function reloadSheet() {
  showToast(lang === 'zh' ? '正在讀取 Google Sheet…' : 'Fetching Google Sheet…');
  const src = await loadMaster();
  if (src === 'sheet' || src === 'live') {
    const valid = new Set(Object.values(DATA).flat().map(i => i.id));
    [state, weekState, weekSkip, fixedOverride].forEach(obj => {
      Object.keys(obj).forEach(id => { if (!valid.has(id)) delete obj[id]; });
    });
    MASTER().forEach(item => {
      if (!state[item.id]) state[item.id] = { qty: 0, skipped: false };
      ensureWeekArrays(item.id);
    });
    renderCatChips(); saveState(); render();
    showToast(lang === 'zh' ? '✅ 已從 Sheet 更新' : '✅ Updated from sheet');
  } else if (src === 'cache') {
    render();
    showToast('離線：使用上次載入的資料');
  } else {
    showToast('未能載入 Sheet（使用內置版本）');
  }
}
function renderCatChips() {
  const w = document.getElementById('catWrap'); if (!w) return;
  if (activeCategory !== 'all' && !CATS.includes(activeCategory)) activeCategory = 'all';
  w.innerHTML = [['all', '全部'], ...CATS.map(c => [c, c])].map(([k, l]) =>
    `<span class="cat-chip ${k === activeCategory ? 'active' : ''}" data-cat="${k}" onclick="setCategory(this.dataset.cat)">${l}</span>`).join('') +
    `<button type="button" id="fixedToggle" class="flag-btn" onclick="toggleShowFixed()" style="margin-left:6px;vertical-align:middle"></button>`;
  updateFlagUI();
}
function MASTER() { return DATA[brand] || []; }


// ===== STATE =====
let brand = 'SEVENS';
function storageKey() { return 'sevens_order_v183_' + brand; }
const STORAGE_KEY_LEGACY = 'sevens_order_v183'; // not used after v1.8.3
const DAYS = ['一', '二', '三', '四', '五', '六', '日'];
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Mon=0 ... Sun=6. Today and past days are locked; default edit day = tomorrow.
const CUTOFF_HOUR = 17; // after 17:00 HKT, treat "tomorrow" lock more strictly if needed

// Day model: index 0-6 = this week Mon-Sun, 7-13 = next week Mon-Sun
const WEEK_LEN = 14;

function todayIndex() {
  // JS getDay: Sun=0..Sat=6 → convert to Mon=0..Sun=6 (this week only)
  return (new Date().getDay() + 6) % 7;
}
function tomorrowIndex() {
  // Editable "明日" may fall in this week or next week (e.g. Sun → next Mon = 7)
  const t = todayIndex();
  if (t < 6) return t + 1; // Mon-Sat → next day same week
  return 7; // Sunday → next Monday
}
/** slot 0-13. Past + today locked; rest of this week + full next week open. */
function isDayLocked(dayIndex) {
  if (dayIndex < 0 || dayIndex >= WEEK_LEN) return true;
  if (dayIndex >= 7) return false; // entire next week is open
  return dayIndex <= todayIndex(); // this week: lock Mon..today
}
function isNextWeek(dayIndex) {
  return dayIndex >= 7;
}
function dayOfWeek(dayIndex) {
  return dayIndex % 7; // 0=Mon .. 6=Sun
}
/** Calendar Date for a slot (this week Mon + offset). */
function dateForSlot(dayIndex) {
  const today = new Date();
  const monIdx = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - monIdx);
  const d = new Date(monday);
  d.setDate(monday.getDate() + dayIndex);
  return d;
}
function formatSlotDate(dayIndex, withWeekday) {
  const d = dateForSlot(dayIndex);
  const wd = lang === 'zh' ? DAYS[dayOfWeek(dayIndex)] : DAYS_EN[dayOfWeek(dayIndex)];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (withWeekday === false) return md;
  const weekTag = isNextWeek(dayIndex)
    ? (lang === 'zh' ? '下週' : 'next')
    : (lang === 'zh' ? '本週' : 'this');
  return lang === 'zh' ? `${weekTag}${wd} ${md}` : `${weekTag} ${wd} ${md}`;
}
function firstEditableDay() {
  for (let d = 0; d < WEEK_LEN; d++) {
    if (!isDayLocked(d)) return d;
  }
  return tomorrowIndex();
}
function emptyWeekArr(fill) {
  return Array(WEEK_LEN).fill(fill);
}

let lang = 'zh';
let mode = 'tomorrow';          // 'tomorrow' | 'preorder'

let activeCategory = 'all';
let activeDay = firstEditableDay(); // e.g. if today Fri → Sat
let preorderDate = null;        // YYYY-MM-DD for preorder mode
let preorderState = {};         // id -> { qty, skipped } for preorder mode
let state = {};                 // id -> { qty, skipped } for tomorrow mode
let weekState = {};             // id -> [qty0..qty6]
let weekSkip = {};              // id -> [bool0..bool6] skip flags per day

let _photoText = '';            // text for current photo card
let _photoGroups = [];          // [{supplier, day, rows}] shown on the current photo card (for the log)

/** Short unit for +/- controls: "5斤裝/包" → "包", "20kg/箱" → "箱" */
// Unit model: multi-char unit = "processed unit" (how supplier packs it); real unit = word after "/" ; single char = real unit
function unitReal(u) {
  const t = String(u || '').trim(); if (!t) return '';
  if (t.includes('/')) return t.split('/').pop().trim() || t;
  if ([...t].length === 1) return t;
  const m = t.match(/([^\d\s.]+)$/); return m ? m[1] : t;
}
function unitProc(u) { const t = String(u || '').trim(); return [...t].length > 1 ? t : ''; }
function shortUnit(u) { return unitReal(u); }
const PROC_STYLE = 'display:inline-block;margin-top:2px;padding:1px 8px;border-radius:6px;background:#fef3c7;color:#92400e;font-weight:700;font-size:.85em';
function metaUnit(item) {
  const pr = unitProc(item.unit);
  return pr ? `<span style="color:#92400e;font-weight:700">${lang === 'zh' ? '加工單位' : 'Processed'}</span> <span style="${PROC_STYLE}">${pr}</span>`
    : `${lang === 'zh' ? '單位' : 'Unit'} ${unitReal(item.unit) || '—'}`;
}
function qtyHtml(item, q) { const pr = unitProc(item.unit); return `<b>${q} ${unitReal(item.unit)}</b>${pr ? `<br><span style="${PROC_STYLE}">${pr}</span>` : ''}`; }
function qtyPlain(item, q) {
  // Forward-friendly: qty+unit first, processed unit contained in（）, notes appended
  const pr = unitProc(item.unit);
  const tail = `${q} ${unitReal(item.unit)}`;
  let line = pr ? `${tail}（${lang === 'zh' ? '加工單位' : 'Processed'}：${pr}）` : tail;
  if (item.notes) line += `（${item.notes}）`;
  return line;
}
/** Summary modal row: name (left) — processed unit (center) — qty + unit (right) */
function summaryRowHtml(name, item, qty) {
  const pr = unitProc(item.unit);
  const proc = pr ? `<span class="si-proc" style="${PROC_STYLE}">${pr}</span>` : '';
  return `<div class="summary-item"><span class="si-name">${name}</span>${proc}<span class="qty"><b>${qty} ${unitReal(item.unit)}</b></span></div>`;
}
// Next-day view: the delivery date is the NEXT scheduled delivery day after today (e.g. Tue/Thu/Sat supplier: Sat order -> Tue, Mon order -> Tue)
function nextDeliverySlot(item) {
  const t = todayIndex();
  for (let d = t + 1; d <= t + 7; d++) if (isDeliveryDay(item, d)) return d;
  return t + 1;
}
function nextDeliverySlotForDate(item, dateStr) {
  // Return slot index for the first delivery on/after the given date
  if (!dateStr) return tomorrowIndex();
  const target = new Date(dateStr + 'T00:00:00');
  const t = todayIndex();
  const targetSlot = Math.round((target - new Date()) / 86400000) + t;
  for (let d = targetSlot; d <= targetSlot + 7; d++) if (isDeliveryDay(item, d)) return d;
  return targetSlot;
}
function deliveryLabel(days) {
  const d = [...new Set(days || [])].sort(), zh = lang === 'zh';
  if (!d.length || d.length === 7) return zh ? '每日' : 'Daily';
  const N = i => zh ? DAYS[i] : DAYS_EN[i], runs = []; let a = d[0], p = d[0];
  for (const x of d.slice(1).concat([99])) { if (x === p + 1) { p = x; continue; } runs.push([a, p]); a = p = x; }
  return runs.map(([x, y]) => y - x >= 2 ? N(x) + (zh ? '至' : '–') + N(y) : (zh ? DAYS.slice(x, y + 1).join('') : DAYS_EN.slice(x, y + 1).join('/'))).join(zh ? '' : ' · ');
}
function supDeliv(supplier) { return deliveryLabel(getDeliveryDays({ supplier })); }
function supNext(supplier) { return fmtDeliv(nextDeliverySlot({ supplier })); }
function fmtDeliv(d) { const dt = dateForSlot(d); const w = lang === 'zh' ? '週' + DAYS[dayOfWeek(d)] : DAYS_EN[dayOfWeek(d)]; return `${dt.getMonth() + 1}/${dt.getDate()}（${w}）`; }

// ---- fixed-schedule items: hidden by default, revealable for emergency edits ----
let showFixed = false, fixedOverride = {};
function isFixed(item) { return fixedOverride[item.id] !== undefined ? !!fixedOverride[item.id] : item.fixed === true; }
function toggleFixed(id) {
  const it = MASTER().find(i => i.id === id); if (!it) return;
  fixedOverride[id] = !isFixed(it); saveState(); render();
  showToast(fixedOverride[id] ? (lang === 'zh' ? '已設為固定排程（預設隱藏）' : 'Set as fixed schedule (hidden by default)') : (lang === 'zh' ? '已取消固定排程' : 'Removed from fixed schedule'));
}
function toggleShowFixed() { showFixed = !showFixed; render(); }
function updateFlagUI() {
  const n = MASTER().filter(i => i.active && isFixed(i)).length;
  const f = document.getElementById('fixedToggle');
  if (f) { f.style.display = n || showFixed ? '' : 'none'; f.classList.toggle('on', showFixed); f.textContent = `📌 ${lang === 'zh' ? (showFixed ? '顯示固定排程' : '固定排程已隱藏') : (showFixed ? 'Fixed shown' : 'Fixed hidden')} (${n})`; }
}

function ensureWeekArrays(id) {
  if (!weekState[id] || weekState[id].length < WEEK_LEN) {
    const old = weekState[id] || [];
    weekState[id] = emptyWeekArr(0);
    for (let i = 0; i < Math.min(old.length, WEEK_LEN); i++) weekState[id][i] = old[i] || 0;
  }
  if (!weekSkip[id] || weekSkip[id].length < WEEK_LEN) {
    const old = weekSkip[id] || [];
    weekSkip[id] = emptyWeekArr(false);
    for (let i = 0; i < Math.min(old.length, WEEK_LEN); i++) weekSkip[id][i] = !!old[i];
  }
}


/** Resolve delivery days for an item (item override > supplier meta > everyday) */
function getDeliveryDays(item) {
  if (item.delivery_days && item.delivery_days.length) return item.delivery_days;
  const meta = SUPPLIER_META[item.supplier];
  if (meta && meta.delivery_days && meta.delivery_days.length) return meta.delivery_days;
  return [0, 1, 2, 3, 4, 5, 6];
}
function isDeliveryDay(item, dayIndex) {
  return getDeliveryDays(item).includes(dayOfWeek(dayIndex));
}

function setBrand(b) {
  if (b === brand) return;
  saveState(); // save current brand state
  brand = b;
  document.body.classList.toggle('brand-kuro', b === 'KURO');
  document.body.classList.toggle('brand-sevens', b === 'SEVENS');
  document.querySelectorAll('.brand-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.brand === b);
  });
  const logo = document.getElementById('brandLogo');
  if (logo) logo.innerHTML = b === 'SEVENS' ? 'SEVENS <span>七道</span>' : 'KURO <span>黑釜</span>';
  activeCategory = 'all';
  // load other brand state (or init)
  state = {}; weekState = {}; weekSkip = {};
  loadState();
  // ensure arrays for all items of this brand
  MASTER().forEach(item => ensureWeekArrays(item.id));
  if (isDayLocked(activeDay)) activeDay = firstEditableDay();
  if (!state || Object.keys(state).length === 0) initState();
  // re-seed defaults for any missing
  MASTER().forEach(item => {
    if (!state[item.id]) state[item.id] = { qty: 0, skipped: false };
  });
  // keep static category chips; just reset active
  renderCatChips();
  setMode(mode);
  render();
  measureStickyChrome();
}

function initState() {
  const editDay = firstEditableDay();
  activeDay = editDay;
  MASTER().forEach(item => {
    state[item.id] = { qty: 0, skipped: false };   // v1.9.6: start at zero — 建議 stays as a hint only
    weekState[item.id] = emptyWeekArr(0);
    weekSkip[item.id] = emptyWeekArr(false);
  });
  loadState();
  MASTER().forEach(item => ensureWeekArrays(item.id));
  if (isDayLocked(activeDay) || activeDay >= WEEK_LEN) activeDay = firstEditableDay();
}

function saveState() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      lang, mode, activeCategory, activeDay, state, weekState, weekSkip, fixedOverride,
      preorderDate, preorderState,
      weekStart: mondayStamp(), tomorrowStamp: dayStamp(dateForSlot(tomorrowIndex()))
    }));
  } catch (e) { }
}

function loadState() {
  try {
    let raw = localStorage.getItem(storageKey());
    if (!raw && brand === 'SEVENS') raw = localStorage.getItem(STORAGE_KEY_LEGACY); // migrate v1.8.2 and earlier
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.lang) lang = data.lang;
    if (data.mode) mode = data.mode;
    if (mode === 'week') mode = 'preorder'; // migrate old week mode to preorder
    if (data.activeCategory) activeCategory = data.activeCategory;
    if (typeof data.activeDay === 'number') activeDay = data.activeDay;
    if (data.state) state = data.state;
    if (data.weekState) weekState = data.weekState;
    if (data.weekSkip) weekSkip = data.weekSkip;
    if (data.preorderDate) preorderDate = data.preorderDate;
    if (data.preorderState) preorderState = data.preorderState;
    fixedOverride = data.fixedOverride || {};
    // Roll over stale data: shift week slots if the saved week is older
    if (data.weekStart && data.weekStart !== mondayStamp()) {
      const pm = data.weekStart.split('-').map(Number);
      const prevMon = new Date(pm[0], pm[1] - 1, pm[2]);
      const weeks = Math.round((dateForSlot(0) - prevMon) / (7 * 86400000));
      const shift = (arr, fill) => {
        const a = Array.isArray(arr) ? arr : []; const out = emptyWeekArr(fill);
        for (let i = 0; i < WEEK_LEN; i++) { const j = i + weeks * 7; if (j >= 0 && j < a.length) out[i] = a[j]; } return out;
      };
      Object.keys(weekState).forEach(id => weekState[id] = shift(weekState[id], 0));
      Object.keys(weekSkip).forEach(id => weekSkip[id] = shift(weekSkip[id], false));
    }
    // "Tomorrow" quantities/skips belong to one date only: reset when the date moved on
    if (data.tomorrowStamp !== dayStamp(dateForSlot(tomorrowIndex()))) {
      MASTER().forEach(it => { state[it.id] = { qty: 0, skipped: false }; });
    }
    if (isDayLocked(activeDay)) activeDay = firstEditableDay();
  } catch (e) { }
}

// ===== MODE & CATEGORY =====
function measureStickyChrome() {
  // Stack: header → mode-tabs → group-toggle → cat-wrap → progress → jump → (day-tabs in week mode)
  const header = document.querySelector('header');
  const modeTabs = document.querySelector('.mode-tabs');
  const groupRow = document.getElementById('groupToggleRow');
  const catWrap = document.querySelector('.cat-wrap');
  const progress = document.querySelector('.progress-wrap');
  const jumpWrap = document.getElementById('jumpWrap');
  const dayTabs = document.getElementById('dayTabs');

  let top = 0;
  if (header) {
    top = header.offsetHeight;
    if (modeTabs) modeTabs.style.top = top + 'px';
  }
  if (modeTabs) top += modeTabs.offsetHeight;
  if (groupRow) {
    groupRow.style.top = top + 'px';
    top += groupRow.offsetHeight;
  }
  if (catWrap) {
    catWrap.style.top = top + 'px';
    top += catWrap.offsetHeight;
  }
  if (progress) {
    progress.style.top = top + 'px';
    top += progress.offsetHeight;
  }
  if (jumpWrap) {
    jumpWrap.style.top = top + 'px';
    top += jumpWrap.offsetHeight;
  }
  const dayTabsTop = top;
  document.documentElement.style.setProperty('--sticky-daytabs-top', dayTabsTop + 'px');
  if (dayTabs) dayTabs.style.top = dayTabsTop + 'px';

  let supplierTop = dayTabsTop;
  if (mode === 'week' && dayTabs && dayTabs.classList.contains('show')) {
    supplierTop += dayTabs.offsetHeight;
  }
  document.documentElement.style.setProperty('--sticky-supplier-top', supplierTop + 'px');
}

function setMode(m) {
  mode = m;
  document.body.classList.toggle('mode-week', m === 'preorder');
  document.body.classList.toggle('mode-tomorrow', m === 'tomorrow');
  document.querySelectorAll('.mode-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === m);
  });
  document.getElementById('dayTabs').classList.toggle('show', m === 'preorder');
  // Label "明日" with actual target weekday (e.g. 六 when today is 五)
  const tLabel = lang === 'zh' ? DAYS[dayOfWeek(tomorrowIndex())] : DAYS_EN[dayOfWeek(tomorrowIndex())];
  document.querySelectorAll('.mode-tab').forEach(el => {
    if (el.dataset.mode === 'tomorrow') {
      el.textContent = lang === 'zh' ? `明日（${tLabel}）` : `Tomorrow (${tLabel})`;
    }
    if (el.dataset.mode === 'preorder') {
      el.textContent = lang === 'zh' ? '預訂 Pre-order' : 'Pre-order 預訂';
    }
  });
  if (mode === 'preorder' && !preorderDate) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    preorderDate = t.toISOString().slice(0, 10);
  }
  saveState();
  render();
}

function setCategory(cat) {
  activeCategory = cat;
  document.querySelectorAll('.cat-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.cat === cat);
  });
  saveState();
  render();
}

function setActiveDay(d) {
  if (isDayLocked(d)) {
    showToast(lang === 'zh' ? '今日及過往日期已鎖定' : 'Today & past days are locked');
    return;
  }
  activeDay = d;
  saveState();
  renderDayTabs();
  render();
}

// ===== RENDER =====
function getFilteredItems() {
  return MASTER().filter(item => {
    if (!item.active) return false;
    if (isFixed(item) && !showFixed) return false;
    if (mode === 'week' && !isDeliveryDay(item, activeDay)) { ensureWeekArrays(item.id); if (!(weekState[item.id][activeDay] > 0)) return false; }
    if (activeCategory === 'all') return true;
    // per-item chip category from StockCheck (not supplier-level)
    return (item.cat || '') === activeCategory;
  });
}

function renderDayTabs() {
  const wrap = document.getElementById('dayTabs');
  if (mode === 'preorder') {
    // Show date picker for preorder mode
    const today = new Date().toISOString().slice(0, 10);
    wrap.innerHTML = `<div class="deliv-cap">📅 ${lang === 'zh' ? '選擇預訂日期' : 'Choose pre-order date'}</div>
      <div class="preorder-date-row">
        <input type="date" id="preorderDateInput" value="${preorderDate || ''}" min="${today}">
        <button type="button" id="preorderQuickToday">${lang === 'zh' ? '今天' : 'Today'}</button>
        <button type="button" id="preorderQuickTomorrow">${lang === 'zh' ? '明天' : 'Tomorrow'}</button>
        <button type="button" id="preorderQuick3d">+3${lang === 'zh' ? '天' : 'd'}</button>
        <button type="button" id="preorderQuick1w">+1${lang === 'zh' ? '週' : 'w'}</button>
      </div>`;
    // Bind events after render
    requestAnimationFrame(() => {
      const inp = document.getElementById('preorderDateInput');
      if (inp) {
        inp.addEventListener('change', e => { preorderDate = e.target.value; saveState(); render(); });
      }
      const setDate = (offset) => {
        const d = new Date(); d.setDate(d.getDate() + offset);
        preorderDate = d.toISOString().slice(0, 10);
        saveState(); render();
      };
      const btns = {
        preorderQuickToday: 0,
        preorderQuickTomorrow: 1,
        preorderQuick3d: 3,
        preorderQuick1w: 7,
      };
      Object.entries(btns).forEach(([id, offset]) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => setDate(offset));
      });
    });
    return;
  }
  if (mode !== 'week') { wrap.innerHTML = ''; return; }

  function rowHtml(weekOffset, labelZh, labelEn, weekClass) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = weekOffset + i;
      const hasQty = MASTER().some(item => {
        ensureWeekArrays(item.id);
        return !weekSkip[item.id][d] && (weekState[item.id][d] || 0) > 0;
      });
      const label = lang === 'zh' ? DAYS[i] : DAYS_EN[i];
      const dayNum = dateForSlot(d).getDate();
      const locked = isDayLocked(d);
      cells += `<div class="day-tab ${weekClass} ${d === activeDay ? 'active' : ''} ${hasQty ? 'has-qty' : ''} ${locked ? 'locked' : ''}"
                    onclick="setActiveDay(${d})">
                  <span class="dow">${label}${locked ? '🔒' : ''}</span>
                  <span class="d-num">${dayNum}</span>
                </div>`;
    }
    const tag = lang === 'zh' ? labelZh : labelEn;
    return `<div class="day-week-row">
      <div class="day-week-label ${weekClass === 'week-this' ? 'this-week' : 'next-week'}">${tag}</div>
      ${cells}
    </div>`;
  }

  wrap.innerHTML = `<div class="deliv-cap">📅 ${lang === 'zh' ? '送貨日 — 以下日期＝供應商到貨日' : 'Delivery date — dates below = when goods arrive'}</div>` +
    rowHtml(0, '本週', 'This', 'week-this') +
    rowHtml(7, '下週', 'Next', 'week-next');
}

/** Live total $ for a supplier (respects current mode + skip) */
function calcSupplierTotal(supplier) {
  let total = 0;
  MASTER().filter(i => i.supplier === supplier).forEach(item => {
    const price = item.unit_price || 0;
    if (mode === 'tomorrow') {
      const s = state[item.id];
      if (s && !s.skipped && s.qty > 0) total += s.qty * price;
    } else if (mode === 'preorder') {
      const s = preorderState[item.id];
      if (s && !s.skipped && s.qty > 0) total += s.qty * price;
    } else {
      // Week mode: MOQ against the active (editable) day only
      const sk = (weekSkip[item.id] || [])[activeDay];
      const q = (weekState[item.id] || [])[activeDay] || 0;
      if (!sk && q > 0) total += q * price;
    }
  });
  return Math.round(total);
}

/** Returns { total, moq, ok, pct } */
function getMoqStatus(supplier) {
  const meta = SUPPLIER_META[supplier] || { moq: 0 };
  const total = calcSupplierTotal(supplier);
  const moq = meta.moq || 0;
  const ok = total >= moq || total === 0; // zero order is fine (not ordered)
  const pct = moq > 0 ? Math.min(100, Math.round(total / moq * 100)) : 100;
  return { total, moq, ok, pct };
}


/** Short label for jump chips: "東興蔬菜 / Spring Up Vegetables" → "東興蔬菜" */
function shortSupplierName(s) {
  if (!s) return '';
  const i = s.indexOf(' / ');
  return i > 0 ? s.slice(0, i) : s;
}

/** Stable id token from supplier or category name */
function jumpIdToken(s) {
  return String(s || '')
    .replace(/\s*\/\s*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff\-]/g, '');
}

function jumpToBlock(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('jump target missing:', id);
    showToast(lang === 'zh' ? '找不到該位置' : 'Section not found');
    return;
  }
  // Re-measure sticky height so offset is accurate
  measureStickyChrome();
  const topStr = getComputedStyle(document.documentElement).getPropertyValue('--sticky-supplier-top');
  const top = parseFloat(topStr) || 200;

  // After layout, nudge up so sticky header doesn't cover the section title
  requestAnimationFrame(() => {
    const y = el.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop) - top - 6;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  });

  // Highlight chip (match data-jump)
  document.querySelectorAll('.jump-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-jump') === id);
  });
  // Keep active chip visible in the horizontal jump bar only
  const activeChip = document.querySelector('.jump-chip.active');
  if (activeChip) {
    const bar = document.getElementById('jumpWrap');
    if (bar) {
      const chipLeft = activeChip.offsetLeft;
      const chipW = activeChip.offsetWidth;
      const barW = bar.clientWidth;
      bar.scrollTo({ left: Math.max(0, chipLeft - (barW - chipW) / 2), behavior: 'smooth' });
    }
  }
}

function renderJumpBar(items) {
  const wrap = document.getElementById('jumpWrap');
  if (!wrap) return;
  if (!items || !items.length) { wrap.innerHTML = ''; return; }
  const label = lang === 'zh' ? '跳至' : 'Jump';
  let chips = `<span class="jump-label">${label}</span>`;
  const seen = [];
  items.forEach(it => { if (!seen.includes(it.supplier)) seen.push(it.supplier); });
  seen.forEach(sup => {
    const id = 'sup-block-' + jumpIdToken(sup);
    chips += `<button type="button" class="jump-chip" data-jump="${id}"
      onclick="event.preventDefault();jumpToBlock('${id}')">${shortSupplierName(sup)}</button>`;
  });
  wrap.innerHTML = chips;
}

function render() {
  updateFlagUI();
  const list = document.getElementById('itemList');
  const items = getFilteredItems();

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">${lang === 'zh' ? '此分類暫無項目' : 'No items in this category'}</div>`;
    renderJumpBar([]);
    updateProgress();
    return;
  }

  let html = '';

  // Pure supplier view — flat by supplier only, no category split
  const groups = {};
  items.forEach(item => {
    (groups[item.supplier] = groups[item.supplier] || []).push(item);
  });

  for (const [supplier, groupItems] of Object.entries(groups)) {
    const meta = SUPPLIER_META[supplier] || { delivery: '—', moq: null, unit: 'HKD', cat: '', cutoff: '', terms: '' };
    const count = groupItems.length;
    const { total, moq, ok, pct } = getMoqStatus(supplier);
    const hasMoq = moq && moq > 0;
    const moqClass = !hasMoq || total === 0 ? '' : (ok ? 'ok' : 'short');
    const barClass = !hasMoq || total === 0 ? '' : (ok ? '' : 'short');
    let moqHtml = '';
    if (hasMoq) {
      const moqLabel = total === 0
        ? `MOQ $${moq}`
        : (lang === 'zh'
          ? `$${total} / MOQ $${moq}${ok ? ' ✓' : ' 未達'}`
          : `$${total} / MOQ $${moq}${ok ? ' ✓' : ' short'}`);
      moqHtml = `<span class="moq ${moqClass}">${moqLabel}
              <span class="moq-bar ${barClass}"><i style="width:${pct}%"></i></span>
            </span>`;
    } else {
      const bits = [];
      if (meta.cutoff) bits.push(meta.cutoff);
      if (meta.terms) bits.push(meta.terms);
      if (bits.length) {
        moqHtml = `<span class="moq" style="color:var(--text-dim)">${bits.join(' · ')}</span>`;
      }
    }

    const skipAllLabel = lang === 'zh' ? '全部跳過' : 'Skip all';
    const vendorSumLabel = lang === 'zh' ? '📷 本商摘要' : '📷 Vendor sum';
    const supAttr = encodeURIComponent(supplier);
    const supIdx = [...new Set(MASTER().map(i => i.supplier))].indexOf(supplier);
    const blockId = 'sup-block-' + jumpIdToken(supplier);
    html += `<div class="supplier-block" id="${blockId}" data-supplier="${supAttr}" data-sup-idx="${supIdx}">
        <div class="supplier-header">
          <div class="supplier-name">
            <span>${supplier}</span>
            <span class="supplier-count">${count}</span>
          </div>
          <div class="supplier-meta">
            <span class="delivery">${lang === 'zh' ? '車期' : 'Delivery'} ${supDeliv(supplier)}${mode === 'tomorrow' ? ' · 📦 ' + supNext(supplier) : mode === 'preorder' && preorderDate ? ' · 📦 ' + fmtDeliv(nextDeliverySlotForDate({ supplier }, preorderDate)) : ''}</span>
            ${moqHtml}
          </div>
        </div>`;

    groupItems.forEach(item => {
      if (mode === 'tomorrow') html += renderTomorrowCard(item, false);
      else if (mode === 'preorder') html += renderPreorderCard(item, false);
      else html += renderWeekCard(item, false);
    });
    // v2.0.1: supplier action footer at bottom (was in header)
    const st = getMoqStatus(supplier);
    const underMoq = !st.ok && st.total > 0;
    const moqWarnAttr = underMoq ? ` title="${lang === 'zh' ? '未達 MOQ，無法轉發' : 'Under MOQ — cannot forward'}"` : '';
    const disabledCls = underMoq ? ' disabled' : '';
    html += `<div class="supplier-footer">
        <button type="button" class="btn-skip-all" data-action="skip-all" data-sup-idx="${supIdx}" data-supplier="${supAttr}">${skipAllLabel}</button>
        <button type="button" class="btn-sup-copy" data-action="vendor-copy" data-sup-idx="${supIdx}" data-supplier="${supAttr}">📄 ${lang === 'zh' ? '複製' : 'Copy'}</button>
        <button type="button" class="btn-sup-wa${disabledCls}" data-action="vendor-wa" data-sup-idx="${supIdx}" data-supplier="${supAttr}"${moqWarnAttr}>🟢 WhatsApp</button>
        <button type="button" class="btn-sup-photo${disabledCls}" data-action="vendor-sum" data-sup-idx="${supIdx}" data-supplier="${supAttr}"${moqWarnAttr}>📷 ${lang === 'zh' ? '本商摘要' : 'Photo'}</button>
      </div></div>`;
  }
  list.innerHTML = html;
  renderJumpBar(items);
  renderDayTabs();
  updateProgress();
  // update lang button
  document.getElementById('langBtn').textContent = lang === 'zh' ? 'EN' : '中';
  // Re-measure after day-tabs height may have changed (week 2-row strip)
  requestAnimationFrame(() => measureStickyChrome());
}


function renderTomorrowCard(item, showSupplier) {
  const s = state[item.id] || { qty: 0, skipped: false };
  const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
  const highlighted = !s.skipped && s.qty > 0;   // v1.9.6: highlight only what will actually be ordered
  const tm = tomorrowIndex();
  const slot = nextDeliverySlot(item);
  const noDelivCls = '';
  const later = slot !== tm;
  const noDelivTag = `<span class="no-deliv-tag" style="background:${later ? '#fef3c7;color:#92400e' : '#ccfbf1;color:#0f766e'}">📦 ${lang === 'zh' ? '送貨' : 'Deliver'} ${fmtDeliv(slot)}</span>`;
  const warn = '';
  return `
    <div class="item-card ${isFixed(item) ? 'fixed-card' : ''} ${s.skipped ? 'skipped' : ''} ${highlighted ? 'has-qty' : ''} ${noDelivCls}" id="card-${item.id}">
      <div class="item-top">
        <div class="item-info">
          <div class="item-name">${name}${noDelivTag}<button class="pin-btn ${isFixed(item) ? 'on' : ''}" onclick="toggleFixed('${item.id}')" title="固定排程">📌</button></div>
          ${showSupplier ? `<div class="item-supplier-tag">${item.supplier}</div>` : ''}
          <div class="item-meta">${metaUnit(item)}${item.default_qty != null ? ` · 建議 ${item.default_qty}` : ""}</div>
          ${item.notes ? `<div class="item-notes">${item.notes}</div>` : ''}
          ${warn}
        </div>
        <button class="skip-btn" onclick="toggleSkip('${item.id}')">${s.skipped ? (lang === 'zh' ? '已跳過' : 'Skipped') : (lang === 'zh' ? '跳過' : 'Skip')}</button>
      </div>
      <div class="controls-row">
        <button class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
        <input class="qty-input" type="number" value="${s.qty}" min="0"
               onchange="setQty('${item.id}', this.value)" ${s.skipped ? 'disabled' : ''}>
        <button class="qty-btn plus" onclick="changeQty('${item.id}', 1)">+</button>
        <span class="unit-label">${shortUnit(item.unit)}</span>
      </div>
    </div>`;
}

function renderPreorderCard(item, showSupplier) {
  const s = preorderState[item.id] || { qty: 0, skipped: false };
  const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
  const highlighted = !s.skipped && s.qty > 0;
  const slot = nextDeliverySlotForDate(item, preorderDate);
  const later = slot !== tomorrowIndex();
  const noDelivTag = `<span class="no-deliv-tag" style="background:${later ? '#fef3c7;color:#92400e' : '#ccfbf1;color:#0f766e'}">📦 ${lang === 'zh' ? '送貨' : 'Deliver'} ${fmtDeliv(slot)}</span>`;
  return `
    <div class="item-card ${isFixed(item) ? 'fixed-card' : ''} ${s.skipped ? 'skipped' : ''} ${highlighted ? 'has-qty' : ''}" id="card-${item.id}">
      <div class="item-top">
        <div class="item-info">
          <div class="item-name">${name}${noDelivTag}<button class="pin-btn ${isFixed(item) ? 'on' : ''}" onclick="toggleFixed('${item.id}')" title="固定排程">📌</button></div>
          ${showSupplier ? `<div class="item-supplier-tag">${item.supplier}</div>` : ''}
          <div class="item-meta">${metaUnit(item)}${item.default_qty != null ? ` · 建議 ${item.default_qty}` : ""}</div>
          ${item.notes ? `<div class="item-notes">${item.notes}</div>` : ''}
        </div>
        <button class="skip-btn" onclick="togglePreorderSkip('${item.id}')">${s.skipped ? (lang === 'zh' ? '已跳過' : 'Skipped') : (lang === 'zh' ? '跳過' : 'Skip')}</button>
      </div>
      <div class="controls-row">
        <button class="qty-btn" onclick="changePreorderQty('${item.id}', -1)">−</button>
        <input class="qty-input" type="number" value="${s.qty}" min="0"
               onchange="setPreorderQty('${item.id}', this.value)" ${s.skipped ? 'disabled' : ''}>
        <button class="qty-btn plus" onclick="changePreorderQty('${item.id}', 1)">+</button>
        <span class="unit-label">${shortUnit(item.unit)}</span>
      </div>
    </div>`;
}

function renderWeekCard(item, showSupplier) {
  ensureWeekArrays(item.id);
  const arr = weekState[item.id];
  const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
  const skippedToday = !!weekSkip[item.id][activeDay];
  const activeQty = skippedToday ? 0 : (arr[activeDay] || 0);
  const dayLabel = formatSlotDate(activeDay);
  const dayLocked = isDayLocked(activeDay) || !isDeliveryDay(item, activeDay);

  function cellsForWeek(weekOffset, weekClass, tagZh, tagEn) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = weekOffset + i;
      const sk = !!weekSkip[item.id][d];
      const q = sk ? 0 : (arr[d] || 0);
      const isActive = d === activeDay;
      const locked = isDayLocked(d);
      const noDel = !isDeliveryDay(item, d);
      cells += `<div class="day-cell ${weekClass} ${isActive ? 'active' : ''} ${q > 0 ? 'has-value' : ''} ${locked ? 'locked' : ''} ${noDel ? 'no-deliv' : ''}"
                    ${noDel ? 'aria-disabled="true"' : `onclick="selectDayCell('${item.id}', ${d})"`} role="button">
                  <span class="d-label">${lang === 'zh' ? DAYS[i] : DAYS_EN[i]}</span>
                  <span class="d-qty ${q === 0 ? 'empty' : ''}">${noDel ? '' : (sk ? '✕' : (q || '—'))}</span>
                </div>`;
    }
    const tag = lang === 'zh' ? tagZh : tagEn;
    const tagClass = weekOffset === 0 ? 'this-week' : 'next-week';
    return `<div class="week-strip-row">
      <div class="week-strip-tag ${tagClass}">${tag}</div>
      ${cells}
    </div>`;
  }

  const skipLabel = skippedToday
    ? (lang === 'zh' ? '已跳過' : 'Skipped')
    : (lang === 'zh' ? '跳過' : 'Skip');
  return `
    <div class="item-card ${skippedToday ? 'skipped' : ''} ${!skippedToday && activeQty > 0 ? 'has-qty' : ''} ${dayLocked ? 'day-locked' : ''}" id="card-${item.id}">
      <div class="item-top">
        <div class="item-info">
          <div class="item-name">${name}<button class="pin-btn ${isFixed(item) ? 'on' : ''}" onclick="toggleFixed('${item.id}')" title="固定排程">📌</button></div>
          ${showSupplier ? `<div class="item-supplier-tag">${item.supplier}</div>` : ''}
          <div class="item-meta">${metaUnit(item)}${item.default_qty != null ? ` · 建議 ${item.default_qty}` : ""}</div>
        </div>
        <button type="button" class="skip-btn" onclick="toggleWeekSkip('${item.id}')"
          ${dayLocked ? 'disabled' : ''}>${skipLabel}</button>
      </div>
      <div class="week-strip">
        ${cellsForWeek(0, 'week-this', '本', 'W0')}
        ${cellsForWeek(7, 'week-next', '下', 'W1')}
      </div>
      <div class="locked-msg">${lang === 'zh' ? '此日已鎖定，請選明日／下週' : 'Day locked — choose tomorrow or next week'}</div>
      <div class="week-edit-panel">
        <div class="week-edit-label">${lang === 'zh' ? '編輯 送貨日' : 'Edit delivery date'} <strong>${dayLabel}</strong></div>
        <div class="controls-row">
          <button type="button" class="qty-btn" onclick="event.stopPropagation(); changeWeekQty('${item.id}', -1)">−</button>
          <input class="qty-input" type="number" inputmode="numeric" value="${activeQty}" min="0"
                 onchange="setWeekQty('${item.id}', this.value)"
                 onclick="event.stopPropagation()" ${skippedToday || dayLocked ? 'disabled' : ''}>
          <button type="button" class="qty-btn plus" onclick="event.stopPropagation(); changeWeekQty('${item.id}', 1)">+</button>
          <span class="unit-label">${shortUnit(item.unit)}</span>
        </div>
      </div>
    </div>`;
}


function changeQty(id, delta) {
  if (!state[id]) { const it = MASTER().find(i => i.id === id); if (!it) return; state[id] = { qty: 0, skipped: false }; }
  if (state[id].skipped) return;
  state[id].qty = Math.max(0, (state[id].qty || 0) + delta);
  saveState();
  render();
}

function setQty(id, val) {
  if (!state[id]) { const it = MASTER().find(i => i.id === id); if (!it) return; state[id] = { qty: 0, skipped: false }; }
  if (state[id].skipped) return;
  state[id].qty = Math.max(0, parseInt(val, 10) || 0);
  saveState();
  render();
}

function changeWeekQty(id, delta) {
  if (isDayLocked(activeDay)) {
    showToast(lang === 'zh' ? '此日已鎖定' : 'Day locked');
    return;
  }
  ensureWeekArrays(id);
  if (weekSkip[id][activeDay]) return;
  weekState[id][activeDay] = Math.max(0, (weekState[id][activeDay] || 0) + delta);
  saveState();
  render();
}

function setWeekQty(id, val) {
  if (isDayLocked(activeDay)) return;
  ensureWeekArrays(id);
  if (weekSkip[id][activeDay]) return;
  weekState[id][activeDay] = Math.max(0, parseInt(val, 10) || 0);
  saveState();
  render();
}

function toggleSkip(id) {
  if (!state[id]) { const it = MASTER().find(i => i.id === id); if (!it) return; state[id] = { qty: 0, skipped: false }; }
  state[id].skipped = !state[id].skipped;
  saveState();
  render();
}

// ===== PREORDER helpers =====
function ensurePreorderItem(id) {
  if (!preorderState[id]) preorderState[id] = { qty: 0, skipped: false };
}
function setPreorderQty(id, val) {
  ensurePreorderItem(id);
  preorderState[id].qty = Math.max(0, parseInt(val, 10) || 0);
  saveState(); render();
}
function changePreorderQty(id, delta) {
  ensurePreorderItem(id);
  if (preorderState[id].skipped) return;
  preorderState[id].qty = Math.max(0, (preorderState[id].qty || 0) + delta);
  saveState(); render();
}
function togglePreorderSkip(id) {
  ensurePreorderItem(id);
  preorderState[id].skipped = !preorderState[id].skipped;
  saveState(); render();
}

function toggleWeekSkip(id) {
  if (isDayLocked(activeDay)) {
    showToast(lang === 'zh' ? '此日已鎖定' : 'Day locked');
    return;
  }
  ensureWeekArrays(id);
  weekSkip[id][activeDay] = !weekSkip[id][activeDay];
  if (weekSkip[id][activeDay]) weekState[id][activeDay] = 0;
  saveState();
  render();
}

/** Resolve supplier from plain name, encoded name, or index string */
function resolveSupplier(ref) {
  if (ref == null || ref === '') return null;
  let s = String(ref);
  try { s = decodeURIComponent(s); } catch (e) { }
  // try again if still encoded
  try { if (s.indexOf('%') >= 0) s = decodeURIComponent(s); } catch (e) { }
  if (MASTER().some(i => i.supplier === s)) return s;
  // match by index into unique supplier list
  const list = [...new Set(MASTER().map(i => i.supplier))];
  const n = parseInt(ref, 10);
  if (!isNaN(n) && list[n]) return list[n];
  // fuzzy: includes
  const hit = list.find(x => x === s || x.includes(s) || s.includes(x));
  return hit || null;
}

/** Skip all items for one supplier (current mode / active day) */
function skipAllSupplier(ref) {
  const supplier = resolveSupplier(ref);
  if (!supplier) {
    showToast(lang === 'zh' ? '找不到此供應商' : 'Supplier not found');
    console.warn('skipAllSupplier: unresolved', ref);
    return;
  }
  const items = MASTER().filter(i => i.supplier === supplier);
  if (items.length === 0) {
    showToast(lang === 'zh' ? '找不到此供應商' : 'Supplier not found');
    return;
  }
  if (mode === 'week' && isDayLocked(activeDay)) {
    showToast(lang === 'zh' ? '此日已鎖定，請選其他日期' : 'Day locked — pick another day');
    return;
  }

  // Skip confirm on tablet (some WebViews block or swallow confirm)
  const allSkipped = items.every(item => mode === 'tomorrow'
    ? (state[item.id] && state[item.id].skipped)
    : (ensureWeekArrays(item.id), weekSkip[item.id][activeDay]));
  if (allSkipped) {
    items.forEach(item => { if (mode === 'tomorrow') state[item.id].skipped = false; else weekSkip[item.id][activeDay] = false; });
    saveState(); render();
    showToast(lang === 'zh' ? `已取消跳過 ${supplier}` : `Un-skipped ${items.length} items`);
    return;
  }
  items.forEach(item => {
    if (mode === 'tomorrow') {
      if (!state[item.id]) state[item.id] = { qty: 0, skipped: false };
      state[item.id].skipped = true;
    } else {
      ensureWeekArrays(item.id);
      weekSkip[item.id][activeDay] = true;
      weekState[item.id][activeDay] = 0;
    }
  });
  saveState();
  render();
  showToast(lang === 'zh' ? `已跳過 ${supplier}（${items.length} 項）` : `Skipped ${items.length} items`);
}

function selectDayCell(id, day) {
  const it = MASTER().find(i => i.id === id);
  if (it && !isDeliveryDay(it, day)) return;
  if (isDayLocked(day)) {
    showToast(lang === 'zh' ? '今日及過往已鎖定，請選本週未來日或下週' : 'Today & past locked — pick later this week or next week');
    return;
  }
  activeDay = day;
  saveState();
  render();
}

/** Build ordered rows for one supplier (respects mode + skip) */
function getVendorRows(supplier, dayIndex) {
  const rows = [];
  const day = (typeof dayIndex === 'number') ? dayIndex : activeDay;
  MASTER().filter(i => i.supplier === supplier).forEach(item => {
    if (mode === 'tomorrow') {
      const s = state[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      rows.push({ item, qty: s.qty });
    } else if (mode === 'preorder') {
      const s = preorderState[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      rows.push({ item, qty: s.qty });
    } else {
      ensureWeekArrays(item.id);
      const sk = weekSkip[item.id][day];
      const q = weekState[item.id][day] || 0;
      if (sk || q <= 0) return;
      rows.push({ item, qty: q });
    }
  });
  return rows;
}

/** All dates that have any order for this supplier (week mode). */
function getVendorDayGroups(supplier) {
  const groups = []; // [{ day, label, rows, total }]
  for (let d = 0; d < WEEK_LEN; d++) {
    const rows = getVendorRows(supplier, d);
    if (rows.length === 0) continue;
    let total = 0;
    rows.forEach(({ item, qty }) => { total += qty * (item.unit_price || 0); });
    groups.push({
      day: d,
      label: formatSlotDate(d),
      rows,
      total: Math.round(total),
      isNext: isNextWeek(d)
    });
  }
  return groups;
}

function showVendorPhoto(supplier, dayIndex) {
  supplier = resolveSupplier(supplier) || supplier;
  if (!supplier || !MASTER().some(i => i.supplier === supplier)) {
    showToast(lang === 'zh' ? '找不到此供應商' : 'Supplier not found');
    return;
  }
  const meta = SUPPLIER_META[supplier] || {};
  const todayStr = new Date().toLocaleDateString('zh-HK', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

  let bodyHtml = '';
  let plain = '';
  let totalItems = 0;

  if (mode === 'tomorrow') {
    const rows = getVendorRows(supplier);
    if (rows.length === 0) {
      showToast(lang === 'zh' ? '此商戶暫無訂貨' : 'No order for this vendor');
      return;
    }
    const bySlot = {};
    rows.forEach(r => { const sl = nextDeliverySlot(r.item); (bySlot[sl] = bySlot[sl] || []).push(r); });
    const slots = Object.keys(bySlot).map(Number).sort((x, y) => x - y);
    // MOQ is per DELIVERY DATE, not a whole-supplier aggregate across dates
    const moqT = meta.moq || 0;
    const shortSlots = [];
    let grandTotal = 0;
    slots.forEach(sl => {
      let t = 0;
      bySlot[sl].forEach(({ item, qty }) => { t += qty * (item.unit_price || 0); });
      t = Math.round(t);
      grandTotal += t;
      if (moqT > 0 && t > 0 && t < moqT) shortSlots.push(`${fmtDeliv(sl)} ($${t}/$${moqT})`);
    });
    // v2.0.1: warn-not-block — show red banner but still allow photo card (copy OK, WhatsApp/Photo blocked per-supplier)
    const moqWarnHtml = shortSlots.length ? `<div class="moq-warn" style="margin-bottom:8px">⚠️ ${lang === 'zh' ? '未達 MOQ' : 'Under MOQ'} · ${shortSlots.join(' · ')}</div>` : '';
    bodyHtml = `<div class="shop-name">🏪 ${supplier}</div>`;
    slots.forEach((sl, bi) => {
      let table = '';
      plain += `${bi ? '\n' : ''}🏪 ${supplier}\n📅 送貨日：${fmtDeliv(sl)}\n`;
      bySlot[sl].forEach(({ item, qty }) => {
        table += `<tr><td>${item.item_zh}${item.item_en ? `<span class="en">${item.item_en}</span>` : ""}</td><td class="qty">${qtyHtml(item, qty)}</td></tr>`;
        plain += `• ${item.item_zh}  ${qtyPlain(item, qty)}\n`;
      });
      bodyHtml += `<div class="photo-day-block" style="border-left:3px solid #0f766e;padding-left:8px;margin:6px 0 4px">
          <div class="photo-day-title" style="color:#0f766e;font-weight:700;font-size:0.85rem;margin-bottom:3px">📅 ${lang === 'zh' ? '送貨日' : 'Delivery'} ${fmtDeliv(sl)}</div>
          <table>${table}</table>
        </div>`;
    });
    totalItems = rows.length;
    bodyHtml = moqWarnHtml + bodyHtml;
    bodyHtml += `<div class="row-count">${rows.length} ${lang === 'zh' ? '項' : 'items'} · $${grandTotal} / MOQ $${meta.moq || '—'}</div>`;
    _photoGroups = slots.map(sl => ({ supplier, day: sl, rows: bySlot[sl] }));
  } else if (mode === 'preorder') {
    const rows = getVendorRows(supplier);
    if (rows.length === 0) { showToast(lang === 'zh' ? '此商戶暫無訂貨' : 'No order for this vendor'); return; }
    let table = '';
    plain = '';
    const sl = nextDeliverySlotForDate(rows[0].item, preorderDate);
    rows.forEach(({ item, qty }) => {
      table += `<tr><td>${item.item_zh}${item.item_en ? `<span class="en">${item.item_en}</span>` : ""}</td><td class="qty">${qtyHtml(item, qty)}</td></tr>`;
      plain += `• ${item.item_zh}  ${qtyPlain(item, qty)}\n`;
    });
    const moqT = meta.moq || 0;
    let grandTotal = 0;
    rows.forEach(({ item, qty }) => { grandTotal += qty * (item.unit_price || 0); });
    grandTotal = Math.round(grandTotal);
    const short = moqT > 0 && grandTotal > 0 && grandTotal < moqT;
    const moqWarnHtml = short ? `<div class="moq-warn" style="margin-bottom:8px">⚠️ ${lang === 'zh' ? '未達 MOQ' : 'Under MOQ'} · $${grandTotal}/$${moqT}</div>` : '';
    bodyHtml = moqWarnHtml + `<div class="shop-name">🏪 ${supplier}</div>`;
    bodyHtml += `<div class="photo-day-block" style="border-left:3px solid #0f766e;padding-left:8px;margin:6px 0 4px">
          <div class="photo-day-title" style="color:#0f766e;font-weight:700;font-size:0.85rem;margin-bottom:3px">📅 ${lang === 'zh' ? '預訂日' : 'Pre-order'} ${preorderDate || '—'} · ${fmtDeliv(sl)}</div>
          <table>${table}</table>
        </div>`;
    totalItems = rows.length;
    bodyHtml += `<div class="row-count">${rows.length} ${lang === 'zh' ? '項' : 'items'} · $${grandTotal} / MOQ $${meta.moq || '—'}</div>`;
    _photoGroups = [{ supplier, day: sl, rows }];
  } else {
    // Week mode: show ALL dates that have edits for this vendor; an explicit dayIndex limits to that one date
    let groups = getVendorDayGroups(supplier);
    if (typeof dayIndex === 'number' && !isNaN(dayIndex)) groups = groups.filter(g => g.day === dayIndex);
    if (groups.length === 0) {
      showToast(lang === 'zh' ? '此商戶暫無訂貨' : 'No order for this vendor');
      return;
    }
    plain = '';
    bodyHtml = `<div class="shop-name">🏪 ${supplier}</div>`;
    const anyShort = groups.some(g => {
      const moq = meta.moq || 0;
      return moq > 0 && g.total > 0 && g.total < moq;
    });
    const moqWarnHtmlWeek = anyShort ? `<div class="moq-warn" style="margin-bottom:8px">⚠️ ${lang === 'zh' ? '未達 MOQ' : 'Under MOQ'}</div>` : '';
    bodyHtml = moqWarnHtmlWeek + bodyHtml;
    groups.forEach(g => {
      const color = g.isNext ? '#6d28d9' : '#0f766e';
      const moq = meta.moq || 0;
      const ok = g.total >= moq;
      plain += `${plain ? '\n' : ''}🏪 ${supplier}\n📅 送貨日：${fmtDeliv(g.day)}\n`;
      let table = '';
      g.rows.forEach(({ item, qty }) => {
        table += `<tr><td>${item.item_zh}${item.item_en ? `<span class="en">${item.item_en}</span>` : ""}</td><td class="qty">${qtyHtml(item, qty)}</td></tr>`;
        plain += `• ${item.item_zh}  ${qtyPlain(item, qty)}\n`;
        totalItems++;
      });
      bodyHtml += `
        <div class="photo-day-block" style="border-left:3px solid ${color};padding-left:8px;margin:8px 0 6px">
          <div class="photo-day-title" style="color:${color};font-weight:700;font-size:0.85rem;margin-bottom:3px">
            📅 ${lang === 'zh' ? '送貨日' : 'Delivery'} ${fmtDeliv(g.day)}
            <span style="font-weight:500;font-size:0.72rem;color:#64748b"> · $${g.total} / MOQ $${moq}${ok ? ' ✓' : (lang === 'zh' ? ' 未達' : ' short')}</span>
          </div>
          <table>${table}</table>
        </div>`;
    });
    _photoGroups = groups.map(g => ({ supplier: g.supplier, day: g.day, rows: g.rows }));
  }

  _photoText = plain;

  const card = document.getElementById('photoCard');
  card.style.transform = 'none';
  card.style.height = 'auto';
  card.innerHTML = `
    <h1>${brandTitle()} · 訂貨</h1>
    ${bodyHtml}
    <div class="footer-note">請用另一部手機拍攝此畫面，發送到對應群組</div>
  `;
  document.getElementById('photoOverlay').classList.add('show');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => fitPhotoCard());
  });
}

function fitPhotoCard() {
  const wrap = document.querySelector('.photo-card-wrap');
  const card = document.getElementById('photoCard');
  if (!wrap || !card) return;
  // Reset so we measure true full content height (all rows, including after 粟米)
  card.style.transform = 'none';
  card.style.height = 'auto';
  const availH = wrap.clientHeight;
  const availW = wrap.clientWidth;
  const needH = card.offsetHeight;
  const needW = card.offsetWidth;
  if (needH <= 0 || availH <= 0) return;
  // Small padding margin so edges are not flush
  const scale = Math.min(1, (availH - 4) / needH, (availW - 4) / needW);
  card.style.transform = `scale(${scale})`;
  // Keep layout space consistent after scale (optional visual centering)
  card.style.marginBottom = scale < 1 ? `${-(needH * (1 - scale))}px` : '0';
}

function closePhotoCard() {
  document.getElementById('photoOverlay').classList.remove('show');
  const card = document.getElementById('photoCard');
  if (card) card.style.transform = 'scale(1)';
}

function copyPhotoText() {
  copyTextUtil(_photoText).then(() => {
    logSend('📷', _photoGroups);
    showToast(lang === 'zh' ? '✅ 已複製並記錄，可貼到群組\n💡 貼上後請檢查數量是否正確' : '✅ Copied & logged — paste to group\n💡 Please double-check quantities after pasting');
  }).catch(() => showToast('Copy failed'));
}

function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  document.getElementById('langBtn').textContent = lang === 'zh' ? 'EN' : '中';
  setMode(mode); // refreshes tab labels (keeps weekday), saves and renders
}

async function resetAll() {
  const msg = lang === 'zh' ? '重置所有數量為建議值？' : 'Reset all quantities to suggested values?';
  if (!(await uiConfirm(msg))) return;
  if (isDayLocked(activeDay)) activeDay = firstEditableDay();
  MASTER().forEach(item => {
    state[item.id] = { qty: 0, skipped: false };
    preorderState[item.id] = { qty: 0, skipped: false };
    weekState[item.id] = emptyWeekArr(0);
    weekSkip[item.id] = emptyWeekArr(false);
  });
  saveState();
  render();
  showToast(lang === 'zh' ? '已重置' : 'Reset done');
}

function updateProgress() {
  const items = getFilteredItems();
  let done = 0, total = items.length;
  if (mode === 'tomorrow') {
    items.forEach(item => {
      const s = state[item.id];
      if (s && (s.skipped || s.qty > 0)) done++;
    });
  } else if (mode === 'preorder') {
    items.forEach(item => {
      const s = preorderState[item.id];
      if (s && (s.skipped || s.qty > 0)) done++;
    });
  } else {
    items.forEach(item => {
      const sk = (weekSkip[item.id] || [])[activeDay];
      const q = (weekState[item.id] || [])[activeDay] || 0;
      if (sk || q > 0) done++;
    });
  }
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${done} / ${total}`;

  let anyShort = false;
  const orderedSup = new Set();
  MASTER().forEach(item => {
    if (mode === 'tomorrow') {
      const s = state[item.id];
      if (s && !s.skipped && s.qty > 0) orderedSup.add(item.supplier);
    } else if (mode === 'preorder') {
      const s = preorderState[item.id];
      if (s && !s.skipped && s.qty > 0) orderedSup.add(item.supplier);
    } else {
      const sk = (weekSkip[item.id] || [])[activeDay];
      const q = (weekState[item.id] || [])[activeDay] || 0;
      if (!sk && q > 0) orderedSup.add(item.supplier);
    }
  });
  orderedSup.forEach(sup => {
    const st = getMoqStatus(sup);
    if (!st.ok && st.total > 0) anyShort = true;
  });

  const btn = document.getElementById('summaryBtn');
  // Enable based on ALL items (not just the filtered view) so a category filter can't hide orders
  let anyOrdered = 0;
  MASTER().forEach(item => {
    if (mode === 'tomorrow') {
      const s = state[item.id];
      if (s && !s.skipped && s.qty > 0) anyOrdered++;
    } else if (mode === 'preorder') {
      const s = preorderState[item.id];
      if (s && !s.skipped && s.qty > 0) anyOrdered++;
    } else {
      const sk = (weekSkip[item.id] || [])[activeDay];
      const q = (weekState[item.id] || [])[activeDay] || 0;
      if (!sk && q > 0) anyOrdered++;
    }
  });
  btn.disabled = anyOrdered === 0;
  btn.title = anyShort
    ? (lang === 'zh' ? '有供應商未達 MOQ（仍可按，產生時會提示）' : 'Some suppliers under MOQ (warned on generate)')
    : '';
}

// ===== SUMMARY =====
function showSummary() {
  // Tomorrow: hard-block under MOQ (per delivery date). Week: show all dates (under-MOQ flagged per section).
  const content = document.getElementById('summaryContent');
  const title = document.getElementById('modalTitle');
  title.textContent = lang === 'zh' ? '訂貨摘要 Order Summary' : 'Order Summary 訂貨摘要';

  let html = '';
  if (mode === 'tomorrow') {
    const groups = {};
    MASTER().forEach(item => {
      const s = state[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      if (activeCategory !== 'all') {
        if ((item.cat || '') !== activeCategory) return;
      }
      const sl = nextDeliverySlot(item), k = item.supplier + '||' + sl;
      if (!groups[k]) groups[k] = { supplier: item.supplier, slot: sl, rows: [] };
      groups[k].rows.push({ item, qty: s.qty });
    });
    // MOQ is per delivery date: block only the under-MOQ supplier+date groups
    const shortGroups = [];
    Object.values(groups).forEach(g => {
      const moq = (SUPPLIER_META[g.supplier] || {}).moq || 0;
      if (moq > 0) {
        let t = 0;
        g.rows.forEach(({ item, qty }) => { t += qty * (item.unit_price || 0); });
        t = Math.round(t);
        if (t > 0 && t < moq) shortGroups.push(`${g.supplier} · ${fmtDeliv(g.slot)} ($${t}/$${moq})`);
      }
    });
    // v2.0.1: warn-not-block — under-MOQ suppliers get a red banner; generate still allowed
    const underMoqMap = {};
    shortGroups.forEach(g => {
      const sup = g.split(' · ')[0];
      underMoqMap[sup] = g;
    });
    for (const { supplier, slot, rows } of Object.values(groups)) {
      const meta = SUPPLIER_META[supplier] || {};
      let gTotal = 0;
      rows.forEach(({ item, qty }) => { gTotal += qty * (item.unit_price || 0); });
      gTotal = Math.round(gTotal);
      const isUnderMoq = underMoqMap[supplier];
      const moqBanner = isUnderMoq ? `<div class="moq-warn">⚠️ ${lang === 'zh' ? '未達 MOQ' : 'Under MOQ'} · ${isUnderMoq}</div>` : '';
      html += `<div class="summary-section">
        <h3>${supplier} <small style="font-weight:500;color:#64748b">📅 ${lang === 'zh' ? '送貨日' : 'Delivery'} ${fmtDeliv(slot)} · $${gTotal} / MOQ $${meta.moq || '—'}</small></h3>${moqBanner}`;
      rows.forEach(({ item, qty }) => {
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        html += summaryRowHtml(name, item, qty);
      });
      html += `<div class="vendor-sum-actions">
        <button type="button" class="btn btn-vendor-sum" data-action="vendor-sum" data-supplier="${encodeURIComponent(supplier)}">${lang === 'zh' ? '📷 截圖給另一部手機' : '📷 Photo for other phone'}</button>
      </div></div>`;
    }
  } else if (mode === 'preorder') {
    const groups = {};
    MASTER().forEach(item => {
      const s = preorderState[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      if (activeCategory !== 'all') {
        if ((item.cat || '') !== activeCategory) return;
      }
      const sl = nextDeliverySlotForDate(item, preorderDate), k = item.supplier + '||' + sl;
      if (!groups[k]) groups[k] = { supplier: item.supplier, slot: sl, rows: [] };
      groups[k].rows.push({ item, qty: s.qty });
    });
    const shortGroups = [];
    Object.values(groups).forEach(g => {
      const moq = (SUPPLIER_META[g.supplier] || {}).moq || 0;
      if (moq > 0) {
        let t = 0;
        g.rows.forEach(({ item, qty }) => { t += qty * (item.unit_price || 0); });
        t = Math.round(t);
        if (t > 0 && t < moq) shortGroups.push(`${g.supplier} · ${fmtDeliv(g.slot)} ($${t}/$${moq})`);
      }
    });
    const underMoqMap = {};
    shortGroups.forEach(g => {
      const sup = g.split(' · ')[0];
      underMoqMap[sup] = g;
    });
    for (const { supplier, slot, rows } of Object.values(groups)) {
      const meta = SUPPLIER_META[supplier] || {};
      let gTotal = 0;
      rows.forEach(({ item, qty }) => { gTotal += qty * (item.unit_price || 0); });
      gTotal = Math.round(gTotal);
      const isUnderMoq = underMoqMap[supplier];
      const moqBanner = isUnderMoq ? `<div class="moq-warn">⚠️ ${lang === 'zh' ? '未達 MOQ' : 'Under MOQ'} · ${isUnderMoq}</div>` : '';
      const preDate = preorderDate ? `${preorderDate} ` : '';
      html += `<div class="summary-section">
        <h3>${supplier} <small style="font-weight:500;color:#64748b">📅 ${lang === 'zh' ? '預訂日' : 'Pre-order'} ${preDate}· $${gTotal} / MOQ $${meta.moq || '—'}</small></h3>${moqBanner}`;
      rows.forEach(({ item, qty }) => {
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        html += summaryRowHtml(name, item, qty);
      });
      html += `<div class="vendor-sum-actions">
        <button type="button" class="btn btn-vendor-sum" data-action="vendor-sum" data-supplier="${encodeURIComponent(supplier)}">${lang === 'zh' ? '📷 截圖給另一部手機' : '📷 Photo for other phone'}</button>
      </div></div>`;
    }
  } else {
    // Week mode: separate section per DATE (this week + next week), then by vendor
    let anyDay = false;
    for (let d = 0; d < WEEK_LEN; d++) {
      const bySup = {};
      MASTER().forEach(item => {
        ensureWeekArrays(item.id);
        const sk = weekSkip[item.id][d];
        const q = weekState[item.id][d] || 0;
        if (sk || q <= 0) return;
        if (activeCategory !== 'all') {
          if ((item.cat || '') !== activeCategory) return;
        }
        if (!bySup[item.supplier]) bySup[item.supplier] = [];
        bySup[item.supplier].push({ item, qty: q });
      });
      const suppliers = Object.keys(bySup);
      if (suppliers.length === 0) continue;
      anyDay = true;
      const dateLabel = formatSlotDate(d);
      const weekColor = isNextWeek(d) ? '#6d28d9' : '#0f766e';
      html += `<div class="summary-section" style="border-left:4px solid ${weekColor};padding-left:10px">
        <h3 style="color:${weekColor}">📅 ${dateLabel}</h3>`;
      suppliers.forEach(supplier => {
        const rows = bySup[supplier];
        const meta = SUPPLIER_META[supplier] || {};
        // MOQ for this date only
        let dayTotal = 0;
        rows.forEach(({ item, qty }) => { dayTotal += qty * (item.unit_price || 0); });
        dayTotal = Math.round(dayTotal);
        const moq = meta.moq || 0;
        const ok = dayTotal >= moq;
        html += `<div style="font-size:0.8rem;font-weight:650;color:var(--accent);margin:8px 0 4px">${supplier}
          <small style="font-weight:500;color:#64748b"> · $${dayTotal} / MOQ $${moq}${ok ? ' ✓' : ' 未達'}</small></div>`;
        rows.forEach(({ item, qty }) => {
          const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
          html += summaryRowHtml(name, item, qty);
        });
        html += `<div class="vendor-sum-actions">
          <button type="button" class="btn btn-vendor-sum" data-action="vendor-sum-day" data-supplier="${encodeURIComponent(supplier)}" data-day="${d}">${lang === 'zh' ? '📷 此日此商截圖' : '📷 Photo this day/vendor'}</button>
        </div>`;
      });
      html += `</div>`;
    }
    if (!anyDay) html = '';
  }

  if (!html) html = `<div class="empty">${lang === 'zh' ? '沒有訂貨項目' : 'No items ordered'}</div>`;
  content.innerHTML = html;
  document.getElementById('modal').classList.add('show');
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

/** Build order text for a single supplier (used by per-supplier footer buttons) */
function buildSupplierOrderText(supplier) {
  let text = lang === 'zh' ? `【${brandTitle()} 訂貨】\n` : `[${brandTitle()} Order]\n`;
  if (mode === 'tomorrow') {
    const rows = getVendorRows(supplier);
    if (!rows.length) return text + (lang === 'zh' ? '\n（無訂貨）' : '\n(no items)');
    const bySlot = {};
    rows.forEach(r => { const sl = nextDeliverySlot(r.item); (bySlot[sl] = bySlot[sl] || []).push(r); });
    Object.keys(bySlot).map(Number).sort((x, y) => x - y).forEach((sl, bi) => {
      text += `${bi ? '\n' : ''}\n━━━━━━━━━━\n🏪 ${supplier}\n📅 送貨日：${fmtDeliv(sl)}\n`;
      bySlot[sl].forEach(({ item, qty }) => {
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        text += `• ${name}  ${qtyPlain(item, qty)}\n`;
      });
    });
  } else if (mode === 'preorder') {
    const rows = getVendorRows(supplier);
    if (!rows.length) return text + (lang === 'zh' ? '\n（無訂貨）' : '\n(no items)');
    const sl = nextDeliverySlotForDate(rows[0].item, preorderDate);
    text += `\n━━━━━━━━━━\n🏪 ${supplier}\n📅 ${lang === 'zh' ? '預訂日' : 'Pre-order'}：${preorderDate || '—'} · ${fmtDeliv(sl)}\n`;
    rows.forEach(({ item, qty }) => {
      const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
      text += `• ${name}  ${qtyPlain(item, qty)}\n`;
    });
  } else {
    const bySup = {};
    for (let d = 0; d < WEEK_LEN; d++) {
      MASTER().filter(i => i.supplier === supplier).forEach(item => {
        ensureWeekArrays(item.id);
        if (!weekSkip[item.id][d] && (weekState[item.id][d] || 0) > 0) {
          (bySup[d] = bySup[d] || []).push({ item, qty: weekState[item.id][d] });
        }
      });
    }
    const days = Object.keys(bySup).map(Number).sort((a, b) => a - b);
    if (!days.length) return text + (lang === 'zh' ? '\n（無訂貨）' : '\n(no items)');
    days.forEach((d, bi) => {
      text += `${bi ? '\n' : ''}\n━━━━━━━━━━\n🏪 ${supplier}\n📅 送貨日：${fmtDeliv(d)}\n`;
      bySup[d].forEach(({ item, qty }) => {
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        text += `• ${name}  ${qtyPlain(item, qty)}\n`;
      });
    });
  }
  return text;
}
function copySupplierOrder(supplier) {
  const text = buildSupplierOrderText(supplier);
  copyTextUtil(text).then(() => {
    logSend('📄', [{ supplier, day: mode === 'tomorrow' ? nextDeliverySlot(MASTER().find(i => i.supplier === supplier)) : activeDay, rows: getVendorRows(supplier).map(({ item, qty }) => ({ item, qty })) }]);
    showToast(lang === 'zh' ? '✅ 已複製\n💡 貼上後請檢查數量是否正確' : '✅ Copied\n💡 Please double-check quantities after pasting');
  }).catch(() => showToast('Copy failed'));
}
function forwardSupplierWhatsApp(supplier) {
  const st = getMoqStatus(supplier);
  if (!st.ok && st.total > 0) {
    showToast(lang === 'zh' ? '未達 MOQ，無法轉發' : 'Under MOQ — cannot forward');
    return;
  }
  const text = buildSupplierOrderText(supplier);
  const w = window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  if (!w) {
    copyTextUtil(text).then(() => showToast(lang === 'zh'
      ? '彈出視窗被封鎖 — 已改為複製，請手動貼到 WhatsApp'
      : 'Pop-up blocked — copied instead; paste into WhatsApp manually'));
  } else {
    logSend('🟢', [{ supplier, day: mode === 'tomorrow' ? nextDeliverySlot(MASTER().find(i => i.supplier === supplier)) : activeDay, rows: getVendorRows(supplier).map(({ item, qty }) => ({ item, qty })) }]);
    showToast(lang === 'zh' ? '已開啟 WhatsApp — 選擇群組後送出' : 'WhatsApp opened — pick the group and send');
  }
}

/** Shared plain-text order builder (used by Copy and WhatsApp forward) */
function buildOrderText() {
  let text = lang === 'zh' ? `【${brandTitle()} 訂貨】\n` : `[${brandTitle()} Order]\n`;

  if (mode === 'tomorrow') {
    const groups = {};
    MASTER().forEach(item => {
      const s = state[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      const sl = nextDeliverySlot(item), k = item.supplier + '||' + sl;
      if (!groups[k]) groups[k] = { supplier: item.supplier, slot: sl, items: [] };
      groups[k].items.push(item);
    });
    for (const { supplier, slot, items } of Object.values(groups)) {
      const meta = SUPPLIER_META[supplier] || {};
      text += `\n━━━━━━━━━━\n🏪 ${supplier}\n📅 送貨日：${fmtDeliv(slot)}\n`;
      items.forEach(item => {
        const s = state[item.id];
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        text += `• ${name}  ${qtyPlain(item, s.qty)}\n`;
      });
    }
  } else if (mode === 'preorder') {
    const groups = {};
    MASTER().forEach(item => {
      const s = preorderState[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      const sl = nextDeliverySlotForDate(item, preorderDate), k = item.supplier + '||' + sl;
      if (!groups[k]) groups[k] = { supplier: item.supplier, slot: sl, items: [] };
      groups[k].items.push(item);
    });
    const preDate = preorderDate || '';
    text += `\n📅 ${lang === 'zh' ? '預訂日' : 'Pre-order'}：${preDate}\n`;
    for (const { supplier, slot, items } of Object.values(groups)) {
      const meta = SUPPLIER_META[supplier] || {};
      text += `\n━━━━━━━━━━\n🏪 ${supplier}\n📅 送貨日：${fmtDeliv(slot)}\n`;
      items.forEach(item => {
        const s = preorderState[item.id];
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        text += `• ${name}  ${qtyPlain(item, s.qty)}\n`;
      });
    }
  } else {
    for (let d = 0; d < WEEK_LEN; d++) {
      const dayItems = [];
      MASTER().forEach(item => {
        ensureWeekArrays(item.id);
        if (!weekSkip[item.id][d] && (weekState[item.id][d] || 0) > 0) dayItems.push(item);
      });
      if (dayItems.length === 0) continue;
      let lastSup = null;
      dayItems.sort((a, b) => a.supplier.localeCompare(b.supplier)).forEach(item => {
        if (item.supplier !== lastSup) { lastSup = item.supplier; text += `\n━━━━━━━━━━\n🏪 ${item.supplier}\n📅 送貨日：${fmtDeliv(d)}\n`; }
        const q = weekState[item.id][d];
        const name = (lang === 'zh' || !item.item_en) ? item.item_zh : item.item_en;
        text += `• ${name}  ${qtyPlain(item, q)}\n`;
      });
    }
  }

  return text;
}
function copyText() {
  copyTextUtil(buildOrderText()).then(() => {
    logSend('📄', collectOrderGroups());
    showToast(lang === 'zh' ? '✅ 已複製 — 請到 WhatsApp 群組貼上並送出\n💡 貼上後請檢查數量是否正確' : '✅ Copied — paste it into the WhatsApp group and send\n💡 Please double-check quantities after pasting');
  }).catch(() => showToast('Copy failed'));
}
/** One-button forward: opens WhatsApp with the order pre-filled; user picks the group and taps send */
function forwardWhatsApp() {
  const text = buildOrderText();
  logSend('🟢', collectOrderGroups());
  const w = window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  if (!w) {
    copyTextUtil(text).then(() => showToast(lang === 'zh'
      ? '彈出視窗被封鎖 — 已改為複製，請手動貼到 WhatsApp'
      : 'Pop-up blocked — copied instead; paste into WhatsApp manually'));
  } else {
    showToast(lang === 'zh' ? '已開啟 WhatsApp — 選擇群組後送出' : 'WhatsApp opened — pick the group and send');
  }
}

function downloadPDF() {
  const w = window.open('', '_blank');
  if (!w) { showToast(lang === 'zh' ? '瀏覽器已封鎖彈出視窗' : 'Pop-up blocked'); return; }
  const today = new Date().toLocaleDateString('zh-HK');
  let body = `<html><head><meta charset="utf-8"><title>SEVENS Order</title>
  <style>
    main, #itemList {
    padding-bottom: 88px;
  }
  body { font-family: "PingFang TC", "Noto Sans TC", sans-serif; padding: 20px; color: #0f172a; }
    h1 { font-size: 18px; margin-bottom: 4px; }
    .date { font-size: 12px; color: #64748b; margin-bottom: 16px; }
    h2 { font-size: 14px; color: #0f766e; margin: 16px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    td { padding: 6px 4px; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    td.qty { text-align: right; font-weight: 700; width: 90px; color: #15803d; }
  </style></head><body>
  <h1>${brandTitle()} · 訂貨摘要</h1>
  <div class="date">日期 Date: ${today} · Mode: ${mode === 'tomorrow' ? 'Tomorrow' : 'Whole Week'}</div>`;

  if (mode === 'tomorrow') {
    const groups = {};
    MASTER().forEach(item => {
      const s = state[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      const sl = nextDeliverySlot(item), k = item.supplier + '||' + sl;
      if (!groups[k]) groups[k] = { supplier: item.supplier, slot: sl, items: [] };
      groups[k].items.push(item);
    });
    for (const { supplier, slot, items } of Object.values(groups)) {
      const meta = SUPPLIER_META[supplier] || {};
      body += `<h2>${supplier} <small>📅 送貨日 ${fmtDeliv(slot)} · MOQ $${meta.moq || '—'}</small></h2><table>`;
      items.forEach(item => {
        const s = state[item.id];
        body += `<tr><td>${item.item_zh}${item.item_en ? `<br><small style="color:#64748b">${item.item_en}</small>` : ""}</td>
                 <td class="qty">${qtyHtml(item, s.qty)}</td></tr>`;
      });
      body += '</table>';
    }
  } else {
    for (let d = 0; d < WEEK_LEN; d++) {
      const dayItems = MASTER().filter(item => { ensureWeekArrays(item.id); return !weekSkip[item.id][d] && (weekState[item.id][d] || 0) > 0; });
      if (dayItems.length === 0) continue;
      body += `<h2>${formatSlotDate(d)}</h2><table>`;
      dayItems.forEach(item => {
        const q = weekState[item.id][d];
        body += `<tr><td>${item.item_zh}${item.item_en ? `<br><small style="color:#64748b">${item.item_en}</small>` : ""}</td>
                 <td class="qty">${qtyHtml(item, q)}</td></tr>`;
      });
      body += '</table>';
    }
  }

  body += '</body></html>';
  w.document.write(body);
  w.document.close();
  setTimeout(() => { w.print(); }, 300);
  logSend('📑', collectOrderGroups());
  showToast(lang === 'zh' ? '正在開啟列印 / PDF' : 'Opening print / PDF');
}

// ===== GENERIC DIALOG (alert/confirm replacement) =====
let _dlgClose = null;
function _openDlg(msg, buttons) {
  const ov = document.getElementById('dlgOverlay');
  document.getElementById('dlgMsg').textContent = msg;
  const act = document.getElementById('dlgActions');
  act.innerHTML = '';
  buttons.forEach(b => {
    const el = document.createElement('button');
    el.className = 'btn ' + b.cls;
    el.textContent = b.label;
    el.onclick = () => {
      ov.classList.remove('show');
      const f = _dlgClose; _dlgClose = null;
      if (f) f(b.val);
    };
    act.appendChild(el);
  });
  ov.classList.add('show');
}
function uiAlert(msg) {
  return new Promise(res => {
    _dlgClose = () => res(true);
    _openDlg(msg, [{ label: lang === 'zh' ? '確定' : 'OK', cls: 'btn-summary', val: true }]);
  });
}
function uiConfirm(msg) {
  return new Promise(res => {
    _dlgClose = v => res(v === true);
    _openDlg(msg, [
      { label: lang === 'zh' ? '取消' : 'Cancel', cls: 'btn-reset', val: false },
      { label: lang === 'zh' ? '確定' : 'OK', cls: 'btn-summary', val: true }
    ]);
  });
}

// ===== SENT LOG (audit trail: when / who / what was forwarded) =====
const LOG_KEY = 'sevens_sentlog_v194';
const VIA_LABEL = { '📷': ['截圖', 'Photo'], '📄': ['複製文字', 'Text'], '🟢': ['WhatsApp', 'WhatsApp'], '📑': ['PDF', 'PDF'] };
function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; } }
function persistLog(log) { try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 300))); } catch (e) { } }
/** groups: [{supplier, day(slot), rows:[{item, qty}]}] — one entry per supplier per send action */
function logSend(via, groups) {
  if (!groups || !groups.length) return;
  const log = loadLog();
  const ts = Date.now();
  groups.forEach(g => {
    log.unshift({
      ts, via, brand, mode,
      supplier: g.supplier,
      dayLabel: fmtDeliv(g.day),
      items: g.rows.map(({ item, qty }) => ({ zh: item.item_zh, qty, u: unitReal(item.unit), pr: unitProc(item.unit) }))
    });
  });
  persistLog(log);
}
/** Current orders grouped like the summary does: per supplier + delivery date */
function collectOrderGroups() {
  const groups = [];
  if (mode === 'tomorrow') {
    const map = {};
    MASTER().forEach(item => {
      const s = state[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      if (activeCategory !== 'all' && (item.cat || '') !== activeCategory) return;
      const sl = nextDeliverySlot(item), k = item.supplier + '||' + sl;
      if (!map[k]) map[k] = { supplier: item.supplier, day: sl, rows: [] };
      map[k].rows.push({ item, qty: s.qty });
    });
    return Object.values(map);
  } else if (mode === 'preorder') {
    const map = {};
    MASTER().forEach(item => {
      const s = preorderState[item.id];
      if (!s || s.skipped || s.qty <= 0) return;
      if (activeCategory !== 'all' && (item.cat || '') !== activeCategory) return;
      const sl = nextDeliverySlotForDate(item, preorderDate), k = item.supplier + '||' + sl;
      if (!map[k]) map[k] = { supplier: item.supplier, day: sl, rows: [] };
      map[k].rows.push({ item, qty: s.qty });
    });
    return Object.values(map);
  }
  for (let d = 0; d < WEEK_LEN; d++) {
    const bySup = {};
    MASTER().forEach(item => {
      ensureWeekArrays(item.id);
      const sk = weekSkip[item.id][d];
      const q = weekState[item.id][d] || 0;
      if (sk || q <= 0) return;
      if (activeCategory !== 'all' && (item.cat || '') !== activeCategory) return;
      (bySup[item.supplier] = bySup[item.supplier] || []).push({ item, qty: q });
    });
    Object.entries(bySup).forEach(([supplier, rows]) => groups.push({ supplier, day: d, rows }));
  }
  return groups;
}
function showLog() {
  const log = loadLog();
  const c = document.getElementById('logContent');
  if (!log.length) {
    c.innerHTML = `<div class="empty">${lang === 'zh' ? '暫無紀錄 — 轉發 / 截圖 / PDF 後會自動記錄' : 'No records — forwarding, photo or PDF is logged automatically'}</div>`;
  } else {
    c.innerHTML = log.slice(0, 60).map(e => {
      const d = new Date(e.ts);
      const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const viaTxt = (VIA_LABEL[e.via] || [e.via, e.via])[lang === 'zh' ? 0 : 1];
      const items = e.items.map(i => `${i.zh} ×${i.qty}${i.u ? ' ' + i.u : ''}${i.pr ? `（${i.pr}）` : ''}`).join('、');
      return `<div class="log-entry">
        <div class="log-head"><span class="log-time">🕒 ${time}</span> ${e.supplier} <span class="log-via">${e.via} ${viaTxt}</span></div>
        <div class="log-sub">📅 ${e.dayLabel} · ${e.brand} · ${e.items.length} ${lang === 'zh' ? '項' : 'items'}</div>
        <div class="log-items">${items}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('logOverlay').classList.add('show');
}
function closeLog() { document.getElementById('logOverlay').classList.remove('show'); }
async function clearLog() {
  if (!(await uiConfirm(lang === 'zh' ? '清空所有訂貨紀錄？' : 'Clear all order records?'))) return;
  persistLog([]);
  showLog();
  showToast(lang === 'zh' ? '已清空' : 'Cleared');
}
function copyLogText() {
  const log = loadLog();
  if (!log.length) { showToast(lang === 'zh' ? '暫無紀錄' : 'No records'); return; }
  const txt = log.map(e => {
    const d = new Date(e.ts);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const items = e.items.map(i => `${i.zh} x${i.qty}${i.u ? ' ' + i.u : ''}${i.pr ? ` (${i.pr})` : ''}`).join(', ');
    return `[${time}] ${e.brand} ${e.supplier} - ${e.dayLabel} (${e.items.length}) ${items}`;
  }).join('\n');
  copyTextUtil(txt).then(() => showToast(lang === 'zh' ? '已複製紀錄' : 'Log copied')).catch(() => showToast('Copy failed'));
}

// ===== DATA EXPORT / IMPORT (CSV for Excel editing, JSON for full backup) =====
let _pendingImport = null;

// --- CSV writer (BOM so Excel opens Chinese correctly) ---
function csvCell(v) {
  v = v == null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function toCSV(rows) { return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCSV(kind) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  if (kind === 'json') {
    downloadText(`sevens_master_backup_${stamp}.json`,
      JSON.stringify({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS, exported_at: new Date().toISOString() }, null, 1),
      'application/json');
    showToast(lang === 'zh' ? '已匯出備份' : 'Backup exported');
    return;
  }
  if (kind === 'items') {
    const rows = [['id', 'brand', 'supplier', 'item_zh', 'item_en', 'unit', 'default_qty', 'unit_price', 'notes', 'delivery_days', 'cat', 'category_raw', 'active']];
    Object.entries(DATA).forEach(([b, arr]) => arr.forEach(it => rows.push([
      it.id, b, it.supplier, it.item_zh, it.item_en || '', it.unit || '',
      it.default_qty == null ? '' : it.default_qty, it.unit_price == null ? '' : it.unit_price,
      it.notes || '', (it.delivery_days || []).join(','), it.cat || '', it.category_raw || '',
      it.active === false ? 'FALSE' : 'TRUE'
    ])));
    downloadText(`sevens_items_${stamp}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    showToast(lang === 'zh' ? '已匯出 items.csv' : 'items.csv exported');
    return;
  }
  if (kind === 'suppliers') {
    const rows = [['supplier', 'moq', 'unit', 'delivery', 'delivery_days', 'terms', 'cutoff']];
    Object.entries(SUPPLIER_META).forEach(([name, m]) => rows.push([
      name, m.moq == null ? '' : m.moq, m.unit || '', m.delivery || '',
      (m.delivery_days || []).join(','), m.terms || '', m.cutoff || ''
    ]));
    downloadText(`sevens_suppliers_${stamp}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    showToast(lang === 'zh' ? '已匯出 suppliers.csv' : 'suppliers.csv exported');
  }
}

// --- CSV parser (handles "quoted, cells" and \r\n) ---
function parseCSV(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// "0,2,4" / "一三五" / "Mon,Wed" → [0,2,4]; '' → null
function parseDeliveryDays(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  const zhMap = { '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6 };
  const enMap = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const out = new Set();
  t.split(/[,，、;；|\/\s]+/).forEach(tok => {
    tok = tok.trim().toLowerCase();
    if (!tok) return;
    if (/^\d+$/.test(tok)) { const n = +tok; if (n >= 0 && n <= 6) out.add(n); return; }
    const m = tok.match(/^(mon|tue|wed|thu|fri|sat|sun)/);
    if (m) { out.add(enMap[m[1]]); return; }
    for (const ch of tok) if (ch in zhMap) out.add(zhMap[ch]);
  });
  return out.size ? [...out].sort((a, b) => a - b) : null;
}
function numOrNull(v) {
  const t = String(v == null ? '' : v).trim();
  if (t === '') return null;
  const n = Number(t);
  return isNaN(n) ? null : n;
}
function parseBool(v, def) {
  if (v == null || String(v).trim() === '') return def;
  return !/^(false|0|no|n|否)$/i.test(String(v).trim());
}

function buildItemsFromCSV(rows) {
  const header = rows[0].map(h => String(h).trim());
  const idx = name => header.indexOf(name);
  const missing = ['id', 'brand', 'supplier', 'item_zh'].filter(c => idx(c) < 0);
  if (missing.length) return { error: (lang === 'zh' ? '缺少欄位：' : 'Missing columns: ') + missing.join(', ') };
  const items = [], warnings = [], brands = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => String(c).trim() === '')) continue;
    const g = c => String(row[idx(c)] == null ? '' : row[idx(c)]).trim();
    const line = r + 1;
    let id = g('id');
    if (!id) { id = 'imp-' + line; warnings.push(`row ${line}: 缺 id，已自動產生 id generated`); }
    const brandK = g('brand') || 'SEVENS';
    const supplier = g('supplier'), zh = g('item_zh');
    if (!supplier || !zh) { warnings.push(`row ${line}: 缺 supplier/item_zh，略過 skipped`); continue; }
    const ddRaw = g('delivery_days');
    const dd = parseDeliveryDays(ddRaw);
    if (ddRaw && !dd) warnings.push(`row ${line}: delivery_days「${ddRaw}」無法解析，將用供應商車期`);
    const dq = numOrNull(g('default_qty'));
    if (dq === null && g('default_qty') !== '') warnings.push(`row ${line}: default_qty 非數字，視為空白`);
    items.push({
      brand: brandK, item: {
        id, supplier, item_zh: zh, item_en: g('item_en'), unit: g('unit'),
        default_qty: dq, unit_price: numOrNull(g('unit_price')), notes: g('notes'),
        delivery_days: dd || undefined, cat: g('cat') || '其他',
        category_raw: g('category_raw') || g('cat') || '', active: parseBool(g('active'), true)
      }
    });
    brands.add(brandK);
  }
  return { items, warnings, brands: [...brands] };
}
function buildSuppliersFromCSV(rows) {
  const header = rows[0].map(h => String(h).trim());
  const idx = name => header.indexOf(name);
  if (idx('supplier') < 0) return { error: lang === 'zh' ? '缺少欄位：supplier' : 'Missing column: supplier' };
  const suppliers = {}, warnings = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => String(c).trim() === '')) continue;
    const g = c => String(row[idx(c)] == null ? '' : row[idx(c)]).trim();
    const name = g('supplier');
    if (!name) { warnings.push(`row ${r + 1}: 缺 supplier，略過 skipped`); continue; }
    suppliers[name] = {
      moq: numOrNull(g('moq')), unit: g('unit') || 'HKD', delivery: g('delivery'),
      delivery_days: parseDeliveryDays(g('delivery_days')) || [0, 1, 2, 3, 4, 5, 6],
      terms: g('terms'), cutoff: g('cutoff'), cat: g('cat') || ''
    };
  }
  return { suppliers, warnings };
}

async function handleImportFiles(fileList) {
  const preview = document.getElementById('importPreview');
  const confirmBtn = document.getElementById('confirmImportBtn');
  const files = [...fileList];
  document.getElementById('importFile').value = '';
  if (!files.length) return;
  preview.textContent = lang === 'zh' ? '讀取中…' : 'Reading…';
  const imp = { items: null, suppliers: null, json: null, warnings: [], errors: [], fileNames: [] };
  for (const f of files) {
    imp.fileNames.push(f.name);
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
        const j = JSON.parse(text);
        if (j && j.brands && j.suppliers) imp.json = j;
        else imp.errors.push(f.name + (lang === 'zh' ? '：JSON 需要 brands/suppliers' : ': JSON needs brands/suppliers'));
      } else {
        const rows = parseCSV(text);
        if (!rows.length) { imp.errors.push(f.name + (lang === 'zh' ? '：空檔案' : ': empty file')); continue; }
        const head = rows[0].join(',');
        if (head.includes('item_zh')) {
          const b = buildItemsFromCSV(rows);
          if (b.error) imp.errors.push(f.name + ' — ' + b.error);
          else { imp.items = (imp.items || []).concat(b.items); imp.warnings.push(...b.warnings); }
        } else if (head.includes('supplier') && /moq|terms|cutoff|delivery/.test(head)) {
          const b = buildSuppliersFromCSV(rows);
          if (b.error) imp.errors.push(f.name + ' — ' + b.error);
          else { imp.suppliers = Object.assign(imp.suppliers || {}, b.suppliers); imp.warnings.push(...b.warnings); }
        } else {
          imp.errors.push(f.name + (lang === 'zh' ? '：無法辨認（需 item_zh 欄位，或 supplier/moq 欄位）' : ': unrecognized (needs item_zh, or supplier/moq columns)'));
        }
      }
    } catch (e) { imp.errors.push(f.name + ': ' + e.message); }
  }
  if (!imp.json && !imp.items && !imp.suppliers) {
    _pendingImport = null;
    confirmBtn.disabled = true;
    preview.innerHTML = imp.errors.map(e => `<div class="imp-err">❌ ${e}</div>`).join('') || '❌';
    return;
  }
  _pendingImport = imp;
  confirmBtn.disabled = false;
  // ---- preview with diff vs current ----
  const curIds = new Set(Object.entries(DATA).flatMap(([b, arr]) => arr.map(i => b + '::' + i.id)));
  const curSup = new Set(Object.keys(SUPPLIER_META));
  let html = '';
  if (imp.json) {
    const nb = Object.entries(imp.json.brands).reduce((s, [b, a]) => { html += ''; return s + a.length; }, 0);
    const perBrand = Object.entries(imp.json.brands).map(([b, a]) => `${b} ${a.length}`).join(' · ');
    html += `<div class="imp-ok">✅ 完整還原 JSON：items ${nb}（${perBrand}）· suppliers ${Object.keys(imp.json.suppliers).length}</div>`;
  }
  if (imp.items) {
    const newIds = new Set(imp.items.map(x => x.brand + '::' + x.item.id));
    const added = [...newIds].filter(k => !curIds.has(k)).length;
    const removed = [...curIds].filter(k => !newIds.has(k)).length;
    const brandsInFile = [...new Set(imp.items.map(x => x.brand))];
    const untouchedBrands = Object.keys(DATA).filter(b => !brandsInFile.includes(b));
    const perBrand = brandsInFile.map(b => `${b} ${imp.items.filter(x => x.brand === b).length}`).join(' · ');
    html += `<div class="imp-ok">📦 items：${imp.items.length}（${perBrand}）· 新增 +${added} · 移除 −${removed}</div>`;
    untouchedBrands.forEach(b => { html += `<div class="imp-warn">⚠️ ${b} 不在檔案內，保留不變（not in file, kept）</div>`; });
    const supInFile = new Set(imp.items.map(x => x.item.supplier));
    const missingSup = [...supInFile].filter(s => !(imp.suppliers ? imp.suppliers[s] : SUPPLIER_META[s]));
    if (missingSup.length) html += `<div class="imp-warn">⚠️ ${missingSup.length} 個供應商無資料（將用每日送貨預設）：${missingSup.map(s => s.split(' / ')[0]).join('、')}</div>`;
  }
  if (imp.suppliers) {
    const names = Object.keys(imp.suppliers);
    const added = names.filter(n => !curSup.has(n)).length;
    const removed = [...curSup].filter(n => !names.includes(n)).length;
    html += `<div class="imp-ok">🚚 suppliers：${names.length} · 新增 +${added} · 移除 −${removed}</div>`;
    if (!imp.items && !imp.json) html += `<div>📦 items 不變（unchanged）</div>`;
  }
  if (imp.fileNames.length) html += `<div style="color:var(--text-dim);font-size:.72rem;margin-top:2px">${imp.fileNames.join(' + ')}</div>`;
  imp.warnings.slice(0, 6).forEach(w => { html += `<div class="imp-warn">⚠️ ${w}</div>`; });
  if (imp.warnings.length > 6) html += `<div class="imp-warn">…共 ${imp.warnings.length} 個警告</div>`;
  imp.errors.forEach(e => { html += `<div class="imp-err">❌ ${e}</div>`; });
  preview.innerHTML = html;
}

async function applyImport() {
  const imp = _pendingImport;
  if (!imp) return;
  if (!(await uiConfirm(lang === 'zh'
    ? '匯入將取代資料（以檔案為準，缺少的列會被刪除）。確定？'
    : 'Import will REPLACE data with what is in the file (missing rows are deleted). Continue?'))) return;
  // auto-backup before replacing
  try { localStorage.setItem('sevens_master_backup', JSON.stringify({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS })); } catch (e) { }
  if (imp.json) {
    DATA = imp.json.brands;
    SUPPLIER_META = imp.json.suppliers;
  } else {
    if (imp.items) {
      const brands = {};
      imp.items.forEach(({ brand, item }) => { (brands[brand] = brands[brand] || []).push(item); });
      // brands not present in the file are kept from current data
      Object.keys(DATA).forEach(b => { if (!brands[b]) brands[b] = DATA[b]; });
      DATA = brands;
    }
    if (imp.suppliers) SUPPLIER_META = imp.suppliers;
  }
  // rebuild category list (known order first, new ones appended)
  const found = new Set(Object.values(DATA).flat().map(i => i.cat || '其他'));
  CATS = [...CATS.filter(c => found.has(c)), ...[...found].filter(c => !CATS.includes(c))];
  applyMaster({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS });
  try { localStorage.setItem('sevens_master_cache', JSON.stringify({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS })); } catch (e) { }
  // prune order state for deleted items so stale ids don't linger
  const valid = new Set(Object.values(DATA).flat().map(i => i.id));
  [state, weekState, weekSkip, fixedOverride].forEach(obj => {
    Object.keys(obj).forEach(id => { if (!valid.has(id)) delete obj[id]; });
  });
  MASTER().forEach(item => {
    if (!state[item.id]) state[item.id] = { qty: 0, skipped: false };
    ensureWeekArrays(item.id);
  });
  activeCategory = 'all';
  renderCatChips();
  saveState();
  render();
  _pendingImport = null;
  document.getElementById('confirmImportBtn').disabled = true;
  document.getElementById('importPreview').innerHTML = '<span class="imp-ok">✅ ' + (lang === 'zh' ? '匯入完成' : 'Import complete') + '</span>';
  document.getElementById('restoreBtn').style.display = '';
  showToast(lang === 'zh' ? '匯入完成' : 'Import complete');
}

async function restoreBackup() {
  if (!(await uiConfirm(lang === 'zh' ? '還原到上次匯入前的備份？目前資料會被覆蓋。' : 'Restore the pre-import backup? Current data will be overwritten.'))) return;
  try {
    const b = JSON.parse(localStorage.getItem('sevens_master_backup'));
    if (b && b.brands) {
      applyMaster({ brands: b.brands, suppliers: b.suppliers || {}, categories: b.categories || CATS });
      try { localStorage.setItem('sevens_master_cache', JSON.stringify({ brands: DATA, suppliers: SUPPLIER_META, categories: CATS })); } catch (e) { }
      renderCatChips(); render();
      showToast(lang === 'zh' ? '已還原備份' : 'Backup restored');
    } else showToast(lang === 'zh' ? '沒有備份' : 'No backup found');
  } catch (e) { showToast('Restore failed'); }
}

function showDataPanel() {
  document.getElementById('restoreBtn').style.display = localStorage.getItem('sevens_master_backup') ? '' : 'none';
  const info = document.getElementById('dataSrcInfo');
  if (info) info.textContent = dataSourceInfo();
  document.getElementById('dataOverlay').classList.add('show');
}
function closeDataPanel() { document.getElementById('dataOverlay').classList.remove('show'); }

// ===== CLIPBOARD (fallback for sandboxed viewers / non-secure local hosting) =====
function legacyCopy(text) {
  return new Promise((res, rej) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      ok ? res() : rej(new Error('execCommand copy failed'));
    } catch (e) { rej(e); }
  });
}
function copyTextUtil(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return legacyCopy(text);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

document.getElementById('modal').addEventListener('click', e => {
  if (e.target.id === 'modal') closeModal();
});
document.getElementById('logOverlay').addEventListener('click', e => {
  if (e.target.id === 'logOverlay') closeLog();
});
document.getElementById('dataOverlay').addEventListener('click', e => {
  if (e.target.id === 'dataOverlay') closeDataPanel();
});
document.getElementById('dlgOverlay').addEventListener('click', e => {
  if (e.target.id === 'dlgOverlay') {
    document.getElementById('dlgOverlay').classList.remove('show');
    const f = _dlgClose; _dlgClose = null;
    if (f) f(false); // backdrop tap = cancel
  }
});

// Event delegation for ALL [data-action] buttons (supplier skip-all / vendor photo, summary modal buttons).
// Supplier-header buttons intentionally have NO inline onclick — inline + delegation used to fire twice,
// which made "Skip all" skip everything and immediately un-skip it (net no-op).
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  if (!action) return;
  // Prefer numeric supplier index (stable); fall back to encoded name
  const idxAttr = btn.getAttribute('data-sup-idx');
  const ref = (idxAttr != null && idxAttr !== '') ? idxAttr : (btn.getAttribute('data-supplier') || '');
  if (action === 'skip-all') {
    e.preventDefault();
    e.stopPropagation();
    skipAllSupplier(ref);
  } else if (action === 'vendor-sum') {
    e.preventDefault();
    e.stopPropagation();
    showVendorPhoto(resolveSupplier(ref) || ref);
  } else if (action === 'vendor-sum-day') {
    e.preventDefault();
    e.stopPropagation();
    const day = parseInt(btn.getAttribute('data-day'), 10);
    showVendorPhoto(resolveSupplier(ref) || ref, day);
  } else if (action === 'vendor-copy') {
    e.preventDefault();
    e.stopPropagation();
    copySupplierOrder(resolveSupplier(ref) || ref);
  } else if (action === 'vendor-wa') {
    e.preventDefault();
    e.stopPropagation();
    forwardSupplierWhatsApp(resolveSupplier(ref) || ref);
  }
});

// Init
document.body.classList.add('brand-sevens');
loadMaster().then(src => {
  initState();
  renderCatChips();
  if (src === 'cache') showToast('離線：使用上次載入的資料');
  else if (src === 'embedded') showToast('未能載入 Sheet（使用內置版本）');
  setMode(mode);          // applies class + renders
  setCategory(activeCategory);
  measureStickyChrome();
}).catch(e => {
  console.error('boot failed:', e);
  try { initState(); renderCatChips(); setMode(mode); measureStickyChrome(); } catch (e2) { console.error(e2); }
});
window.addEventListener('resize', () => measureStickyChrome());
const _loadedDay = dayStamp();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && dayStamp() !== _loadedDay) { saveState(); location.reload(); }
});