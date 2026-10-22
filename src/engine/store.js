// 本地数据读写：%APPDATA%\<appName> 下的设置、动作包目录、订阅缓存；任何读写失败都回落默认值，不抛异常。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PACK_FORMAT = 'gongwei-tixing-pack/1';
const REGISTRY_FORMAT = 'gongwei-tixing-registry/1';
const LEGAL_LEVELS = ['静音', '轻响', '震动'];

/** 规范第 6 节的默认设置 */
/**
 * 提醒条外观默认值。
 * minWidth / maxWidth 是像素；maxWidthRatio 是把「最大宽度」表达成屏宽比例时用的上限系数
 * （用户在界面里填最大宽度，实际生效值还会被屏宽 80% 夹一次，防止把屏幕占满）。
 */
const DEFAULT_APPEARANCE = {
  minWidth: 1100, // 默认（最小）宽度——用户要求 1100
  maxWidth: 1280, // 最大宽度
  fontSize: 15, // 文字大小 px
  align: 'center', // 文字对齐：left / center / right
  textColor: '#ffffff', // 文字颜色
  textOpacity: 0.92, // 文字透明度 0.1–1
  bgOpacity: 0.92, // 背景透明度 0.1–1
  screen: 'cursor', // 显示的屏幕：cursor（鼠标所在）/ primary（主屏）
  position: 'bottom', // 展示位置：bottom / top / center
  theme: 'dark' // 背景深浅：dark / light（影响背景基色，透明度仍由 bgOpacity 控制）
};

const ALIGN_VALUES = ['left', 'center', 'right'];
const SCREEN_VALUES = ['cursor', 'primary'];
const POSITION_VALUES = ['bottom', 'top', 'center'];
const THEME_VALUES = ['dark', 'light'];

const DEFAULT_SETTINGS = {
  intervalMin: 20,
  enabled: true,
  popupSeconds: 0,
  categories: { 身体: true },
  levels: { 静音: true },
  // 按树节点单独禁用，形如「身体/小腿/静音」。同一档位在不同部位下互不影响。
  disabledPaths: [],
  // 内置包默认全部启用；订阅包安装时会被追加进来（见 engine.afterSubscriptionChange）
  activePackIds: ['gongwei-5lianhuan', 'office-light', 'office-calm'],
  shuffle: false,
  activeHours: { start: 9, end: 20 },
  showCountdown: true,
  // 提醒条外观（样式 tab 里改的那些）
  appearance: DEFAULT_APPEARANCE
};

/** 规范第 7 节的订阅索引默认值 */
const DEFAULT_SUBSCRIPTION_META = { format: REGISTRY_FORMAT, sources: [], lastSyncAt: null, lastSyncError: null };

/**
 * 主进程是否已经把 userData 定到我们算出来的目录。
 * 为 false 时忽略 Electron 的默认 userData（那是按 productName 起的另一个目录）。
 */
let userDataPinned = false;

// Electron 的 app.setPath('userData') 会把根目录改到别处；纯 node 环境下没有 electron，返回 null。
function electronUserDataDir() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      const dir = electron.app.getPath('userData');
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch (_e) {
    /* 不是 Electron 环境 */
  }
  return null;
}

