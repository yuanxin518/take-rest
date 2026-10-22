// 打包脚本：把应用收进 electron 发行版目录，产出一个可以直接双击运行的绿色版文件夹。
// 不引入 electron-builder 之类的重依赖，只用 node 内置模块。
//
// 用法：npm run build         → 产出 dist/<package.json name>-win32-x64/
//      npm run build -- --zip → 额外压成 zip
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// 需要拷进 app 目录的文件与目录（相对工程根）
// 注意：renderer/ 源码不进包，进包的是 Vite 构建产物 dist-renderer/，
// 所以运行时不依赖 node_modules（React / antd 已经打进去了）。
// assets/ 里是应用图标（托盘、窗口图标），运行时要用，必须进包
const APP_ENTRIES = ['package.json', 'src', 'dist-renderer', 'assets', 'docs', 'README.md'];

// 无论在哪都不该进包的东西
const SKIP = new Set(['node_modules', '.git', '.smoke-data', '.smoke-proxy', 'dist', 'scripts', '素材', '交付截图', 'renderer']);

function log(msg) {
  console.log(`[打包] ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(entry)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, filter);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total / (1024 * 1024);
}

function main() {
  const wantZip = process.argv.includes('--zip');

  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('[打包] 找不到 Electron 运行时，先执行 npm install');
    process.exit(1);
  }

  // 平台目录名跟着当前 electron dist 走，不写死
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch;
  // 产物名跟着 package.json 的 name 走（改项目名不用动这个脚本）
  const pkgName = (() => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      return (p && typeof p.name === 'string' && p.name.trim()) || 'app';
    } catch (_e) {
      return 'app';
    }
  })();
  const outName = `${pkgName}-${platform}-${arch}`;
  const outDir = path.join(ROOT, 'dist', outName);

  log(`输出目录：${path.relative(ROOT, outDir)}`);
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 拷 Electron 运行时
  log('复制 Electron 运行时…');
  copyDir(ELECTRON_DIST, outDir);

  // 2. 把应用文件塞进 resources/app
  //    用 app 目录（非 asar）便于打包后直接查问题；体积差异可忽略
  const appDir = path.join(outDir, 'resources', 'app');
  log('收集应用文件…');
  for (const name of APP_ENTRIES) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(appDir, name);
    if (fs.statSync(from).isDirectory()) {
      copyDir(from, to, (entry) => !SKIP.has(entry.name));
    } else {
      copyFile(from, to);
    }
  }

  // 3. preload 是 CommonJS，不经 Vite 打包，必须单独拷进包，
  //    否则打包后面板拿不到 window.api（只剩一个空壳界面）。
  const PRELOADS = ['renderer/panel/preload.cjs', 'renderer/popup/preload.cjs'];
  for (const rel of PRELOADS) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {
      console.error(`[打包] 缺少 preload：${rel}`);
      process.exit(1);
    }
    copyFile(from, path.join(appDir, rel));
    log(`preload 已收入：${rel}`);
  }

  // 4. 生成精简的 package.json：去掉开发用脚本与 devDependencies
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    type: pkg.type,
    license: pkg.license
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n', 'utf8');

  // 4. 可执行文件改名
  if (platform === 'win32') {
    const exeSrc = path.join(outDir, 'electron.exe');
    const exeDst = path.join(outDir, `${pkg.name}.exe`);
    if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);
  }

  // 5. 给用户看的首启说明（全部从 package.json 取值，不写死名字）
  const exeName = platform === 'win32' ? `${pkg.name}.exe` : pkg.name;
  const dataFolder = pkg.name;
  fs.writeFileSync(
    path.join(outDir, 'README-FIRST.txt'),
    [
      `${pkg.productName || pkg.name} v${pkg.version}`,
      '',
      `双击 ${exeName} 启动。首次启动会在托盘出现图标并自动打开设置面板。`,
      `数据保存在 %APPDATA%\\${dataFolder}\\，卸载时删掉该目录即可。`,
      '',
      '这是便携版，不需要安装，整个文件夹可以随意挪动。',
      ''
    ].join('\r\n'),
    'utf8'
  );

  const sizeMB = dirSizeMB(outDir);
  log(`完成：${path.relative(ROOT, outDir)}（${sizeMB.toFixed(0)} MB）`);
  log(`入口：${path.join(outDir, platform === 'win32' ? `${pkg.name}.exe` : pkg.name)}`);

  // 5. 可选压缩
  if (wantZip) {
    const zipPath = path.join(ROOT, 'dist', `${outName}.zip`);
    rmrf(zipPath);
    log('压缩中…');
    const { execFileSync } = require('node:child_process');
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force`],
        { stdio: 'inherit' }
      );
    } else {
      execFileSync('zip', ['-qr', zipPath, outName], { cwd: path.join(ROOT, 'dist'), stdio: 'inherit' });
    }
    log(`已压缩：${path.relative(ROOT, zipPath)}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)} MB）`);
  }
}

main();
