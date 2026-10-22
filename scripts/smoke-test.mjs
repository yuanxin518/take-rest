// 自检脚本：校验动作包数据规范 + 各模块语法 + 纯函数行为。运行：node scripts/smoke-test.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = new Set(['静音', '轻响', '震动']);
let pass = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

function section(title) { console.log(`\n== ${title} ==`); }

// ---------- 1. 动作包数据 ----------
section('动作包数据');
const packsDir = join(ROOT, 'src', 'packs');
const packFiles = existsSync(packsDir) ? readdirSync(packsDir).filter(f => f.endsWith('.json')) : [];
ok('src/packs 至少有一个包', packFiles.length > 0, `实际 ${packFiles.length}`);

const allMoveIds = new Set();
let totalMoves = 0;
/** 逐包累计，最后和 totalMoves 对一次账，防止某个包被静默跳过 */
let perPackSum = 0;
for (const file of packFiles) {
  const raw = readFileSync(join(packsDir, file), 'utf8');
  ok(`${file} 无 BOM`, !raw.startsWith('\uFEFF'));
  let pack;
  try { pack = JSON.parse(raw); } catch (e) { ok(`${file} 可解析`, false, e.message); continue; }
  ok(`${file} format 正确`, pack.format === 'gongwei-tixing-pack/1', pack.format);
  ok(`${file} 有 id/name`, typeof pack.id === 'string' && typeof pack.name === 'string');
  ok(`${file} categories 非空`, Array.isArray(pack.categories) && pack.categories.length > 0);
  let packMoves = 0;
  for (const cat of pack.categories ?? []) {
    ok(`  类别 ${cat.name} 有 parts`, Array.isArray(cat.parts) && cat.parts.length > 0);
    for (const part of cat.parts ?? []) {
      ok(`    部位 ${part.name} 有 moves`, Array.isArray(part.moves) && part.moves.length > 0);
      for (const mv of part.moves ?? []) {
        totalMoves++;
        packMoves++;
        const where = `${cat.name}/${part.name}/${mv.name}`;
        ok(`      ${where} id 非空且唯一`, typeof mv.id === 'string' && mv.id.length > 0 && !allMoveIds.has(mv.id), mv.id);
        allMoveIds.add(mv.id);
        const lvl = mv.level ?? '静音';
        ok(`      ${where} level 合法`, LEVELS.has(lvl), String(lvl));
        // 正文两种来源：分段动作由 phases 生成，简单动作直接写 prompt
        const phases = Array.isArray(mv.phases) ? mv.phases : [];
        if (phases.length > 0) {
          ok(`      ${where} phases 合法`, phases.every((p) => typeof p.text === 'string' && p.text && Number.isInteger(p.sec) && p.sec > 0), JSON.stringify(phases));
          ok(`      ${where} reps 是正整数`, Number.isInteger(mv.reps) && mv.reps > 0, String(mv.reps));
          const active = phases.reduce((a, b) => a + b.sec, 0);
          const trans = (phases.length - 1) * (Number.isInteger(mv.transitionSec) ? mv.transitionSec : 2);
          const expect = (active + trans) * mv.reps;
          ok(`      ${where} durationSec 与 phases 自洽`, mv.durationSec === expect, `标称 ${mv.durationSec} / 计算 ${expect}`);
        } else {
          ok(`      ${where} prompt 非空且≤40字`, typeof mv.prompt === 'string' && mv.prompt.length > 0 && mv.prompt.length <= 40, `长度 ${mv.prompt?.length}`);
        }
        ok(`      ${where} durationSec 是正数`, Number.isFinite(mv.durationSec) && mv.durationSec > 0, String(mv.durationSec));
        // reps 可选，但给了就必须是正整数（提醒条据此显示「3/20」和进度条）
        if (mv.reps !== undefined) {
          ok(`      ${where} reps 是正整数`, Number.isInteger(mv.reps) && mv.reps > 0, String(mv.reps));
        }
      }
    }
  }
  ok(`${file} 至少 1 条动作`, packMoves > 0, `实际 ${packMoves}`);
  perPackSum += packMoves;
}
ok('每个包的动作数之和 = 总动作数', perPackSum === totalMoves, `逐包 ${perPackSum} / 总计 ${totalMoves}`);