/** 数据目录名：优先 package.json 的 name（= 仓库名 take-rest），不写死产品中文名 */
function appDataFolderName() {
  try {
    const pkg = require('../../package.json');
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch (_e) {
    /* 读不到就用下面的常量 */
  }
  return 'take-rest';
}

/**
 * 老版本用过的数据目录名。改名后如果新目录还不存在、而老目录在，
 * 就把老目录整个搬过来，用户的设置、本地动作包、订阅缓存都不会丢。
 * 顺序即优先级：desk-reminder 是上一版，站立提醒 是最早那版。
 */
const LEGACY_FOLDER_NAMES = ['desk-reminder', '站立提醒'];

/**
 * 一次性迁移老数据目录。**每个进程只跑一次**（rootDir 会被调用很多次）。
 *
 * 时机很关键：Electron 在 app.setName() 之后、app ready 之前就会建好 userData 目录，
 * 而且整个进程生命周期都占着它（Windows 上 rename 该目录会 EPERM）。
 * 所以这里**不能重命名目标目录**，只能把老目录里的内容复制进去。
 *
 * 判断依据：老目录里有没有真正的用户数据（settings.json / packs / subscriptions）。
 * 有就复制过来，覆盖新目录里那份默认设置。
 */
let legacyMigrationDone = false;

/**
 * @param {string} appDataRoot
 * @returns {string} 最终可用的数据根目录
 */
function migrateLegacyDataDir(appDataRoot) {
  const target = path.join(appDataRoot, appDataFolderName());
  if (legacyMigrationDone) return target;

  /** 老目录里是否真的有用户数据 */
  const hasUserData = (dir) => {
    try {
      if (!fs.existsSync(dir)) return false;
      if (fs.existsSync(path.join(dir, 'settings.json'))) return true;
      const packs = path.join(dir, 'packs');
      if (fs.existsSync(packs) && fs.readdirSync(packs).length > 0) return true;
      const subs = path.join(dir, 'subscriptions');
      if (fs.existsSync(subs) && fs.readdirSync(subs).length > 0) return true;
      return false;
    } catch (_e) {
      return false;
    }
  };

  for (const legacy of LEGACY_FOLDER_NAMES) {
    const from = path.join(appDataRoot, legacy);
    if (!hasUserData(from)) continue;
    try {
      // 只复制「我们自己的东西」，Chromium 的缓存不搬（搬过来也没用，还会冲突）
      fs.mkdirSync(target, { recursive: true });
      const OWN_ENTRIES = ['settings.json', 'packs', 'subscriptions'];
      let moved = 0;
      for (const name of OWN_ENTRIES) {
        const src = path.join(from, name);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(target, name);
        try {
          fs.rmSync(dest, { recursive: true, force: true });
          fs.cpSync(src, dest, { recursive: true });
          moved += 1;
        } catch (e) {
          logWarn(`迁移「${legacy}/${name}」失败：${e && e.message}`);
        }
      }
      if (moved > 0) {
        log(`已把老数据目录「${legacy}」的 ${moved} 项数据迁到「${appDataFolderName()}」`);
      }
      legacyMigrationDone = true;
      return target;
    } catch (e) {
      logWarn(`迁移老数据目录「${legacy}」失败（继续用新目录）：${e && e.message}`);
    }
  }
  legacyMigrationDone = true;
  return target;
}

/**
 * 数据根目录：环境变量覆盖 → 显式指定的 userData（主进程 setPath 之后）
 * → %APPDATA%\<appName>（含老目录迁移） → 用户主目录。
 *
 * 注意顺序：Electron 在 setPath 之前就会按 productName 建一个默认 userData 目录，
 * 那个名字（如「休息一下 Take rest」）不该拿来当数据根 —— 我们统一用 package.json 的 name。
 * 所以这里先看「有没有被主进程显式设过」，没设过就走 <APPDATA>/<name> 这条确定路径。
 */
function rootDir() {
  const override = process.env.DESK_REMINDER_DATA_DIR || process.env.GONGWEI_DATA_DIR;
  if (override) return override;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (userDataPinned) {
    const fromElectron = electronUserDataDir();
    if (fromElectron) return fromElectron;
  }
  return migrateLegacyDataDir(appData);
}

/**
 * 主进程调用：把「数据目录该叫什么」定下来，之后再读 rootDir() 才认 Electron 的 userData。
 * @param {string} dir 已确定的数据根目录
 */
function pinUserDataDir(dir) {
  userDataPinned = typeof dir === 'string' && dir !== '';
}

/**
 * 内置动作包目录候选（按优先级，取第一个真实存在的）。
 * 关键事实：本文件在 src/engine/ 下，__dirname === <工程根>/src/engine，
 * 内置包在 <工程根>/src/packs，所以要往上走一级：__dirname/../packs。
 * （曾误写成 getAppPath()/src/packs 优先：electron 入口是 scripts/e2e-check.cjs 时
 *   getAppPath() 返回 scripts 目录，于是拼出 …/scripts/src/packs，内置包就丢了。）
 */
function builtinPacksCandidates() {
  const candidates = [];
  const push = (p) => {
    if (typeof p === 'string' && p && !candidates.includes(p)) candidates.push(p);
  };

  // 1. 首选：src/engine/store.js → ../packs = src/packs（纯 node、electron .、打包后都成立）
  push(path.resolve(__dirname, '..', 'packs'));

  // 2. 兜底：app.getAppPath()（正常 electron . 启动时是工程根；入口在 scripts/ 时会偏一级）
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getAppPath === 'function') {
      const appPath = electron.app.getAppPath();
      if (typeof appPath === 'string' && appPath) {
        push(path.join(appPath, 'src', 'packs'));
        // 入口在子目录（如 scripts）时，往上找一级工程的 src/packs
        push(path.resolve(appPath, '..', 'src', 'packs'));
      }
    }
  } catch (_e) {
    /* 不是 Electron 环境 */
  }

  return candidates;
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_e) {
    return false;
  }
}

