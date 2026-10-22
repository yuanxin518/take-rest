/**
 * components/TitleBar.jsx —— 自定义窗口标题栏
 *
 * 主进程把面板设成了 `frame: false`，系统标题栏不再存在，所以这里负责：
 *   - 显示应用图标 + 标题（图标来自 assets/icon-256.png）
 *   - 提供最小化 / 最大化切换 / 关闭三个按钮
 *   - 空白区域可拖动窗口（CSS `-webkit-app-region: drag`）
 *
 * 按钮通过 preload 暴露的 window.api.window* 调主进程，拿不到桥时按钮禁用，
 * 不会因为环境缺 IPC 就白屏。
 */
import React, { useCallback, useEffect, useState } from 'react';
import iconUrl from '../../../assets/icon-256.png';

export default function TitleBar({ title = '休息一下' }) {
  const api = typeof window !== 'undefined' ? window.api || null : null;
  const canControl = Boolean(api && typeof api.windowMinimize === 'function');
  const [maximized, setMaximized] = useState(false);

  // 同步一次最大化状态（窗口可能是上次最大化后恢复的）
  useEffect(() => {
    if (!canControl || typeof api.windowIsMaximized !== 'function') return undefined;
    let alive = true;
    api
      .windowIsMaximized()
      .then((v) => {
        if (alive) setMaximized(v === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, canControl]);

  const onMinimize = useCallback(() => {
    if (canControl) api.windowMinimize().catch(() => {});
  }, [api, canControl]);

  const onToggleMax = useCallback(async () => {
    if (!canControl) return;
    try {
      const next = await api.windowToggleMaximize();
      setMaximized(next === true);
    } catch (_e) {
      /* 忽略 */
    }
  }, [api, canControl]);

  const onClose = useCallback(() => {
    if (canControl) api.windowClose().catch(() => {});
  }, [api, canControl]);

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <img className="titlebar-icon" src={iconUrl} alt="" draggable={false} />
        <span className="titlebar-title">{title}</span>
      </div>

      <div className="titlebar-controls">
        <button type="button" className="tb-btn" onClick={onMinimize} disabled={!canControl} title="最小化" aria-label="最小化">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.6" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={onToggleMax}
          disabled={!canControl}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="3" width="5.5" height="5.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3.5 3V1.5h5v5H7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button type="button" className="tb-btn tb-close" onClick={onClose} disabled={!canControl} title="关闭" aria-label="关闭">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
