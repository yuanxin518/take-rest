/**
 * executors/text.jsx —— 执行方式 `text`（推送文字）的渲染实现
 *
 * 与主进程 src/executors/text.js 一一对应：那边决定「停留多久、窗口多大」，这边只决定「中间那行字怎么画」。
 * payload 结构（src/executors/text.js 的 payload()）：
 *   { type:'text', prompt, name, dosage, seconds, showCountdown, level, category, part, vertical }
 *
 * 约定：执行方式组件只负责「条中间的正文区域」，
 * 左侧呼吸点、右侧倒计时、入场/退场动画、点击穿透都由外层 App.jsx 统一提供。
 */
import React from 'react';

/** 文案兜底：prompt 为空时退化成「动作名 · 剂量」 */
export function textOf(payload) {
  const data = payload || {};
  const prompt = typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt.trim() : '';
  if (prompt) return prompt;
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
  const dosage = typeof data.dosage === 'string' && data.dosage.trim() ? data.dosage.trim() : '';
  if (name && dosage) return `${name} · ${dosage}`;
  if (name) return name;
  return '站起来动一下';
}

/**
 * 正文组件。
 * @param {{ payload: object, textStyle?: object }} props
 *   textStyle 由外层按「样式」设置算好（字号 / 颜色 / 透明度 / 对齐），这里只负责套上去。
 *
 * 分段动作（payload.phases 非空）渲染成「深呼吸 6秒 · 吐气 4秒」，
 * 当前段用它的浅色高亮，其它段压暗——一眼能看出现在该做哪一段。
 * 简单动作仍然只显示一整句 prompt。
 */
export default function TextExecutor({ payload, textStyle, activeIndex, accent }) {
  const phases = payload && Array.isArray(payload.phases) ? payload.phases : [];

  if (phases.length > 0) {
    return (
      <span className="popup-content popup-phases" title={textOf(payload)} style={textStyle}>
        {phases.map((p, i) => {
          const on = i === activeIndex;
          return (
            <span key={`${p.text}-${i}`} className={`phase-chunk${on ? ' is-active' : ''}`}>
              <span className="phase-text" style={on && accent ? { color: accent } : undefined}>
                {p.text}
              </span>
              <span className="phase-sec">{p.sec}秒</span>
              {i < phases.length - 1 ? <span className="phase-sep">·</span> : null}
            </span>
          );
        })}
      </span>
    );
  }

  const text = textOf(payload);
  return (
    <span className="popup-content" title={text} style={textStyle}>
      {text}
    </span>
  );
}
