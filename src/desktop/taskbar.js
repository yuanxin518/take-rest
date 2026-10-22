// 任务栏探测与弹窗几何计算：按规范 5.1/5.2，纯函数，方便单测。
'use strict';

// 弹窗几何常量（规范 5.2）
const BAR_HEIGHT = 44; // 横条高度 H
const SIDE_MARGIN = 24; // 左右留白 M
const GAP = 8; // 与任务栏的贴合间距 G
const FALLBACK_THICKNESS = 48; // 兜底任务栏厚度
const FALLBACK_INSET = 12; // 兜底时再往屏幕内缩的像素
const MIN_SIZE = 1; // 窄条退化时的最小尺寸

/**
 * 任务栏所在边 → 该边对应的按键名（settings 里可选覆盖，见 resolveTaskbar）
 * 这个映射只为让 detectTaskbar 的附加参数可读，不影响默认行为。
 */
const EDGE_LABELS = { bottom: '下方', top: '上方', left: '左侧', right: '右侧' };

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 规范化一个矩形，字段缺失或非法时按 0 处理 */
function normalizeRect(r) {
  const src = r && typeof r === 'object' ? r : {};
  return {
    x: isNum(src.x) ? src.x : 0,
    y: isNum(src.y) ? src.y : 0,
    width: isNum(src.width) && src.width > 0 ? src.width : 0,
    height: isNum(src.height) && src.height > 0 ? src.height : 0
  };
}

/**
 * 探测任务栏所在边与厚度。纯函数。
 * @param {{bounds?:object, workArea?:object, size?:object}} display Electron 的 Display 对象（bounds/workArea），
 *        也接受渲染进程的 {x,y,width,height} 或旧式 {size} 简化对象。
 * @param {object} [boundAt] 可选的点击事件屏幕坐标 {x,y}（给未来的自适应留口子，默认不用）。
 * @returns {{edge:'bottom'|'top'|'left'|'right', thickness:number,
 *            workArea:{x:number,y:number,width:number,height:number},
 *            screen:{x:number,y:number,width:number,height:number},
 *            fallback:boolean}}
 *           兜底时额外带 fallback:true，供 computePopupBounds 多缩 12px。
 */
function detectTaskbar(display, boundAt) {
  // 参数顺序为契约规定，这里不使用 boundAt，仅保留给调用方显式传入时的调试日志
  void boundAt;

  const d = display && typeof display === 'object' ? display : {};
  const screen = normalizeRect(d.bounds || d.screen || d.size);
  const hasWorkArea = d.workArea && typeof d.workArea === 'object';
  const workArea = hasWorkArea ? normalizeRect(d.workArea) : { ...screen };

  // 1. 四边「屏幕框 - 工作区」差值
  const gaps = {
    top: workArea.y - screen.y,
    bottom: screen.y + screen.height - (workArea.y + workArea.height),
    left: workArea.x - screen.x,
    right: screen.x + screen.width - (workArea.x + workArea.width)
  };

  // 2. 差值最大的那条边即任务栏所在边
  let edge = 'bottom';
  let thickness = 0;
  for (const key of ['bottom', 'top', 'left', 'right']) {
    if (gaps[key] > thickness) {
      thickness = gaps[key];
      edge = key;
    }
  }

  // 3. 兜底：四条边都 ≤ 0（自动隐藏 / 工作区被占满）
  if (thickness <= 0) {
    return {
      edge: 'bottom',
      thickness: FALLBACK_THICKNESS,
      workArea,
      screen,
      fallback: true
    };
  }

  return { edge, thickness, workArea, screen, fallback: false };
}

/**
 * 按规范 5.2 计算弹窗窗口的 x/y/width/height。纯函数。
 * @param {{taskbar:object, screenSize?:{width:number,height:number}, mode?:string}} opts
 *        mode 用于日志/扩展，首版只有 'bar'，传其他值也走同一套几何。
 * @returns {{x:number,y:number,width:number,height:number,edge:string,thickness:number,
 *            layout:'horizontal'|'vertical', fallback:boolean}}
 */