/** 内置动作包目录（真实存在的那个；都不存在时返回首选路径，日志里会列出全部候选） */
function builtinPacksDir() {
  const candidates = builtinPacksCandidates();
  for (const dir of candidates) {
    if (dirExists(dir)) return dir;
  }
  return candidates[0];
}

const paths = {
  root: () => rootDir(),
  appDataFolderName: () => appDataFolderName(),
  settingsFile: () => path.join(rootDir(), 'settings.json'),
  packsDir: () => path.join(rootDir(), 'packs'),
  subsDir: () => path.join(rootDir(), 'subscriptions'),
  subMetaFile: () => path.join(rootDir(), 'subscriptions', 'subscriptions.json'),
  builtinPacksDir: () => builtinPacksDir()
};

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

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    logWarn(`创建目录失败：${dir}：${e && e.message}`);
    return false;
  }
}

/** 原子写：先写 .tmp 再改名，掉电也不会留下半截 JSON */
function writeJsonAtomic(file, data) {
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    logWarn(`写入失败：${file}：${e && e.message}`);
    return false;
  }
}

/** 读 JSON；不存在/损坏/不是对象都返回 null（调用方决定回落） */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') logWarn(`读取失败：${file}：${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return isObj(parsed) ? parsed : null;
  } catch (e) {
    logWarn(`JSON 解析失败（按默认值处理）：${file}：${e.message}`);
    return null;
  }
}

/** 把任意输入规范成合法 settings，非法字段一律回落到规范默认值 */
function normalizeSettings(input) {
  const src = isObj(input) ? input : {};
  const out = clone(DEFAULT_SETTINGS);

  out.intervalMin = clampInt(src.intervalMin, 1, 24 * 60, DEFAULT_SETTINGS.intervalMin);
  out.enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SETTINGS.enabled;
  out.popupSeconds = clampInt(src.popupSeconds, 0, 600, DEFAULT_SETTINGS.popupSeconds);

  // categories / levels：只保留布尔值，非法键丢弃；空对象回落默认
  const normMap = (v, dflt) => {
    if (!isObj(v)) return clone(dflt);
    const map = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'boolean') map[k] = val;
    }
    return Object.keys(map).length > 0 ? map : clone(dflt);
  };
  out.categories = normMap(src.categories, DEFAULT_SETTINGS.categories);
  out.levels = normMap(src.levels, DEFAULT_SETTINGS.levels);

  // disabledPaths：字符串数组（「身体/小腿/静音」），去重、去空、非字符串丢弃
  out.disabledPaths = Array.isArray(src.disabledPaths)
    ? Array.from(new Set(src.disabledPaths.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())))
    : clone(DEFAULT_SETTINGS.disabledPaths);

  out.activePackIds = Array.isArray(src.activePackIds)
    ? Array.from(new Set(src.activePackIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())))
    : clone(DEFAULT_SETTINGS.activePackIds);

  out.shuffle = typeof src.shuffle === 'boolean' ? src.shuffle : DEFAULT_SETTINGS.shuffle;
  out.showCountdown = typeof src.showCountdown === 'boolean' ? src.showCountdown : DEFAULT_SETTINGS.showCountdown;

  // appearance：逐字段夹取值域，非法一律回落默认
  const ap = isObj(src.appearance) ? src.appearance : {};
  const clampFloat = (v, min, max, dflt) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  const oneOf = (v, list, dflt) => (typeof v === 'string' && list.includes(v) ? v : dflt);
  const normColor = (v, dflt) => {
    const s = typeof v === 'string' ? v.trim() : '';
    // 只接受 #rgb / #rrggbb，避免把任意字符串塞进 CSS
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : dflt;
  };
  const minW = clampInt(ap.minWidth, 120, 2000, DEFAULT_APPEARANCE.minWidth);
  const maxW = clampInt(ap.maxWidth, 200, 4000, DEFAULT_APPEARANCE.maxWidth);
  // 迁移：旧版默认最小宽是 240。用户没主动改过（仍等于 240）就升到新默认 1100；
  // 自己改过的不动，尊重用户的选择。
  const migratedMinW = minW === 240 ? DEFAULT_APPEARANCE.minWidth : minW;
  out.appearance = {
    minWidth: migratedMinW,
    // 最大宽度不允许小于最小宽度，否则几何算不出来；也不低于新默认，避免迁移后反而变窄
    maxWidth: Math.max(migratedMinW, maxW),
    fontSize: clampInt(ap.fontSize, 10, 32, DEFAULT_APPEARANCE.fontSize),
    align: oneOf(ap.align, ALIGN_VALUES, DEFAULT_APPEARANCE.align),
    textColor: normColor(ap.textColor, DEFAULT_APPEARANCE.textColor),
    textOpacity: clampFloat(ap.textOpacity, 0.1, 1, DEFAULT_APPEARANCE.textOpacity),
    bgOpacity: clampFloat(ap.bgOpacity, 0.1, 1, DEFAULT_APPEARANCE.bgOpacity),
    screen: oneOf(ap.screen, SCREEN_VALUES, DEFAULT_APPEARANCE.screen),
    position: oneOf(ap.position, POSITION_VALUES, DEFAULT_APPEARANCE.position),
    theme: oneOf(ap.theme, THEME_VALUES, DEFAULT_APPEARANCE.theme)
  };

  // activeHours：{start,end}（0-23 整点）。null / 缺字段 / 非法 → 不限制
  if (src.activeHours === null || src.activeHours === false) {
    out.activeHours = null;
  } else if (isObj(src.activeHours)) {
    const start = clampInt(src.activeHours.start, 0, 23, NaN);
    const end = clampInt(src.activeHours.end, 0, 23, NaN);
    out.activeHours = Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  } else {
    out.activeHours = clone(DEFAULT_SETTINGS.activeHours);
  }

  return out;
}

