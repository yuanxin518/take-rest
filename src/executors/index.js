// 执行方式汇总：新增一种呈现形式时，在这里追加一行即可。
// 驱动桌面初始化时调用 list() 批量注册，引擎与驱动桌面都不需要改。
'use strict';

const text = require('./text');

/** 内置执行方式清单（顺序不重要，注册表会按 priority 排序） */
function list() {
  return [text];
}

module.exports = { list };
