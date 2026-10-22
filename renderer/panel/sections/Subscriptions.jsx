/**
 * sections/Subscriptions.jsx —— 「订阅」区块
 *
 * 能力：
 *   1. 输入框 + 添加按钮 —— 走 shared/gh.js 的 addSubscription(api, input)：
 *        normalizeRepoInput → 逐个试 manifest.json → 分支探测 → 拉 packs → subscriptions:install
 *      （所有 HTTPS 请求都由主进程的 gh:request 转发，渲染进程不直连，避免 CORS）
 *   2. 已订阅列表 —— 名称 / 来源 / 上次同步 / 动作包数 / 失败红字
 *   3. 立即同步（单个 + 全部）
 *   4. 本地导入 JSON 文件（只收单个动作包 gongwei-tixing-pack/1）
 *   5. 一段折叠的动作包格式说明
 *
 * 本文件不存权威 settings；订阅装完通过 props.onChanged 让 App 全量重取。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Input, Space, Spin, Tag, Tooltip } from 'antd';
import GH from '../../shared/gh.js';
import { errMsg, formatFull, num, toTime } from '../../shared/format.js';

/** 记住最后一次粘进来的订阅地址（localStorage 键） */
const LAST_INPUT_KEY = 'desk-reminder:lastSubInput';

/**
 * 把 subscription:status 的 sources 与 packs 摘要合成一份「给列表看」的数据。
 * 主进程 sources 条目形如 { name, source, dir, packs:[packId], installedAt, lastSyncAt }，
 * 其中 packs 是「包 id 数组」，用它算每个来源的包数 / 启用数。
 */
