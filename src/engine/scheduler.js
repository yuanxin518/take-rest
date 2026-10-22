// 动作抽取纯逻辑：把动作包的三级结构展平成可选 move 列表，并按设置挑下一条（不碰 Electron API）。
'use strict';

const PACK_FORMAT = 'gongwei-tixing-pack/1';
const LEGAL_LEVELS = ['静音', '轻响', '震动'];
const DEFAULT_LEVEL = '静音';
const STUB_SECONDS = 30; // 没有任何可用动作时的兜底弹窗秒数

/**
 * 日志：主进程里有统一的 [提醒] 前缀；纯逻辑模块也统一走这里，方便以后接管。
 */
function log(...args) {
  try {
    console.log('[提醒]', ...args);
  } catch (_e) {
    /* 忽略日志异常 */
  }
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function compareOrder(a, b) {
  // order 缺省时保持原顺序（用下标兜底）
  const oa = num(a.order, a.__index);
  const ob = num(b.order, b.__index);
  return oa - ob;
}

/**
 * 把三级结构展平成 move 列表。输入为「动作包数组」或「{ packs: [...] }」。
 * @param {Array|{packs:Array}} packs
 * @returns {Array<{category:string, part:string, level:string, path:string[], move:object, packId:string, packName:string, format:string}>}
 */
function buildIndex(packs) {
  const list = Array.isArray(packs)
    ? packs
    : isObj(packs) && Array.isArray(packs.packs)
      ? packs.packs
      : [];

  const index = [];
  const seenMoveIds = new Set();

  for (const pack of list) {
    if (!isObj(pack)) continue;
    const packId = typeof pack.id === 'string' ? pack.id : '';
    const packName = typeof pack.name === 'string' ? pack.name : packId;
    if (pack.format !== PACK_FORMAT) {
      log(`跳过动作包「${packName || packId}」：format 不是 ${PACK_FORMAT}`);
      continue;
    }

    const categories = Array.isArray(pack.categories) ? pack.categories : [];
    categories
      .filter(isObj)
      .map((c, i) => ({ ...c, __index: i }))
      .sort(compareOrder)
      .forEach((category) => {
        const categoryName = typeof category.name === 'string' && category.name ? category.name : String(category.id || '未命名类别');
        const parts = Array.isArray(category.parts) ? category.parts : [];
        parts
          .filter(isObj)
          .map((p, i) => ({ ...p, __index: i }))
          .sort(compareOrder)
          .forEach((part) => {
            const partName = typeof part.name === 'string' && part.name ? part.name : String(part.id || '未命名部位');
            const moves = Array.isArray(part.moves) ? part.moves : [];
            moves
              .filter(isObj)
              .map((m, i) => ({ ...m, __index: i }))
              .sort(compareOrder)
              .forEach((move) => {
                const id = typeof move.id === 'string' ? move.id.trim() : '';
                if (!id) {
                  log(`丢弃 move：缺少 id（${categoryName}/${partName}/${move.name || '?'}）`);
                  return;
                }
                if (seenMoveIds.has(id)) {
                  log(`丢弃 move：id 重复「${id}」（保留先出现的那条）`);
                  return;
                }
                let level = typeof move.level === 'string' && move.level ? move.level : DEFAULT_LEVEL;
                if (!LEGAL_LEVELS.includes(level)) {
                  log(`丢弃 move「${id}」：level「${level}」非法（只允许 ${LEGAL_LEVELS.join('/')}）`);
                  return;
                }
                seenMoveIds.add(id);
                const clean = { ...move, level };
                delete clean.__index;
                index.push({
                  category: categoryName,
                  part: partName,
                  level,
                  path: [categoryName, partName],
                  move: clean,
                  packId,
                  packName,
                  format: pack.format
                });
              });
          });
      });
  }

  return index;
}

/** 取某条索引项的动作 id */
function idOf(entry) {
  return entry &&isObj(entry.move) && typeof entry.move.id === 'string' ? entry.move.id : '';
}

/**
 * 按设置过滤出候选列表（保持 buildIndex 的顺序）。
 * @param {Array} index buildIndex 的结果
 * @param {object} settings 见规范第 6 节
 */
function filterCandidates(index, settings) {
  const s = isObj(settings) ? settings : {};
  const list = Array.isArray(index) ? index.filter(isObj) : [];
  const categories = isObj(s.categories) ? s.categories : null;
  const levels = isObj(s.levels) ? s.levels : null;
  const activePackIds = Array.isArray(s.activePackIds) ? s.activePackIds : null;
  // 按树节点路径单独禁用：形如「身体/小腿/静音」。
  // 这个是「细粒度」开关——同一档位在不同的部位下互不影响，
  // 上面的 categories / levels 只作为粗粒度兜底（老设置文件里可能还有）。
  const disabledPaths = Array.isArray(s.disabledPaths) ? s.disabledPaths : null;

  return list.filter((entry) => {
    // 类别过滤：categories 里显式写成 false 才排除，没写的类别默认放行
    if (categories && Object.prototype.hasOwnProperty.call(categories, entry.category) && categories[entry.category] === false) {
      return false;
    }
    // 幅度档位过滤：同上，显式 false 才排除
    if (levels && Object.prototype.hasOwnProperty.call(levels, entry.level) && levels[entry.level] === false) {
      return false;
    }
    // 细粒度：这个部位下的这个档位被单独关掉了
    if (disabledPaths && disabledPaths.length > 0) {
      if (disabledPaths.includes(`${entry.category}/${entry.part}/${entry.level}`)) return false;
    }
    // 启用的动作包：非空数组时才算白名单，空数组视为「没限制」
    if (activePackIds && activePackIds.length > 0 && !activePackIds.includes(entry.packId)) {
      return false;
    }
    return true;
  });
}

function findCursorIndex(list, cursorId) {
  if (!cursorId) return -1;
  return list.findIndex((entry) => idOf(entry) === cursorId);
}

/**
 * 没有任何可用动作时的安全兜底，保证主进程永远有话可说而不是崩掉。
 */
function buildStubEntry() {
  return {
    category: '身体',
    part: '全部',
    level: '静音',
    path: ['身体', '全部'],
    packId: 'builtin-stub',
    packName: '内置兜底',
    format: PACK_FORMAT,
    move: {
      id: 'builtin-stub',
      level: '静音',
      name: '站起来动一下',
      order: 1,
      prompt: '站起来动一下 · 动作包为空，去设置面板选一个动作包 · 走两步',
      detail: '当前没有可用的动作包，检查设置面板里的动作包开关和订阅源。',
      dosage: '走两步',
      durationSec: STUB_SECONDS,
      tags: ['兜底']
    }
  };
}

/**
 * 挑下一条动作并推进游标。
 * @param {Array} index buildIndex 的结果
 * @param {object} settings 见规范第 6 节
 * @param {string|{currentId?:string, id?:string}} [cursor] 游标（上一条动作 id），也可直接传 id 字符串
 * @returns {{move:object, category:string, part:string, path:string[],
 *            level:string, packId:string, packName:string, stubbed?:boolean}}
 */
function pickNext(index, settings, cursor) {
  const s = isObj(settings) ? settings : {};
  const cursorId =
    typeof cursor === 'string'
      ? cursor
      : isObj(cursor) && typeof cursor.currentId === 'string'
        ? cursor.currentId
        : isObj(cursor) && typeof cursor.id === 'string'
          ? cursor.id
          : '';

  const candidates = filterCandidates(index, s);
  if (candidates.length === 0) {
    log('没有可用的动作（动作包为空或过滤后为空），使用内置兜底文案');
    const stub = buildStubEntry();
    return {
      move: stub.move,
      category: stub.category,
      part: stub.part,
      path: stub.path,
      level: stub.level,
      packId: stub.packId,
      packName: stub.packName,
      stubbed: true
    };
  }

  let chosen;
  if (s.shuffle === true && !cursorId) {
    // 随机模式、还没开始循环：直接随机起点
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (s.shuffle === true && cursorId) {
    // 随机模式、有游标：排掉上一条，避免连续两次同一个动作
    const pool = candidates.length > 1 ? candidates.filter((e) => idOf(e) !== cursorId) : candidates;
    chosen = pool[Math.floor(Math.random() * pool.length)];
  } else {
    // 顺序模式：从游标的下一条开始循环；游标不在候选里则从头开始
    const at = findCursorIndex(candidates, cursorId);
    chosen = candidates[(at + 1) % candidates.length];
  }

  if (!chosen) chosen = candidates[0];

  return {
    move: chosen.move,
    category: chosen.category,
    part: chosen.part,
    path: chosen.path,
    level: chosen.level,
    packId: chosen.packId,
    packName: chosen.packName
  };
}

/**
 * 预览下一条但不推进游标（面板「下一条」用）。
 */
function peekNext(index, settings, cursor) {
  return pickNext(index, settings, cursor);
}

module.exports = {
  buildIndex,
  pickNext,
  peekNext,
  filterCandidates,
  buildStubEntry,
  PACK_FORMAT,
  LEGAL_LEVELS,
  DEFAULT_LEVEL,
  STUB_SECONDS
};
