// 驱动桌面：负责把一次提醒「放到屏幕上的合适位置」并呈现出来。
// 职责边界：挑执行方式 → 算窗口几何 → 创建/定位/显示窗口 → 挂看门狗收起。
// 它不认识具体动作内容，也不认识某个执行方式的细节，全部通过 registry 与 executor 契约交互。
'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const taskbar = require('./taskbar');
const registry = require('./registry');

/** 预告条上显示的产品名：取 package.json 的 productName / name，不写死 */
const APP_TITLE = (() => {
  try {
    const pkg = require('../../package.json');
    return (pkg && (pkg.productName || pkg.name)) || 'Take rest';
  } catch (_e) {
    return 'Take rest';
  }
})();

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

function logError(...args) {
  try {
    console.error('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

/** 渲染层入口地址：开发期用 dev server，构建后用本地文件 */
function resolveRendererEntry() {
  const devUrl = process.env.DESK_REMINDER_DEV_URL;
  if (devUrl) {
    return { kind: 'url', value: `${devUrl.replace(/\/$/, '')}/popup/index.html` };
  }
  return { kind: 'file', value: path.join(__dirname, '..', '..', 'dist-renderer', 'popup', 'index.html') };
}

/** 模块内状态：只属于「桌面呈现」这件事，不掺业务数据 */
const state = {
  win: null,
  pending: null, // 页面还没就绪时暂存的载荷
  hideTimer: null,
  lastBounds: null,
  layout: null, // 本次呈现的布局诉求（resizeTo 要沿用同一套参数）
  fit: false, // 是否自适应宽度模式
  appearance: null, // 本次呈现用的外观配置（选屏 / 位置 / 宽高限制）
  lastPayload: null, // 本次呈现的完整载荷（外观变化时用它换 look 再推）
  lastContent: null // 渲染层量到的内容尺寸（外观变化时用它重排窗口）
};

function clearHideTimer() {
  if (state.hideTimer) {
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
  }
}

/** 看门狗：无论页面是否正常回报，到点必须收起，避免提醒条糊在桌面上 */
function armHideTimer(seconds) {
  clearHideTimer();
  const ms = Math.max(1, Number(seconds) || 1) * 1000 + 500;
  state.hideTimer = setTimeout(() => {
    log(`提醒到点自动收起（${seconds}s）`);
    hide();
  }, ms);
}

/**
 * 取出用户设置里的外观配置（样式 tab 那些）。
 * 任何字段缺失都回落到 taskbar 模块的默认值，保证几何一定能算出来。
 */
function appearanceOf(settings) {
  const ap = settings && typeof settings.appearance === 'object' && settings.appearance ? settings.appearance : {};
  return {
    screen: ap.screen === 'primary' ? 'primary' : 'cursor',
    position: ['bottom', 'top', 'center'].includes(ap.position) ? ap.position : 'bottom',
    minWidth: isNum(ap.minWidth) ? ap.minWidth : undefined,
    maxWidth: isNum(ap.maxWidth) ? ap.maxWidth : undefined
  };
}

/**
 * 按设置挑显示器：primary = 主屏，cursor = 鼠标所在屏（默认）。
 */
function pickDisplay(screenMode) {
  try {
    if (screenMode === 'primary') return screen.getPrimaryDisplay();
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (e) {
    logWarn(`取显示器失败，退回主屏：${e && e.message}`);
    return screen.getPrimaryDisplay();
  }
}

/**
 * 探测目标屏的任务栏，并算出目标窗口矩形。
 * @param {{mode?:string, height?:number, fit?:boolean}} layout 执行方式给来的尺寸诉求
 * @param {object} [appearance] 用户在「样式」里配的选屏 / 位置 / 宽度
 */
function computeGeometry(layout, appearance) {
  const ap = appearance || appearanceOf(null);
  const display = pickDisplay(ap.screen);
  const detected = taskbar.detectTaskbar(display);
  const fit = !!(layout && layout.fit);
  const screenSize = { width: detected.screen.width, height: detected.screen.height };
  // 自适应宽度：先按「估算内容宽度」摆一帧，真实宽高由渲染层量完回报（resizeTo）
  const bounds = fit
    ? taskbar.computeFitBounds({
        taskbar: detected,
        screenSize,
        contentWidth: isNum(layout.estimateWidth) ? layout.estimateWidth : 0,
        contentHeight: isNum(layout.height) ? layout.height : 44,
        minWidth: ap.minWidth != null ? ap.minWidth : layout.minWidth,
        maxWidth: ap.maxWidth,
        position: ap.position
      })
    : taskbar.computePopupBounds({
        taskbar: detected,
        screenSize,
        mode: (layout && layout.mode) || 'bar',
        position: ap.position
      });
  return { display, detected, bounds, fit };
}

/** 记住上一次的布局诉求，渲染层回报尺寸时沿用同一套参数 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function createWindow() {
  const entry = resolveRendererEntry();
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    acceptFirstMouse: false,
    backgroundColor: '#00000000',
    webPreferences: {
      // 提醒窗只做呈现，不需要 Node 能力；用 preload 暴露一个最小事件桥
      preload: path.join(__dirname, '..', '..', 'renderer', 'popup', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  try {
    win.setAlwaysOnTop(true, 'screen-saver');
  } catch (e) {
    logWarn(`screen-saver 置顶失败，退回 floating：${e && e.message}`);
    try {
      win.setAlwaysOnTop(true, 'floating');
    } catch (e2) {
      logWarn(`floating 置顶也失败：${e2 && e2.message}`);
    }
  }

  // 点击穿透，不抢焦点
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (_e) {
    try {
      win.setIgnoreMouseEvents(true);
    } catch (_e2) {
      /* 忽略 */
    }
  }
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_e) {
    /* 旧系统忽略 */
  }

  if (entry.kind === 'url') {
    win.loadURL(entry.value).catch((e) => logError(`提醒窗加载失败：${e && e.message}`));
  } else {
    win.loadFile(entry.value).catch((e) => logError(`提醒窗加载失败：${e && e.message}`));
  }

  win.webContents.on('did-finish-load', () => {
    win.__pageReady = true;
  });
  win.on('closed', () => {
    state.win = null;
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logWarn(`提醒窗渲染进程退出：${details && details.reason}，将重建窗口`);
    state.win = null;
    try {
      win.destroy();
    } catch (_e2) {
      /* 忽略 */
    }
  });

  return win;
}