/** 读设置；文件缺失/损坏时回落到默认值并（尽力）落盘一份默认设置 */
function loadSettings() {
  const file = paths.settingsFile();
  const raw = readJson(file);
  if (!raw) {
    const dflt = clone(DEFAULT_SETTINGS);
    log('设置文件缺失或损坏，使用默认设置');
    writeJsonAtomic(file, dflt);
    return dflt;
  }
  const settings = normalizeSettings(raw);
  return settings;
}

/** 合并式保存设置，返回完整 settings */
function saveSettings(patch) {
  const current = loadSettings();
  const merged = isObj(patch) ? { ...current, ...patch } : current;
  const settings = normalizeSettings(merged);
  const ok = writeJsonAtomic(paths.settingsFile(), settings);
  if (!ok) logWarn('设置写入失败，本次改动只在内存生效');
  return settings;
}

/**
 * 校验并清洗单个动作包；非法返回 { pack:null, error }
 * 严格按规范第 4 节：format、id、name、categories 必须有；move 必须 id/name/prompt；level 非法整条丢弃。
 */
function sanitizePack(raw, sourcePath) {
  if (!isObj(raw)) return { pack: null, error: '不是 JSON 对象' };
  if (raw.format !== PACK_FORMAT) return { pack: null, error: `format 应为 ${PACK_FORMAT}，实际 ${String(raw.format)}` };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return { pack: null, error: '缺少 id' };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;

  const categoriesIn = Array.isArray(raw.categories) ? raw.categories : null;
  if (!categoriesIn) return { pack: null, error: '缺少 categories 数组' };

  const dropped = [];
  const categories = [];
  categoriesIn.forEach((c, ci) => {
    if (!isObj(c)) {
      dropped.push(`categories[${ci}] 不是对象`);
      return;
    }
    const partsIn = Array.isArray(c.parts) ? c.parts : [];
    const parts = [];
    partsIn.forEach((p, pi) => {
      if (!isObj(p)) {
        dropped.push(`${c.name || c.id}.parts[${pi}] 不是对象`);
        return;
      }
      const movesIn = Array.isArray(p.moves) ? p.moves : [];
      const moves = [];
      movesIn.forEach((m, mi) => {
        const where = `${c.name || c.id}/${p.name || p.id}/moves[${mi}]`;
        if (!isObj(m)) {
          dropped.push(`${where} 不是对象`);
          return;
        }
        const moveId = typeof m.id === 'string' ? m.id.trim() : '';
        if (!moveId) {
          dropped.push(`${where} 缺少 id`);
          return;
        }
        if (typeof m.name !== 'string' || !m.name.trim()) {
          dropped.push(`move「${moveId}」缺少 name`);
          return;
        }
        // phases：分段时间轴（可选）。有 phases 时正文由各段生成，prompt 可以省略
        const phases = [];
        if (Array.isArray(m.phases)) {
          for (const ph of m.phases.slice(0, 12)) {
            if (!isObj(ph)) continue;
            const text = typeof ph.text === 'string' ? ph.text.trim() : '';
            const rawSec = typeof ph.sec === 'number' ? ph.sec : Number(ph.sec);
            // 0 / 负数 / 非数字都是非法段：丢弃，而不是夹成 1 秒
            if (!text || !Number.isFinite(rawSec) || rawSec <= 0) continue;
            const step = { text, sec: clampInt(rawSec, 1, 600, 1) };
            // 做法说明（可选）：进度条上方固定显示的「这一步具体怎么做」
            if (typeof ph.how === 'string' && ph.how.trim()) step.how = ph.how.trim();
            phases.push(step);
          }
        }
        const hasPhases = phases.length > 0;
        if (!hasPhases && (typeof m.prompt !== 'string' || !m.prompt.trim())) {
          dropped.push(`move「${moveId}」缺少 prompt，也没有 phases`);
          return;
        }
        const level = typeof m.level === 'string' && m.level.trim() ? m.level.trim() : '静音';
        if (!LEGAL_LEVELS.includes(level)) {
          dropped.push(`move「${moveId}」level 非法：${level}`);
          return;
        }
        const move = {
          ...m,
          id: moveId,
          level,
          name: m.name.trim(),
          prompt: typeof m.prompt === 'string' ? m.prompt.trim() : ''
        };
        // 分段动作：一次流程 = 各段之和 + 段间切换；重复次数单独记
        if (hasPhases) {
          move.phases = phases;
          move.transitionSec = clampInt(m.transitionSec, 0, 10, 2);
          move.reps = clampInt(m.reps, 1, 99, 1);
          // 没有 prompt 时用各段拼一句，方便面板与订阅源预览
          if (!move.prompt) move.prompt = phases.map((p) => `${p.text} ${p.sec}秒`).join(' · ');
        } else {
          delete move.phases;
          delete move.transitionSec;
          const reps = clampInt(m.reps, 0, 9999, 0);
          if (reps > 0) move.reps = reps;
          else delete move.reps;
        }
        move.durationSec = clampInt(m.durationSec, 1, 3600, 30);
        if (typeof move.order !== 'number' || !Number.isFinite(move.order)) move.order = mi + 1;
        if (!Array.isArray(move.tags)) move.tags = [];
        moves.push(move);
      });
      if (moves.length === 0) {
        dropped.push(`部位「${p.name || p.id}」没有合法动作，整条丢弃`);
        return;
      }
      parts.push({
        ...p,
        id: typeof p.id === 'string' && p.id ? p.id : `part-${pi + 1}`,
        name: typeof p.name === 'string' && p.name ? p.name : `部位 ${pi + 1}`,
        order: typeof p.order === 'number' && Number.isFinite(p.order) ? p.order : pi + 1,
        moves
      });
    });
    if (parts.length === 0) {
      dropped.push(`类别「${c.name || c.id}」没有合法部位，整条丢弃`);
      return;
    }
    categories.push({
      ...c,
      id: typeof c.id === 'string' && c.id ? c.id : `cat-${ci + 1}`,
      name: typeof c.name === 'string' && c.name ? c.name : `类别 ${ci + 1}`,
      order: typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : ci + 1,
      parts
    });
  });

  if (categories.length === 0) return { pack: null, error: '没有可用的动作（全部被清洗掉）' };

  const pack = {
    ...raw,
    format: PACK_FORMAT,
    id,
    name,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    author: typeof raw.author === 'string' ? raw.author : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    categories,
    __file: sourcePath || null
  };
  if (dropped.length > 0) logWarn(`动作包「${name}」清洗掉 ${dropped.length} 条：${dropped.slice(0, 5).join('；')}`);
  return { pack, error: null, dropped };
}

