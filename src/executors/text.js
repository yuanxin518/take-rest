// 执行方式：推送文字。把动作渲染成任务栏上方的一条口令，做完自动消失。
// 这是当前唯一实现的执行方式，也是以后加图片/视频时对照的样板：
// 只实现 canHandle / measure / payload / duration 四个方法，不碰窗口定位与计时。
//
// 支持两种动作形态：
//   1) 简单动作：只有 prompt + durationSec（老包，直接显示一句话）
//   2) 分段动作：move.phases = [{ text:'深呼吸', sec:6 }, { text:'吐气', sec:4 }]
//      一次流程 = 各段秒数之和 + 段间切换时间（transitionSec，默认 2 秒）
//      重复 reps 次；提醒条按段换色（红橙黄绿青蓝紫的浅色系），
//      文字只写「深呼吸 6秒 · 吐气 4秒」，不把「重复 4 次」塞进正文——
//      重复次数只体现在底部的 1/4 计数上。
'use strict';

const TYPE = 'text';
const DEFAULT_SECONDS = 30;
/** 段与段之间的切换留白（秒）：让用户有时间换动作 */
const DEFAULT_TRANSITION_SEC = 2;
/** 单段秒数的合理上限，防止坏数据把一次提醒拖成几十分钟 */
const MAX_PHASE_SEC = 600;
const MAX_PHASES = 12;
const MAX_REPS = 99;

/** 取整并夹到合理区间 */
function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 规范化 phases：只保留 { text, sec }，非法项丢弃。
 * @returns {Array<{text:string, sec:number}>}
 */
function normalizePhases(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw.slice(0, MAX_PHASES)) {
    if (!p || typeof p !== 'object') continue;
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const rawSec = typeof p.sec === 'number' ? p.sec : Number(p.sec);
    // 注意：0 / 负数 / NaN 都是非法段，要丢弃，不能夹成 1 秒
    if (!text || !Number.isFinite(rawSec) || rawSec <= 0) continue;
    const step = { text, sec: clampInt(rawSec, 1, MAX_PHASE_SEC, 1) };
    // 做法说明（可选）：进度条上方固定显示「这一步具体怎么做」
    if (typeof p.how === 'string' && p.how.trim()) step.how = p.how.trim();
    out.push(step);
  }
  return out;
}

/** 一次流程的纯动作时长（不含切换留白） */
function phasesActiveSec(phases) {
  return phases.reduce((n, p) => n + p.sec, 0);
}

/**
 * 一次流程的总时长 = 各段 + 每段之间的切换留白。
 * 有 n 段就有 n-1 个段间切换（最后一段做完直接进下一次，不需要额外的停顿）。
 */
function cycleSecOf(phases, transitionSec) {
  if (phases.length === 0) return 0;
  return phasesActiveSec(phases) + Math.max(0, phases.length - 1) * transitionSec;
}

/**
 * 分段动作的正文：`深呼吸 6秒 · 吐气 4秒`。
 * 不写「重复 N 次」——那属于计数，交给底部的 1/4。
 */
function phasesToText(phases) {
  return phases.map((p) => `${p.text} ${p.sec}秒`).join(' · ');
}

/**
 * 能不能呈现：带文字信息的动作都归它管。
 */
function canHandle(action) {
  if (!action || !action.move) return false;
  const { move } = action;
  if (Array.isArray(move.phases) && move.phases.length > 0) return true;
  return typeof move.prompt === 'string' && move.prompt.length > 0
    ? true
    : typeof move.name === 'string' && move.name.length > 0;
}

/**
 * 尺寸诉求：居中自适应宽度（不铺满全宽）。
 * 具体的上下限由驱动桌面按「样式」设置（默认宽度 / 最大宽度）覆盖，这里只给形态。
 */
function measure() {
  return {
    mode: 'bar',
    fit: true, // 驱动桌面据此走 computeFitBounds
    height: 44, // 首帧临时高度，真实高度由渲染层回报
    maxWidthRatio: 0.5
  };
}

