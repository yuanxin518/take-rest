/**
 * App.jsx —— 设置面板的骨架与「唯一事实来源」
 *
 * 职责划分：
 *   - 本文件管数据：state:get / settings:set 的读写、300ms 防抖、广播回流、
 *     焦点保护、试看与立刻提醒的调用；分区组件只负责「长什么样、点了以后调哪个回调」。
 *   - sections/Rhythm.jsx        节奏
 *   - sections/ActionTree.jsx    三级动作树（唯一数据来源 state.packs[i].categories）
 *   - sections/Subscriptions.jsx 订阅（GitHub 拉取 / 同步 / 本地导入）
 *
 * 三条硬要求（与旧版 panel.js 一致）：
 *   1) 设置改动防抖 300ms 再调 api.setSettings，本地先乐观生效；
 *   2) settings:changed 广播回来时不覆盖正在聚焦的输入框；
 *   3) 空状态必须有明确的中文占位。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Space, Switch, Tooltip } from 'antd';
import Home from './sections/Home.jsx';
import Rhythm from './sections/Rhythm.jsx';
import ActionTree from './sections/ActionTree.jsx';
import Subscriptions from './sections/Subscriptions.jsx';
import Appearance from './sections/Appearance.jsx';
import TitleBar from './components/TitleBar.jsx';
import { clampNum, errMsg, formatHM, normalizeHour, num, relativeMin, toTime } from '../shared/format.js';

/** 防抖提交间隔（毫秒） */
const DEBOUNCE_MS = 300;
/** 摘要里「下次提醒」的刷新间隔（毫秒）：不做秒级动效，一分钟一次足够 */
const SUMMARY_TICK_MS = 30000;

/** 侧边栏的三个 tab */
const TABS = [
  { key: 'home', label: '主页', hint: '概览与快捷操作' },
  { key: 'actions', label: '动作', hint: '节奏、动作包、订阅' },
  { key: 'appearance', label: '样式', hint: '提醒条外观与位置' }
];

/** 与主进程 store.DEFAULT_APPEARANCE 对齐 */
const DEFAULT_APPEARANCE = {
  minWidth: 240,
  maxWidth: 1280,
  fontSize: 15,
  align: 'center',
  textColor: '#ffffff',
  textOpacity: 0.92,
  bgOpacity: 0.92,
  screen: 'cursor',
  position: 'bottom',
  theme: 'dark'
};

/** 与主进程 store.DEFAULT_SETTINGS 对齐的兜底默认值 */
export const DEFAULT_SETTINGS = {
  intervalMin: 20,
  enabled: true,
  popupSeconds: 0,
  categories: { 身体: true },
  levels: { 静音: true },
  disabledPaths: [],
  activePackIds: [],
  shuffle: false,
  activeHours: { start: 9, end: 20 },
  showCountdown: true,
  appearance: DEFAULT_APPEARANCE
};

/** 深拷贝（结构化数据都用它，避免共享引用被误改） */
function clone(o) {
  if (o == null || typeof o !== 'object') return o;
  return JSON.parse(JSON.stringify(o));
}

/**
 * settings 归一化：把后端 / 广播 / 本地乐观更新过的对象都收成同一形状。
 * 注意 activeHours：只有起止都是合法整点时才算「限定时段」，否则按全天处理（与主进程 store 一致）。
 */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.intervalMin = clampNum(s.intervalMin, 1, 600, 20);
  s.popupSeconds = clampNum(s.popupSeconds, 0, 600, 0);
  s.enabled = s.enabled !== false;
  s.shuffle = s.shuffle === true;
  s.showCountdown = s.showCountdown !== false;

  if (!s.categories || typeof s.categories !== 'object' || Array.isArray(s.categories)) {
    s.categories = { ...DEFAULT_SETTINGS.categories };
  }
  if (!s.levels || typeof s.levels !== 'object' || Array.isArray(s.levels)) {
    s.levels = { ...DEFAULT_SETTINGS.levels };
  }
  if (!Array.isArray(s.activePackIds)) s.activePackIds = [];

  const ah = s.activeHours && typeof s.activeHours === 'object' ? s.activeHours : {};
  const start = normalizeHour(ah.start);
  const end = normalizeHour(ah.end);
  s.activeHours = start == null || end == null ? { start: null, end: null } : { start, end };
  return s;
}

/** 合并两次 patch：一层对象做浅合并，其它字段直接覆盖 */
function mergePatch(a, b) {
  if (!a) return clone(b);
  const out = { ...a };
  Object.keys(b || {}).forEach((k) => {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  });
  return out;
}

