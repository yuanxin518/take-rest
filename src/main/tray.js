// 托盘：图标来自 assets/icons（由 make-icon.py 生成），找不到时退回内存绘制＋ 右键菜单。
// 边界：菜单只调用注入进来的动作（打开面板 / 立刻提醒 / 暂停 / 退出），
//       时间和「下一次几点」一律读引擎给出的只读视图，这里自己不算时间。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Menu, Tray, nativeImage, shell } = require('electron');

const store = require('../engine/store');

const log = (...args) => console.log('[提醒]', ...args);
const logError = (...args) => console.error('[提醒]', ...args);

/** 托盘实例（创建失败时为 null，一切调用都要容错） */
let tray = null;
let appTitle = 'Take rest';

/**
 * 注入进来的外部动作。框架层不认识引擎，只认识这几个回调名。
 * getRuntime() 需要返回 { settings, paused, nextFireAt }：只读，不在这里改任何状态。
 */
const handlers = {
  openPanel: () => {},
  fireNow: () => {},
  togglePause: () => {},
  quit: () => {},
  getRuntime: () => ({ settings: null, paused: false, nextFireAt: null })
};

/**
 * 初始化托盘的依赖。
 * @param {{appTitle?:string, openPanel?:Function, fireNow?:Function,
 *          togglePause?:Function, quit?:Function, getRuntime?:Function}} [options]
 */
function init(options) {
  const opts = options || {};
  if (typeof opts.appTitle === 'string' && opts.appTitle.trim()) appTitle = opts.appTitle.trim();
  for (const key of Object.keys(handlers)) {
    if (typeof opts[key] === 'function') handlers[key] = opts[key];
  }
}

function formatClock(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 托盘图标：优先用 assets 里生成好的多尺寸 PNG，找不到再退回内存绘制的圆点。
 * 这样换图标只需要重新跑 scripts/make-icon.py，不用改代码。
 */
function buildTrayIcon() {
  const ROOT = path.join(__dirname, '..', '..');
  // 托盘在不同 DPI 下想要不同像素：优先 32（Windows 100%~200% 都清晰）
  for (const size of [32, 16, 48]) {
    const p = path.join(ROOT, 'assets', 'icons', `${size}x${size}.png`);
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch (_e) {
      /* 继续找下一个尺寸 */
    }
  }
  return drawFallbackIcon();
}

/** 内存里画一个 16x16 的圆形托盘图标（深色圆底 + 绿色圆点），不依赖外部图片文件 */
function drawFallbackIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outerR = 7.5;
  const innerR = 3.2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;

      // 抗锯齿：距离边缘 1px 内做线性过渡
      const outerA = dist <= outerR - 0.5 ? 1 : dist >= outerR + 0.5 ? 0 : outerR + 0.5 - dist;
      const innerA = dist <= innerR - 0.5 ? 1 : dist >= innerR + 0.5 ? 0 : innerR + 0.5 - dist;

      // 底色深灰蓝（非预乘 alpha，Electron 需要非预乘 BGRA）
      let r = 24;
      let g = 26;
      let b = 32;
      let a = outerA;

      // 绿色圆点（#4ade80）覆盖在中间
      if (innerA > 0) {
        r = Math.round(r * (1 - innerA) + 74 * innerA);
        g = Math.round(g * (1 - innerA) + 222 * innerA);
        b = Math.round(b * (1 - innerA) + 128 * innerA);
        a = Math.max(a, innerA);
      }

      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(a * 255);
    }
  }

  const image = nativeImage.createFromBuffer(buf, { width: size, height: size });
  if (image.isEmpty()) {
    // 极端兜底：1x1 的绿色像素，至少托盘不会挂
    return nativeImage.createFromBuffer(Buffer.from([128, 222, 74, 255]), { width: 1, height: 1 });
  }
  return image;
}

/** 建托盘图标并挂上双击 / 单击行为 */
function create() {
  if (tray) return tray;

  const icon = buildTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (e) {
    logError(`托盘创建失败：${e && e.message}`);
    tray = null;
    return null;
  }

  tray.setToolTip(appTitle);
  refresh();
  tray.on('double-click', () => handlers.openPanel());
  tray.on('click', () => {
    // 单击不弹菜单时给个即时反馈（Windows 上菜单会在右键/isContextMenu 时弹出）
    if (process.platform !== 'win32') handlers.openPanel();
  });
  log('托盘图标已创建');
  return tray;
}

/** 按当前状态重建右键菜单（状态变化时由框架层回调） */
function refresh() {
  if (!tray) return;

  const view = handlers.getRuntime() || {};
  const settings = view.settings || store.DEFAULT_SETTINGS;
  const paused = view.paused === true;
  const running = !!settings.enabled && !paused;
  const next = view.nextFireAt ? formatClock(view.nextFireAt) : '–';

  const menu = Menu.buildFromTemplate([
    {
      label: `悬挂中 · 下一次 ${next}（每 ${settings.intervalMin} 分钟）`,
      enabled: false
    },
    { type: 'separator' },
    { label: '显示设置', click: () => handlers.openPanel() },
    { label: '立刻提醒一次', click: () => handlers.fireNow() },
    {
      label: paused ? '恢复提醒' : '暂停',
      type: 'checkbox',
      checked: paused,
      click: () => handlers.togglePause()
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(store.paths.root()).catch(() => {}) },
    { label: '退出', click: () => handlers.quit() }
  ]);

  try {
    tray.setContextMenu(menu);
    tray.setToolTip(`${appTitle} · ${running ? `下一次 ${next}` : '已暂停'}`);
  } catch (e) {
    logError(`刷新托盘菜单失败：${e && e.message}`);
  }
}

function getTray() {
  return tray;
}

/** 退出前销毁托盘，避免退出时图标残留 */
function destroy() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (_e) {
    /* 忽略 */
  }
  tray = null;
}

module.exports = {
  init,
  create,
  refresh,
  destroy,
  getTray,
  // 给排障与自检用
  buildTrayIcon
};
