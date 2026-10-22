/**
 * sections/ActionTree.jsx —— 「动作」区块：三级（其实到动作条目是四级）折叠树
 *
 *   类别（category） → 部位（part） → 幅度档位（move.level） → 动作条目（move）
 *
 * 唯一数据来源：props.packs[i].categories（来自 state:get）。
 * 这一层绝不去猜、不去拼别的数据：没有 categories 就只显示「动作包结构缺失」。
 *
 * 勾选语义（与主进程 engine/scheduler.js 一致）：
 *   - 类别层勾选框 ← settings.categories[类别名]，值为 false 时该类别整枝不参与抽取（整枝置灰）；
 *   - 档位层勾选框 ← settings.disabledPaths，里面存「类别/部位/档位」这样的完整路径。
 *     **每个部位各管各的**：关掉「身体/小腿/静音」不会影响「身体/腹部/静音」；
 *   - 动作条目本身不可单独勾选，颗粒度就到「类别 / 部位下的档位」这一层。
 *   - 树默认全部收起（进来先看到动作包与类别），需要时自己展开。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Empty, Space, Switch, Tag, Tooltip, Tree } from 'antd';
import { num, truncate } from '../../shared/format.js';

/** 幅度档位的固定顺序与文案（首版只实现「静音」的呈现） */
const LEVEL_ORDER = ['静音', '轻响', '震动'];
const LEVEL_LABEL = { 静音: '静音', 轻响: '轻响', 震动: '震动' };
const LEVEL_HINT = { 静音: '纯文字条', 轻响: '轻提示音（预留）', 震动: '轻微抖动（预留）' };

/**
 * 把 packs 摊平成「类别 → 部位 → 档位 → 条目」的结构。
 * 同名类别 / 同名部位会跨包合并（多个订阅里都有「身体 → 小腿」时合成一枝）。
 */
function collectTree(packs) {
  const categories = new Map(); // name -> { name, order, parts: Map }
  let missing = false; // 有包但没带 categories
  let totalMoves = 0;

  (packs || []).forEach((p) => {
    if (!p) return;
    const cats = Array.isArray(p.categories) ? p.categories : null;
    if (!cats) {
      missing = true;
      return;
    }
    cats.forEach((cat) => {
      if (!cat || !Array.isArray(cat.parts)) return;
      const catName = String(cat.name || cat.id || '未命名类别');
      let cnode = categories.get(catName);
      if (!cnode) {
        cnode = { name: catName, order: num(cat.order, 999), parts: new Map() };
        categories.set(catName, cnode);
      } else {
        cnode.order = Math.min(cnode.order, num(cat.order, 999));
      }
      cat.parts.forEach((part) => {
        if (!part) return;
        const partName = String(part.name || part.id || '未命名部位');
        let pnode = cnode.parts.get(partName);
        if (!pnode) {
          pnode = { name: partName, order: num(part.order, 999), levels: new Map() };
          cnode.parts.set(partName, pnode);
        } else {
          pnode.order = Math.min(pnode.order, num(part.order, 999));
        }
        const moves = Array.isArray(part.moves) ? part.moves : [];
        moves.forEach((mv) => {
          if (!mv) return;
          const level = LEVEL_ORDER.indexOf(mv.level) >= 0 ? mv.level : '静音';
          if (!pnode.levels.has(level)) pnode.levels.set(level, []);
          pnode.levels.get(level).push({ move: mv, packId: p.id || '', packName: p.name || '' });
          totalMoves += 1;
        });
      });
    });
  });

  const catList = Array.from(categories.values()).sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh')
  );
  catList.forEach((c) => {
    c.parts = Array.from(c.parts.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'));
    c.parts.forEach((pt) => {
      pt.levels = LEVEL_ORDER.filter((lv) => pt.levels.has(lv)).map((lv) => ({
        level: lv,
        items: pt.levels.get(lv).sort(
          (a, b) =>
            num(a.move.order, 999) - num(b.move.order, 999) ||
            String(a.move.name || '').localeCompare(String(b.move.name || ''), 'zh')
        )
      }));
    });
  });

  return { catList, missing, totalMoves };
}

/** 一个类别下的动作总数 */
function countCat(cat) {
  return cat.parts.reduce((n, pt) => n + pt.levels.reduce((m, l) => m + l.items.length, 0), 0);
}

