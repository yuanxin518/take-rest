/**
 * sections/Appearance.jsx —— 「样式」区块
 *
 * 控制提醒条长什么样、出现在哪。所有改动都通过 props.patch 交给 App.jsx
 * 做乐观更新 + 防抖提交，本文件不发 IPC、不存权威状态。
 *
 * 对应 settings.appearance（主进程 store 里有同名默认值与逐字段校验）：
 *   minWidth / maxWidth / fontSize / align / textColor / textOpacity / bgOpacity / screen / position / theme
 */
import React, { useMemo } from 'react';
import { Checkbox, ColorPicker, Form, InputNumber, Radio, Select, Slider, Space } from 'antd';

/** 一行的标签 + 说明 */
function RowLabel({ title, hint }) {
  return (
    <div className="row-label">
      <span className="label">{title}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** 外观默认值（与主进程 store.DEFAULT_APPEARANCE 保持一致，只用于兜底展示） */
const DEFAULTS = {
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

/** 百分比显示：0.92 → 92% */
const pct = (v) => `${Math.round(v * 100)}%`;

export default function Appearance({ settings, patch, markFocus, clearFocus }) {
  const ap = useMemo(() => ({ ...DEFAULTS, ...(settings.appearance || {}) }), [settings.appearance]);

  /** 只改 appearance 里的某一项，其余保持不变 */
  const set = (key, value) => patch({ appearance: { ...ap, [key]: value } });

  /** #rrggbb → antd ColorPicker 需要的格式；antd 回调给的是 Color 对象或字符串 */
  const colorValue = ap.textColor || '#ffffff';
  const onColorChange = (c) => {
    // antd 5 的 ColorPicker 给的是 Color 实例，toHexString() 拿到 #rrggbb
    const hex = c && typeof c.toHexString === 'function' ? c.toHexString() : String(c || '');
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m) set('textColor', `#${m[1].toLowerCase()}`);
  };

  return (
    <section className="card" id="sec-appearance">
      <div className="card-head">
        <h2>样式</h2>
        <p>提醒条长什么样、出现在哪。改完立刻生效，试看一次就能看到效果。</p>
      </div>
      <div className="card-body">
        <Form layout="horizontal" colon={false} labelCol={{ flex: '0 0 250px' }} wrapperCol={{ flex: '1 1 auto' }} className="rhythm-form">
          {/* ---------- 宽度 ---------- */}
          <Form.Item label={<RowLabel title="默认宽度" hint="内容较短时提醒条的最小宽度（像素）" />}>
            <span className="num-wrap">
              <InputNumber
                className="num"
                min={120}
                max={2000}
                step={20}
                precision={0}
                value={ap.minWidth}
                onFocus={() => markFocus('ap.minWidth')}
                onBlur={() => clearFocus('ap.minWidth')}
                onChange={(v) => v != null && set('minWidth', v)}
              />
              <span className="unit">px</span>
            </span>
          </Form.Item>

          <Form.Item label={<RowLabel title="最大宽度" hint="内容超长时到这么宽就换行；实际不超过屏幕 80%" />}>
            <span className="num-wrap">
              <InputNumber
                className="num"
                min={200}
                max={4000}
                step={40}
                precision={0}
                value={ap.maxWidth}
                onFocus={() => markFocus('ap.maxWidth')}
                onBlur={() => clearFocus('ap.maxWidth')}
                onChange={(v) => v != null && set('maxWidth', v)}
              />
              <span className="unit">px</span>
            </span>
          </Form.Item>

          {/* ---------- 文字 ---------- */}
          <Form.Item label={<RowLabel title="文字大小" hint="提醒条正文字号" />}>
            <Space size={12} align="center">
              <Slider
                min={10}
                max={32}
                step={1}
                value={ap.fontSize}
                onChange={(v) => set('fontSize', v)}
              />
              <span className="inline-note value">{ap.fontSize}px</span>
            </Space>
          </Form.Item>

          <Form.Item label={<RowLabel title="文字对齐" hint="多行时文字的横向对齐方式" />}>
            <Radio.Group
              value={ap.align}
              onChange={(e) => set('align', e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="left">左对齐</Radio.Button>
              <Radio.Button value="center">居中</Radio.Button>
              <Radio.Button value="right">右对齐</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item label={<RowLabel title="文字颜色" hint="提醒条正文的颜色" />}>
            <Space size={12} align="center">
              <ColorPicker
                value={colorValue}
                onChange={onColorChange}
                showText
                disabledAlpha
              />
            </Space>
          </Form.Item>

          <Form.Item label={<RowLabel title="文字透明度" hint="正文的不透明度；倒计时会再淡一档" />}>
            <Space size={12} align="center">
              <Slider
                min={0.1}
                max={1}
                step={0.02}
                value={ap.textOpacity}
                onChange={(v) => set('textOpacity', v)}
                tooltip={{ formatter: pct }}
              />
              <span className="inline-note value">{pct(ap.textOpacity)}</span>
            </Space>
          </Form.Item>

          {/* ---------- 背景 ---------- */}
          <Form.Item label={<RowLabel title="背景透明度" hint="提醒条底色不透明度，越低越透" />}>
            <Space size={12} align="center">
              <Slider
                min={0.1}
                max={1}
                step={0.02}
                value={ap.bgOpacity}
                onChange={(v) => set('bgOpacity', v)}
                tooltip={{ formatter: pct }}
              />
              <span className="inline-note value">{pct(ap.bgOpacity)}</span>
            </Space>
          </Form.Item>

          <Form.Item label={<RowLabel title="背景深浅" hint="深色适合夜间与深色壁纸" />}>
            <Checkbox
              checked={ap.theme === 'light'}
              onChange={(e) => set('theme', e.target.checked ? 'light' : 'dark')}
            >
              浅色背景
            </Checkbox>
          </Form.Item>

          {/* ---------- 位置 ---------- */}
          <Form.Item label={<RowLabel title="显示的屏幕" hint="多显示器时提醒条出现在哪块屏" />}>
            <Select
              style={{ width: 200 }}
              value={ap.screen}
              onChange={(v) => set('screen', v)}
              options={[
                { value: 'cursor', label: '鼠标所在的屏幕' },
                { value: 'primary', label: '主屏幕' }
              ]}
            />
          </Form.Item>

          <Form.Item label={<RowLabel title="展示位置" hint="默认贴任务栏上方；也可贴屏幕顶部或垂直居中" />}>
            <Select
              style={{ width: 200 }}
              value={ap.position}
              onChange={(v) => set('position', v)}
              options={[
                { value: 'bottom', label: '贴任务栏上方' },
                { value: 'top', label: '屏幕顶部' },
                { value: 'center', label: '垂直居中' }
              ]}
            />
          </Form.Item>
        </Form>
      </div>
    </section>
  );
}
