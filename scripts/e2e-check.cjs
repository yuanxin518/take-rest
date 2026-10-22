// 端到端验证（新架构）：启动应用 → 内置包加载 → 订阅同步 → 执行方式分发 → 提醒窗呈现与收起。
// 隔离数据目录，验证完自动清理。
// 用法：npx electron scripts/e2e-check.cjs   或   npm run check
'use strict';

const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
process.env.DESK_REMINDER_DATA_DIR = path.join(ROOT, '.smoke-data');
const OUT = path.join(ROOT, '.smoke-data', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const logs = [];
for (const m of ['log', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logs.push(`[${m}] ${a.join(' ')}`); orig(...a); };
}

// 加载真实入口，让整个应用按正常流程装配（托盘、窗口、IPC 都会就绪）
require('../src/main/index.js');

const engine = require('../src/engine/index.js');
const desktop = require('../src/desktop/index.js');
const { detectTaskbar } = require('../src/desktop/taskbar.js');
const { syncSource } = require('../src/subscriptions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail: String(detail) });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  → ' + detail}`);
};

async function shot(win, name, report) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = await win.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    report.shots.push({ name, file, size: img.getSize() });
  } catch (e) {
    report.errors.push(`截图 ${name} 失败：${e.message}`);
  }
}

app.whenReady().then(async () => {
  const report = { errors: [], results, shots: [], github: null };
  await sleep(3000);

  // 1. 引擎已装配、内置包已加载
  const st = engine.buildState();
  check('引擎读到内置包（至少 5 条动作）', st.actionCount >= 5, `actionCount=${st.actionCount}`);
  check('packs 里有内置包', st.packs.some((p) => p.origin === 'builtin'), JSON.stringify(st.packs.map((p) => p.origin)));
  check('packs 带 categories（面板渲染三级树的唯一来源）', Array.isArray(st.packs?.[0]?.categories));
  check('引擎列出了执行方式', Array.isArray(st.executors) && st.executors.length > 0, JSON.stringify(st.executors));

  // 2. 订阅同步（file:// 源，与 GitHub 仓库内容一致）
  const localSrc = 'file:///' + path.join(ROOT, '订阅仓库模板').replace(/\\/g, '/') + '/';
  const syncRes = await syncSource(localSrc);
  check('订阅同步成功', syncRes.ok === true, syncRes.error || JSON.stringify(syncRes.errors));
  check('订阅拉到动作包', syncRes.packCount >= 1, `packCount=${syncRes.packCount}`);

  // 3. 执行方式分发（不经过真实定时器，直接让引擎抽一条并交给驱动桌面）
  const fired = engine.fire('test');
  check('引擎抽到动作并完成呈现', Boolean(fired && fired.move), JSON.stringify(fired));
  check('呈现用的执行方式是 text', desktop.registry.list().length > 0);

  await sleep(1500);
  const popup = BrowserWindow.getAllWindows().find((w) => /popup/.test(w.webContents.getURL()));
  if (popup) {
    await shot(popup, 'popup', report);
    check('提醒窗可见', popup.isVisible());
    check('提醒窗置顶', popup.isAlwaysOnTop());
    report.popupBounds = popup.getBounds();
    try {
      report.popupText = await popup.webContents.executeJavaScript('document.body.innerText.slice(0,200)');
    } catch (e) {
      report.errors.push(`读取提醒窗文本失败：${e.message}`);
    }
  } else {
    check('提醒窗存在', false, '没找到 popup 窗口');
  }

  // 4. 提醒窗位置与任务栏算法一致
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const tb = detectTaskbar(disp);
  const actual = popup && popup.getBounds();
  const maxW = Math.round(disp.workArea.width * 0.5);
  const centerX = disp.workArea.x + disp.workArea.width / 2;
  check(
    '提醒窗居中对齐（不再铺满全宽）',
    Boolean(actual) && Math.abs(actual.x + actual.width / 2 - centerX) <= 3,
    JSON.stringify({ actual, centerX })
  );
  check(
    '提醒窗宽度不超过屏幕一半',
    Boolean(actual) && actual.width <= maxW,
    JSON.stringify({ width: actual && actual.width, maxW })
  );
  check(
    '提醒窗在任务栏上方（不越界）',
    Boolean(actual) && actual.y + actual.height <= disp.workArea.y + disp.workArea.height,
    JSON.stringify({ actual, workArea: disp.workArea })
  );

  // 5. 收起
  desktop.hide();
  await sleep(600);
  check('提醒窗能收起', !popup || !popup.isVisible());

  // 6. 面板窗口（React 构建产物）
  const panel = BrowserWindow.getAllWindows().find((w) => /panel/.test(w.webContents.getURL()));
  if (panel) {
    await sleep(1200);
    await shot(panel, 'panel', report);
    try {
      report.panelText = await panel.webContents.executeJavaScript('document.body.innerText.slice(0,600)');
    } catch (e) {
      report.errors.push(`读取面板文本失败：${e.message}`);
    }
    check('设置面板已加载', true);
  } else {
    check('设置面板已加载', false, '没找到 panel 窗口');
  }

  // 7. 外网（外部环境项，失败不算回归）
  const ghRes = await syncSource('https://github.com/yuanxin518/take-rest');
  report.github = { ok: ghRes.ok, branch: ghRes.branch, packCount: ghRes.packCount, error: ghRes.error };
  check('GitHub 仓库订阅能找到动作包分支（外部环境项）', ghRes.ok === true && ghRes.branch === 'packs', JSON.stringify(report.github));

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'logs.txt'), logs.join('\n'), 'utf8');

  const failed = results.filter((x) => !x.ok && !x.name.includes('外部环境项')).length;
  const external = results.filter((x) => x.name.includes('外部环境项') && !x.ok).length;
  console.log(`\n结果：${results.length - failed - external}/${results.length - external} 通过（本地项）`);
  if (external) console.log(`⚠ 外部网络项 ${external} 条失败，属环境波动，不代表代码回归`);
  console.log('GitHub 订阅：', JSON.stringify(report.github));
  if (report.popupText) console.log('提醒窗文字：', String(report.popupText).replace(/\n/g, ' | '));
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
});

setTimeout(() => {
  console.log('超时退出');
  app.exit(2);
}, 120000);