function ensureWindow() {
  if (state.win && !state.win.isDestroyed()) return state.win;
  state.win = createWindow();
  return state.win;
}

/**
 * 呈现一次提醒。
 * @param {object} action 引擎抽出的动作（含 move / category / part / level）
 * @param {object} settings 当前设置
 * @param {{source?:string, previewSec?:number}} [meta]
 *        previewSec：正片前的预告秒数（默认 3；传 0 关闭预告）
 * @returns {{executor:string, seconds:number, move:object}|null}
 */
function dispatch(action, settings, meta) {
  const source = (meta && meta.source) || 'timer';
  if (!action || !action.move) {
    logWarn('没有可呈现的动作，本次跳过');
    return null;
  }

  const executor = registry.pick(action);
  if (!executor) {
    logWarn(`没有执行方式能呈现这个动作（${action.move.id}），本次跳过`);
    return null;
  }

  clearHideTimer();

  // 预告秒数：默认 3 秒；「立刻提醒一次」等手动触发传 previewSec:0 直接上正片
  const previewSec = meta && isNum(meta.previewSec)
    ? Math.max(0, Math.min(10, Math.round(meta.previewSec)))
    : 3;

  let layout;
  try {
    layout = executor.measure(action) || { mode: 'bar', height: 44 };
  } catch (e) {
    logWarn(`执行方式 ${executor.type} 的 measure 抛错，退回默认横条：${e && e.message}`);
    layout = { mode: 'bar', height: 44 };
  }

  let seconds;
  try {
    seconds = executor.duration(action, settings) || 30;
  } catch (e) {
    logWarn(`执行方式 ${executor.type} 的 duration 抛错，退回 30 秒：${e && e.message}`);
    seconds = 30;
  }

  // 把「样式」里的选屏 / 位置 / 宽度限制带进几何计算
  const appearance = appearanceOf(settings);
  const { detected, bounds, fit } = computeGeometry(layout, appearance);
  log(
    `呈现动作「${action.move.prompt || action.move.name}」` +
      `（${action.category} / ${action.part} / ${action.level}，执行方式 ${executor.type}，来源 ${source}，停留 ${seconds}s）`
  );
  log(
    `任务栏判定：edge=${detected.edge} thickness=${detected.thickness}` +
      `${detected.fallback ? '（兜底）' : ''}，屏幕=${appearance.screen} 位置=${appearance.position}，` +
      `窗口 x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`
  );

  // 记住这一帧的布局诉求：渲染层量出真实宽高后会回头调 resizeTo()
  state.layout = layout;
  state.fit = fit;
  state.appearance = appearance;

  const win = ensureWindow();
  try {
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (e) {
    logWarn(`设置窗口位置失败：${e && e.message}`);
  }
  state.lastBounds = bounds;

  let payload;
  try {
    payload = executor.payload(action, {
      seconds,
      showCountdown: settings && settings.showCountdown !== false,
      appearance: settings && settings.appearance ? settings.appearance : null
    });
  } catch (e) {
    logWarn(`执行方式 ${executor.type} 的 payload 抛错：${e && e.message}`);
    return null;
  }
  // 布局实情由驱动桌面决定，执行方式不需要自己猜
  payload.vertical = bounds.layout === 'vertical';
  // 本次提醒的身份戳：渲染层靠它区分「新一次提醒」与「只是外观变了」，
  // 后者不该重置倒计时和分段进度。
  payload.startAt = Date.now();

  const send = () => {
    if (!state.win || state.win.isDestroyed()) return;
    try {
      state.win.webContents.send('executor:render', payload);
      state.win.showInactive();
      state.pending = null;
    } catch (e) {
      logWarn(`提醒发送失败：${e && e.message}`);
    }
  };

  /** 预告载荷：项目介绍 + 倒计时，让用户有个「要来了」的心理准备 */
  const noticePayload = () => ({
    type: 'notice',
    title: APP_TITLE,
    intro: '休息一下 · 活动一下身体，马上开始',
    seconds: previewSec,
    showCountdown: true,
    level: action.level || '静音',
    vertical: bounds.layout === 'vertical',
    startAt: Date.now()
  });

  const sendNotice = () => {
    if (!state.win || state.win.isDestroyed()) return;
    try {
      state.win.webContents.send('executor:render', noticePayload());
      state.win.showInactive();
    } catch (e) {
      logWarn(`预告发送失败：${e && e.message}`);
    }
  };

  state.pending = payload;
  // 记住这次的载荷：设置（样式）变化时要拿它换 look 再推给渲染层
  state.lastPayload = payload;

  /**
   * 正片发送（预告结束后调用）。单独拆出来是因为要延迟 previewSec 秒。
   * 发送时刷新 startAt：正片的分段进度从「正片开始」算起，而不是从预告开始。
   */
  const sendMain = () => {
    if (!state.win || state.win.isDestroyed()) return;
    try {
      payload.startAt = Date.now();
      state.win.webContents.send('executor:render', payload);
      state.win.showInactive();
      state.pending = null;
    } catch (e) {
      logWarn(`提醒发送失败：${e && e.message}`);
    }
  };

  if (win.__pageReady === true) {
    if (previewSec > 0) {
      // 先预告，倒计时走完再上正片；预告期间窗口保持置顶显示
      sendNotice();
      setTimeout(() => {
        if (state.pending) sendMain();
      }, previewSec * 1000);
    } else {
      send();
    }
  } else {
    win.webContents.once('did-finish-load', () => {
      if (state.pending) {
        if (previewSec > 0) {
          sendNotice();
          setTimeout(() => {
            if (state.pending) sendMain();
          }, previewSec * 1000);
        } else {
          send();
        }
      }
    });
    // 页面迟迟没加载完也不能让这次提醒丢掉
    setTimeout(() => {
      if (state.pending) send();
    }, 1500);
  }

  // 看门狗要覆盖「预告 + 正片」两段，避免预告期卡住导致整条提醒永远糊在屏幕上
  armHideTimer(seconds + previewSec);

  // 个别显卡驱动下 showInactive 可能不生效，3 秒后仍不可见就补一次
  setTimeout(() => {
    if (!state.win || state.win.isDestroyed()) return;
    if (state.win.isVisible()) return;
    try {
      state.win.showInactive();
    } catch (_e) {
      /* 忽略 */
    }
  }, 3000);

  return { executor: executor.type, seconds, move: action.move };
}

/**
 * 设置（尤其「样式」里的外观）变了之后，把新外观推给正在显示的提醒条，
 * 并按新的选屏 / 位置 / 宽度重新摆一次窗口。
 *
 * 之前只在 dispatch 那一刻读一次 settings，所以调样式必须等下一次提醒才看得到效果。
 *
 * @param {object} settings 最新的完整 settings
 * @returns {boolean} 是否有正在显示的提醒条被更新
 */
function applyAppearance(settings) {
  if (!state.win || state.win.isDestroyed()) return false;
  if (!state.win.isVisible()) return false;
  if (!state.lastPayload) return false;

  const appearance = appearanceOf(settings);
  const nextLook = {
    fontSize: Number.isFinite(appearanceRaw(settings).fontSize) ? appearanceRaw(settings).fontSize : 15,
    align: typeof appearanceRaw(settings).align === 'string' ? appearanceRaw(settings).align : 'center',
    textColor: typeof appearanceRaw(settings).textColor === 'string' ? appearanceRaw(settings).textColor : '#ffffff',
    textOpacity: Number.isFinite(appearanceRaw(settings).textOpacity) ? appearanceRaw(settings).textOpacity : 0.92,
    bgOpacity: Number.isFinite(appearanceRaw(settings).bgOpacity) ? appearanceRaw(settings).bgOpacity : 0.92,
    theme: appearanceRaw(settings).theme === 'light' ? 'light' : 'dark'
  };

  // 1) 通知渲染层换外观（字号 / 颜色 / 透明度 / 对齐 / 主题）
  state.lastPayload = { ...state.lastPayload, look: nextLook };
  try {
    state.win.webContents.send('executor:patch', { look: nextLook });
  } catch (e) {
    logWarn(`推送外观更新失败：${e && e.message}`);
    return false;
  }

  // 2) 选屏 / 位置 / 宽度限制可能变了，按当前内容尺寸重排一次
  const prevSize = state.lastContent || { width: 0, height: 0 };
  state.appearance = appearance;
  state.layout = { ...(state.layout || {}), fit: true };
  if (prevSize.width > 0 || prevSize.height > 0) {
    resizeTo(prevSize);
  }
  return true;
}

/** 取原始 appearance 对象（不做归一化，交给调用方判断合法性） */
function appearanceRaw(settings) {
  const ap = settings && typeof settings.appearance === 'object' && settings.appearance ? settings.appearance : {};
  return ap;
}

/**
 * 渲染层量完真实内容尺寸后回报，驱动桌面据此重新定位。
 * 自适应宽度模式下窗口宽度由内容决定，换行后高度也会变，所以必须先量再摆。
 * @param {{width:number, height:number}} size 内容自身的宽高（不含窗口内 padding）
 */
function resizeTo(size) {
  if (!state.win || state.win.isDestroyed()) return;
  if (!state.fit) return; // 只有自适应模式才需要重排
  const contentWidth = size && isNum(size.width) ? size.width : 0;
  const contentHeight = size && isNum(size.height) ? size.height : 0;
  if (contentWidth <= 0 && contentHeight <= 0) return;

  // 记住内容尺寸：外观变化时要拿它重算窗口
  state.lastContent = { width: contentWidth, height: contentHeight };

  const appearance = state.appearance || appearanceOf(null);
  const display = pickDisplay(appearance.screen);
  const detected = taskbar.detectTaskbar(display);
  const layout = state.layout || {};
  const bounds = taskbar.computeFitBounds({
    taskbar: detected,
    screenSize: { width: detected.screen.width, height: detected.screen.height },
    contentWidth,
    contentHeight,
    maxWidth: appearance.maxWidth,
    minWidth: appearance.minWidth != null ? appearance.minWidth : layout.minWidth,
    position: appearance.position
  });

  // 尺寸没变就别折腾窗口（避免抖动）
  const prev = state.lastBounds;
  if (prev && prev.width === bounds.width && prev.height === bounds.height && prev.x === bounds.x && prev.y === bounds.y) {
    return;
  }
  try {
    state.win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    state.lastBounds = bounds;
    log(`提醒条按内容重排：w=${bounds.width} h=${bounds.height}${bounds.clampedWidth ? '（已到最大宽度，内容换行）' : ''}`);
  } catch (e) {
    logWarn(`重排提醒窗失败：${e && e.message}`);
  }
}

/** 收起提醒窗 */
function hide() {
  clearHideTimer();
  state.pending = null;
  if (!state.win || state.win.isDestroyed()) return;
  try {
    state.win.hide();
  } catch (e) {
    logWarn(`隐藏提醒窗失败：${e && e.message}`);
  }
}

/** 页面就绪回报（渲染进程主动通知时用） */
function markReady() {
  if (state.win && !state.win.isDestroyed()) {
    state.win.__pageReady = true;
    if (state.pending) {
      try {
        state.win.webContents.send('executor:render', state.pending);
        state.win.showInactive();
        state.pending = null;
      } catch (_e) {
        /* 忽略 */
      }
    }
  }
}

/** 初始化：把执行方式注册进注册表（由框架层在 app ready 后调用） */
function init(executors) {
  const list = Array.isArray(executors) ? executors : [];
  const count = registry.registerAll(list);
  log(`驱动桌面就绪，执行方式 ${count} 个：${registry.list().map((e) => e.type).join('、')}`);
  return count;
}

module.exports = {
  init,
  dispatch,
  hide,
  markReady,
  resizeTo,
  applyAppearance,
  computeGeometry,
  registry,
  // 仅供自检脚本观察
  get state() {
    return state;
  }
};