/** 从磁盘读一个动作包文件并清洗（v1 规范：UTF-8，可带可不带 BOM） */
function readPackFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    logWarn(`动作包读取失败：${file}（${e && e.code ? e.code : '未知'}）：${e && e.message}`);
    return null;
  }
  // 显式按 UTF-8 解码并去掉 BOM，中文文件名/中文内容都能正确读
  let raw = buf.toString('utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (raw.trim() === '') {
    logWarn(`动作包是空文件：${file}`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    logWarn(`动作包 JSON 解析失败：${file}：${e && e.message}（文件前 60 字符：${JSON.stringify(raw.slice(0, 60))}）`);
    return null;
  }
  const { pack, error } = sanitizePack(data, file);
  if (!pack) {
    logWarn(`动作包校验不通过，已跳过：${file}：${error}`);
    return null;
  }
  return pack;
}

/** 列出目录下的 .json（忽略隐藏文件和非 json），按 UTF-8 文件名排序 */
function listJsonFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code !== 'ENOENT') logWarn(`读取目录失败：${dir}（${e.code}）：${e.message}`);
    return [];
  }
  return names
    .filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.json') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((f) => path.join(dir, f));
}

/** 数一个动作包里有多少条 move / 多少个类别 */
function countPack(pack) {
  let count = 0;
  const categories = Array.isArray(pack && pack.categories) ? pack.categories : [];
  for (const c of categories) {
    for (const p of Array.isArray(c.parts) ? c.parts : []) {
      count += Array.isArray(p.moves) ? p.moves.length : 0;
    }
  }
  return { count, categoryCount: categories.length };
}

