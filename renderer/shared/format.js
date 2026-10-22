/**
 * format.js —— 时间 / 数字 / 文本小工具（设置面板与提醒窗共用）
 *
 * 全部是纯函数：不碰 DOM、不碰 React、不碰主进程。
 * 这批函数从旧版 src/panel/panel.js 里的同名逻辑迁移过来，行为保持一致。
 */

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

/** 两位数补零：9 → "09" */
export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把主进程给的「下次提醒时间」统一成 Date。
 * 兼容 Date 实例、毫秒时间戳、秒时间戳（< 1e12 视为秒）、ISO 字符串；解析不了返回 null。
 * @param {unknown} v
 * @returns {Date|null}
 */
export function toTime(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "21:30" */
export function formatHM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "2025-01-08 21:30" */
export function formatFull(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHM(d)}`;
}

/** 距离某个时间还有多久："即将提醒" / "1 分钟后" / "1 小时 20 分钟后" */
export function relativeMin(d) {
  const diff = Math.round((d.getTime() - Date.now()) / 60000);
  if (diff <= 0) return '即将提醒';
  if (diff === 1) return '1 分钟后';
  if (diff < 60) return `${diff} 分钟后`;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m ? `${h} 小时 ${m} 分钟后` : `${h} 小时后`;
}

/** 整点小时数的展示："9" → "09:00"，null → "不限制" */
export function hourText(h) {
  return h == null ? '不限制' : `${pad2(h)}:00`;
}

/** 提醒条右侧的倒计时文案：「剩余 28s」 */
export function countdownText(seconds) {
  return `剩余 ${Math.max(0, Math.round(seconds))}s`;
}

/** 6 秒 → "6s"，90 秒 → "1分30秒"（只在需要给人类看时长的地方用） */
export function formatSeconds(sec) {
  const n = Math.round(Number(sec) || 0);
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m}分${s}秒` : `${m}分`;
}

/* ------------------------------------------------------------------ *
 * 数字
 * ------------------------------------------------------------------ */

/** 安全转数字：非法值退回 dflt */
export function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 取整并夹在 [min, max] 之间；非法值退回 dflt */
export function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 时段整点：'' / null / 非法 / 越界都归一成 null（= 不限制） */
export function normalizeHour(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  return Math.round(n);
}

/* ------------------------------------------------------------------ *
 * 文本
 * ------------------------------------------------------------------ */

/** 超长截断："…" 收尾 */
export function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** 错误对象压成一句中文，任何位置都能直接显示 */
export function errMsg(e) {
  if (!e) return '未知错误';
  return e.message || String(e) || '未知错误';
}
