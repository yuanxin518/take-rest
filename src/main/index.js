// 主进程入口（框架层）：单实例锁、数据目录、app 生命周期，以及把窗口 / 托盘 / IPC 串起来。
// 边界：不算时间（engine 的事）、不决定出现在屏幕哪里（desktop 的事）。
// 本文件只做「宿主 + 接线」：谁先起来、谁调谁、状态变了通知谁。
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const engine = require('../engine');
const store = require('../engine/store');
const desktop = require('../desktop');
const executors = require('../executors');
const subscriptions = require('../subscriptions');

const windows = require('./windows');
const tray = require('./tray');
const ipc = require('./ipc');

const log = (...args) => console.log('[提醒]', ...args);
const logWarn = (...args) => console.warn('[提醒]', ...args);
const logError = (...args) => console.error('[提醒]', ...args);

/** 规范 7.3：每 6 小时自动同步一次订阅 */
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动 30 秒后先跑一次同步（不阻塞首屏） */
const FIRST_SYNC_DELAY_MS = 30 * 1000;

/** 界面上显示的产品名：取 package.json 的 productName / name，不写死 */
const APP_TITLE = (() => {
  try {
    const pkg = require('../../package.json');
    return (pkg && (pkg.productName || pkg.name)) || 'Take rest';
  } catch (_e) {
    return 'Take rest';
  }
})();

let syncTimer = null;
/** 自动同步的并发保护（一次同步没跑完不叠第二次） */
let syncing = false;

/* ------------------------------------------------------------------ *
 * 运行时只读视图（给托盘和调试用，不对外暴露可变状态）
 * ------------------------------------------------------------------ */

function engineRuntime() {
  const s = engine.state;
  return {
    settings: s.settings,
    packs: s.packs,
    index: s.index,
    nextFireAt: s.nextFireAt,
    paused: s.paused
  };
}

/* ------------------------------------------------------------------ *
 * 托盘动作
 * ------------------------------------------------------------------ */

/** 托盘「暂停 / 恢复」：暂停时把正在显示的提醒收掉，并让面板的开关看起来一致 */
function handleTogglePause() {
  const paused = engine.togglePause();
  log(paused ? '用户从托盘暂停了提醒' : '用户从托盘恢复了提醒');
  if (paused) desktop.hide();
  ipc.broadcastSettings();
  return paused;
}

/* ------------------------------------------------------------------ *
 * 订阅自动同步
 * ------------------------------------------------------------------ */

async function runAutoSync() {
  if (syncing) return;
  const sources = store.listSubscriptionSources().filter((s) => typeof s.source === 'string' && s.source);
  if (sources.length === 0) return;

  syncing = true;
  log(`开始自动同步 ${sources.length} 个订阅源`);
  try {
    const results = await subscriptions.syncAll();
    const newIds = [];
    for (const r of results || []) {
      if (!r || !r.ok) {
        logWarn(`订阅源 ${(r && r.source) || '未知'} 同步失败：${(r && r.error) || '未知错误'}（保留旧缓存）`);
        continue;
      }
      for (const p of r.packs || []) {
        const id = p && p.id;
        if (typeof id === 'string' && id && !newIds.includes(id)) newIds.push(id);
      }
    }
    // 重建索引 + 这次同步下来的包并入启用列表 + 重排定时器，统一交给引擎
    engine.afterSubscriptionChange(newIds);
    ipc.broadcastPacks();
  } catch (e) {
    logWarn(`自动同步异常：${e && e.message}`);
  } finally {
    syncing = false;
  }
}

function startSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    runAutoSync().catch((e) => logWarn(`自动同步任务异常：${e && e.message}`));
  }, SYNC_INTERVAL_MS);
  setTimeout(() => {
    runAutoSync().catch(() => {});
  }, FIRST_SYNC_DELAY_MS);
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function quitApp() {
  try {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    engine.stop();
  } catch (_e) {
    /* 忽略 */
  }
  tray.destroy();
  app.quit();
}