function loadSubscriptionMeta() {
  const raw = readJson(paths.subMetaFile());
  if (!raw) return clone(DEFAULT_SUBSCRIPTION_META);
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter(isObj)
        .map((s) => ({
          name: typeof s.name === 'string' ? s.name : '',
          source: typeof s.source === 'string' ? s.source : '',
          dir: typeof s.dir === 'string' ? s.dir : '',
          packs: Array.isArray(s.packs) ? s.packs.filter((x) => typeof x === 'string') : [],
          installedAt: typeof s.installedAt === 'string' ? s.installedAt : null,
          lastSyncAt: typeof s.lastSyncAt === 'string' ? s.lastSyncAt : null
        }))
        .filter((s) => s.name)
    : [];
  return {
    format: REGISTRY_FORMAT,
    sources,
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
    lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null
  };
}

function saveSubscriptionMeta(meta) {
  writeJsonAtomic(paths.subMetaFile(), { ...DEFAULT_SUBSCRIPTION_META, ...meta });
}

/** 读一个目录下所有动作包，origin 打标 */
function loadPacksFromDir(dir, origin) {
  const out = [];
  const files = listJsonFiles(dir);
  if (files.length === 0) {
    if (!fs.existsSync(dir)) {
      if (origin === 'builtin') {
        const tried = builtinPacksCandidates();
        logWarn(`内置动作包目录不存在，尝试过的路径：\n  - ${tried.join('\n  - ')}`);
      } else {
        logWarn(`动作包目录不存在（按空处理）：${dir}`);
      }
    }
    return out;
  }
  for (const file of files) {
    let pack = null;
    try {
      pack = readPackFile(file);
    } catch (e) {
      logWarn(`读取动作包抛异常：${file}：${e && (e.stack || e.message)}`);
      continue;
    }
    if (pack) out.push({ ...pack, __origin: origin });
    else logWarn(`动作包跳过（见上方原因）：${file}`);
  }
  return out;
}

/**
 * 加载全部动作包，来源三级，顺序固定：内置（随程序）→ 本地（用户 packs\）→ 订阅（subscriptions\）。
 * 内置包永远参与加载，跟 %APPDATA% 有没有用户数据无关。
 * 同 id 的包后出现者覆盖先出现者：订阅是权威源（规范 7.4）。
 * 目录不存在 / 为空都返回空数组，不抛异常。
 */
