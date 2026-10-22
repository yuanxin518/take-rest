/**
 * executors/notice.jsx —— 执行方式 `notice`（预告）
 *
 * 正片前 3 秒的预告条：左边产品名，中间一句介绍，右边 3、2、1 倒计时。
 * 视觉与正片同风格但更简洁——没有分段、没有进度条，目的是「要来了，有个心理准备」。
 *
 * 与主进程 src/desktop/index.js 的 noticePayload() 一一对应：
 *   { type:'notice', title, intro, seconds, showCountdown, level, vertical, startAt }
 */
import React from 'react';

/** 简单倒计时：从 seconds 递减到 1，由外层负责到点切换正片 */
export default function NoticeExecutor({ payload }) {
  const data = payload || {};
  const title = typeof data.title === 'string' && data.title ? data.title : 'Take rest';
  const intro = typeof data.intro === 'string' && data.intro ? data.intro : '活动一下身体，马上开始';
  const sec = Number.isFinite(data.seconds) && data.seconds > 0 ? Math.round(data.seconds) : 3;

  return (
    <span className="notice-content">
      <span className="notice-title">{title}</span>
      <span className="notice-sep" aria-hidden="true" />
      <span className="notice-intro">{intro}</span>
      <span className="notice-count" aria-hidden="true">
        {sec}
      </span>
    </span>
  );
}