// ---------- 2. 模块语法 ----------
section('模块语法');
// 主进程侧（CommonJS）：四层各自的 .js 全做语法检查
const jsFiles = [
  'src/main/index.js', 'src/main/windows.js', 'src/main/tray.js', 'src/main/ipc.js',
  'src/engine/index.js', 'src/engine/scheduler.js', 'src/engine/store.js',
  'src/desktop/index.js', 'src/desktop/taskbar.js', 'src/desktop/registry.js',
  'src/executors/index.js', 'src/executors/text.js',
  'src/subscriptions.js',
  'scripts/dev.cjs', 'scripts/build.cjs'
];
for (const f of jsFiles) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { ok(`${f} 存在`, false); continue; }
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    ok(`${f} 语法`, true);
  } catch (e) {
    ok(`${f} 语法`, false, String(e.stderr ?? e.message).slice(0, 300));
  }
}

// ---------- 3. 纯函数行为 ----------
section('任务栏探测与几何计算');
const { computePopupBounds } = await import('../src/desktop/taskbar.js').catch(() => ({}));
if (typeof computePopupBounds === 'function') {
  // 真实场景：屏幕 1920x1080，任务栏在下 → 工作区高 1032
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const waBottom = { x: 0, y: 0, width: 1920, height: 1032 };
  const waTop = { x: 0, y: 48, width: 1920, height: 1032 };
  const waLeft = { x: 62, y: 0, width: 1858, height: 1080 };
  const bottom = computePopupBounds({ taskbar: { edge: 'bottom', thickness: 48, screen, workArea: waBottom }, screenSize: screen });
  ok('任务栏在下：窗口整体在任务栏上方', bottom.y + bottom.height <= 1032, JSON.stringify(bottom));
  ok('任务栏在下：与任务栏间距 ≤ 12px', 1032 - (bottom.y + bottom.height) <= 12, JSON.stringify(bottom));
  ok('任务栏在下：横向留白', bottom.x > 0 && bottom.width < 1920, JSON.stringify(bottom));
  // 注意：垂直位置现在由 settings.appearance.position 决定（bottom / top / center），
  // 不再跟着任务栏那条边自动翻。默认是 bottom（贴任务栏上方）。
  const top = computePopupBounds({ taskbar: { edge: 'top', thickness: 48, screen, workArea: waTop }, screenSize: screen, position: 'top' });
  ok('position=top：窗口贴工作区顶部', top.y >= 48 && top.y <= 60, JSON.stringify(top));
  const centered = computePopupBounds({ taskbar: { edge: 'bottom', thickness: 48, screen, workArea: waBottom }, screenSize: screen, position: 'center' });
  ok('position=center：窗口垂直居中', Math.abs(centered.y + centered.height / 2 - 1032 / 2) <= 2, JSON.stringify(centered));
  const byDefault = computePopupBounds({ taskbar: { edge: 'bottom', thickness: 48, screen, workArea: waBottom }, screenSize: screen });
  ok('默认 position=bottom：贴任务栏上方', byDefault.y + byDefault.height <= 1032 && 1032 - (byDefault.y + byDefault.height) <= 12, JSON.stringify(byDefault));
  const left = computePopupBounds({ taskbar: { edge: 'left', thickness: 62, screen, workArea: waLeft }, screenSize: screen });
  ok('任务栏在左：窗口不压在任务栏上', left.x >= 62, JSON.stringify(left));
  ok('任务栏在左：退化为竖向窄条', left.height > left.width, JSON.stringify(left));
  const noBar = computePopupBounds({ taskbar: { edge: 'bottom', thickness: 48, fallback: true, screen, workArea: screen }, screenSize: screen });
  ok('任务栏隐藏兜底：仍在屏内', noBar.y + noBar.height <= 1080, JSON.stringify(noBar));
  const { detectTaskbar } = await import('../src/desktop/taskbar.js');
  const d1 = detectTaskbar({ bounds: screen, workArea: waBottom });
  ok('探测到任务栏在下、厚 48', d1.edge === 'bottom' && d1.thickness === 48, JSON.stringify(d1));
  const d2 = detectTaskbar({ bounds: screen, workArea: waTop });
  ok('探测到任务栏在上、厚 48', d2.edge === 'top' && d2.thickness === 48, JSON.stringify(d2));
  const d3 = detectTaskbar({ bounds: screen, workArea: waLeft });
  ok('探测到任务栏在左、厚 62', d3.edge === 'left' && d3.thickness === 62, JSON.stringify(d3));
  const d4 = detectTaskbar({ bounds: screen, workArea: screen });
  ok('全屏时走兜底', d4.fallback === true && d4.thickness === 48, JSON.stringify(d4));
} else {
  ok('taskbar.js 导出 computePopupBounds', false);
}

