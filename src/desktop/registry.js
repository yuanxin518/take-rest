// 执行方式注册表：驱动桌面通过它按类型挑选执行方式。
// 注册表本身不认识任何具体类型，只认契约（canHandle / measure / payload / duration）。
'use strict';

/** 已注册的执行方式，按 priority 从高到低维持有序 */
const registry = [];

function log(...args) {
  try {
    console.log('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

function logWarn(...args) {
  try {
    console.warn('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

/**
 * 校验执行方式是否满足契约，缺字段直接拒收（早失败好过运行时崩）。
 * @param {object} executor
 * @returns {string} 错误原因，空串表示合法
 */
function validate(executor) {
  if (!executor || typeof executor !== 'object') return '执行方式必须是对象';
  if (typeof executor.type !== 'string' || !executor.type) return '缺少 type';
  if (typeof executor.canHandle !== 'function') return '缺少 canHandle()';
  if (typeof executor.measure !== 'function') return '缺少 measure()';
  if (typeof executor.payload !== 'function') return '缺少 payload()';
  if (typeof executor.duration !== 'function') return '缺少 duration()';
  return '';
}

/**
 * 注册一个执行方式。同 type 重复注册视为覆盖（便于开发期热改）。
 * @param {object} executor
 * @returns {boolean}
 */
function register(executor) {
  const err = validate(executor);
  if (err) {
    logWarn(`执行方式注册失败（${executor && executor.type}）：${err}`);
    return false;
  }
  const index = registry.findIndex((e) => e.type === executor.type);
  if (index >= 0) {
    registry.splice(index, 1);
    log(`${executor.type} 执行方式已更新（${executor.label || executor.type}）`);
  } else {
    log(`注册执行方式：${executor.type}（${executor.label || executor.type}，priority ${executor.priority || 0}）`);
  }
  registry.push(executor);
  registry.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return true;
}

/** 批量注册，返回成功条数 */
function registerAll(list) {
  const items = Array.isArray(list) ? list : [];
  return items.filter((e) => register(e)).length;
}

/**
 * 按优先级找到第一个能处理这次动作的执行方式。
 * @param {object} action 引擎抽出的动作
 * @returns {object|null}
 */
function pick(action) {
  for (const executor of registry) {
    let ok = false;
    try {
      ok = executor.canHandle(action) === true;
    } catch (e) {
      logWarn(`执行方式 ${executor.type} 的 canHandle 抛错：${e && e.message}`);
      ok = false;
    }
    if (ok) return executor;
  }
  return null;
}

/** 当前可用的执行方式摘要（面板可用来展示"支持哪些呈现形式"） */
function list() {
  return registry.map((e) => ({
    type: e.type,
    label: e.label || e.type,
    priority: e.priority || 0
  }));
}

/** 取某个类型的执行方式（不按优先级，按名字精确取） */
function get(type) {
  return registry.find((e) => e.type === type) || null;
}

/** 清空（仅自检脚本用，避免多次 require 叠加） */
function clear() {
  registry.length = 0;
}

module.exports = {
  register,
  registerAll,
  pick,
  list,
  get,
  clear,
  validate
};