/** 单个动作条目的内容：名称 / id / 口令 / 剂量 / 时长 / 标签 */
function MoveRow({ item, dimmed }) {
  const mv = item.move || {};
  const dur = num(mv.durationSec, 30);
  const prompt = typeof mv.prompt === 'string' && mv.prompt ? mv.prompt : '';
  const detail = typeof mv.detail === 'string' && mv.detail ? mv.detail : '';
  // 分段动作：正文由各段生成，这里额外显示「一轮 Xs × N 次」帮助核对节奏
  const phases = Array.isArray(mv.phases) ? mv.phases : [];
  const isPhased = phases.length > 0;
  const cycleSec = isPhased
    ? phases.reduce((a, b) => a + (num(b.sec, 0) || 0), 0) + (phases.length - 1) * num(mv.transitionSec, 2)
    : 0;
  return (
    <div className={`move-row${dimmed ? ' off' : ''}`}>
      <div className="move-name">
        <span className="move-title">{String(mv.name || '未命名动作')}</span>
        {mv.id ? <code className="move-id">{String(mv.id)}</code> : null}
      </div>
      {prompt ? <div className="move-prompt">{prompt}</div> : detail ? <div className="move-prompt">{detail}</div> : null}
      <div className="move-meta">
        <Tag color={dimmed ? undefined : 'green'} className="tag">
          {LEVEL_LABEL[mv.level] || mv.level || '静音'}
        </Tag>
        {isPhased ? (
          <Tag className="tag">
            {phases.length} 步 · 一轮 {cycleSec}s × {num(mv.reps, 1)} 次
          </Tag>
        ) : mv.dosage ? (
          <Tag className="tag">{String(mv.dosage)}</Tag>
        ) : null}
        <Tag className="tag dur">{dur}s</Tag>
        {prompt && detail ? <Tag className="tag">{truncate(detail, 26)}</Tag> : null}
        {item.packName ? <Tag className="tag pack">{String(item.packName)}</Tag> : null}
        {(Array.isArray(mv.tags) ? mv.tags : []).slice(0, 3).map((t, i) => (
          <Tag className="tag" key={`${String(t)}-${i}`}>
            {String(t)}
          </Tag>
        ))}
      </div>
    </div>
  );
}

