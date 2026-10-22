/**
 * sections/Rhythm.jsx —— 「节奏」区块
 *
 * 决定多久提醒一次、提醒条停多久、什么时段打扰你。
 * 所有改动都通过 props.patch 交给 App.jsx 做乐观更新 + 300ms 防抖提交，
 * 本文件不发 IPC、不存权威状态。
 *
 * 焦点保护：InputNumber / TimePicker 获得焦点时登记字段名（markFocus），
 * 失焦时注销（clearFocus），这样广播回流不会打断正在输入的框。
 */
import React, { useMemo } from 'react';
import { Checkbox, Form, InputNumber, Space } from 'antd';
import { clampNum, pad2 } from '../../shared/format.js';

/** 间隔快捷值（分钟） */
const INTERVAL_PRESETS = [10, 20, 30, 45, 60];

/** 弹出停留快捷值（秒）：0 = 跟随动作自带的 durationSec */
const POPUP_PRESETS = [0, 5, 8, 12];

// 标签列宽与 panel.css 里 `.rhythm-form .ant-form-item-label { flex: 0 0 250px }` 保持一致，
// 两边写成同一个值，避免内联样式把 CSS 排版顶掉。
const labelCol = { flex: '0 0 250px' };
const wrapperCol = { flex: '1 1 auto' };

/** 一行的标签 + 说明 */
function RowLabel({ title, hint }) {
  return (
    <div className="row-label">
      <span className="label">{title}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export default function Rhythm({ settings, patch, markFocus, clearFocus, disabled }) {
  const interval = settings.intervalMin;
  const popupSeconds = settings.popupSeconds;
  const { start, end } = settings.activeHours || { start: null, end: null };

  const activeHoursNote = useMemo(() => {
    if (start == null && end == null) return '全天提醒';
    if (start != null && end != null) return `只在 ${pad2(start)}:00 - ${pad2(end)}:00 提醒`;
    return '开始/结束都要填才会限制时段';
  }, [start, end]);

  /** 更新生效时段：只把变化的那一端写回 settings */
  const commitHours = (nextStart, nextEnd) => {
    patch({ activeHours: { start: nextStart, end: nextEnd } });
  };

  return (
    <section className={`card${disabled ? ' dimmed' : ''}`} id="sec-rhythm">
      <div className="card-head">
        <h2>节奏</h2>
        <p>决定多久提醒一次、提醒条停多久、什么时段打扰你。</p>
      </div>
      <div className="card-body">
        <Form layout="horizontal" colon={false} labelCol={labelCol} wrapperCol={wrapperCol} className="rhythm-form">
          {/* ---------- 提醒间隔 ---------- */}
          <Form.Item label={<RowLabel title="提醒间隔" hint="到点就在任务栏上方弹一条" />}>
            <Space size={10} wrap>
              <span className="num-wrap">
                <InputNumber
                  className="num"
                  min={1}
                  max={600}
                  step={1}
                  precision={0}
                  value={interval}
                  onFocus={() => markFocus('intervalMin')}
                  onBlur={() => clearFocus('intervalMin')}
                  onChange={(v) => {
                    if (v == null) return; // 清空时不提交，等失焦或重填
                    patch({ intervalMin: clampNum(v, 1, 600, 20) });
                  }}
                />
                <span className="unit">分钟</span>
              </span>
              <span className="chips">
                {INTERVAL_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip${Number(interval) === m ? ' on' : ''}`}
                    onClick={() => patch({ intervalMin: m })}
                  >
                    {m}
                  </button>
                ))}
              </span>
            </Space>
          </Form.Item>

          {/* ---------- 弹出停留：设计图是分段胶囊 ---------- */}
          <Form.Item label={<RowLabel title="弹出停留" hint="提醒条在屏幕上停留多久；0 = 跟随动作自带时长" />}>
            <Space size={10} wrap={false}>
              <span className="chips">
                {POPUP_PRESETS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip${Number(popupSeconds) === s ? ' on' : ''}`}
                    onClick={() => patch({ popupSeconds: s })}
                  >
                    {s === 0 ? '自动' : `${s} 秒`}
                  </button>
                ))}
              </span>
              <span className="num-wrap">
                <InputNumber
                  className="num"
                  min={0}
                  max={600}
                  step={1}
                  precision={0}
                  value={popupSeconds}
                  onFocus={() => markFocus('popupSeconds')}
                  onBlur={() => clearFocus('popupSeconds')}
                  onChange={(v) => {
                    if (v == null) return;
                    patch({ popupSeconds: clampNum(v, 0, 600, 0) });
                  }}
                />
                <span className="unit">秒</span>
              </span>
            </Space>
          </Form.Item>

          {/* ---------- 动作顺序：设计图是方形勾选框 ---------- */}
          <Form.Item label={<RowLabel title="随机顺序" hint="不勾选 = 按包里 order 顺序循环走" />}>
            <Checkbox
              checked={settings.shuffle}
              onChange={(e) => patch({ shuffle: e.target.checked })}
            >
              随机抽取下一条
            </Checkbox>
          </Form.Item>

          {/* ---------- 生效时间段：设计图是纯数字框 ---------- */}
          <Form.Item label={<RowLabel title="生效时间段" hint="只在整点区间内提醒；两边都留空 = 全天" />}>
            <Space size={10} wrap={false}>
              <span className="hour-picker">
                <InputNumber
                  className="hour"
                  min={0}
                  max={23}
                  step={1}
                  precision={0}
                  value={start == null ? null : start}
                  placeholder="不限"
                  onFocus={() => markFocus('activeHours')}
                  onBlur={() => clearFocus('activeHours')}
                  onChange={(v) => commitHours(v == null ? null : clampNum(v, 0, 23, 0), end)}
                />
                <span className="unit">时</span>
              </span>
              <span className="hours-dash">—</span>
              <span className="hour-picker">
                <InputNumber
                  className="hour"
                  min={0}
                  max={23}
                  step={1}
                  precision={0}
                  value={end == null ? null : end}
                  placeholder="不限"
                  onFocus={() => markFocus('activeHours')}
                  onBlur={() => clearFocus('activeHours')}
                  onChange={(v) => commitHours(start, v == null ? null : clampNum(v, 0, 23, 0))}
                />
                <span className="unit">时</span>
              </span>
              <span className="inline-note">{activeHoursNote}</span>
            </Space>
          </Form.Item>

          {/* ---------- 显示倒计时 ---------- */}
          <Form.Item label={<RowLabel title="显示倒计时" hint="提醒条右侧显示「剩余 28s」" />}>
            <Checkbox
              checked={settings.showCountdown}
              onChange={(e) => patch({ showCountdown: e.target.checked })}
            >
              在提醒条右侧显示剩余秒数
            </Checkbox>
          </Form.Item>
        </Form>
      </div>
    </section>
  );
}