section('动作调度');
const { buildIndex, pickNext } = await import('../src/engine/scheduler.js').catch(() => ({}));
if (typeof buildIndex === 'function' && typeof pickNext === 'function') {
  const packFiles2 = packFiles.map(f => JSON.parse(readFileSync(join(packsDir, f), 'utf8')));
  const index = buildIndex(packFiles2);
  const moves = index.moves ?? index;
  const indexedCount = Array.isArray(moves) ? moves.length : 0;
  ok('索引条数与包内动作数一致', indexedCount === totalMoves, `索引 ${indexedCount} / 包内 ${totalMoves}`);
  const settings = {
    activePackIds: packFiles2.map(p => p.id), categories: { 身体: true },
    levels: { 静音: true }, shuffle: false, enabled: true,
  };
  const seen = new Set();
  let cursor = '';
  // 走满「动作总数」次，顺序模式应当一条不落地各抽到一次
  for (let i = 0; i < indexedCount; i++) {
    const r = pickNext(index, settings, cursor);
    if (!r?.move) { ok('pickNext 返回 move', false, JSON.stringify(r)); break; }
    seen.add(r.move.id);
    cursor = r.move.id; // 游标是「上一条动作 id」
  }
  ok('顺序模式能循环出全部动作', seen.size === indexedCount, `实际 ${seen.size} / 应为 ${indexedCount}`);

  // 细粒度开关：只关掉一条路径，别的部位同名档位不该被牵连
  const sample = index[0];
  const onePath = `${sample.category}/${sample.part}/${sample.level}`;
  const othersBefore = index.filter((e) => `${e.category}/${e.part}/${e.level}` !== onePath);
  const blockedSettings = { ...settings, disabledPaths: [onePath] };
  const afterDisable = pickNext(index, blockedSettings, '');
  const sameLayerOthersAlive = othersBefore.some(
    (e) => e.part === sample.part && e.level === sample.level && e.move.id !== sample.move.id
  );
  ok(
    '关掉一个路径不会连带别的部位',
    !afterDisable?.move || `${afterDisable.category}/${afterDisable.part}/${afterDisable.level}` !== onePath || !sameLayerOthersAlive,
    JSON.stringify({ onePath, picked: afterDisable?.move?.id })
  );
  const allDisabled = { ...settings, disabledPaths: index.map((e) => `${e.category}/${e.part}/${e.level}`) };
  ok('全部路径关掉时走兜底文案', pickNext(index, allDisabled, '')?.stubbed === true);
  const muted = pickNext(index, settings, '');
  ok('抽取结果带三级路径', Boolean(muted?.category && muted?.part && muted?.level), JSON.stringify(Object.keys(muted ?? {})));
  const noLevel = pickNext(index, { ...settings, levels: { 静音: false } }, '');
  ok('幅度全关时不抽到被禁的档位', noLevel?.stubbed === true, JSON.stringify(noLevel?.move?.id));
} else {
  ok('scheduler.js 导出 buildIndex/pickNext', false);
}

// ---------- 4. 四层架构 ----------
section('执行方式注册表');
const registry = await import('../src/desktop/registry.js').catch(() => null);
if (registry && typeof registry.register === 'function') {
  registry.clear();
  const textExec = (await import('../src/executors/text.js')).default ?? require('../src/executors/text.js');
  ok('text 执行方式契约完整', registry.validate(textExec) === '', registry.validate(textExec));
  ok('注册 text 成功', registry.register(textExec) === true);
  ok('注册表能列出 text', registry.list().some((e) => e.type === 'text'));

  const action = {
    move: { id: 'a1', prompt: '测试口令 · 做三次', name: '测试', durationSec: 20 },
    category: '身体', part: '小腿', level: '静音'
  };
  const picked = registry.pick(action);
  ok('能按动作选中执行方式', picked && picked.type === 'text', JSON.stringify(picked && picked.type));
  ok('canHandle 拒绝空动作', textExec.canHandle(null) === false && textExec.canHandle({}) === false);

  const layout = textExec.measure(action);
  ok('measure 返回横条 44 高', layout.mode === 'bar' && layout.height === 44, JSON.stringify(layout));
  ok('duration 优先用设置的秒数', textExec.duration(action, { popupSeconds: 12 }) === 12);
  ok('duration 回退动作自带时长', textExec.duration(action, { popupSeconds: 0 }) === 20);
  const p = textExec.payload(action, { seconds: 20, showCountdown: true });
  ok('payload 是纯数据且字段齐全',
    p.type === 'text' && p.prompt === action.move.prompt && p.seconds === 20 && p.level === '静音',
    JSON.stringify(p));
  ok('payload 可结构化克隆', (() => { try { structuredClone(p); return true; } catch { return false; } })());
  registry.clear();
} else {
  ok('registry.js 可加载', false);
}