/** 统计所有包里能抽到的动作条数（按三级结构数，数不到再退化成 pack.count） */
function countMoves(packs) {
  let n = 0;
  (packs || []).forEach((p) => {
    if (!p) return;
    const cats = Array.isArray(p.categories) ? p.categories : null;
    if (cats) {
      cats.forEach((c) => {
        (Array.isArray(c && c.parts) ? c.parts : []).forEach((pt) => {
          n += Array.isArray(pt && pt.moves) ? pt.moves.length : 0;
        });
      });
    }
  });
  if (n) return n;
  (packs || []).forEach((p) => {
    n += num(p && p.count, 0);
  });
  return n;
}

export default function App() {
  const { message } = AntApp.useApp();
  const api = typeof window !== 'undefined' ? window.api || null : null;

  /* ---------------- 数据状态 ---------------- */
  const [settings, setSettings] = useState(() => normalizeSettings(DEFAULT_SETTINGS));
  const [packs, setPacks] = useState([]);
  const [actionCount, setActionCount] = useState(0);
  const [nextFireAt, setNextFireAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null); // 底部结果：{ text, kind: 'ok'|'err'|'busy' }
  const [fireBusy, setFireBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // 订阅变化后触发整页重取
  // 侧边栏当前 tab；刷新后记住上次看的是哪个
  const [tab, setTab] = useState(() => {
    try {
      const saved = window.localStorage.getItem('desk-reminder:panelTab');
      return TABS.some((t) => t.key === saved) ? saved : 'home';
    } catch (_e) {
      return 'home';
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('desk-reminder:panelTab', tab);
    } catch (_e) {
      /* 忽略 */
    }
  }, [tab]);

  /* ---------------- 防抖与焦点保护 ---------------- */
  const pendingRef = useRef(null); // 还没提交的 patch
  const timerRef = useRef(null); // 防抖定时器
  const focusRef = useRef(new Set()); // 正在聚焦的字段名
  const unmountedRef = useRef(false);

  /** 输入框获得焦点：登记字段名，广播回流时跳过它 */
  const markFocus = useCallback((field) => {
    focusRef.current.add(field);
  }, []);
  const clearFocus = useCallback((field) => {
    focusRef.current.delete(field);
  }, []);

  /**
   * 把一份「权威 settings」并进本地，跳过正在聚焦的字段。
   * 这样面板自己回填时不会把用户正在敲的输入框打断（光标乱跳）。
   */
  const applyIncoming = useCallback((incoming) => {
    if (!incoming) return;
    const next = normalizeSettings(incoming);
    setSettings((prev) => {
      const merged = { ...next };
      const focus = focusRef.current;
      if (focus.has('intervalMin')) merged.intervalMin = prev.intervalMin;
      if (focus.has('popupSeconds')) merged.popupSeconds = prev.popupSeconds;
      if (focus.has('activeHours')) merged.activeHours = prev.activeHours;
      return merged;
    });
  }, []);

  /** 把待提交的 patch 发给主进程 */
  const flushSave = useCallback(async () => {
    timerRef.current = null;
    const patch = pendingRef.current;
    pendingRef.current = null;
    if (!patch) return;
    if (!api || typeof api.setSettings !== 'function') return;
    try {
      const full = await api.setSettings(patch);
      // 期间用户又改了东西：这次回包已经过时，别再覆盖 UI（下一次提交马上到）
      if (pendingRef.current || timerRef.current) return;
      applyIncoming(full);
    } catch (e) {
      // 只有「期间没有新改动」时才提示，避免连点时刷屏
      if (!pendingRef.current && !timerRef.current) {
        message.error(`设置保存失败：${errMsg(e)}`);
      }
    }
  }, [api, applyIncoming, message]);

  /**
   * 改一个设置：本地立刻生效（乐观）→ 合并待提交 patch → 300ms 后统一提交。
   * 注意：调用方传进来的对象字段要传「完整值」（例如 categories 传整个映射）。
   */
  const patchSettings = useCallback(
    (patch) => {
      setSettings((prev) => normalizeSettings({ ...prev, ...patch }));
      pendingRef.current = mergePatch(pendingRef.current, patch);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        flushSave();
      }, DEBOUNCE_MS);
    },
    [flushSave]
  );

  /* ---------------- 数据加载 ---------------- */
  /** 全量状态：settings / packs（含 categories）/ actionCount / nextFireAt */
  const refreshState = useCallback(
    async (opts) => {
      if (!api || typeof api.getState !== 'function') {
        setLoading(false);
        return;
      }
      try {
        const st = await api.getState();
        if (!st || unmountedRef.current) return;
        // 有没提交的改动时不覆盖设置，等下一个人回包
        if (st.settings && !pendingRef.current && !timerRef.current) applyIncoming(st.settings);
        const list = Array.isArray(st.packs) ? st.packs : [];
        setPacks(list);
        setActionCount(num(st.actionCount, 0) || countMoves(list));
        setNextFireAt(st.nextFireAt != null ? st.nextFireAt : null);
        setLoading(false);
      } catch (e) {
        setLoading(false);
        if (!opts || !opts.silent) message.error(`读取状态失败：${errMsg(e)}`);
      }
    },
    [api, applyIncoming, message]
  );

  /**
   * 轻量动作包列表（packs:list 不含 categories）。
   * 合并时必须保住旧的 categories —— 它是三级树的唯一数据来源，不能被摘要冲掉。
   */
  const refreshPacks = useCallback(async () => {
    if (!api || typeof api.listPacks !== 'function') return;
    try {
      const list = await api.listPacks();
      if (!Array.isArray(list) || unmountedRef.current) return;
      setPacks((prev) => {
        const known = new Map();
        (prev || []).forEach((p) => {
          if (p && p.id) known.set(p.id, p);
        });
        const merged = list.map((p) => {
          if (!p || !p.id) return p;
          const old = known.get(p.id);
          if (!old) return p;
          const out = { ...old, ...p };
          if (!Array.isArray(p.categories) && Array.isArray(old.categories)) out.categories = old.categories;
          return out;
        });
        (prev || []).forEach((p) => {
          if (!p || !p.id) return;
          if (!merged.some((m) => m && m.id === p.id)) merged.push(p);
        });
        return merged;
      });
      setActionCount((n) => n || countMoves(list));
    } catch (_e) {
      /* 摘要刷新失败不打断主流程 */
    }
  }, [api]);

  /** 订阅装 / 同步完：列表、订阅状态、完整 state 都要重取一遍 */
  const handlePackDataChanged = useCallback(async () => {
    await refreshPacks();
    await refreshState({ silent: true });
    setRefreshKey((k) => k + 1);
  }, [refreshPacks, refreshState]);

  /** 开关某个动作包（packs:toggle） */
  const togglePackEnabled = useCallback(
    async (id, enabled) => {
      if (!api || typeof api.togglePack !== 'function') {
        message.warning('当前主进程不支持单独开关动作包');
        return;
      }
      // 先乐观改一下开关的视觉状态
      setPacks((prev) => (prev || []).map((p) => (p && p.id === id ? { ...p, enabled: !!enabled } : p)));
      try {
        const list = await api.togglePack(id, enabled);
        if (Array.isArray(list)) {
          // 返回的是最新摘要，categories 用旧值补上
          setPacks((prev) => {
            const known = new Map();
            (prev || []).forEach((p) => {
              if (p && p.id) known.set(p.id, p);
            });
            return list.map((p) => {
              const old = known.get(p && p.id);
              return old && !Array.isArray(p.categories) ? { ...old, ...p, categories: old.categories } : p;
            });
          });
        }
        await refreshState({ silent: true });
      } catch (e) {
        message.error(`动作包开关失败：${errMsg(e)}`);
        await refreshPacks();
      }
    },
    [api, message, refreshPacks, refreshState]
  );

  /* ---------------- 生命周期 ---------------- */

  useEffect(() => {
    unmountedRef.current = false;
    refreshState().then(() => refreshPacks());
    return () => {
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // 只在挂载时跑一次；refreshKey 变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅变化后重取一次（refreshKey 由 handlePackDataChanged 递增）
  useEffect(() => {
    if (!refreshKey) return;
    refreshState({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // 摘要里的「下次提醒」每分钟重新算一次，同时把过期的 nextFireAt 从主进程再取一遍
  useEffect(() => {
    const t = setInterval(() => {
      refreshState({ silent: true });
    }, SUMMARY_TICK_MS);
    return () => clearInterval(t);
  }, [refreshState]);

  // 关窗前把还没提交的设置尽量刷掉
  useEffect(() => {
    const onUnload = () => {
      if (pendingRef.current && api && typeof api.setSettings === 'function') {
        try {
          api.setSettings(pendingRef.current);
        } catch (_e) {
          /* 尽力而为 */
        }
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [api]);

  // 主进程广播：settings:changed / packs:changed
  useEffect(() => {
    if (!api) return undefined;
    const offs = [];

    if (typeof api.onSettingsChanged === 'function') {
      offs.push(
        api.onSettingsChanged((incoming) => {
          if (!incoming) return;
          // 自己刚提交、主进程回广播的旧版本：忽略，避免 UI 反弹
          if (pendingRef.current || timerRef.current) return;
          applyIncoming(incoming);
          refreshState({ silent: true });
        })
      );
    }

    // packs:changed 由 panel preload 提供（若该版本没暴露，就靠 settings:changed + 手动刷新兜底）
    if (typeof api.onPacksChanged === 'function') {
      offs.push(
        api.onPacksChanged(() => {
          refreshPacks().then(() => refreshState({ silent: true }));
        })
      );
    }

    return () => {
      offs.forEach((off) => {
        try {
          if (typeof off === 'function') off();
        } catch (_e) {
          /* 忽略 */
        }
      });
    };
  }, [api, applyIncoming, refreshPacks, refreshState]);

  /* ---------------- 底部工具栏：试看 / 立刻提醒 ---------------- */

  const describePath = (path) => {
    if (!path) return '';
    if (typeof path === 'string') return path;
    if (Array.isArray(path)) {
      return path
        .map((x) => (x && typeof x === 'object' ? x.name || x.id || '' : x))
        .filter(Boolean)
        .join(' → ');
    }
    if (typeof path !== 'object') return '';
    const nameOf = (v) => (v == null ? '' : typeof v === 'object' ? v.name || v.id || '' : String(v));
    const bits = [nameOf(path.category), nameOf(path.part), nameOf(path.level)];
    if (!bits.some(Boolean)) bits.push(nameOf(path.text), nameOf(path.label), nameOf(path.id));
    return bits.filter(Boolean).join(' → ');
  };

  const previewNext = async () => {
    if (!api || typeof api.previewNext !== 'function') {
      setStatus({ text: '当前主进程不支持预览下一条。', kind: 'err' });
      return;
    }
    setPreviewBusy(true);
    try {
      const res = await api.previewNext();
      // 兼容两种返回形态：{ move, pack, path } 或直接给 move 本身
      const payload = res && res.move ? res : res && (res.name || res.prompt) ? { move: res } : null;
      if (!payload || !payload.move) {
        setStatus({ text: '没有可用的动作：请检查「动作」区块里的勾选，或在下方添加订阅。', kind: 'err' });
        return;
      }
      const move = payload.move;
      const name = move.name || move.prompt || '未命名动作';
      const dur = num(move.durationSec, 30);
      const pathText = describePath(payload.path || payload.pathText);
      setStatus({ text: `下一条：${name} · ${dur}s${pathText ? ' · ' + pathText : ''}`, kind: 'ok' });
    } catch (e) {
      setStatus({ text: `预览失败：${errMsg(e)}`, kind: 'err' });
    } finally {
      setPreviewBusy(false);
    }
  };

  const fireNow = async () => {
    if (!api || typeof api.fireNow !== 'function') {
      setStatus({ text: '当前主进程不支持立刻提醒。', kind: 'err' });
      return;
    }
    setFireBusy(true);
    try {
      await flushSave();
      const res = await api.fireNow();
      const move = res && res.move ? res.move : null;
      if (res && res.reason) {
        setStatus({ text: `这次没有弹出：${res.reason}`, kind: 'err' });
      } else {
        setStatus({
          text: move ? `已弹出一次提醒：${move.name || move.prompt || ''}` : '已弹出一次提醒。',
          kind: 'ok'
        });
      }
      await refreshState({ silent: true });
    } catch (e) {
      setStatus({ text: `提醒失败：${errMsg(e)}`, kind: 'err' });
    } finally {
      setFireBusy(false);
    }
  };

  /**
   * 恢复默认设置：只重置「节奏」与勾选，不动已订阅的动作包（那是用户的资产，不该被一键清掉）。
   */
  const resetSettings = async () => {
    const keepPacks = Array.isArray(settings.activePackIds) ? settings.activePackIds.slice() : [];
    const defaults = normalizeSettings({ ...DEFAULT_SETTINGS, activePackIds: keepPacks });
    setSettings(defaults);
    pendingRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!api) return;
    try {
      await api.setSettings({
        intervalMin: defaults.intervalMin,
        popupSeconds: defaults.popupSeconds,
        shuffle: defaults.shuffle,
        showCountdown: defaults.showCountdown,
        activeHours: defaults.activeHours,
        categories: defaults.categories,
        levels: defaults.levels,
        enabled: defaults.enabled
      });
      setStatus({ text: '已恢复默认设置（订阅与动作包保持不变）。', kind: 'ok' });
      await refreshState({ silent: true });
    } catch (e) {
      setStatus({ text: `恢复默认失败：${errMsg(e)}`, kind: 'err' });
    }
  };

  /* ---------------- 顶部摘要 ---------------- */

  const enabledPackCount = useMemo(() => {
    if (!Array.isArray(packs) || packs.length === 0) return null;
    return packs.filter((p) => p && p.enabled !== false).length;
  }, [packs]);

  const nextText = useMemo(() => {
    if (!settings.enabled) return '总开关已关闭，不会自动提醒';
    const t = toTime(nextFireAt);
    if (!t) return settings.intervalMin ? `约 ${settings.intervalMin} 分钟后` : '间隔未设置';
    return `下次提醒 ${formatHM(t)}（约 ${relativeMin(t)}）`;
  }, [settings.enabled, settings.intervalMin, nextFireAt]);

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="app">
      <TitleBar title="休息一下" />

      <div className="app-body">
      {/* ---------- 侧边栏：品牌 + 三个 tab + 底部总开关 ---------- */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className={settings.enabled ? 'brand-dot' : 'brand-dot off'} aria-hidden="true" />
          <div className="sidebar-brand-text">
            <h1>休息一下</h1>
            <span>Take rest</span>
          </div>
        </div>

        <nav className="sidebar-nav" role="tablist" aria-label="主导航">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`nav-item${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span className="nav-dot" aria-hidden="true" />
              <span className="nav-text">
                <span className="nav-label">{t.label}</span>
                <span className="nav-hint">{t.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-switch">
            <span className="switch-label">{settings.enabled ? '提醒已开启' : '提醒已关闭'}</span>
            <Tooltip title="总开关：关闭后不再按间隔提醒">
              <Switch
                checked={settings.enabled}
                onChange={(checked) => patchSettings({ enabled: checked })}
              />
            </Tooltip>
          </div>
          <div className="sidebar-summary">
            已加载 <b>{actionCount || 0}</b> 个动作
            {enabledPackCount != null ? ` · ${enabledPackCount} 个包启用` : ''}
          </div>
        </div>
      </aside>

      {/* ---------- 右侧主区 ---------- */}
      <div className="main">
        <header className="top">
          <div className="top-main">
            <h2 className="page-title">{TABS.find((t) => t.key === tab)?.label || '主页'}</h2>
            <span className="page-sub">{loading ? '正在载入…' : nextText}</span>
          </div>
          {!api ? (
            <div className="bridge-warn">
              没有检测到 Electron 桥（window.api）。请用 <code>npm start</code> 启动应用，而不是直接用浏览器打开这个页面。
            </div>
          ) : null}
        </header>

      <main className="scroll">
        {tab === 'home' ? (
          <Home
            settings={settings}
            packs={packs}
            actionCount={actionCount}
            nextText={nextText}
            enabledPackCount={enabledPackCount}
            onPreview={previewNext}
            previewBusy={previewBusy}
            onFire={fireNow}
            fireBusy={fireBusy}
            onGotoActions={() => setTab('actions')}
            onGotoAppearance={() => setTab('appearance')}
          />
        ) : null}

        {tab === 'actions' ? (
          <>
            <Rhythm
              settings={settings}
              patch={patchSettings}
              markFocus={markFocus}
              clearFocus={clearFocus}
              disabled={!settings.enabled}
            />

            <ActionTree
              packs={packs}
              settings={settings}
              patch={patchSettings}
              onTogglePack={togglePackEnabled}
              onRefresh={() => refreshState({ silent: true }).then(refreshPacks)}
              onPreview={previewNext}
              previewBusy={previewBusy}
            />

            <Subscriptions packs={packs} onChanged={handlePackDataChanged} refreshKey={refreshKey} />
          </>
        ) : null}

        {tab === 'appearance' ? (
          <Appearance settings={settings} patch={patchSettings} markFocus={markFocus} clearFocus={clearFocus} />
        ) : null}

        <div className="scroll-pad" />
      </main>

      <footer className="toolbar">
        <Button onClick={resetSettings}>恢复默认设置</Button>
        <Button type="primary" onClick={fireNow} loading={fireBusy}>
          立刻提醒一次
        </Button>
        <div className={`toolbar-out${status ? ' ' + status.kind : ''}`}>
          {status ? status.text : ''}
        </div>
      </footer>
      </div>
      </div>
    </div>
  );
}