function normalizeSubs(status, packs) {
  const out = [];
  const seen = new Set();
  const packById = new Map();
  (packs || []).forEach((p) => {
    if (p && p.id) packById.set(p.id, p);
  });

  const push = (o) => {
    if (!o) return;
    const source = String(o.source == null ? '' : o.source).trim();
    const name = String(o.name || '').trim();
    const key = source || name;
    if (!key || seen.has(key)) return;
    seen.add(key);

    const ids = Array.isArray(o.packs) ? o.packs : [];
    const packCount = num(
      o.packCount != null
        ? o.packCount
        : ids.length
          ? ids.length
          : o.count != null
            ? o.count
            : Array.isArray(o.packs)
              ? o.packs.length
              : 0,
      0
    );
    // 启用情况：用包 id 去对 packs 摘要里的 enabled（摘要里没有就不知道）
    let enabledCount = null;
    let known = 0;
    ids.forEach((id) => {
      const p = packById.get(id);
      if (!p) return;
      known += 1;
      if (p.enabled !== false) enabledCount = (enabledCount || 0) + 1;
    });
    if (known === 0) enabledCount = null;

    out.push({
      name: name || source || '未命名订阅',
      source,
      packCount,
      enabledCount,
      lastSyncAt: o.lastSyncAt != null ? o.lastSyncAt : o.syncedAt != null ? o.syncedAt : null,
      installedAt: o.installedAt != null ? o.installedAt : null,
      // source 为空是正常的（本地导入 / 索引里还没登记来源），不能当成「无来源」错误
      error: o.lastSyncError || o.error || ''
    });
  };

  if (status) {
    const raw = status.sources;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.keys(raw).map((k) => ({ source: k, ...(raw[k] || {}) }))
        : [];
    list.forEach((s) => {
      if (typeof s === 'string') {
        push({ name: s, source: s, lastSyncAt: status.lastSyncAt, error: status.lastSyncError });
      } else {
        push({ lastSyncAt: status.lastSyncAt, error: status.lastSyncError, ...s });
      }
    });
    // 全局错误：没有具体来源可显示时平铺一条
    if (status.lastSyncError && list.length === 0) {
      push({ name: '订阅同步', source: '', error: status.lastSyncError, lastSyncAt: status.lastSyncAt });
    }
  }

  // 兜底：packs 摘要里带 GitHub 来源、但上面的来源列表没覆盖到的，补一条
  (packs || []).forEach((p) => {
    if (!p) return;
    const src = String(p.source || '').trim();
    if (!/^https?:\/\/(raw\.)?github(user)?(usercontent)?\.com\//i.test(src)) return;
    if (seen.has(src)) return;
    push({ name: p.name || src, source: src, packs: [p.id], lastSyncAt: null });
  });

  return out;
}

/** 统一的同步调用：永不让异常逃出去 */
async function safeSync(api, payload) {
  try {
    const res = await api.syncSubscription(payload);
    let error = res && res.ok === false ? res.error || '同步失败' : res && (res.error || res.lastSyncError);
    if (!error && res && Array.isArray(res.results)) {
      const bad = res.results.filter((r) => r && r.ok === false);
      if (bad.length) error = bad.map((r) => r.error || '未知原因').join('；');
    }
    return { ok: !error, error: error || '', res };
  } catch (e) {
    return { ok: false, error: errMsg(e), res: null };
  }
}

const GUIDE_ITEMS = [
  {
    key: 'guide',
    label: '怎么在自己的 GitHub 仓库里放动作包？',
    children: (
      <div className="guide-body">
        <p>
          在仓库根目录放一个 <code>manifest.json</code> 指明有哪些包：
        </p>
        <pre>{`{
  "format": "gongwei-tixing-registry/1",
  "name": "我的提醒动作",
  "packs": [
    "packs/工位五连环.json"
  ]
}`}</pre>
        <p>
          每个动作包是一个 JSON 文件，三级结构是「类别 → 部位 → 幅度档位」，幅度档位首版只有 <code>静音</code>：
        </p>
        <pre>{`{
  "format": "gongwei-tixing-pack/1",
  "id": "my-desk-pack",
  "name": "我的工位动作",
  "version": "1.0.0",
  "description": "随手加的提醒动作",
  "categories": [
    {
      "id": "body", "name": "身体", "order": 1,
      "parts": [
        {
          "id": "calf", "name": "小腿", "order": 1,
          "moves": [
            {
              "id": "my-calf-raise",
              "level": "静音",
              "name": "坐姿踮脚",
              "order": 1,
              "prompt": "坐姿踮脚 · 脚平踩用力踮脚尖，停 2 秒重重放下 · 连做 20 个",
              "detail": "久坐后把血泵回心脏",
              "dosage": "连续做 20 个",
              "durationSec": 40,
              "tags": ["下肢泵血"]
            }
          ]
        }
      ]
    }
  ]
}`}</pre>
        <ul>
          <li>
            <code>level</code> 必须是 <code>静音</code> / <code>轻响</code> / <code>震动</code> 之一，缺省补{' '}
            <code>静音</code>。
          </li>
          <li>
            <code>prompt</code> 就是弹窗上那一整行字，用 <code> · </code> 分隔「动作 · 要领 · 数量」，控制在 40 字内。
          </li>
          <li>
            <code>durationSec</code> 缺省 30；面板里「弹出停留 = 0」时就用它。
          </li>
          <li>动作包也可以单独放在一个分支上（比如 packs 分支），面板会自动跨分支找 manifest.json。</li>
          <li>不需要服务器：推到 GitHub 后，把仓库地址粘到上面的输入框即可。</li>
        </ul>
      </div>
    )
  }
];

export default function Subscriptions({ packs, onChanged, refreshKey }) {
  const api = typeof window !== 'undefined' ? window.api || null : null;

  // 输入框记住上次填过的地址：订阅源清单本身由主进程持久化在 subscriptions.json，
  // 这里只是把「最后粘过的那条」也留在本地，重启后不用重新找仓库地址。
  const readLastInput = () => {
    try {
      return window.localStorage.getItem(LAST_INPUT_KEY) || '';
    } catch (_e) {
      return '';
    }
  };
  const [input, setInputState] = useState(readLastInput);
  const setInput = (v) => {
    setInputState(v);
    try {
      if (v) window.localStorage.setItem(LAST_INPUT_KEY, v);
      else window.localStorage.removeItem(LAST_INPUT_KEY);
    } catch (_e) {
      /* 隐私模式等场景忽略 */
    }
  };
  const [subs, setSubs] = useState([]);
  const [status, setStatus] = useState({ kind: '', text: '' }); // 顶部表单消息
  const [importStatus, setImportStatus] = useState({ kind: '', text: '' });
  const [adding, setAdding] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingOne, setSyncingOne] = useState('');
  const [loadingSubs, setLoadingSubs] = useState(true);
  const fileRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshSubscriptionStatus = useCallback(async () => {
    if (!api || typeof api.subscriptionStatus !== 'function') {
      setLoadingSubs(false);
      setSubs(normalizeSubs(null, packs));
      return;
    }
    try {
      const st = await api.subscriptionStatus();
      if (!aliveRef.current) return;
      setSubs(normalizeSubs(st, packs));
    } catch (_e) {
      if (aliveRef.current) setSubs(normalizeSubs(null, packs));
    } finally {
      if (aliveRef.current) setLoadingSubs(false);
    }
  }, [api, packs]);

  // packs 变化（装包 / 同步 / 开关）后重算列表里的包数与启用数
  useEffect(() => {
    refreshSubscriptionStatus();
  }, [refreshSubscriptionStatus, refreshKey]);

  /** 订阅数据变了：刷新自己的列表 → 通知 App 全量重取 */
  const afterChange = async () => {
    await refreshSubscriptionStatus();
    if (onChanged) await onChanged();
    // 包 id → categories 变了，重算一次
    if (typeof api?.subscriptionStatus === 'function') await refreshSubscriptionStatus();
  };

  /* ---------------- 添加订阅 ---------------- */

  const addSubscription = async () => {
    const value = input.trim();
    if (!value) {
      setStatus({ kind: 'err', text: '请先粘贴 GitHub 仓库地址或 raw JSON 地址。' });
      return;
    }
    if (!api) {
      setStatus({ kind: 'err', text: '没有检测到 Electron 桥（window.api），无法添加订阅。' });
      return;
    }
    setAdding(true);
    setStatus({ kind: 'busy', text: '正在拉取 manifest.json 与动作包…' });
    try {
      const result = await GH.addSubscription(api, value);
      const branchText = result.branch && result.branch !== 'HEAD' ? `（动作包分支：${result.branch}）` : '';
      setStatus({
        kind: 'ok',
        text: `已添加订阅「${result.name}」，共 ${result.packs.length} 个动作包${branchText}。`
      });
      setInput('');
      await afterChange();
    } catch (e) {
      setStatus({ kind: 'err', text: errMsg(e) });
    } finally {
      if (aliveRef.current) setAdding(false);
    }
  };

  /* ---------------- 同步 ---------------- */

  const syncOne = async (sub) => {
    if (!api || typeof api.syncSubscription !== 'function') {
      setStatus({ kind: 'err', text: '当前主进程不支持单条同步，请用「立即同步」手动刷新。' });
      return;
    }
    if (!sub.source) {
      setStatus({ kind: 'err', text: `「${sub.name}」是本地导入的，没有远程地址，无法同步。` });
      return;
    }
    setSyncingOne(sub.source);
    setStatus({ kind: 'busy', text: `正在同步「${sub.name}」…` });
    const settled = await safeSync(api, { source: sub.source });
    if (!aliveRef.current) return;
    setStatus(
      settled.ok
        ? { kind: 'ok', text: `「${sub.name}」同步完成。` }
        : { kind: 'err', text: `「${sub.name}」同步失败：${settled.error}（已保留本地旧动作）` }
    );
    await afterChange();
    if (aliveRef.current) setSyncingOne('');
  };

  const syncAll = async () => {
    if (!api || typeof api.syncSubscription !== 'function') {
      setStatus({ kind: 'err', text: '当前主进程不支持手动同步。' });
      return;
    }
    setSyncingAll(true);
    setStatus({ kind: 'busy', text: '正在同步所有订阅…' });
    const settled = await safeSync(api, { source: '' });
    if (!aliveRef.current) return;
    setStatus(
      settled.ok
        ? { kind: 'ok', text: '同步完成。' }
        : { kind: 'err', text: `同步失败：${settled.error}（已保留本地旧缓存）` }
    );
    await afterChange();
    if (aliveRef.current) setSyncingAll(false);
  };

  /* ---------------- 本地导入 ---------------- */

  const importFile = async (file) => {
    setImportStatus({ kind: '', text: '' });
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      setImportStatus({ kind: 'err', text: '只支持 .json 文件。' });
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (e) {
      setImportStatus({ kind: 'err', text: `读取文件失败：${errMsg(e)}` });
      return;
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      setImportStatus({
        kind: 'err',
        text: `这个文件不是合法的 JSON：${errMsg(e)}。请检查文件是否完整、有没有多余的逗号。`
      });
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setImportStatus({ kind: 'err', text: '文件内容应该是一个 JSON 对象（动作包）。' });
      return;
    }

    // 先用 gh.js 的校验器统一口径（format 不对 / 没有 categories 都会给中文原因）
    try {
      GH.validatePack(obj, file.name);
    } catch (e) {
      setImportStatus({
        kind: 'err',
        text: `${errMsg(e)}。如果你导入的是 manifest.json（订阅清单），请改用上面的「添加订阅」。`
      });
      return;
    }
    if (!api || typeof api.installSubscription !== 'function') {
      setImportStatus({ kind: 'err', text: '当前主进程不支持安装订阅，无法导入。' });
      return;
    }

    const name = String(obj.name || obj.id || file.name.replace(/\.json$/i, ''));
    setImportStatus({ kind: 'busy', text: `正在导入「${name}」…` });
    try {
      const res = await api.installSubscription({ name, source: 'local', packs: [obj] });
      // 主进程失败时不一定抛错，而是返回 { ok:false, error }
      if (res && res.ok === false) {
        setImportStatus({ kind: 'err', text: `导入失败：${res.error || '主进程拒绝了这次导入'}` });
        return;
      }
      setImportStatus({ kind: 'ok', text: `已导入「${name}」，动作已写入本地。` });
      await afterChange();
    } catch (e) {
      if (aliveRef.current) setImportStatus({ kind: 'err', text: `导入失败：${errMsg(e)}` });
    }
  };

  /* ---------------- 渲染 ---------------- */

  const statusType = status.kind === 'err' ? 'error' : status.kind === 'ok' ? 'success' : 'info';
  const importType = importStatus.kind === 'err' ? 'error' : importStatus.kind === 'ok' ? 'success' : 'info';

  const subList = useMemo(() => subs, [subs]);

  return (
    <section className="card" id="sec-subs">
      <div className="card-head">
        <h2>订阅</h2>
        <p>粘贴 GitHub 仓库地址，拉取里面 manifest.json 声明的动作包。</p>
      </div>
      <div className="card-body">
        {/* ---------- 添加 ---------- */}
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={addSubscription}
            placeholder="https://github.com/用户名/仓库名 或 raw.githubusercontent.com/…/manifest.json"
            allowClear
            disabled={adding}
          />
          <Button type="primary" onClick={addSubscription} loading={adding}>
            添加订阅
          </Button>
        </Space.Compact>
        {status.text ? (
          <Alert className="form-alert" type={statusType} showIcon message={status.text} />
        ) : null}

        {/* ---------- 已订阅 ---------- */}
        <div className="sub-list-head">
          <span className="label">已添加的订阅</span>
          <Tooltip title="重新拉取所有订阅源（失败时保留本地旧缓存）">
            <Button size="small" onClick={syncAll} loading={syncingAll} disabled={syncingAll}>
              立即同步
            </Button>
          </Tooltip>
        </div>

        <Spin spinning={loadingSubs}>
          <div className="sub-list">
            {subList.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有订阅任何动作包。把 GitHub 仓库地址粘到上面的输入框，点「添加订阅」即可。"
              />
            ) : (
              subList.map((sub) => {
                const t = toTime(sub.lastSyncAt);
                const it = toTime(sub.installedAt);
                return (
                  <div className="sub-item" key={`${sub.source}|${sub.name}`}>
                    <div className="sub-item-top">
                      <span className="sub-name">{sub.name}</span>
                      {sub.packCount ? (
                        <Tag color={sub.enabledCount ? 'green' : undefined} className="tag">
                          {sub.enabledCount == null
                            ? `${sub.packCount} 个动作包`
                            : sub.enabledCount === sub.packCount
                              ? `${sub.packCount} 个动作包`
                              : `${sub.packCount} 个动作包 / ${sub.enabledCount} 个启用`}
                        </Tag>
                      ) : null}
                      <span className="sub-spacer" />
                      <Button
                        size="small"
                        onClick={() => syncOne(sub)}
                        loading={syncingOne === sub.source}
                        disabled={!sub.source || syncingOne === sub.source}
                      >
                        立即同步
                      </Button>
                    </div>
                    <div className="sub-src">{sub.source || '本地导入（没有远程来源）'}</div>
                    <div className="sub-meta">
                      <span>{t ? `上次同步：${formatFull(t)}` : '上次同步：（从未同步）'}</span>
                      {it ? <span>添加于 {formatFull(it)}</span> : null}
                    </div>
                    {sub.error ? <div className="sub-error">同步失败：{sub.error}</div> : null}
                  </div>
                );
              })
            )}
          </div>
        </Spin>

        {/* ---------- 本地导入 ---------- */}
        <div className="import-line">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files && e.target.files[0];
              e.target.value = ''; // 允许重复选同一个文件
              importFile(file);
            }}
          />
          <Button onClick={() => fileRef.current && fileRef.current.click()}>本地导入 JSON 文件</Button>
          <span className="inline-note">
            支持单个动作包文件（format = gongwei-tixing-pack/1），导入后写入本地订阅目录。
          </span>
        </div>
        {importStatus.text ? (
          <Alert className="form-alert" type={importType} showIcon message={importStatus.text} />
        ) : null}

        {/* ---------- 格式说明（折叠） ---------- */}
        <Collapse className="guide" ghost items={GUIDE_ITEMS} />
      </div>
    </section>
  );
}