function computePopupBounds(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const taskbar = options.taskbar && typeof options.taskbar === 'object' ? options.taskbar : {};
  const mode = typeof options.mode === 'string' && options.mode ? options.mode : 'bar';

  // 选中的显示器尺寸：优先用 taskbar.screen（探测时就在鼠标那块屏上算的），
  // 没有就退回调用方传的 screenSize，再退回 workArea。
  let screen = normalizeRect(taskbar.screen);
  const givenSize = options.screenSize && typeof options.screenSize === 'object' ? options.screenSize : null;
  if (givenSize && normalizeRect(givenSize).width > 0) {
    const g = normalizeRect(givenSize);
    if (screen.width <= 0 || screen.height <= 0) {
      screen = { x: screen.x || 0, y: screen.y || 0, width: g.width, height: g.height };
    }
  }
  let workArea = normalizeRect(taskbar.workArea);
  if (workArea.width <= 0 || workArea.height <= 0) {
    workArea = { ...screen };
  }

  const edge = ['bottom', 'top', 'left', 'right'].includes(taskbar.edge) ? taskbar.edge : 'bottom';
  const thickness = isNum(taskbar.thickness) && taskbar.thickness > 0 ? taskbar.thickness : FALLBACK_THICKNESS;
  const fallback = taskbar.fallback === true;
  const inset = fallback ? FALLBACK_INSET : 0; // 兜底时再往屏幕内缩 12px

  if (edge === 'left' || edge === 'right') {
    // 退化为竖向窄条
    const width = Math.max(MIN_SIZE, Math.round(thickness * 4));
    const height = Math.max(MIN_SIZE, Math.round(workArea.height - 2 * SIDE_MARGIN));
    const x =
      edge === 'left'
        ? Math.round(workArea.x + inset)
        : Math.round(workArea.x + workArea.width - width - inset);
    const y = Math.round(workArea.y + SIDE_MARGIN);
    return { x: clamp(x, workArea.x, workArea.x + workArea.width - width), y, width, height, edge, thickness, layout: 'vertical', fallback };
  }

  const width = Math.max(MIN_SIZE, Math.round(workArea.width - 2 * SIDE_MARGIN));
  let x = Math.round(workArea.x + SIDE_MARGIN);
  const position = ['bottom', 'top', 'center'].includes(options.position) ? options.position : 'bottom';
  let y;
  if (position === 'top') {
    y = Math.round(workArea.y + GAP + inset);
  } else if (position === 'center') {
    y = Math.round(workArea.y + (workArea.height - BAR_HEIGHT) / 2);
  } else {
    // 贴在任务栏上方
    y = Math.round(workArea.y + workArea.height - BAR_HEIGHT - GAP - inset);
  }
  const minY = workArea.y + inset;
  const maxY = workArea.y + workArea.height - BAR_HEIGHT - inset;
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, minY, Math.max(minY, maxY)),
    width,
    height: BAR_HEIGHT,
    edge,
    thickness,
    layout: 'horizontal',
    fallback,
    mode
  };
}

function clamp(v, min, max) {
  if (max < min) return Math.round(min);
  return Math.round(Math.min(Math.max(v, min), max));
}

/** 自适应宽度模式：最大占屏宽的比例、最小宽度、左右留白 */
const FIT_MAX_WIDTH_RATIO = 0.5;
const FIT_MAX_SCREEN_RATIO = 0.8; // 无论用户把「最大宽度」设多大，都不超过屏宽的这个比例
const FIT_MIN_WIDTH = 240;
const FIT_SIDE_MARGIN = 16;
const FIT_PADDING_X = 28; // 与 CSS 的 .popup-bar padding 左右之和保持一致

/**
 * 「居中 + 宽度自适应」的提醒条几何。
 *
 * 与铺满全宽的 computePopupBounds 不同：
 *   - 宽度由内容决定，夹在 [minWidth, maxWidth] 之间，并水平居中；
 *     没给 maxWidth 时退回「屏宽 × maxWidthRatio」，再和屏宽 80% 取小，避免占满整屏；
 *   - 高度由内容决定（换行后自动变高），不是固定 44；
 *   - position 决定竖直方向：bottom=贴任务栏上方、top=贴顶、center=垂直居中。
 *
 * @param {{taskbar:object, screenSize?:object, contentWidth:number, contentHeight:number,
 *          maxWidth?:number, maxWidthRatio?:number, minWidth?:number, paddingX?:number,
 *          position?:'bottom'|'top'|'center'}} opts
 */
