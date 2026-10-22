/**
 * preload.cjs —— 提醒窗的最小事件桥（contextIsolation: true）
 *
 * 路径写死在 src/desktop/index.js 里：renderer/popup/preload.cjs，改这两处要一起改。
 * 用 .cjs 扩展名是因为 package.json 里是 "type": "commonjs"，而 preload 必须能被 Electron 以 CJS 加载；
 * 渲染层的 .jsx / .js 是 ESM，两者互不干扰。
 *
 * 只暴露三个方法，不给渲染进程任何 Node 能力：
 *   onRender(cb)     订阅主进程的 'executor:render'，收到一次载荷就回调一次；返回取消订阅函数
 *   notifyDone()     倒计时归零时通知主进程收起窗口（'popup:done'）
 *   reportSize(size) 把量到的真实内容宽高告诉主进程，由驱动桌面重排（'popup:resize'）
 *
 * 约定：拿不到 IPC 能力时（比如页面被直接用浏览器打开）一律安静降级，不抛错。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('executorBridge', {
  /**
   * 订阅一次提醒载荷。
   * @param {(payload: object) => void} cb 收到驱动桌面发来的 payload 时调用
   * @returns {() => void} 取消订阅函数（重复调用安全）
   */
  onRender(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        cb(payload);
      } catch (err) {
        // 渲染层自己的异常不能把主进程的发送链拖坏
        console.error('[提醒窗] 渲染回调出错', err);
      }
    };
    ipcRenderer.on('executor:render', listener);
    return () => {
      try {
        ipcRenderer.removeListener('executor:render', listener);
      } catch (_e) {
        /* 忽略 */
      }
    };
  },

  /** 倒计时结束：请主进程收起提醒窗 */
  notifyDone() {
    try {
      ipcRenderer.send('popup:done');
    } catch (_e) {
      /* 主进程窗口可能已销毁，忽略 */
    }
  },

  /**
   * 订阅外观补丁（'executor:patch'）。
   * 用户在「样式」里改字号 / 颜色 / 透明度 / 对齐时，主进程把新的 look 推过来，
   * 提醒条不用等下一次提醒就能立刻变样。
   * @param {(patch: object) => void} cb
   * @returns {() => void} 取消订阅函数
   */
  onPatch(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, patch) => {
      try {
        cb(patch);
      } catch (err) {
        console.error('[提醒窗] 外观补丁回调出错', err);
      }
    };
    ipcRenderer.on('executor:patch', listener);
    return () => {
      try {
        ipcRenderer.removeListener('executor:patch', listener);
      } catch (_e) {
        /* 忽略 */
      }
    };
  },

  /**
   * 上报真实内容尺寸（自适应宽度模式用）。
   * @param {{width:number, height:number}} size
   */
  reportSize(size) {
    if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') return;
    try {
      ipcRenderer.send('popup:resize', {
        width: Math.ceil(size.width),
        height: Math.ceil(size.height)
      });
    } catch (_e) {
      /* 忽略 */
    }
  }
});
