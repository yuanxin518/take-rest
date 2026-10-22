// 设置面板窗口：创建 / 复用、入口解析（dev server 与构建产物）、preload 路径、向面板广播。
// 边界：只管「宿主窗口」本身，不认识设置内容，不决定任何东西显示在屏幕哪里。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

// 本文件在 src/main/ 下，工程根要往上走两级；一律 __dirname 推导，不写死任何本机路径
const ROOT = path.join(__dirname, '..', '..');

/** 面板 preload：由渲染层负责创建，这里只写路径 */
const PANEL_PRELOAD = path.join(ROOT, 'renderer', 'panel', 'preload.cjs');
/** 生产构建产物入口（vite 多页构建的 panel 页） */
const PANEL_DIST_HTML = path.join(ROOT, 'dist-renderer', 'panel', 'index.html');
/** 应用图标（由 scripts/make-icon.py 生成） */
const APP_ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
const APP_ICON_PNG = path.join(ROOT, 'assets', 'icon-256.png');

const log = (...args) => console.log('[提醒]', ...args);
const logWarn = (...args) => console.warn('[提醒]', ...args);

/**
 * 找应用图标：优先 .ico（Windows 任务栏/标题栏用），退回 256px PNG。
 * 找不到返回 undefined（Electron 会用默认图标，不会崩）。
 */
function resolveAppIcon() {
  try {
    if (fs.existsSync(APP_ICON_ICO)) return APP_ICON_ICO;
    if (fs.existsSync(APP_ICON_PNG)) return APP_ICON_PNG;
  } catch (_e) {
    /* 忽略 */
  }
  return undefined;
}

const state = {
  panel: null
};

let appTitle = 'Take rest';
let onPanelLoaded = null;

/**
 * 初始化：标题与「面板页面加载完」的挂点。
 * @param {{title?:string, onPanelLoaded?:Function}} [options]
 */
function init(options) {
  const opts = options || {};
  if (typeof opts.title === 'string' && opts.title.trim()) appTitle = opts.title.trim();
  onPanelLoaded = typeof opts.onPanelLoaded === 'function' ? opts.onPanelLoaded : null;
}

/**
 * 面板入口解析，两种形态：
 *   1. 开发期：process.env.DESK_REMINDER_DEV_URL（vite dev server，默认 http://localhost:5173）
 *      → 拼成 <devUrl>/panel/index.html 用 loadURL
 *   2. 生产：dist-renderer/panel/index.html 用 loadFile
 * @returns {{kind:'url'|'file', value:string}}
 */
function resolvePanelEntry() {
  const devUrl =
    typeof process.env.DESK_REMINDER_DEV_URL === 'string' ? process.env.DESK_REMINDER_DEV_URL.trim() : '';
  if (devUrl) {
    return { kind: 'url', value: `${devUrl.replace(/\/+$/, '')}/panel/index.html` };
  }
  return { kind: 'file', value: PANEL_DIST_HTML };
}

/**
 * preload 只做存在性检查：文件由渲染层同事创建。
 * 缺失时返回 undefined（窗口照开、不崩），并给一条能定位问题的日志；
 * 这里刻意不生成任何占位文件——renderer/ 目录不归框架层管。
 */
function resolvePanelPreload() {
  try {
    if (fs.existsSync(PANEL_PRELOAD)) return PANEL_PRELOAD;
  } catch (_e) {
    /* 读不到就按缺失处理 */
  }
  logWarn(`未找到面板 preload：${PANEL_PRELOAD}（面板仍可打开，但拿不到 IPC 桥；等该文件落地即可）`);
  return undefined;
}

/** 建一个面板窗口（不显示，等 ready-to-show） */
function createPanelWindow() {
  const entry = resolvePanelEntry();
  const preload = resolvePanelPreload();

  const win = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 620,
    minHeight: 540,
    show: false,
    // 自定义标题栏：去掉系统边框，标题栏交给渲染层画（见 renderer/panel 的 .titlebar）
    frame: false,
    titleBarStyle: 'hidden',
    title: `${appTitle} · 设置`,
    icon: resolveAppIcon(),
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.setMenuBarVisibility(false);

  const loading = entry.kind === 'url' ? win.loadURL(entry.value) : win.loadFile(entry.value);
  if (loading && typeof loading.catch === 'function') {
    loading.catch((e) =>
      logWarn(
        `设置面板页面加载失败（${entry.kind === 'url' ? entry.value : 'dist-renderer/panel/index.html 可能还没构建'}）：${
          e && e.message
        }`
      )
    );
  }

  win.once('ready-to-show', () => {
    win.show();
  });
  win.webContents.on('did-finish-load', () => {
    // 面板就绪后补推一次设置，避免错过首次广播
    if (typeof onPanelLoaded === 'function') {
      try {
        onPanelLoaded();
      } catch (e) {
        logWarn(`面板就绪回调失败：${e && e.message}`);
      }
    }
  });
  // 面板里的外部链接交给系统浏览器，不把窗口导航走。
  // 允许留在「自己这一份页面」里：生产是 file://，开发是同一个 dev server 源
  // （dev 模式下整页刷新也会触发 will-navigate，不能拦掉）。
  const ownOrigin = entry.kind === 'url' ? entry.value.replace(/\/panel\/index\.html$/, '') : '';
  win.webContents.on('will-navigate', (e, url) => {
    const isOwnPage = url.startsWith('file://') || (ownOrigin && url.startsWith(ownOrigin));
    if (!isOwnPage) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.on('closed', () => {
    state.panel = null;
  });

  return win;
}

/** 打开（或复用）设置面板窗口 */
function openPanel() {
  const existing = state.panel;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  state.panel = createPanelWindow();
  return state.panel;
}

/** 当前面板窗口（可能为 null） */
function getPanelWindow() {
  const win = state.panel;
  return win && !win.isDestroyed() ? win : null;
}

/**
 * 主 → 渲染广播：面板不在就静默跳过，发送失败只记日志。
 * @returns {boolean} 是否真的发出去了
 */
function broadcast(channel, payload) {
  const win = getPanelWindow();
  if (!win) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (e) {
    logWarn(`广播 ${channel} 失败：${e && e.message}`);
    return false;
  }
}

module.exports = {
  init,
  openPanel,
  getPanelWindow,
  broadcast,
  // 下面两个给排障与自检用
  resolvePanelEntry,
  resolvePanelPreload,
  get state() {
    return state;
  }
};
