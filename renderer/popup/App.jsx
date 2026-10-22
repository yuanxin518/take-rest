/**
 * App.jsx —— 提醒窗的那一条横条
 *
 * 只渲染一条深色圆角条：左侧绿点（呼吸动画）、中间口令文字、右侧「剩余 Ns」倒计时。
 * 视觉规格见 docs/架构与数据规范.md 5.3；样式写在 popup/index.html 的 <style> 里
 * （提醒窗要极致轻，不引 antd，也不额外打一份 CSS 文件）。
 *
 * 生命周期：
 *   收到 payload → 入场动画 → 每秒递减倒计时 → 归零后播退场动画（120ms）→ 回调 onDone 让主进程 hide
 * 主进程侧还有看门狗兜底（armHideTimer），这里即使卡住也不会让提醒条糊在桌面上。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LIGHT_RAINBOW } from '../shared/palette.js';

/** 入场动画时长（与 CSS transition 对齐） */
const ENTER_MS = 180;
/** 退场动画时长（与 CSS transition 对齐） */
const LEAVE_MS = 120;
/** 载荷没给 seconds 时的兜底（与 src/executors/text.js 的 DEFAULT_SECONDS 一致） */
const DEFAULT_SECONDS = 30;

/**
 * #rgb / #rrggbb + 透明度 → rgba()。
 * 颜色来自用户在「样式」里填的值，主进程已经校验过格式，这里再兜一层。
 */
