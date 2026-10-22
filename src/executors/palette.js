// 分段时间轴用的浅色彩虹色系：红橙黄绿青蓝紫。
// 提醒条把一次动作切成若干段（吸气 / 呼气 / 停 / 放下…），每段按顺序取一个颜色，
// 全部用浅色版本——深色提醒条上浅色更清楚，也不会抢文字的视觉重心。
'use strict';

/** 顺序即取色顺序；用 rgb 数组方便主进程拼 rgba（透明度由渲染层按设置决定） */
const LIGHT_RAINBOW = [
  { key: 'red', label: '红', rgb: [255, 180, 180], hex: '#ffb4b4' },
  { key: 'orange', label: '橙', rgb: [255, 210, 168], hex: '#ffd2a8' },
  { key: 'yellow', label: '黄', rgb: [255, 234, 160], hex: '#ffeaa0' },
  { key: 'green', label: '绿', rgb: [184, 236, 196], hex: '#b8ecc4' },
  { key: 'cyan', label: '青', rgb: [168, 230, 224], hex: '#a8e6e0' },
  { key: 'blue', label: '蓝', rgb: [180, 212, 255], hex: '#b4d4ff' },
  { key: 'purple', label: '紫', rgb: [215, 188, 255], hex: '#d7bcff' }
];

const N = LIGHT_RAINBOW.length;

/**
 * 按序号取色（循环使用红橙黄绿青蓝紫）。
 * @param {number} index 段序号，从 0 开始
 */
function colorAt(index) {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) % N : 0;
  return LIGHT_RAINBOW[i];
}

module.exports = {
  LIGHT_RAINBOW,
  COLOR_COUNT: N,
  colorAt
};