function bootstrap() {
  // 数据目录统一叫 <appData>\<package.json name>（= take-rest），路径一律推导。
  //
  // 两个坑：
  //   1) Electron 在 ready 之前就按 productName 建好了 userData（比如「休息一下 Take rest」），
  //      所以不能直接信任 app.getPath('userData')；
  //   2) 改名后老目录（desk-reminder / 站立提醒）里还有用户数据，要先迁移再定 userData。
  let dataRoot = '';
  try {
    const appData = process.env.APPDATA || app.getPath('appData');
    const early = path.join(appData, String(APP_TITLE));
    const target = path.join(appData, store.paths.appDataFolderName());

    // 先把 Electron 预建的那个目录清掉，store 里的迁移逻辑才能落到正确目标。
    // 只删 Chromium 自动生成的东西（Local State / Cache 等）；一旦发现我们有意义的
    // 数据文件（settings.json / packs / subscriptions），说明是用户在用的，就原样保留。
    if (early !== target) {
      const CHROMIUM_ONLY = new Set(['Local State', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Session Storage', 'Local Storage', 'Network', 'blob_storage', 'Shared Dictionary', 'Preferences', 'SingletonCookie', 'SingletonLock', 'SingletonSocket', 'Crashpad']);
      const entries = fs.existsSync(early) ? fs.readdirSync(early) : [];
      const looksAutoCreated = entries.every((n) => CHROMIUM_ONLY.has(n));
      if (entries.length === 0 || looksAutoCreated) {
        fs.rmSync(early, { recursive: true, force: true });
        log(`清理 Electron 预建的目录（只有 Chromium 自动生成的文件）：${early}`);
      } else {
        logWarn(`保留目录 ${early}：里面有用户数据，未做清理`);
      }
    }

    // store 现在会把 <appData>\<name> 定下来，并顺带迁移老目录
    store.pinUserDataDir(false);
    dataRoot = store.paths.root();
    store.pinUserDataDir(true);
    app.setPath('userData', dataRoot);
  } catch (e) {
    logWarn(`设置 userData 目录失败：${e && e.message}`);
  }
  log(`数据目录：${dataRoot || store.paths.root()}`);

  if (!app.isPackaged) {
    // 开发期方便看日志
    app.commandLine.appendSwitch('disable-http-cache');
  }

  // 1. 窗口模块：面板入口（dev / 生产两套加载路径）与页面就绪后的补推
  windows.init({
    title: APP_TITLE,
    onPanelLoaded: () => ipc.broadcastSettings()
  });

  // 2. 托盘：先建出来，引擎一启动就会通过 onChange 把菜单刷成真实状态
  tray.init({
    appTitle: APP_TITLE,
    openPanel: () => windows.openPanel(),
    fireNow: () => engine.fire('tray'),
    togglePause: () => handleTogglePause(),
    quit: () => quitApp(),
    getRuntime: () => engineRuntime()
  });
  tray.create();

  // 3. IPC：面板一打开就能拿到全部通道
  ipc.register({ refreshTray: () => tray.refresh() });

  // 4. 呈现层：只把执行方式清单交出去，注册表与几何都在驱动桌面里
  desktop.init(executors.list());

  // 5. 引擎：该呈现时交给驱动桌面、状态变了刷新托盘、执行方式清单问驱动桌面
  engine.init({
    onFire: (picked, settings, meta) => desktop.dispatch(picked, settings, meta),
    onChange: () => tray.refresh(),
    onListExecutors: () => desktop.registry.list()
  });
  engine.start();

  // 上一次订阅同步失败只影响那一次展示；启动后第一次成功同步（或本次启动无订阅）会把它清掉
  try {
    const meta = store.getSubscriptionMeta();
    if (meta.lastSyncError && store.listSubscriptionSources().filter((s) => s.source).length === 0) {
      store.recordSync({ ok: true, at: meta.lastSyncAt || new Date().toISOString() });
      log('已清理上次遗留的订阅同步错误提示');
    }
  } catch (e) {
    logWarn(`清理订阅同步错误提示失败：${e && e.message}`);
  }

  // 6. 启动就把设置面板开出来（没有任何动作包时用户也能立刻去设置）
  windows.openPanel();

  // 7. 订阅自动同步
  startSyncTimer();

  log(`${APP_TITLE} 已启动`);
}

/* ------------------------------------------------------------------ *
 * 单实例锁 + app 事件
 * ------------------------------------------------------------------ */

// 先把应用名定成 package.json 的 name（take-rest）。
// 不设的话 Electron 会用 productName（「休息一下 Take rest」）去建 userData 目录，
// 中文+空格既不合规范也会产生一个多余目录。必须在 requestSingleInstanceLock 之前设。
try {
  const pkgForName = require('../../package.json');
  if (pkgForName && typeof pkgForName.name === 'string' && pkgForName.name.trim()) {
    app.setName(pkgForName.name.trim());
  }
} catch (_e) {
  /* 读不到就用默认 */
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('已经有一个实例在跑，本次启动退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('检测到第二次启动，打开设置面板');
    windows.openPanel();
  });

  app.disableHardwareAcceleration();
  app.setAppUserModelId('com.gongwei.tixing');

  app.whenReady().then(() => {
    try {
      bootstrap();
    } catch (e) {
      logError(`启动失败：${e && e.stack ? e.stack : e}`);
      // 启动异常也不要留下半死进程
      setTimeout(() => app.exit(1), 50);
    }
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不因为关掉面板就退出（Windows 上必须显式什么都不做）
  });

  app.on('before-quit', () => {
    try {
      if (syncTimer) clearInterval(syncTimer);
      engine.stop();
    } catch (_e) {
      /* 忽略 */
    }
  });

  app.on('activate', () => windows.openPanel());
}

/* ------------------------------------------------------------------ *
 * 对外（调试 / 自检脚本用）
 * ------------------------------------------------------------------ */

/** 立刻呈现一条（相当于原 firePopup，source 只用于日志） */
function firePopup(opts) {
  const source = (opts && opts.source) || 'timer';
  return engine.fire(source);
}

// 暴露给调试控制台（--inspect 时可用）
global.__提醒 = {
  engine,
  desktop,
  fire: firePopup,
  openPanel: () => windows.openPanel(),
  reloadPacks: () => engine.reloadPacks(),
  get runtime() {
    return engineRuntime();
  }
};

module.exports = {
  firePopup,
  hidePopup: () => desktop.hide(),
  openPanel: () => windows.openPanel(),
  buildState: ipc.buildState,
  engine,
  desktop,
  get runtime() {
    return {
      ...engineRuntime(),
      panel: windows.getPanelWindow(),
      tray: tray.getTray()
    };
  }
};
