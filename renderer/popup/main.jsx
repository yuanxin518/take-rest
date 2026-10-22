/**
 * main.jsx —— 提醒窗入口（React，裸渲染，不引 antd）
 *
 * 提醒窗的窗口形态（透明 / 无边框 / 点击穿透 / 44px 横条）由主进程 src/desktop/index.js 决定，
 * 这里只做一件事：把主进程发来的载荷分发给对应的「执行方式组件」并渲染。
 *
 * 分发表 EXECUTOR_COMPONENTS 就是扩展点（对应 docs 2.2「执行方式注册契约」的渲染侧）：
 *   - 现在只有 text；
 *   - 以后加 image / marquee / video 时：
 *       1) 在 renderer/popup/executors/ 下新建同名组件（只画正文区域）；
 *       2) 在这里的表里加一行 `image: ImageExecutor`；
 *       3) 主进程新增 src/executors/image.js 并注册进 src/executors/index.js。
 *     驱动桌面与面板都不需要改。
 *   - 表里找不到的类型（或载荷里没写 type）退化成纯文字，保证永远有东西可看、不会白屏。
 *
 * 渲染进程收不到 'executor:render' 时什么都不画、不报错，安静等待下一次提醒。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PopupApp from './App.jsx';
import TextExecutor from './executors/text.jsx';
import NoticeExecutor from './executors/notice.jsx';

/**
 * 执行方式分发表：payload.type → 正文组件。
 * ★ 这里就是以后加 image / marquee 的扩展点（详见文件头注释）。
 */
export const EXECUTOR_COMPONENTS = {
  text: TextExecutor,
  notice: NoticeExecutor
};

/** 取到本次载荷应该用的组件；找不到类型时退化成纯文字 */
export function pickExecutor(type) {
  const key = typeof type === 'string' ? type : '';
  return EXECUTOR_COMPONENTS[key] || TextExecutor;
}

/** 事件桥：preload.cjs 暴露的 window.executorBridge；拿不到时安静降级 */
function bridge() {
  if (typeof window === 'undefined') return null;
  return window.executorBridge || null;
}

function Root() {
  const [payload, setPayload] = useState(null);

  const handleRender = useCallback((incoming) => {
    if (!incoming || typeof incoming !== 'object') return;
    setPayload(incoming);
  }, []);

  /** 外观补丁：只覆盖 look，其它字段（phases / reps / seconds…）保持不变 */
  const handlePatch = useCallback((patch) => {
    if (!patch || typeof patch !== 'object') return;
    setPayload((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  useEffect(() => {
    const b = bridge();
    // 收不到 'executor:render' 时（非 Electron 环境 / preload 没加载）不报错，安静等待
    if (!b || typeof b.onRender !== 'function') return undefined;
    let off = null;
    let offPatch = null;
    try {
      off = b.onRender(handleRender);
      if (typeof b.onPatch === 'function') offPatch = b.onPatch(handlePatch);
    } catch (err) {
      console.warn('[提醒窗] 订阅 executor:render 失败，将不会有内容显示', err);
      return undefined;
    }
    return () => {
      [off, offPatch].forEach((fn) => {
        if (typeof fn === 'function') {
          try {
            fn();
          } catch (_e) {
            /* 忽略 */
          }
        }
      });
    };
  }, [handleRender, handlePatch]);

  /** 倒计时归零：通知主进程收起窗口（主进程另有看门狗兜底） */
  const notifyDone = useCallback(() => {
    const b = bridge();
    if (b && typeof b.notifyDone === 'function') {
      try {
        b.notifyDone();
      } catch (_e) {
        /* 忽略 */
      }
    }
  }, []);

  return <PopupApp payload={payload} executor={pickExecutor(payload && payload.type)} onDone={notifyDone} />;
}

const host = document.getElementById('root');
if (host) createRoot(host).render(<Root />);
