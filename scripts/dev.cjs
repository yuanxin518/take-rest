// 开发模式：先起 Vite dev server，再带 DESK_REMINDER_DEV_URL 启动 Electron。
// 渲染层改动能热更新；主进程改动需要重跑本命令。
// 用法：npm run dev
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 5173;
const DEV_URL = `http://localhost:${PORT}`;

const electronBin = (() => {
  try {
    // electron 包导出的就是可执行文件路径
    const p = require(path.join(ROOT, 'node_modules', 'electron'));
    return typeof p === 'string' && p ? p : null;
  } catch (_e) {
    return null;
  }
})();

if (!electronBin) {
  console.error('[dev] 找不到 Electron，先执行 npm install');
  process.exit(1);
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForVite(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(`${DEV_URL}/panel/index.html`)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('[dev] 启动 Vite dev server…');
  const vite = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }
  );

  const ready = await waitForVite(30000);
  if (!ready) {
    console.error(`[dev] Vite 在 30 秒内没有就绪（${DEV_URL}），放弃启动 Electron`);
    vite.kill();
    process.exit(1);
  }
  console.log(`[dev] Vite 就绪：${DEV_URL}`);

  console.log('[dev] 启动 Electron…');
  // 本机环境可能带 ELECTRON_RUN_AS_NODE=1，会让 electron 退化成纯 Node
  const env = { ...process.env, DESK_REMINDER_DEV_URL: DEV_URL };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = spawn(electronBin, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env
  });

  const shutdown = (code) => {
    try {
      vite.kill();
    } catch (_e) {
      /* 忽略 */
    }
    process.exit(code || 0);
  };

  app.on('exit', (code) => shutdown(code));
  process.on('SIGINT', () => {
    try {
      app.kill();
    } catch (_e) {
      /* 忽略 */
    }
    shutdown(0);
  });
}

main();