function hexToRgba(hex, alpha) {
  const s = typeof hex === 'string' ? hex.trim() : '';
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  const a = typeof alpha === 'number' && Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  if (!m) return `rgba(255, 255, 255, ${a})`;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * @param {{
 *   payload: object|null,
 *   executor: React.ComponentType<{payload: object}>,
 *   onDone: () => void
 * }} props
 */
export default function PopupApp({ payload, executor, onDone }) {
  const [phase, setPhase] = useState('idle'); // idle | entering | in | leaving
  const [remaining, setRemaining] = useState(DEFAULT_SECONDS);
  const [elapsed, setElapsed] = useState(0); // 已过去的秒数，用来推进进度
  const rootRef = useRef(null);
  const barRef = useRef(null);

  // 每一次新的载荷自增，避免上一轮的定时器把这一轮提前关掉
  const tokenRef = useRef(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const seconds = useMemo(() => {
    const s = payload && typeof payload.seconds === 'number' ? payload.seconds : NaN;
    return Number.isFinite(s) && s > 0 ? Math.round(s) : DEFAULT_SECONDS;
  }, [payload && payload.seconds]);

  /**
   * 本次提醒的「身份」：由 startAt（主进程下发）或 phases/reps/seconds 拼成。
   *
   * 为什么需要它：外观补丁（'executor:patch'）会替换 payload 对象但内容不变，
   * 如果计时 effect 直接依赖 payload，用户在「样式」里拖一下滑块就会把倒计时重置回 0。
   * 所以计时只认这个签名——外观变化签名不变，计时继续走。
   */
  const runId = useMemo(() => {
    if (!payload) return '';
    const start = typeof payload.startAt === 'number' ? payload.startAt : 0;
    const phaseKey = Array.isArray(payload.phases)
      ? payload.phases.map((p) => `${p.text}:${p.sec}`).join('|')
      : '';
    return `${start}#${payload.name || ''}#${payload.seconds || ''}#${payload.reps || ''}#${phaseKey}`;
  }, [payload && payload.startAt, payload && payload.name, payload && payload.seconds, payload && payload.reps, payload && payload.phases]);

  const showCountdown = !(payload && payload.showCountdown === false);
  const isNotice = !!(payload && payload.type === 'notice');
  const vertical = !!(payload && payload.vertical === true);
  const level = (payload && payload.level) || '静音';
  const reps = payload && Number.isFinite(payload.reps) && payload.reps > 0 ? Math.round(payload.reps) : 0;
  const showProgress = !!(payload && payload.showProgress) && reps > 0;

  /** 分段时间轴：phases + 段间切换 + 重复次数 */
  const phases = payload && Array.isArray(payload.phases) ? payload.phases : [];
  const transitionSec = payload && Number.isFinite(payload.transitionSec) ? Math.max(0, payload.transitionSec) : 0;
  const isPhased = phases.length > 0;
  const cycleSec = payload && Number.isFinite(payload.cycleSec) && payload.cycleSec > 0 ? payload.cycleSec : 0;

  /**
   * 把「已过秒数」映射到「第几轮 / 第几段 / 段内进度」。
   * 段与段之间有 transitionSec 的切换留白（显示下一段的文案，颜色先切过去）。
   */
  const timeline = useMemo(() => {
    if (!isPhased || cycleSec <= 0) return null;
    const total = cycleSec * (reps || 1);
    const t = Math.min(elapsed, Math.max(0, total - 0.001));
    const cycleIndex = Math.min((reps || 1) - 1, Math.floor(t / cycleSec));
    const inCycle = t - cycleIndex * cycleSec;

    // 在这一次流程里找当前段（跳过段间留白时落在下一段身上）
    let acc = 0;
    let phaseIndex = 0;
    let inPhase = 0;
    for (let i = 0; i < phases.length; i += 1) {
      const len = phases[i].sec;
      if (inCycle < acc + len) {
        phaseIndex = i;
        inPhase = inCycle - acc;
        break;
      }
      acc += len;
      // 这一段结束后是切换留白：落在留白里仍算「刚结束这段」
      if (i < phases.length - 1 && inCycle < acc + transitionSec) {
        phaseIndex = i;
        inPhase = len;
        break;
      }
      acc += i < phases.length - 1 ? transitionSec : 0;
      phaseIndex = i;
      inPhase = len;
    }

    return {
      round: cycleIndex + 1, // 第几次（用于 1/4）
      phaseIndex,
      phase: phases[phaseIndex] || phases[0],
      inPhase,
      // 当前段还剩多少秒：进度条靠它决定「该不该显示满格」
      phaseLeft: Math.max(0, (phases[phaseIndex] ? phases[phaseIndex].sec : 0) - inPhase),
      total
    };
  }, [isPhased, cycleSec, reps, elapsed, phases, transitionSec]);

  /** 当前段的颜色（红橙黄绿青蓝紫的浅色系，按段序号取） */
  const phaseColor = timeline ? LIGHT_RAINBOW[timeline.phaseIndex % LIGHT_RAINBOW.length] : null;
  /** 当前段内的进度 0~1（用于段内进度条） */
  /**
   * 当前段内的进度 0~1。
   *
   * 这里要处理一个采样误差：进度每 100ms 才刷新一次，如果只在 inPhase/sec 上做除法，
   * 3 秒的段最后一帧只会到 2.9s（97%），然后下一帧已经跨到下一段——用户看到的就是
   * 「没填满就跳走了」。所以当距离段末不足一个采样间隔时，直接按满格显示，
   * 保证每一段（包括最后一段）都真的走完 100%。
   */
  const PHASE_SAMPLE_SEC = 0.12;
  const phaseRatio = (() => {
    if (!timeline || !timeline.phase) return 0;
    const sec = timeline.phase.sec || 1;
    if (timeline.inPhase >= sec) return 1; // 落在切换留白里 = 上一段已走完
    if (timeline.phaseLeft <= PHASE_SAMPLE_SEC) return 1; // 差最后一帧：直接满格
    return Math.min(1, Math.max(0, timeline.inPhase / sec));
  })();

  /** 外观配置（来自「样式」tab）：字号 / 颜色 / 透明度 / 对齐 / 背景深浅 */
  const look = (payload && payload.look) || {};
  const barStyle = {
    // 深色主题背景基色 rgbr(18,20,24)，浅色主题用 (248,250,252)
    background:
      look.theme === 'light'
        ? `rgba(248, 250, 252, ${typeof look.bgOpacity === 'number' ? look.bgOpacity : 0.92})`
        : `rgba(18, 20, 24, ${typeof look.bgOpacity === 'number' ? look.bgOpacity : 0.92})`,
    borderColor:
      look.theme === 'light' ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.10)'
  };
  // 分段动作的圆点与进度条用当前段颜色，简单动作沿用主题绿
  const accent = phaseColor ? phaseColor.hex : '#8ee0a4';
  const textStyle = {
    color: hexToRgba(look.textColor || '#ffffff', typeof look.textOpacity === 'number' ? look.textOpacity : 0.92),
    fontSize: `${typeof look.fontSize === 'number' ? look.fontSize : 15}px`,
    textAlign: ['left', 'center', 'right'].includes(look.align) ? look.align : 'center'
  };
  // 倒计时 / 计数这类次要文字跟着主文字走，但透明度再降一档
  const dimColor = hexToRgba(look.textColor || '#ffffff', Math.max(0.35, (look.textOpacity || 0.92) * 0.62));

  useEffect(() => {
    if (!payload) return undefined;

    tokenRef.current += 1;
    const token = tokenRef.current;

    setRemaining(seconds);
    setElapsed(0);
    setPhase('entering');

    const timers = [];
    const startedAt = Date.now();
    /** 进度推进间隔：100ms 一帧。按整秒推进会让「3 秒的段」永远停在 67%，看起来像提前跳走。 */
    const TICK_MS = 100;

    // 下一帧再进入，保证 transition 有起点（否则直接跳到终态）
    timers.push(
      setTimeout(() => {
        if (token !== tokenRef.current) return;
        setPhase('in');
      }, 20)
    );

    // 用真实经过时间算进度；倒计时只取整秒显示
    const tick = setInterval(() => {
      if (token !== tokenRef.current) return;
      const passed = Math.min(seconds, (Date.now() - startedAt) / 1000);
      setElapsed(passed);
      setRemaining(Math.max(0, Math.ceil(seconds - passed)));
    }, TICK_MS);
    timers.push(tick);

    // 到点：先让进度停在 100% 一帧，再播退场，避免最后一段看着没填满
    timers.push(
      setTimeout(() => {
        if (token !== tokenRef.current) return;
        clearInterval(tick);
        setElapsed(seconds);
        setRemaining(0);
        timers.push(
          setTimeout(() => {
            if (token !== tokenRef.current) return;
            setPhase('leaving');
            timers.push(
              setTimeout(() => {
                if (token !== tokenRef.current) return;
                setPhase('idle');
                if (typeof doneRef.current === 'function') doneRef.current();
              }, LEAVE_MS)
            );
          }, 180)
        );
      }, seconds * 1000)
    );

    return () => {
      timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
      });
    };
    // 只依赖「本次提醒的身份」：外观补丁换了 payload 对象但 runId 不变，计时不会被重置
  }, [runId, seconds]);

  /**
   * 自适应宽度：内容画完后量一遍真实尺寸，回报给驱动桌面重排。
   *
   * 量两件事：
   *   naturalWidth  —— 整个条「如果不换行」有多宽（用一份脱离布局的克隆量，nowrap）。
   *                    主进程拿它去夹到 [最小宽, 屏宽一半]；夹到上限就会换行。
   *   height        —— 当前实际高度（换行后自然变高）。
   * 窗口宽度一变，bar 的换行结果就变，ResizeObserver 会再报一次高度，形成稳定收敛。
   */
  useEffect(() => {
    if (!payload) return undefined;
    const bridge = typeof window !== 'undefined' ? window.executorBridge : null;
    if (!bridge || typeof bridge.reportSize !== 'function') return undefined;

    const el = barRef.current;
    if (!el) return undefined;

    /** 量「不换行时需要多宽」：克隆一份、解除宽度约束后再量，量完立刻移除 */
    const measureNaturalWidth = () => {
      const node = barRef.current;
      if (!node) return 0;
      let clone = null;
      try {
        clone = node.cloneNode(true);
        clone.style.position = 'absolute';
        clone.style.left = '-99999px';
        clone.style.top = '0';
        clone.style.visibility = 'hidden';
        clone.style.width = 'auto';
        clone.style.maxWidth = 'none';
        clone.style.minWidth = '0';
        clone.style.transform = 'none';
        clone.style.opacity = '1';
        clone.style.transition = 'none';
        // 正文一律不换行，量到的才是「一行排下来」的宽度
        clone.querySelectorAll('.popup-content').forEach((c) => {
          c.style.whiteSpace = 'nowrap';
          c.style.overflow = 'visible';
          c.style.webkitLineClamp = 'unset';
        });
        document.body.appendChild(clone);
        const w = Math.ceil(clone.getBoundingClientRect().width);
        return w;
      } catch (_e) {
        return 0;
      } finally {
        if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
      }
    };

    let last = '';
    const report = () => {
      const node = barRef.current;
      if (!node) return;
      const naturalWidth = measureNaturalWidth() || Math.ceil(node.getBoundingClientRect().width);
      const height = Math.max(node.scrollHeight, Math.ceil(node.getBoundingClientRect().height));
      if (naturalWidth <= 0 || height <= 0) return;
      const sig = `${naturalWidth}x${height}`;
      if (sig === last) return;
      last = sig;
      bridge.reportSize({ width: naturalWidth, height });
    };

    report();
    // 字体/内容布局稳定后再补一次，避免首帧量到尚未排版完的尺寸
    const t1 = setTimeout(report, 60);
    const t2 = setTimeout(report, 240);

    let observer = null;
    try {
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => report());
        observer.observe(el);
      }
    } catch (_e) {
      /* 忽略 */
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (observer) {
        try {
          observer.disconnect();
        } catch (_e) {
          /* 忽略 */
        }
      }
    };
  }, [payload]);

  // 还没收到载荷：什么都不画（透明窗口，安静等待）
  if (!payload) return null;
  const Content = executor || null;
  const barClass = [
    'popup-bar',
    phase === 'in' || phase === 'leaving' ? 'is-in' : '',
    phase === 'leaving' ? 'is-leaving' : '',
    vertical ? 'is-vertical' : '',
    showProgress ? 'has-progress' : '',
    payload && payload.type === 'notice' ? 'is-notice' : '',
    `level-${level}`
  ]
    .filter(Boolean)
    .join(' ');

  // 进度：按时间推进，完成度 = 已过秒数 / 总秒数
  const ratio = seconds > 0 ? Math.min(1, elapsed / seconds) : 0;
  // 次数计数：分段动作直接读时间轴的轮次；简单动作把整体进度换算成 1/N
  const doneReps = timeline
    ? timeline.round
    : reps > 0
      ? Math.max(1, Math.min(reps, Math.ceil(ratio * reps) || 1))
      : 0;
  // 进度条：分段动作显示「当前段内的进度」（颜色跟着段走），简单动作显示整体进度
  const barRatio = timeline ? phaseRatio : ratio;
  // 正文：分段动作显示「深呼吸 6秒 · 吐气 4秒」，并在段落间把当前段高亮
  const phaseLabel = timeline && timeline.phase ? `${timeline.phase.text} ${timeline.phase.sec}秒` : '';

  return (
    <div className="popup-root" ref={rootRef}>
      <div className={barClass} role="status" aria-live="polite" ref={barRef} style={barStyle}>
        <div className="popup-line">
          <span
            className="popup-dot"
            aria-hidden="true"
            style={phaseColor ? { background: accent, boxShadow: `0 0 6px ${accent}` } : undefined}
          />
          {Content ? (
            <Content
              payload={payload}
              textStyle={textStyle}
              activeIndex={timeline ? timeline.phaseIndex : 0}
              accent={accent}
            />
          ) : null}
          {showCountdown && !isNotice ? (
            <span className="popup-countdown" style={{ color: dimColor }}>
              剩余 {remaining}s
            </span>
          ) : null}
        </div>

        {/* 当前步骤的做法：固定在进度条上方，跟着当前段换内容与颜色 */}
        {timeline && timeline.phase && timeline.phase.how ? (
          <div className="popup-how" style={{ color: accent }}>
            {timeline.phase.how}
          </div>
        ) : null}

        {showProgress ? (
          <div className="popup-progress">
            <div className="popup-track" aria-hidden="true">
              <div
                className="popup-fill"
                style={{
                  width: `${Math.round(barRatio * 100)}%`,
                  background: accent,
                  boxShadow: `0 0 6px ${accent}`
                }}
              />
            </div>
            <span className="popup-reps" style={{ color: dimColor }}>
              {doneReps}/{reps}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
