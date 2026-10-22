/**
 * sections/Home.jsx —— 「主页」区块
 *
 * 只做概览：开没开、什么时候下一次、装了几个动作包、总共多少条动作，
 * 外加两个最常用的动作（试看一次 / 立刻提醒），以及订阅入口的快捷跳转。
 * 真正的设置在「动作」「样式」两个 tab 里。
 */
import React from 'react';
import { Button, Empty, Space, Tag } from 'antd';

/** 一行统计 */
function Stat({ label, value, hint }) {
  return (
    <div className="home-stat">
      <span className="home-stat-label">{label}</span>
      <span className="home-stat-value">{value}</span>
      {hint ? <span className="home-stat-hint">{hint}</span> : null}
    </div>
  );
}

export default function Home({
  settings,
  packs,
  actionCount,
  nextText,
  enabledPackCount,
  onPreview,
  previewBusy,
  onFire,
  fireBusy,
  onGotoActions,
  onGotoAppearance
}) {
  const enabled = settings.enabled !== false;
  const packList = Array.isArray(packs) ? packs : [];

  return (
    <>
      <section className="card" id="sec-home-status">
        <div className="card-head">
          <h2>当前状态</h2>
          <p>一眼看清现在什么节奏、下次什么时候提醒。</p>
        </div>
        <div className="card-body">
          <div className="home-grid">
            <Stat label="提醒开关" value={enabled ? '已开启' : '已关闭'} hint={enabled ? '' : '打开左上角总开关才会自动提醒'} />
            <Stat label="提醒间隔" value={`${settings.intervalMin} 分钟`} />
            <Stat label="下次提醒" value={nextText} />
            <Stat
              label="动作"
              value={`${actionCount || 0} 条`}
              hint={enabledPackCount != null ? `${enabledPackCount} 个动作包启用` : ''}
            />
          </div>
          <Space size={10} style={{ marginTop: 16 }}>
            <Button onClick={onPreview} loading={previewBusy}>
              试看下一条
            </Button>
            <Button type="primary" onClick={onFire} loading={fireBusy}>
              立刻提醒一次
            </Button>
          </Space>
        </div>
      </section>

      <section className="card" id="sec-home-packs">
        <div className="card-head">
          <h2>动作包</h2>
          <p>已安装的动作包；勾选与订阅管理在「动作」里。</p>
        </div>
        <div className="card-body">
          {packList.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有动作包。去「动作」里添加 GitHub 订阅，或导入本地 JSON。"
            />
          ) : (
            <>
              <div className="home-pack-list">
                {packList.map((p) => (
                  <div className="home-pack" key={p.id || p.name}>
                    <span className="home-pack-name">{p.name || p.id || '未命名动作包'}</span>
                    <span className="home-pack-count">{p.count || 0} 条</span>
                    {p.origin ? (
                      <Tag className="tag origin">{p.origin === 'builtin' ? '内置' : p.origin === 'subscription' ? '订阅' : '本地'}</Tag>
                    ) : null}
                    {p.enabled === false ? <Tag className="tag origin">未启用</Tag> : null}
                  </div>
                ))}
              </div>
              <Space size={10} style={{ marginTop: 14 }}>
                <Button onClick={onGotoActions}>管理动作与订阅</Button>
                <Button onClick={onGotoAppearance}>调整提醒条样式</Button>
              </Space>
            </>
          )}
        </div>
      </section>
    </>
  );
}