/**
 * 生成渲染载荷。必须全部是可结构化克隆的纯数据。
 * @param {object} action
 * @param {{ seconds:number, showCountdown:boolean, appearance?:object }} ctx
 */
function payload(action, ctx) {
  const move = (action && action.move) || {};
  const options = ctx || {};
  const seconds = typeof options.seconds === 'number' ? options.seconds : DEFAULT_SECONDS;

  const phases = normalizePhases(move.phases);
  const transitionSec = clampInt(move.transitionSec, 0, 10, DEFAULT_TRANSITION_SEC);
  const reps = clampInt(move.reps, 1, MAX_REPS, 1);
  const isPhased = phases.length > 0;

  // 分成动作的正文由 phases 生成；简单动作沿用 prompt
  const prompt = isPhased ? phasesToText(phases) : move.prompt || move.name || '';

  // 外观配置透传给渲染层（字号 / 颜色 / 透明度 / 对齐 / 主题）
  const ap = options.appearance && typeof options.appearance === 'object' ? options.appearance : {};
  return {
    type: TYPE,
    prompt,
    name: move.name || '',
    dosage: isPhased ? '' : move.dosage || '',
    seconds,
    showCountdown: options.showCountdown !== false,
    level: action.level || move.level || '静音',
    category: action.category || '',
    part: action.part || '',
    // 计数：分段动作一定显示 1/N（N = reps）；简单动作只在包写了 reps 时显示
    reps: isPhased ? reps : clampInt(move.reps, 0, MAX_REPS, 0),
    showProgress: isPhased || Number.isFinite(move.reps) && move.reps > 0,
    // 分段时间轴：渲染层据此按段推进、按段换色
    phases: isPhased ? phases : [],
    transitionSec: isPhased ? transitionSec : 0,
    cycleSec: isPhased ? cycleSecOf(phases, transitionSec) : 0,
    look: {
      fontSize: Number.isFinite(ap.fontSize) ? ap.fontSize : 15,
      align: typeof ap.align === 'string' ? ap.align : 'center',
      textColor: typeof ap.textColor === 'string' ? ap.textColor : '#ffffff',
      textOpacity: Number.isFinite(ap.textOpacity) ? ap.textOpacity : 0.92,
      bgOpacity: Number.isFinite(ap.bgOpacity) ? ap.bgOpacity : 0.92,
      theme: ap.theme === 'light' ? 'light' : 'dark'
    },
    vertical: false // 由驱动桌面按实际布局覆盖
  };
}

/**
 * 停留时长：
 *   - 分段动作：一次流程 × 重复次数（让整套动作完整播完）
 *   - 简单动作：设置里给了固定秒数就用它，否则用动作自带的 durationSec
 * 用户在「样式」里没法定时长，只有「弹出停留」这一个总开关，所以两处都要尊重它。
 */
function duration(action, settings) {
  const s = settings || {};
  const move = (action && action.move) || {};

  const phases = normalizePhases(move.phases);
  if (phases.length > 0) {
    const transitionSec = clampInt(move.transitionSec, 0, 10, DEFAULT_TRANSITION_SEC);
    const reps = clampInt(move.reps, 1, MAX_REPS, 1);
    return Math.max(1, cycleSecOf(phases, transitionSec) * reps);
  }

  if (typeof s.popupSeconds === 'number' && s.popupSeconds > 0) return s.popupSeconds;
  if (typeof move.durationSec === 'number' && move.durationSec > 0) return move.durationSec;
  return DEFAULT_SECONDS;
}

module.exports = {
  type: TYPE,
  label: '推送文字',
  priority: 100,
  canHandle,
  measure,
  payload,
  duration,
  // 给自检与文档用
  normalizePhases,
  phasesToText,
  cycleSecOf,
  DEFAULT_TRANSITION_SEC
};