function computeFitBounds(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const taskbar = options.taskbar && typeof options.taskbar === 'object' ? options.taskbar : {};

  let screen = normalizeRect(taskbar.screen);
  const given = options.screenSize && typeof options.screenSize === 'object' ? normalizeRect(options.screenSize) : null;
  if (given && given.width > 0 && (screen.width <= 0 || screen.height <= 0)) {
    screen = { x: screen.x || 0, y: screen.y || 0, width: given.width, height: given.height };
  }
  let workArea = normalizeRect(taskbar.workArea);
  if (workArea.width <= 0 || workArea.height <= 0) workArea = { ...screen };

  const edge = ['bottom', 'top', 'left', 'right'].includes(taskbar.edge) ? taskbar.edge : 'bottom';
  const thickness = isNum(taskbar.thickness) && taskbar.thickness > 0 ? taskbar.thickness : FALLBACK_THICKNESS;
  const fallback = taskbar.fallback === true;
  const inset = fallback ? FALLBACK_INSET : 0;
  const position = ['bottom', 'top', 'center'].includes(options.position) ? options.position : 'bottom';

  const ratio = isNum(options.maxWidthRatio) && options.maxWidthRatio > 0 ? options.maxWidthRatio : FIT_MAX_WIDTH_RATIO;
  const minWidth = isNum(options.minWidth) && options.minWidth > 0 ? options.minWidth : FIT_MIN_WIDTH;
  const paddingX = isNum(options.paddingX) ? options.paddingX : FIT_PADDING_X;

  // 上限：用户配的 maxWidth 优先；否则用屏宽比例；无论哪种都不超过屏宽 80%
  const hardCap = Math.round(workArea.width * FIT_MAX_SCREEN_RATIO);
  const userMax = isNum(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : Math.round(workArea.width * ratio);
  const maxWidth = Math.max(MIN_SIZE, Math.min(userMax, hardCap, workArea.width));

  const wanted = Math.round((isNum(options.contentWidth) ? options.contentWidth : 0) + paddingX);
  const width = clamp(wanted, Math.min(minWidth, maxWidth), maxWidth);
  const clampedWidth = wanted >= maxWidth;

  const wantedHeight = isNum(options.contentHeight) && options.contentHeight > 0 ? options.contentHeight : BAR_HEIGHT;
  const height = Math.round(Math.max(BAR_HEIGHT, wantedHeight));

  // 水平居中
  const centered = workArea.x + (workArea.width - width) / 2;
  const x = clamp(centered, workArea.x, workArea.x + workArea.width - width);

  let y;
  if (position === 'top') {
    y = Math.round(workArea.y + GAP + inset);
  } else if (position === 'center') {
    y = Math.round(workArea.y + (workArea.height - height) / 2);
  } else {
    // bottom：默认贴任务栏上方。任务栏不在下边时，贴工作区底部
    if (edge === 'left' || edge === 'right') {
      y = Math.round(workArea.y + workArea.height - height - GAP - inset);
    } else {
      y = Math.round(workArea.y + workArea.height - height - GAP - inset);
    }
  }
  const minY = workArea.y + inset;
  const maxY = workArea.y + workArea.height - height - inset;
  y = clamp(y, minY, Math.max(minY, maxY));

  return {
    x,
    y,
    width,
    height,
    edge,
    thickness,
    layout: edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal',
    fallback,
    clampedWidth
  };
}

module.exports = {
  detectTaskbar,
  computePopupBounds,
  computeFitBounds,
  EDGE_LABELS,
  BAR_HEIGHT,
  SIDE_MARGIN,
  GAP,
  FALLBACK_THICKNESS,
  FALLBACK_INSET,
  FIT_MAX_WIDTH_RATIO,
  FIT_MIN_WIDTH,
  FIT_PADDING_X
};
