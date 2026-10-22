// 全部 ipcMain 通道注册。框架层在这里只做搬运：
// 参数清洗 → 调 engine / desktop / subscriptions 的公开方法 → 回结构，不自己算时间、不碰屏幕。
'use strict';

const { ipcMain } = require('electron');

const engine = require('../engine');
const store = require('../engine/store');
const desktop = require('../desktop');
const subscriptions = require('../subscriptions');

const windows = require('./windows');

const log = (...args) => console.log('[提醒]', ...args);
const logWarn = (...args) => console.warn('[提醒]', ...args);
const logError = (...args) => console.error('[提醒]', ...args);

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 别名通道：渲染层可能按规范第 7 节写法调 subscriptions:install / subscriptions:sync / gh:request，
 * 而契约表（第 6 节 + 任务补充）是 subscription:install / subscription:sync / ipc:gh:request。
 * 两种名字都接上、转到同一个处理函数，避免两边对不上静默失败。
 */
const CHANNEL_ALIASES = {
  'subscriptions:install': 'subscription:install',
  'subscriptions:sync': 'subscription:sync',
  'gh:request': 'ipc:gh:request'
};

/** 收集已注册的 handler，供别名通道转发 */
const handlerTable = new Map();

let registered = false;
let refreshTray = () => {};

/** 注册一个 handler 并登记到表里（供别名转发复用） */
function handle(channel, fn) {
  handlerTable.set(channel, fn);
  ipcMain.handle(channel, fn);
}

/** 统一异常包装：出错记日志后照原样抛给渲染进程（preload 会把消息洗成中文） */
function guard(name, fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      logError(`IPC ${name} 处理失败：${e && e.stack ? e.stack : e}`);
      throw e;
    }
  };
}

/** 给别名通道装上转发逻辑（等真实 handler 都注册完再装，才能拿到同一个处理函数） */
function installAliases() {
  for (const [alias, target] of Object.entries(CHANNEL_ALIASES)) {
    ipcMain.handle(alias, async (event, payload) => {
      const fn = handlerTable.get(target);
      if (typeof fn !== 'function') {
        logWarn(`别名通道 ${alias} 找不到目标 ${target}`);
        return { ok: false, error: `通道 ${target} 未注册` };
      }
      return fn(event, payload);
    });
  }
}

/* ------------------------------------------------------------------ *
 * 主 → 渲染广播
 * ------------------------------------------------------------------ */

/** 广播设置给面板（面板不在就静默跳过） */
function broadcastSettings() {
  return windows.broadcast('settings:changed', engine.state.settings || store.DEFAULT_SETTINGS);
}

/** 广播动作包变化（面板若监听就刷新；没监听也不报错） */
function broadcastPacks() {
  return windows.broadcast('packs:changed', engine.packsList());
}

/* ------------------------------------------------------------------ *
 * 面板要的全量状态
 * ------------------------------------------------------------------ */

/** 执行方式清单：只给面板展示用（谁被选中由驱动桌面决定） */
function executorSummary() {
  try {
    return desktop.registry.list();
  } catch (e) {
    logWarn(`读取执行方式清单失败：${e && e.message}`);
    return [];
  }
}

/** state:get 的返回：引擎组装业务数据，框架层补上「有哪些呈现方式」 */
function buildState() {
  const base = engine.buildState();
  return { ...base, executors: executorSummary() };
}

/* ------------------------------------------------------------------ *
 * 通道注册
 * ------------------------------------------------------------------ */

/**
 * 注册全部通道（只允许调用一次）。
 * @param {{refreshTray?:Function}} [options]
 */