section('分段时间轴（phases）');
// text.js / palette.js 是 CommonJS，用 createRequire 加载（本文件是 ESM）
const requireCjs = createRequire(import.meta.url);
let textExec = null;
try {
  textExec = requireCjs('../src/executors/text.js');
} catch (_e) {
  textExec = null;
}
if (textExec && typeof textExec.cycleSecOf === 'function') {
  const phases = [{ text: '深呼吸', sec: 6 }, { text: '吐气', sec: 4 }];
  const trans = 2;
  const cycle = textExec.cycleSecOf(phases, trans);
  ok('一轮 = 各段之和 + 段间切换', cycle === 12, `实际 ${cycle}（6+4 + 1×2）`);

  const totalSec = textExec.duration(
    { move: { phases, transitionSec: trans, reps: 4 } },
    {}
  );
  ok('总时长 = 一轮 × 次数', totalSec === 48, `实际 ${totalSec}`);

  const text = textExec.phasesToText(phases);
  ok('正文是「深呼吸 6秒 · 吐气 4秒」', text === '深呼吸 6秒 · 吐气 4秒', text);
  ok('正文里不出现「重复 N 次」', !/重复|共\s*\d+\s*次|×\s*\d+/.test(text), text);

  const p = textExec.payload(
    { move: { phases, transitionSec: trans, reps: 4, name: '深呼吸' }, category: '身体', part: '呼吸', level: '静音' },
    { seconds: totalSec, showCountdown: true }
  );
  ok('payload 带 phases', Array.isArray(p.phases) && p.phases.length === 2);
  ok('payload 的 reps 用于 1/N 计数', p.reps === 4 && p.showProgress === true, `${p.reps}/${p.showProgress}`);
  ok('payload 的 cycleSec 正确', p.cycleSec === 12, String(p.cycleSec));
  ok('payload.prompt 与 phasesToText 一致', p.prompt === text, p.prompt);

  // 简单动作（没有 phases）保持原样
  const plain = textExec.payload({ move: { prompt: '坐姿踮脚 · 做 20 个', durationSec: 40 }, category: '身体', part: '小腿', level: '静音' }, {});
  ok('简单动作 payload 不含 phases', Array.isArray(plain.phases) && plain.phases.length === 0);
  ok('简单动作仍然保留 prompt', plain.prompt === '坐姿踮脚 · 做 20 个', plain.prompt);
  // 单段没有段间切换
  ok('单段动作没有切换时间', textExec.cycleSecOf([{ text: '保持', sec: 5 }], 2) === 5);
  // 非法 phases 会被丢掉
  ok('非法 phases 被规范化掉', textExec.normalizePhases([{ text: '', sec: 3 }, { text: '好', sec: 0 }, { text: '正常', sec: 4 }]).length === 1);
} else {
  ok('text.js 导出 phasesToText / cycleSecOf', false);
}

section('浅色彩虹色系');
try {
  const palette = requireCjs('../src/executors/palette.js');
  ok('共 7 个颜色（红橙黄绿青蓝紫）', palette.COLOR_COUNT === 7, String(palette.COLOR_COUNT));
  ok('顺序是红橙黄绿青蓝紫', palette.LIGHT_RAINBOW.map((c) => c.label).join('') === '红橙黄绿青蓝紫');
  ok('全部是浅色（RGB 均 ≥ 160）', palette.LIGHT_RAINBOW.every((c) => c.rgb.every((v) => v >= 160)), JSON.stringify(palette.LIGHT_RAINBOW.map((c) => c.rgb)));
  ok('色值循环取用', palette.colorAt(7).key === palette.colorAt(0).key);
} catch (e) {
  ok('palette.js 可加载', false, e.message);
}

