/**
 * preload.cjs —— 设置面板的安全桥（contextIsolation: true）
 *
 * 契约来源：docs/架构与数据规范.md 第 6 节 IPC 契约、第 7 节「统一走主进程发 HTTPS 请求」。
 * 通道名字符串与规范保持一致：
 *   state:get / settings:set / scheduler:next / scheduler:fire
 *   packs:list / packs:toggle / subscription:status / gh:request
 *   订阅安装与同步：subscriptions:install / subscriptions:sync
 * 广播：settings:changed / packs:changed
 *
 * 这里只做「方法 ←→ 通道」的搬运，不放任何业务逻辑。
 * 注意：本文件不经 Vite 打包，由 Electron 直接 require，所以必须是 CommonJS。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 统一的 invoke 包装：主进程抛错时把消息规范化，保证渲染层能直接显示中文 */
async function invoke(channel, payload) {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    // Electron 会把主进程的异常包一层 "Error invoking remote method 'xxx': "，里面才是中文原因
    const cleaned = message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
    const e = new Error(cleaned || '与主进程通信失败');
    e.channel = channel;
    throw e;
  }
}

/** 统一的广播订阅：返回取消函数，回调抛错只打日志不影响通道 */
function subscribe(channel, cb, tag) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[panel] ${tag} 回调出错`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  /* ---- 状态与设置 ---- */
  /** @returns {Promise<{settings:object, packs:Array, actionCount:number, nextFireAt:number|string|null, paused:boolean}>} */
  getState: () => invoke('state:get'),

  /** @param {object} partial 部分 settings，返回完整 settings */
  setSettings: (partial) => invoke('settings:set', partial || {}),

  /* ---- 调度 ---- */
  /** @returns {Promise<{move:object, pack:object, path:object|string}|null>} */
  previewNext: () => invoke('scheduler:next'),

  /** 立刻弹一次（试看） */
  fireNow: () => invoke('scheduler:fire'),

  /* ---- 动作包 ---- */
  listPacks: () => invoke('packs:list'),

  togglePack: (id, enabled) => invoke('packs:toggle', { id, enabled: !!enabled }),

  /* ---- 订阅 ---- */
  subscriptionStatus: () => invoke('subscription:status'),

  installSubscription: (payload) => invoke('subscriptions:install', payload || {}),

  syncSubscription: (payload) => invoke('subscriptions:sync', payload || {}),

  /* ---- 网络（绕过渲染进程 CORS，统一走主进程） ---- */
  ghRequest: (req) => invoke('gh:request', req || {}),

  /* ---- 主进程广播 ---- */
  onSettingsChanged: (cb) => subscribe('settings:changed', cb, 'settings:changed'),

  /** 动作包变化（订阅安装/同步、包开关后主进程会广播） */
  onPacksChanged: (cb) => subscribe('packs:changed', cb, 'packs:changed'),

  /* ---- 自定义标题栏：无边框窗口要靠这几个通道才能最小化/关闭 ---- */
  windowMinimize: () => invoke('window:minimize'),
  windowToggleMaximize: () => invoke('window:toggleMaximize'),
  windowClose: () => invoke('window:close'),
  windowIsMaximized: () => invoke('window:isMaximized'),
};

contextBridge.exposeInMainWorld('api', api);
