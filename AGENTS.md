# 续办规则

「休息一下 Take rest」是 Windows 桌面提醒工具：定时在任务栏正上方弹一条文字，提醒做工位微动作，动作内容通过 GitHub 订阅扩展。主进程 Electron 30（CommonJS），界面 React 18 + Ant Design 5（Vite 构建）。

开始工作先读 `README.md` 了解现状，再读 `docs/架构与数据规范.md`——它是唯一契约：四层架构与执行方式契约（第 2 节）、三级数据结构（类别 → 部位 → 幅度档位）、任务栏探测算法、IPC 通道名、settings 字段、验收标准。改任何实现前先确认它跟规范是否一致，改了规范就同步改 README。

**四层依赖只能从上往下**，改代码时别把方向搞反：
`src/main/`（框架）→ `src/engine/`（定时引擎）→ `src/desktop/`（驱动桌面）→ `src/executors/`（执行方式）。
引擎层不许碰 `BrowserWindow` / `ipcMain` / 屏幕；驱动桌面不许直接依赖引擎业务；执行方式不许碰 electron。`npm run smoke` 里有一节专门查这个。

不能把规范里的设想当已实现：`轻响` / `震动` 两档只有语义定义，程序里尚未实现；订阅只支持公开仓库；`image` / `marquee` 等执行方式只是预留。

验证必须实际跑，不能只看代码：
- `npm run smoke` 全部通过（数据结构 + 语法 + 四层依赖边界）；
- `npm run check` 全部通过（含订阅同步、执行方式分发、真实动作弹窗、弹窗位置与任务栏算法一致）；
- 改过界面要 `npx vite build` 后启动应用截图看，别靠读 CSS 判断布局；
- 改过打包相关逻辑，要 `npm run build` 后实际启动一次产物目录里的可执行文件——打包态和开发态的路径解析不一样，preload 尤其容易漏。

**不要在任何文件里写死本机路径**（用户名目录、盘符、克隆位置）。需要路径一律用 `__dirname` / `app.getAppPath()` / 环境变量推导；数据目录跑 `store.paths.root()`，内置包目录跑 `store.paths.builtinPacksDir()`。文档里的命令只用相对路径。

渲染层的 `preload.cjs` 是 CommonJS，不经 Vite 打包，必须由 `scripts/build.cjs` 显式拷进包（已在 `PRELOADS` 列表里），新增 preload 记得同步加进去。

环境注意：某些终端 / IDE 会设置 `ELECTRON_RUN_AS_NODE=1`，此时 `electron` 会退化成纯 Node 进程（`app` 为 `undefined`）。跑 Electron 相关命令前先清掉该变量。

改完必须跑上面几条验证并复核 diff。