export default function ActionTree({ packs, settings, patch, onTogglePack, onRefresh, onPreview, previewBusy }) {
  const { catList, missing, totalMoves } = useMemo(() => collectTree(packs), [packs]);

  const cats = settings.categories || {};
  // 细粒度开关：形如「身体/小腿/静音」，同一档位在不同部位下互不影响
  const disabledPaths = Array.isArray(settings.disabledPaths) ? settings.disabledPaths : [];
  const catOn = (name) => cats[name] !== false;
  /** 某个部位下的某个档位是否启用（不与其他部位联动） */
  const levelOn = (catName, partName, lv) => !disabledPaths.includes(`${catName}/${partName}/${lv}`);

  /** 树上所有节点的 key（用来判断是否需要重置展开状态） */
  const allKeys = useMemo(() => {
    const keys = { cats: [], parts: [], levels: [] };
    catList.forEach((c) => {
      const ck = `cat:${c.name}`;
      keys.cats.push(ck);
      c.parts.forEach((pt) => {
        const pk = `${ck}|part:${pt.name}`;
        keys.parts.push(pk);
        pt.levels.forEach((lv) => keys.levels.push(`${pk}|level:${lv.level}`));
      });
    });
    return keys;
  }, [catList]);

  const [expandedKeys, setExpandedKeys] = useState([]);
  const dataSignature = useMemo(() => allKeys.cats.concat(allKeys.parts, allKeys.levels).join('§'), [allKeys]);
  const signatureRef = useRef('');

  // 数据变化时只做一件事：把已经不存在的 key 从展开集合里清掉。
  // 默认保持「全部收起」——进来先看到动作包与类别，需要时再自己展开，
  // 而不是一进来就把几十条口诀摊在屏幕上。
  useEffect(() => {
    if (signatureRef.current === dataSignature) return;
    signatureRef.current = dataSignature;
    setExpandedKeys((prev) =>
      prev.filter((k) => allKeys.cats.includes(k) || allKeys.parts.includes(k) || allKeys.levels.includes(k))
    );
  }, [dataSignature, allKeys]);

  const toggleCategory = (name, checked) => {
    patch({ categories: { ...cats, [name]: !!checked } });
  };

  /**
   * 切换某个部位下某个档位的启用状态。
   * 只动这一条路径（「类别/部位/档位」），不去碰别的部位——之前用全局 levels 映射，
   * 点一个小腿的「静音」会把腹部、颈肩背的「静音」一起改掉，那是错的。
   */
  const toggleLevel = (catName, partName, lv, checked) => {
    const key = `${catName}/${partName}/${lv}`;
    const set = new Set(disabledPaths);
    if (checked) set.delete(key);
    else set.add(key);
    patch({ disabledPaths: Array.from(set) });
  };

  /** 类别勾选框 */
  const catCheckbox = (name) => (
    <span className="node-check" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Checkbox checked={catOn(name)} onChange={(e) => toggleCategory(name, e.target.checked)}>
        参与
      </Checkbox>
    </span>
  );

  /** 档位勾选框（每个部位各一份，互不联动） */
  const levelCheckbox = (catName, partName, lv) => (
    <span className="node-check" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Tooltip title={LEVEL_HINT[lv] || ''}>
        <Checkbox
          checked={levelOn(catName, partName, lv)}
          onChange={(e) => toggleLevel(catName, partName, lv, e.target.checked)}
        >
          启用
        </Checkbox>
      </Tooltip>
    </span>
  );

  const treeData = useMemo(
    () =>
      catList.map((cat) => {
        const catDim = !catOn(cat.name);
        return {
          key: `cat:${cat.name}`,
          className: `tree-cat${catDim ? ' dimmed-branch' : ''}`,
          title: (
            <span className="node-head">
              <span className="node-title">类别 · {cat.name}</span>
              <span className="node-count">{countCat(cat)} 个动作</span>
              {catCheckbox(cat.name)}
            </span>
          ),
          children: cat.parts.map((part) => {
            const partKey = `cat:${cat.name}|part:${part.name}`;
            const partCount = part.levels.reduce((n, l) => n + l.items.length, 0);
            return {
              key: partKey,
              className: `tree-part${catDim ? ' dimmed-branch' : ''}`,
              title: (
                <span className="node-head">
                  <span className="node-title">部位 · {part.name}</span>
                  <span className="node-count">{partCount} 个动作</span>
                </span>
              ),
              children: part.levels.map((lv) => {
                const lvDim = catDim || !levelOn(cat.name, part.name, lv.level);
                return {
                  key: `${partKey}|level:${lv.level}`,
                  className: `tree-level${lvDim ? ' dimmed-branch' : ''}`,
                  title: (
                    <span className="node-head">
                      <span className="node-title">
                        档位 · {LEVEL_LABEL[lv.level] || lv.level}
                        <span className="node-sub">{LEVEL_HINT[lv.level] || ''}</span>
                      </span>
                      <span className="node-count">{lv.items.length} 个</span>
                      {levelCheckbox(cat.name, part.name, lv.level)}
                    </span>
                  ),
                  children: lv.items.map((item, idx) => ({
                    key: `${partKey}|level:${lv.level}|move:${item.packId}:${item.move.id || item.move.name}:${idx}`,
                    isLeaf: true,
                    className: `tree-move${lvDim ? ' dimmed-branch' : ''}`,
                    title: <MoveRow item={item} dimmed={lvDim} />
                  }))
                };
              })
            };
          })
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catList, cats, disabledPaths]
  );

  const expandAll = () => setExpandedKeys(allKeys.cats.concat(allKeys.parts, allKeys.levels));
  const collapseAll = () => setExpandedKeys(allKeys.cats); // 类别层保留展开，避免整块变空白

  const hasPacks = Array.isArray(packs) && packs.length > 0;

  return (
    <section className="card" id="sec-actions">
      <div className="card-head">
        <h2>动作</h2>
        <p>类别 → 部位 → 幅度档位 → 动作。取消勾选类别，它下面整枝都不参与抽取。</p>
      </div>
      <div className="card-body">
        {/* 动作包开关：勾掉某个包，它里面的动作就不再被抽到 */}
        {hasPacks ? (
          <div className="pack-strip">
            <span className="pack-strip-label">动作包</span>
            <Space size={8} wrap>
              {packs.map((p) => (
                <span className="pack-chip" key={p.id || p.name}>
                  <Switch
                    size="small"
                    checked={p.enabled !== false}
                    onChange={(v) => onTogglePack && onTogglePack(p.id, v)}
                  />
                  <span className="pack-name">{p.name || p.id || '未命名动作包'}</span>
                  <span className="pack-count">{num(p.count, 0)} 个</span>
                  {p.origin ? <Tag className="tag origin">{p.origin}</Tag> : null}
                </span>
              ))}
            </Space>
          </div>
        ) : null}

        <div className="tree-tools">
          <Button size="small" onClick={expandAll} disabled={!totalMoves}>
            全部展开
          </Button>
          <Button size="small" onClick={collapseAll} disabled={!totalMoves}>
            全部收起
          </Button>
          <Button size="small" onClick={() => onRefresh && onRefresh()}>
            刷新
          </Button>
          <Button size="small" onClick={() => onPreview && onPreview()} loading={previewBusy}>
            试看下一条
          </Button>
          <span className="inline-note">
            {totalMoves ? `共 ${catList.length} 个类别 / ${totalMoves} 个动作` : ''}
          </span>
        </div>

        <div className="tree-wrap">
          {catList.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                missing
                  ? '动作包结构缺失（state.packs[].categories 没拿到），请重启软件。'
                  : !hasPacks
                    ? '还没有动作包。请在下方「订阅」里添加 GitHub 动作包，或点击「本地导入 JSON 文件」。'
                    : '动作包里没有可用的动作条目，请检查包的 categories 是否为空。'
              }
            />
          ) : (
            <Tree
              checkable={false}
              selectable={false}
              showLine={false}
              blockNode
              treeData={treeData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              className="action-tree"
            />
          )}
        </div>
      </div>
    </section>
  );
}