function loadAllPacks() {
  const builtinDir = builtinPacksDir();
  const builtin = loadPacksFromDir(builtinDir, 'builtin');
  const local = loadPacksFromDir(paths.packsDir(), 'local');
  const remote = loadSubscriptionPacks();

  // 按 id 去重：内置 → 本地 → 订阅，后者覆盖前者
  const byId = new Map();
  for (const pack of builtin) byId.set(pack.id, pack);
  for (const pack of local) {
    if (byId.has(pack.id)) log(`动作包 id 撞车「${pack.id}」：用本地版本覆盖内置版本`);
    byId.set(pack.id, pack);
  }
  for (const pack of remote) {
    if (byId.has(pack.id)) log(`动作包 id 撞车「${pack.id}」：用订阅版本覆盖已有版本`);
    byId.set(pack.id, pack);
  }

  const merged = [...byId.values()];
  const totalMoves = merged.reduce((n, p) => n + countPack(p).count, 0);
  log(
    `已加载动作包 ${merged.length} 个（内置 ${builtin.length} 个 / 订阅 ${remote.length} 个，另有本地 ${local.length} 个），动作 ${totalMoves} 条`
  );
  if (merged.length === 0) {
    const tried = builtinPacksCandidates();
    logWarn(`一个动作包都没读到，内置目录尝试过的路径：\n  - ${tried.join('\n  - ')}`);
  }
  return merged;
}

/** 面板用的精简列表：[{ id, name, source, count, categoryCount, file? }] */
function listPacksSummary(packs) {
  const list = Array.isArray(packs) ? packs : loadAllPacks();
  return list.map((pack) => {
    const { count, categoryCount } = countPack(pack);
    const source =
      typeof pack.source === 'string' && pack.source
        ? pack.source
        : (pack.__file || '').toString();
    return {
      id: pack.id,
      name: pack.name,
      source,
      count,
      categoryCount,
      origin: pack.__origin || 'local'
    };
  });
}

/** 名字 → 安全的目录名（去掉路径分隔符等非法字符） */
function safeDirName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || `sub-${Date.now()}`;
}

/** 判断字符串是否像一个 URL */
function looksLikeUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

/**
 * 安装/更新一个订阅：把 packs 数组写进 <数据目录>\subscriptions\{name}\
 * @param {string} name 订阅目录名（一般 owner-repo）
 * @param {Array|object} packs 已拉取并解析的 pack 对象数组（或单个对象）
 * @returns {{ok:boolean, dir?:string, packs?:Array, error?:string}}
 */
function installSubscription(name, packs) {
  try {
    const list = Array.isArray(packs) ? packs : isObj(packs) ? [packs] : null;
    if (!list || list.length === 0) return { ok: false, error: 'packs 为空，未写入任何文件（旧订阅保持不变）' };

    const dirName = safeDirName(name);
    const dir = path.join(paths.subsDir(), dirName);
    if (!ensureDir(dir)) return { ok: false, error: `无法创建订阅目录：${dir}` };

    const written = [];
    for (const raw of list) {
      const { pack, error } = sanitizePack(raw, path.join(dir, 'pending.json'));
      if (!pack) {
        logWarn(`订阅「${dirName}」中的包被跳过：${error}`);
        continue;
      }
      const file = path.join(dir, `${safeDirName(pack.id)}.json`);
      const payload = { ...pack };
      delete payload.__file;
      if (writeJsonAtomic(file, payload)) written.push({ id: pack.id, file });
    }
    if (written.length === 0) return { ok: false, error: '没有合法的动作包，未写入（旧订阅保持不变）' };

    // 本次成功写入包集合 ≠ 缓存里已有的包时，清掉多余旧文件，避免动作重复
    const keep = new Set(written.map((w) => path.basename(w.file)));
    for (const file of listJsonFiles(dir)) {
      if (!keep.has(path.basename(file))) {
        try {
          fs.unlinkSync(file);
          log(`订阅「${dirName}」移除过期包：${path.basename(file)}`);
        } catch (e) {
          logWarn(`删除过期包失败：${file}：${e && e.message}`);
        }
      }
    }
    return { ok: true, dir, packs: written };
  } catch (e) {
    return { ok: false, error: `安装订阅异常：${e && e.message}` };
  }
}

