/**
 * 分段时间轴的浅色彩虹色系（红橙黄绿青蓝紫）。
 *
 * 与主进程 src/executors/palette.js 保持同一份取值——两边都要用：
 * 主进程给日志/自检，渲染层真正上色。改色时两处一起改。
 */
export const LIGHT_RAINBOW = [
  { key: 'red', label: '红', hex: '#ffb4b4' },
  { key: 'orange', label: '橙', hex: '#ffd2a8' },
  { key: 'yellow', label: '黄', hex: '#ffeaa0' },
  { key: 'green', label: '绿', hex: '#b8ecc4' },
  { key: 'cyan', label: '青', hex: '#a8e6e0' },
  { key: 'blue', label: '蓝', hex: '#b4d4ff' },
  { key: 'purple', label: '紫', hex: '#d7bcff' }
];

/** 按序号取色（循环） */
export function colorAt(index) {
  const n = LIGHT_RAINBOW.length;
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) % n : 0;
  return LIGHT_RAINBOW[i];
}