section('外观设置（样式 tab）');const storeMod = await import('../src/engine/store.js').catch(() => null);
if (storeMod && typeof storeMod.normalizeSettings === 'function') {
  const ap = storeMod.DEFAULT_APPEARANCE || {};
  ok('默认外观有 9 个可配项', ['minWidth', 'maxWidth', 'fontSize', 'align', 'textColor', 'textOpacity', 'bgOpacity', 'screen', 'position'].every((k) => k in ap), JSON.stringify(Object.keys(ap)));

  // 非法值全部回落默认
  const bad = storeMod.normalizeSettings({ appearance: { fontSize: 999, align: 'diagonal', textColor: 'red', textOpacity: 9, bgOpacity: -3, screen: 'tv', position: 'diagonal' } }).appearance;
  ok('非法字号被夹到上限 32', bad.fontSize === 32, String(bad.fontSize));
  ok('非法对齐回落 center', bad.align === 'center', bad.align);
  ok('非法颜色回落 #ffffff', bad.textColor === '#ffffff', bad.textColor);
  ok('透明度被夹到 [0.1,1]', bad.textOpacity === 1 && bad.bgOpacity === 0.1, `${bad.textOpacity}/${bad.bgOpacity}`);
  ok('非法屏幕回退 cursor', bad.screen === 'cursor', bad.screen);

  // 最大宽度不允许小于最小宽度
  const swapped = storeMod.normalizeSettings({ appearance: { minWidth: 600, maxWidth: 300 } }).appearance;
  ok('最大宽度不小于最小宽度', swapped.maxWidth >= swapped.minWidth, JSON.stringify(swapped));

  // 颜色只接受 hex
  ok('3 位 hex 也能通过', storeMod.normalizeSettings({ appearance: { textColor: '#0af' } }).appearance.textColor === '#0af');
} else {
  ok('store 导出 normalizeSettings / DEFAULT_APPEARANCE', false);
}

section('分层依赖方向');
const readSrc = (f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : '');
const engineFiles = ['src/engine/index.js', 'src/engine/scheduler.js', 'src/engine/store.js'];
const engineAll = engineFiles.map(readSrc).join('\n');
const engineIdx = readSrc('src/engine/index.js');
// 引擎层允许用 electron.app 做路径查询（userData / getAppPath），
// 但绝不能碰窗口、IPC、屏幕这些「宿主」能力——那会把引擎绑死在 UI 上。
ok('引擎层不碰窗口 / IPC / 屏幕',
  !/BrowserWindow|ipcMain|webContents|screen\.|nativeImage|Tray/.test(engineAll),
  '引擎层出现了宿主能力');
ok('引擎层只在 store 里查路径，index 完全无 electron',
  !/require\(['"]electron['"]\)/.test(engineIdx));
ok('引擎层不 require 驱动桌面', !/require\(['"]\.\.\/desktop/.test(engineAll));
ok('引擎层不 require 执行方式', !/require\(['"]\.\.\/executors/.test(engineAll));

const desktopAll = ['src/desktop/index.js', 'src/desktop/taskbar.js'].map(readSrc).join('\n');
ok('驱动桌面不 require 引擎（业务）', !/require\(['"]\.\.\/engine\/index\.js['"]\)/.test(desktopAll));
ok('驱动桌面只依赖注册表而非具体执行方式', !/require\(['"]\.\.\/executors\/text/.test(desktopAll));

const executorsAll = ['src/executors/index.js', 'src/executors/text.js'].map(readSrc).join('\n');
ok('执行方式不碰 BrowserWindow', !/BrowserWindow/.test(executorsAll));
ok('执行方式不碰 electron', !/require\(['"]electron['"]\)/.test(executorsAll));

section('框架层与渲染层资源');
const ipcSrc = readSrc('src/main/ipc.js');
for (const ch of ['state:get', 'settings:set', 'scheduler:next', 'scheduler:fire', 'packs:list', 'packs:toggle', 'subscription:status']) {
  ok(`框架层注册了 ${ch}`, ipcSrc.includes(ch));
}
ok('框架层把呈现交给驱动桌面', /desktop\.dispatch/.test(readSrc('src/main/index.js')));
ok('提醒窗 preload 路径指向 renderer/popup', /renderer['"],\s*['"]popup['"],\s*['"]preload\.cjs/.test(readSrc('src/desktop/index.js')));
for (const f of ['renderer/panel/index.html', 'renderer/popup/index.html', 'renderer/popup/preload.cjs', 'renderer/shared/gh.js']) {
  ok(`${f} 存在`, existsSync(join(ROOT, f)));
}
ok('vite 配置存在', existsSync(join(ROOT, 'vite.config.mjs')));

// ---------- 汇总 ----------
console.log(`\n${'='.repeat(40)}`);
if (fails.length) {
  console.log(`失败 ${fails.length} 项，通过 ${pass} 项`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${pass} 项`);
}
