// 后台定时引擎：只回答「什么时候该提醒」和「提醒哪条动作」。
// 它不认识窗口，也不认识屏幕位置——该呈现时通过注入的 onFire 回调把动作交出去。
'use strict';

const store = require('./store');
const scheduler = require('./scheduler');

function log(...args) {
  try {
    console.log('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

function logWarn(...args) {
  try {
    console.warn('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

function formatClock(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 引擎状态：只有「跟时间有关」的东西，没有任何 UI */
const state = {
  settings: null,
  packs: [],
  index: [],
  cursor: '',
  timer: null,
  nextFireAt: null,
  paused: false,
  hiddenForNow: false,
  lastFireAt: 0,
  /** 到点后由外部注入：把动作交给驱动桌面。返回 null 表示没呈现成功 */
  onFire: null,
  /** 状态变化时通知（托盘菜单、面板都靠它刷新） */
  onChange: null,
  /** 由框架层注入：返回当前可用的执行方式清单（引擎不直接认识驱动桌面） */
  onListExecutors: null
};

function emitChange(reason) {
  if (typeof state.onChange === 'function') {
    try {
      state.onChange(reason || '');
    } catch (e) {
      logWarn(`引擎状态回调失败：${e && e.message}`);
    }
  }
}

function settingsOf() {
  return state.settings || store.DEFAULT_SETTINGS;
}

/* ------------------------------------------------------------------ *
 * 数据装载
 * ------------------------------------------------------------------ */

/** 重新读动作包并重建索引 */
function reloadPacks() {
  try {
    state.packs = store.loadAllPacks();
  } catch (e) {
    logWarn(`加载动作包异常，保持上一次结果：${e && e.message}`);
    if (!Array.isArray(state.packs)) state.packs = [];
  }
  try {
    state.index = scheduler.buildIndex(state.packs);
  } catch (e) {
    logWarn(`构建动作索引异常：${e && e.message}`);
    state.index = [];
  }
  log(`动作包 ${state.packs.length} 个，可选动作 ${state.index.length} 条`);
  return { packs: state.packs, index: state.index };
}

/* ------------------------------------------------------------------ *
 * 时间判定
 * ------------------------------------------------------------------ */

/** 当前是否在 activeHours 允许的时间段内（整点，含起止，跨夜也支持） */
function withinActiveHours(settings, now) {
  const hours = settings && settings.activeHours;
  if (!hours || typeof hours.start !== 'number' || typeof hours.end !== 'number') return true;
  const h = now.getHours();
  const { start, end } = hours;
  if (start === end) return true; // 起点等于终点视为全天
  if (start < end) return h >= start && h <= end;
  return h >= start || h <= end; // 跨夜，如 22 → 6
}

function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/** 排下一次提醒：intervalMin 分钟一次，enabled / activeHours 生效 */
function scheduleNext(reason) {
  clearTimer();
  const settings = settingsOf();
  const intervalMs = Math.max(1, settings.intervalMin) * 60 * 1000;

  if (!settings.enabled || state.paused) {
    state.nextFireAt = null;
    log(`定时器停用（${!settings.enabled ? '总开关关闭' : '已手工暂停'}${reason ? `，原因：${reason}` : ''}），不再安排下一次`);
    emitChange('schedule');
    return;
  }

  state.nextFireAt = Date.now() + intervalMs;
  state.timer = setTimeout(() => {
    state.timer = null;
    tick();
  }, intervalMs);
  log(`下一次提醒：${formatClock(state.nextFireAt)}（间隔 ${settings.intervalMin} 分钟${reason ? `，原因：${reason}` : ''}）`);
  emitChange('schedule');
}

/** 到点：判定要不要弹，要弹就让外部去呈现 */
function tick() {
  const settings = settingsOf();
  if (!settings.enabled) {
    scheduleNext('总开关关闭');
    return;
  }
  if (state.paused) {
    // 手工暂停：计时器继续转，恢复后自然接上，不用重新等满一个间隔
    const intervalMs = Math.max(1, settings.intervalMin) * 60 * 1000;
    state.nextFireAt = Date.now() + intervalMs;
    state.timer = setTimeout(() => {
      state.timer = null;
      tick();
    }, intervalMs);
    log(`已暂停，本次跳过（下一次尝试 ${formatClock(state.nextFireAt)}）`);
    emitChange('paused');
    return;
  }
  if (!withinActiveHours(settings, new Date())) {
    state.hiddenForNow = true;
    const hours = settings.activeHours || {};
    log(`当前 ${new Date().getHours()} 点不在提醒时段 ${hours.start}–${hours.end}，本次跳过`);
    scheduleNext('不在提醒时段');
    return;
  }
  if (state.hiddenForNow) {
    state.hiddenForNow = false;
    log('回到提醒时段');
  }
  fire('timer');
  scheduleNext('已提醒');
}

/**
 * 抽一条动作并交给外部呈现。
 * @param {string} source timer / tray / panel / test
 * @returns {{move:object, category:string, part:string, level:string, seconds?:number}|null}
 */
function fire(source) {
  const settings = settingsOf();
  const picked = scheduler.pickNext(state.index, settings, state.cursor);
  if (!picked || !picked.move) {
    logWarn('没有可呈现的动作，本次跳过');
    return null;
  }
  state.cursor = picked.move.id;
  state.lastFireAt = Date.now();

  if (typeof state.onFire !== 'function') {
    logWarn('引擎没有接 onFire 回调，动作无法呈现');
    return null;
  }

  let result = null;
  try {
    // 手动触发（面板/托盘）跳过预告直接上正片；只有定时器来的才先预告 3 秒
    const previewSec = source === 'timer' ? undefined : 0;
    result = state.onFire(picked, settings, { source: source || 'timer', previewSec });
  } catch (e) {
    logWarn(`呈现回调失败：${e && e.message}`);
    return null;
  }
  emitChange('fire');
  return result;
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function init(options) {
  const opts = options || {};
  state.onFire = typeof opts.onFire === 'function' ? opts.onFire : null;
  state.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  // 执行方式清单由框架层注入（引擎不直接认识驱动桌面，避免反向依赖）
  state.onListExecutors = typeof opts.onListExecutors === 'function' ? opts.onListExecutors : null;
  state.settings = store.loadSettings();
  reloadPacks();
  return state;
}

/** 更新设置（由框架层在 IPC 收到后调用），并重排定时器 */
function applySettings(patch) {
  state.settings = store.saveSettings(patch || {});
  scheduleNext('设置变化');
  return state.settings;
}

function start() {
  scheduleNext('启动');
}

function stop() {
  clearTimer();
  state.nextFireAt = null;
}

/** 托盘 / 面板的「暂停」开关 */
function togglePause() {
  state.paused = !state.paused;
  log(state.paused ? '已暂停提醒' : '已恢复提醒');
  scheduleNext(state.paused ? '手工暂停' : '手工恢复');
  return state.paused;
}

function isPaused() {
  return state.paused;
}

/** 面板要的 packs 摘要 */
function packsList() {
  const active = Array.isArray(state.settings && state.settings.activePackIds)
    ? state.settings.activePackIds
    : [];
  return store.listPacksSummary(state.packs).map((p) => ({ ...p, enabled: active.includes(p.id) }));
}

/**
 * state:get 里的 packs：摘要 + 完整三级结构 categories，面板据此渲染折叠树。
 */
function packsDetail() {
  const active = Array.isArray(state.settings && state.settings.activePackIds)
    ? state.settings.activePackIds
    : [];
  return state.packs.map((pack) => {
    const { count, categoryCount } = store.countPack(pack);
    const source = typeof pack.source === 'string' && pack.source ? pack.source : String(pack.__file || '');
    return {
      id: pack.id,
      name: pack.name,
      source,
      count,
      categoryCount,
      origin: pack.__origin || 'local',
      enabled: active.includes(pack.id),
      version: pack.version || '',
      description: pack.description || '',
      categories: Array.isArray(pack.categories) ? pack.categories : []
    };
  });
}

function buildState() {
  let packs;
  try {
    packs = packsDetail();
  } catch (e) {
    logWarn(`整理动作包详情失败，退回摘要：${e && e.message}`);
    packs = packsList();
  }
  return {
    settings: state.settings ? { ...state.settings } : store.DEFAULT_SETTINGS,
    packs,
    actionCount: state.index.length,
    nextFireAt: state.nextFireAt,
    paused: state.paused,
    executors: typeof state.onListExecutors === 'function' ? state.onListExecutors() : []
  };
}

/** 预览下一条（不推进游标、不弹窗） */
function peekNext() {
  const picked = scheduler.peekNext(state.index, settingsOf(), state.cursor);
  const pack = state.packs.find((p) => p.id === picked.packId) || null;
  return {
    move: picked.move,
    pack: pack ? { id: pack.id, name: pack.name } : { id: picked.packId, name: picked.packName },
    path: [...(Array.isArray(picked.path) ? picked.path : []), picked.move.name],
    category: picked.category,
    part: picked.part,
    level: picked.level
  };
}

/** 开关某个动作包 */
function togglePack(id, enabled) {
  const packId = typeof id === 'string' ? id.trim() : '';
  if (!packId) return packsList();
  const current = settingsOf();
  const knownIds = state.packs.map((p) => p.id);
  let active = Array.isArray(current.activePackIds) ? current.activePackIds.slice() : [];
  if (active.length === 0) active = knownIds.slice();
  const wantOn = typeof enabled === 'boolean' ? enabled : !active.includes(packId);
  if (wantOn) {
    if (!active.includes(packId)) active.push(packId);
  } else {
    active = active.filter((x) => x !== packId);
  }
  state.settings = store.saveSettings({ activePackIds: active });
  emitChange('packs');
  return packsList();
}

/** 订阅安装/同步后：刷新索引，并把新包默认启用 */
function afterSubscriptionChange(installedPackIds) {
  const { index } = reloadPacks();
  const settings = settingsOf();
  const active = Array.isArray(settings.activePackIds) ? settings.activePackIds.slice() : [];
  for (const id of installedPackIds || []) {
    if (id && !active.includes(id)) active.push(id);
  }
  state.settings = store.saveSettings({ activePackIds: active });
  scheduleNext('订阅安装');
  emitChange('packs');
  return index.length;
}

module.exports = {
  init,
  start,
  stop,
  fire,
  tick,
  applySettings,
  togglePause,
  isPaused,
  reloadPacks,
  packsList,
  packsDetail,
  buildState,
  peekNext,
  togglePack,
  afterSubscriptionChange,
  withinActiveHours,
  formatClock,
  // 状态对象可供自检脚本观察
  get state() {
    return state;
  }
};