/** 更新订阅索引里某个来源的元信息（安装时调用） */
function upsertSubscriptionSource(entry) {
  const meta = loadSubscriptionMeta();
  const now = new Date().toISOString();
  const source = typeof entry === 'object' && entry ? entry.source : '';
  const name = typeof entry === 'object' && entry ? entry.name : '';
  const idx = meta.sources.findIndex((s) => s.source && s.source === source);
  const record = {
    name: String(name || ''),
    source: typeof source === 'string' ? source : '',
    dir: typeof entry.dir === 'string' ? entry.dir : '',
    packs: Array.isArray(entry.packs) ? entry.packs : [],
    installedAt: idx >= 0 ? meta.sources[idx].installedAt || now : now,
    lastSyncAt: typeof entry.lastSyncAt === 'string' ? entry.lastSyncAt : now
  };
  if (!record.name) record.name = record.dir || record.source;
  if (idx >= 0) meta.sources[idx] = { ...meta.sources[idx], ...record };
  else meta.sources.push(record);
  meta.lastSyncAt = record.lastSyncAt;
  saveSubscriptionMeta(meta);
  return meta;
}

/** 订阅来源列表：[{ name, source, dir, packs, installedAt, lastSyncAt }] */
function listSubscriptionSources() {
  const meta = loadSubscriptionMeta();
  const sources = meta.sources.slice();

  // 兜底：磁盘上存在但索引里没登记的订阅目录，也列出来
  try {
    const dirs = fs
      .readdirSync(paths.subsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const dirName of dirs) {
      if (sources.some((s) => {
        if (typeof s.dir === 'string' && s.dir) return path.basename(s.dir) === dirName;
        return safeDirName(s.name) === dirName;
      })) {
        continue;
      }
      const packs = listJsonFiles(path.join(paths.subsDir(), dirName))
        .map((f) => readPackFile(f))
        .filter(Boolean)
        .map((p) => p.id);
      sources.push({ name: dirName, source: '', dir: path.join(paths.subsDir(), dirName), packs, installedAt: null, lastSyncAt: null });
    }
  } catch (_e) {
    /* 目录不存在就是没有订阅 */
  }

  return sources;
}

/** 读订阅缓存目录里的全部动作包（每个订阅一个子目录） */
function loadSubscriptionPacks() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(paths.subsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_e) {
    return out; // 没有订阅目录
  }
  for (const dirName of dirs.sort()) {
    for (const file of listJsonFiles(path.join(paths.subsDir(), dirName))) {
      const pack = readPackFile(file);
      if (pack) out.push({ ...pack, __origin: 'subscription' });
    }
  }
  return out;
}

/** 记录一次同步结果（成功清空错误，失败只记错误，不动缓存） */
function recordSync({ ok, error, source, at } = {}) {
  const meta = loadSubscriptionMeta();
  const when = typeof at === 'string' ? at : new Date().toISOString();
  meta.lastSyncAt = when;
  meta.lastSyncError = ok ? null : String(error || '未知错误');
  if (typeof source === 'string' && source) {
    const idx = meta.sources.findIndex((s) => s.source === source);
    if (idx >= 0) {
      if (ok) {
        meta.sources[idx].lastSyncAt = when;
        meta.lastSyncAt = when;
        meta.lastSyncError = null;
      }
    }
  }
  if (ok) meta.lastSyncError = null;
  saveSubscriptionMeta(meta);
  return meta;
}

/** 读取订阅索引（不崩） */
function getSubscriptionMeta() {
  return loadSubscriptionMeta();
}

// 暴露给外部：给面板拉 GitHub 时拼 raw 链接用
function githubRepo(source) {
  const s = typeof source === 'string' ? source.trim() : '';
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function rawManifestUrl(source) {
  const repo = githubRepo(source);
  if (!repo) return typeof source === 'string' && looksLikeUrl(source) ? source.trim() : null;
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/manifest.json`;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_APPEARANCE,
  DEFAULT_SUBSCRIPTION_META,
  PACK_FORMAT,
  REGISTRY_FORMAT,
  LEGAL_LEVELS,
  paths,
  pinUserDataDir,
  appDataFolderName,
  loadSettings,
  saveSettings,
  normalizeSettings,
  loadAllPacks,
  loadSubscriptionPacks,
  builtinPacksDir,
  sanitizePack,
  listPacksSummary,
  installSubscription,
  listSubscriptionSources,
  upsertSubscriptionSource,
  loadSubscriptionMeta,
  saveSubscriptionMeta,
  recordSync,
  getSubscriptionMeta,
  githubRepo,
  rawManifestUrl,
  looksLikeUrl,
  safeDirName,
  countPack,
  readPackFile
};