function register(options) {
  if (registered) {
    logWarn('IPC 通道已经注册过，跳过重复注册');
    return;
  }
  registered = true;

  const opts = options || {};
  refreshTray = typeof opts.refreshTray === 'function' ? opts.refreshTray : () => {};

  // 面板 → 主：一次性拿全量状态
  handle(
    'state:get',
    guard('state:get', () => buildState())
  );

  // 面板 → 主：部分 settings，返回完整 settings
  handle(
    'settings:set',
    guard('settings:set', (_event, patch) => {
      const safePatch = isObj(patch) ? patch : {};
      // 落盘 + 重排定时器都由引擎负责
      const settings = engine.applySettings(safePatch);
      // 原文：改动里带 enabled 就解除暂停（面板的总开关要立刻生效）
      if (Object.prototype.hasOwnProperty.call(safePatch, 'enabled') && engine.isPaused()) {
        engine.togglePause();
      }
      log(`设置已更新：${Object.keys(safePatch).join('、') || '（空）'}`);
      broadcastSettings();
      refreshTray();
      // 正在显示的提醒条也要立刻跟着变（改样式不用等下一次提醒）
      try {
        desktop.applyAppearance(engine.state.settings || settings);
      } catch (e) {
        log(`推送外观到提醒条失败：${e && e.message}`);
      }
      return engine.state.settings || settings;
    })
  );

  // 面板 → 主：预览下一条（不推进游标、不弹窗）
  handle(
    'scheduler:next',
    guard('scheduler:next', () => engine.peekNext())
  );

  // 面板 → 主：立刻弹一次（试看），返回驱动桌面实际的呈现结果
  handle(
    'scheduler:fire',
    guard('scheduler:fire', () => {
      const fired = engine.fire('panel');
      return fired || { move: null, path: [] };
    })
  );

  // 面板 → 主：动作包列表（轻量摘要，不含 categories）
  handle(
    'packs:list',
    guard('packs:list', () => engine.packsList())
  );

  // 面板 → 主：开关某个动作包，返回最新列表
  handle(
    'packs:toggle',
    guard('packs:toggle', (_event, payload) => {
      const data = isObj(payload) ? payload : {};
      const id = typeof data.id === 'string' ? data.id.trim() : '';
      if (!id) return engine.packsList();

      const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined;
      // 「空数组 = 不过滤」到显式白名单的换算是引擎的事
      const list = engine.togglePack(id, enabled);
      const active = Array.isArray(engine.state.settings && engine.state.settings.activePackIds)
        ? engine.state.settings.activePackIds
        : [];
      log(`动作包「${id}」→ ${active.includes(id) ? '启用' : '停用'}，当前启用 ${active.length} 个`);
      broadcastSettings();
      broadcastPacks();
      return list;
    })
  );

  // 面板 → 主：订阅状态
  handle(
    'subscription:status',
    guard('subscription:status', () => {
      const meta = store.getSubscriptionMeta();
      return {
        sources: store.listSubscriptionSources(),
        lastSyncAt: meta.lastSyncAt,
        lastSyncError: meta.lastSyncError
      };
    })
  );

  // 面板 → 主：GitHub 请求代理（渲染进程直连会撞 CORS）
  handle(
    'ipc:gh:request',
    guard('ipc:gh:request', async (_event, payload) => {
      const url = isObj(payload) ? payload.url : payload;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
        return { ok: false, status: 0, body: '', error: `网址不合法：${String(url)}` };
      }
      const res = await subscriptions.ghFetchText(url.trim());
      if (!res.ok) logWarn(`GitHub 请求失败（${url}）：${res.error}`);
      return {
        ok: res.ok === true,
        status: res.status || 0,
        body: typeof res.text === 'string' ? res.text : '',
        error: res.ok ? null : res.error || '未知错误'
      };
    })
  );

  // 面板 → 主：安装订阅（落盘、重建索引、新包默认启用）
  handle(
    'subscription:install',
    guard('subscription:install', async (_event, payload) => {
      const data = isObj(payload) ? payload : {};
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
      const source = typeof data.source === 'string' ? data.source.trim() : '';
      const packs = Array.isArray(data.packs) ? data.packs : null;
      if (!name) return { ok: false, error: '缺少订阅名 name' };
      if (!packs || packs.length === 0) return { ok: false, error: 'packs 为空，未安装（已有动作保持不变）' };

      const installed = store.installSubscription(name, packs);
      if (!installed.ok) {
        logWarn(`订阅安装失败（${name}）：${installed.error}`);
        return { ok: false, error: installed.error };
      }

      store.upsertSubscriptionSource({
        name,
        source,
        dir: installed.dir,
        packs: installed.packs.map((p) => p.id)
      });

      const newIds = installed.packs.map((p) => p.id);
      // 重建索引 + 把新包追加进 activePackIds + 重排定时器，全在引擎里完成
      engine.afterSubscriptionChange(newIds);
      const actionCount = engine.state.index.length;
      const packCount = engine.state.packs.length;

      log(`订阅「${name}」安装完成：${installed.packs.length} 个包，当前共 ${actionCount} 条动作`);
      broadcastSettings();
      broadcastPacks();
      refreshTray();
      return {
        ok: true,
        name,
        dir: installed.dir,
        packs: newIds,
        // 动作包来自哪个分支：与原实现一致，取写入结果上的 branch（installSubscription 只回 {id,file}）
        branch: installed.packs.map((p) => p.branch).find((b) => typeof b === 'string' && b) || '',
        actionCount,
        packCount
      };
    })
  );

  // 面板 → 主：重新拉取某个订阅源（source 为空 = 同步全部）
  handle(
    'subscription:sync',
    guard('subscription:sync', async (_event, payload) => {
      let source = isObj(payload) ? payload.source : payload;
      if (typeof source !== 'string') source = '';
      source = source.trim();

      if (!source) {
        const list = store.listSubscriptionSources().filter((s) => typeof s.source === 'string' && s.source);
        if (list.length === 0) return { ok: false, error: '还没有可同步的订阅源' };
        const results = [];
        for (const s of list) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await subscriptions.syncSource(s.source));
        }
        // 同原文：全部同步只重建索引 + 重排定时器，不自动把新包塞进启用列表
        engine.afterSubscriptionChange([]);
        broadcastSettings();
        broadcastPacks();
        const failed = results.filter((r) => !r.ok);
        return {
          ok: failed.length === 0,
          results,
          packCount: results.reduce((n, r) => n + (r.packCount || 0), 0),
          error: failed.length ? failed.map((r) => r.error).join('；') : null
        };
      }

      const result = await subscriptions.syncSource(source);
      // 同步成功后新包进入启用列表，保证拉下来就能被抽到；失败时保持已有动作不变
      const newIds =
        result && result.ok && Array.isArray(result.packs)
          ? result.packs.map((p) => p && p.id).filter((id) => typeof id === 'string' && id)
          : [];
      engine.afterSubscriptionChange(newIds);
      if (!result || !result.ok) {
        logWarn(`订阅同步失败（${source}）：${(result && result.error) || '未知错误'}；已有动作保持不变`);
      }
      broadcastSettings();
      broadcastPacks();
      return result;
    })
  );

  // 真实 handler 全部就位后再挂别名通道
  installAliases();

  // 提醒窗 → 主：倒计时播完，收起窗口（常驻窗口，不销毁）
  ipcMain.on('popup:done', () => {
    desktop.hide();
  });

  // 提醒窗 → 主：页面就绪，把还没发出去的载荷补发一次（只认提醒窗自己发来的）
  ipcMain.on('popup:ready', (event) => {
    const win = desktop.state && desktop.state.win;
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    desktop.markReady();
  });

  // 提醒窗 → 主：量完真实内容尺寸，交给驱动桌面重排（自适应宽度 + 换行后自动变高）
  ipcMain.on('popup:resize', (event, size) => {
    const win = desktop.state && desktop.state.win;
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    desktop.resizeTo(size);
  });

  // 面板自定义标题栏 → 主：最小化 / 最大化切换 / 关闭 / 查询最大化状态
  // 无边框窗口必须靠这几个通道，否则用户没法关窗口。
  const panelWindowOf = (event) => {
    const win = windows.getPanelWindow();
    if (!win || win.isDestroyed()) return null;
    if (event.sender !== win.webContents) return null;
    return win;
  };

  ipcMain.handle(
    'window:minimize',
    guard('window:minimize', (event) => {
      const win = panelWindowOf(event);
      if (!win) return false;
      win.minimize();
      return true;
    })
  );

  ipcMain.handle(
    'window:toggleMaximize',
    guard('window:toggleMaximize', (event) => {
      const win = panelWindowOf(event);
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    })
  );

  ipcMain.handle(
    'window:close',
    guard('window:close', (event) => {
      const win = panelWindowOf(event);
      if (!win) return false;
      win.close();
      return true;
    })
  );

  ipcMain.handle(
    'window:isMaximized',
    guard('window:isMaximized', (event) => {
      const win = panelWindowOf(event);
      return win ? win.isMaximized() : false;
    })
  );
}

module.exports = {
  register,
  broadcastSettings,
  broadcastPacks,
  buildState,
  // 通道清单：给文档/自检核对用
  CHANNELS: [
    'state:get',
    'settings:set',
    'scheduler:next',
    'scheduler:fire',
    'packs:list',
    'packs:toggle',
    'subscription:status',
    'ipc:gh:request',
    'subscription:install',
    'subscription:sync',
    'popup:done',
    'popup:ready'
  ],
  CHANNEL_ALIASES
};
