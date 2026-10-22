/**
 * gh.js —— GitHub 订阅相关的纯逻辑（无 DOM、无框架）
 *
 * 契约来源：docs/架构与数据规范.md 第 7 节「订阅机制规范」
 *   - 订阅源 = 能直接 GET 到 JSON 的 raw URL，或一个含 manifest.json 的 GitHub 仓库
 *   - manifest 格式：{ format: "gongwei-tixing-registry/1", name, packs: ["packs/xxx.json", ...] }
 *   - 渲染进程不能直接 fetch（CORS），所有 HTTPS 请求都通过主进程的 api.ghRequest({ url }) 发
 *
 * 迁移说明：本文件从 src/panel/gh.js 原样搬到 React 渲染层，业务逻辑一行未改，
 * 只把原来「CommonJS / window.GH」两种导出换成 ESM 的具名导出 + 默认导出（GH）。
 * 用法：import GH from '../shared/gh.js';  await GH.addSubscription(window.api, input)
 */

'use strict';

const REGISTRY_FORMAT = 'gongwei-tixing-registry/1';
const PACK_FORMAT = 'gongwei-tixing-pack/1';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 统一抛中文错误（调用方 catch 到的 e.message 一定可以直接显示给用户） */
function fail(message) {
  const err = new Error(message);
  err.name = 'SubError';
  err.isUserFacing = true;
  return err;
}

/** 把任意后端错误/响应压成一句中文可读的话 */
function describeFailure(res, httpStatus) {
  if (!res) return '没有拿到任何响应';
  const status = Number(res.status || res.statusCode || httpStatus || 0);
  if (status === 404) return '404（文件不存在）';
  if (status === 401 || status === 403) return `${status}（无权限或触发 GitHub 限流）`;
  if (status === 429) return '429（请求过于频繁）';
  if (status >= 500) return `${status}（GitHub 服务端错误）`;
  if (res.error) return String(res.error);
  if (status) return `${status}`;
  return '请求失败';
}

/** 400ms 超时兜底，避免后端永远不 resolve 时面板卡死 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** ghRequest 的返回值可能是字符串，也可能是 {ok,status,body} 之类的对象，统一成文本 */
function bodyToText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (typeof res.body === 'string') return res.body;
  if (typeof res.text === 'string') return res.text;
  if (typeof res.data === 'string') return res.data;
  if (typeof res.data === 'object' && res.data !== null) return res.data;
  if (typeof res.body === 'object' && res.body !== null) return res.body;
  if (typeof res.content === 'string') return res.content;
  return res;
}

/** 判断一次 ghRequest 是否算成功 */
function isOk(res) {
  if (res == null) return false;
  if (typeof res === 'string') return res.length > 0;
  if (typeof res !== 'object') return false;
  if (res.ok === false) return false;
  const status = Number(res.status || res.statusCode || 0);
  if (status && (status < 200 || status >= 300)) return false;
  if (res.error) return false;
  return true;
}

/** 调一次 ghRequest，失败抛中文错误 */
async function fetchText(ghRequest, url, label) {
  let res;
  try {
    res = await withTimeout(
      ghRequest({ url }),
      20000,
      `${label}请求超时（20 秒没有响应），请检查网络能否访问 GitHub`
    );
  } catch (e) {
    if (e && e.isUserFacing) throw e;
    throw fail(`${label}请求失败：${(e && e.message) || '未知网络错误'}`);
  }
  if (!isOk(res)) {
    throw fail(`${label}${describeFailure(res)}`);
  }
  const text = bodyToText(res);
  if (typeof text === 'string' && text.trim() === '') {
    throw fail(`${label}返回了空内容`);
  }
  return text;
}

/** pack URL 里的中文/空格要编码，但不能重复编码 % */
function encodePath(p) {
  return String(p)
    .split('/')
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch (_) {
        return encodeURIComponent(seg);
      }
    })
    .join('/');
}

/* ------------------------------------------------------------------ *
 * normalizeRepoInput
 * ------------------------------------------------------------------ */

/**
 * 把用户粘贴的内容归一化成 { owner, repo, kind, url, manifestUrl }
 *   kind   —— 'repo'：GitHub 仓库地址；'raw'：直接指向 JSON 文件（manifest 或单个 pack）
 *   url    —— 真正的 JSON 地址（kind==='raw' 时就是用户给的那个；kind==='repo' 时是 HEAD 的 manifest.json）
 *   owner/repo —— kind==='raw' 时尽力从 raw.githubusercontent.com 路径里解析
 */
function normalizeRepoInput(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) throw fail('请先粘贴 GitHub 仓库地址或 raw JSON 地址');

  // 允许用户直接粘贴整段 shell 命令 / markdown 链接
  const urlMatch = raw.match(/https?:\/\/[^\s"'<>）)]+/i);
  if (urlMatch) raw = urlMatch[0];

  // 去掉零宽字符和一些常见噪声
  raw = raw.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[。，,；;、]+$/g, '').trim();
  if (!raw) throw fail('请先粘贴 GitHub 仓库地址或 raw JSON 地址');

  // a/b 简写
  const shorthand = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand && !raw.includes(':') && !raw.includes(' ')) {
    const owner = shorthand[1];
    const repo = shorthand[2].replace(/\.git$/i, '');
    return makeRepo(owner, repo);
  }

  // 带协议但可能是 http/https/git
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw fail('看不懂这个地址，请粘贴形如 https://github.com/用户名/仓库名 的链接');
  }

  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);

  // raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
  if (host === 'raw.githubusercontent.com') {
    if (segments.length < 3) {
      throw fail('raw 地址不完整，需要形如 https://raw.githubusercontent.com/用户名/仓库名/main/manifest.json');
    }
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, '');
    if (!/\.json$/i.test(u.pathname)) {
      throw fail('这个 raw 地址不是 JSON 文件，请粘贴指向 manifest.json 或动作包 JSON 的链接');
    }
    return {
      owner,
      repo,
      kind: 'raw',
      url: encodeURI(u.href),
      manifestUrl: encodeURI(u.href),
    };
  }

  // github.com 和它的各种变体
  if (host === 'github.com' || host === 'www.github.com' || host === 'raw.gitmirror.com') {
    if (segments.length < 2) {
      throw fail('链接里缺少仓库名，需要形如 https://github.com/用户名/仓库名');
    }
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, '');
    const rest = segments.slice(2);

    // github.com/{o}/{r}/raw/{branch}/{path}
    if (rest[0] === 'raw') {
      if (!/\.json$/i.test(u.pathname)) {
        throw fail('这个链接不是 JSON 文件，请粘贴指向 manifest.json 的链接');
      }
      const branch = rest[1] || 'HEAD';
      const path = rest.slice(2).join('/');
      if (!path) throw fail('链接里缺少文件路径');
      return {
        owner,
        repo,
        kind: 'raw',
        url: encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`),
        manifestUrl: encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`),
      };
    }

    // github.com/{o}/{r}/blob/{branch}/{path} → 转成 raw
    if (rest[0] === 'blob') {
      const branch = rest[1] || 'HEAD';
      const path = rest.slice(2).join('/');
      if (!path || !/\.json$/i.test(path)) {
        throw fail('这个链接不是 JSON 文件，请粘贴指向 manifest.json 的链接');
      }
      return {
        owner,
        repo,
        kind: 'raw',
        url: encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`),
        manifestUrl: encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`),
      };
    }

    return makeRepo(owner, repo);
  }

  // 其它主机：视作直接的 JSON 地址
  if (/^https?:$/.test(u.protocol)) {
    if (!/\.json$/i.test(u.pathname)) {
      throw fail('目前只支持 github.com 仓库地址，或者直接指向 .json 文件的地址');
    }
    return {
      owner: 'raw',
      repo: `source-${segments.length ? segments[segments.length - 2] || 'json' : 'json'}`.replace(/\.git$/i, ''),
      kind: 'raw',
      url: u.href,
      manifestUrl: u.href,
    };
  }

  throw fail('目前只支持 https 地址，请粘贴形如 https://github.com/用户名/仓库名 的链接');
}

function makeRepo(owner, repo) {
  if (!owner || !repo) throw fail('仓库地址里缺少用户名或仓库名');
  if (/[^\w.-]/.test(owner) || /[^\w.-]/.test(repo)) {
    throw fail('用户名或仓库名里有不支持的字符，请确认链接是否正确');
  }
  return {
    owner,
    repo,
    kind: 'repo',
    url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/manifest.json`,
    manifestUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/manifest.json`,
  };
}

/* ------------------------------------------------------------------ *
 * manifestUrls
 * ------------------------------------------------------------------ */

/** 依次尝试 manifest.json 的三个候选地址（HEAD → main → master） */
function manifestUrls(target) {
  const t = target && typeof target === 'object' ? target : normalizeRepoInput(target);
  if (t.kind === 'raw') {
    // 已经是具体文件地址：只试它自己，再补一个「同目录下的 manifest.json」
    const list = [t.url];
    if (!/\/manifest\.json$/i.test(t.url)) {
      const guessed = t.url.replace(/\/[^/]*$/, '/manifest.json');
      if (guessed !== t.url) list.push(guessed);
    }
    return list;
  }
  const base = `https://raw.githubusercontent.com/${t.owner}/${t.repo}`;
  return [
    `${base}/HEAD/manifest.json`,
    `${base}/main/manifest.json`,
    `${base}/master/manifest.json`,
  ];
}

/* ------------------------------------------------------------------ *
 * resolvePacks
 * ------------------------------------------------------------------ */

/**
 * 从 raw URL 里抠出分支名：https://raw.githubusercontent.com/o/r/{branch}/path
 * 不是 raw 结构时返回 ''。
 */
function branchOfUrl(url) {
  const m = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//i.exec(String(url || ''));
  return m ? m[1] : '';
}

/** 常见分支名的兜底探测顺序（GitHub API 拿不到分支列表时用） */
const FALLBACK_BRANCHES = ['packs', 'data', 'actions', 'main', 'master'];

/**
 * 用 ghRequest 逐个试 manifest URL → 校验 registry 格式 → 拉 packs。
 *
 * 分支感知（v0.1.2）：仓库约定是「默认分支放代码、单独一个分支放动作包」，
 * 所以默认分支上没有 manifest.json 是正常情况。流程是：
 *   1. 先按 URL 形式试（HEAD / main / master）
 *   2. 都失败且是仓库地址 → 问 GitHub API 有哪些分支，逐个分支试 manifest.json
 *   3. API 拿不到 → 退回到常见分支名（packs / data / actions …）
 * 找到的分支记在 manifestUrl 里，由 addSubscription 落到动作包的 branch 字段。
 *
 * @returns {Promise<{manifest:object, packs:object[], manifestUrl:string, branch:string}>}
 */
async function resolvePacks(ghRequest, target) {
  if (typeof ghRequest !== 'function') {
    throw fail('内部错误：缺少网络请求函数 ghRequest');
  }
  const t = target && typeof target === 'object' && target.owner
    ? target
    : normalizeRepoInput(target);

  const tryManifestUrl = async (url) => {
    const text = await fetchText(ghRequest, url, '拉取 manifest.json 时');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      throw fail(`manifest.json 不是合法的 JSON（${shortUrl(url)}）`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw fail(`manifest.json 内容不是对象（${shortUrl(url)}）`);
    }
    // 允许「直接指向单个动作包」的 raw 订阅：没有 format 或格式是 pack 时，包起来当 manifest
    if (parsed.format === PACK_FORMAT) {
      return { format: REGISTRY_FORMAT, name: parsed.name || t.repo, packs: [], _inlinePack: parsed };
    }
    if (parsed.format !== REGISTRY_FORMAT) {
      throw fail(
        `manifest.json 的 format 字段应为 "${REGISTRY_FORMAT}"，实际是 ${JSON.stringify(parsed.format == null ? null : parsed.format)}（${shortUrl(url)}）`
      );
    }
    return parsed;
  };

  let manifest = null;
  let manifestUrl = '';
  let lastError = null;

  // 第 1 步：按 URL 形式试
  const urls = manifestUrls(t);
  for (const url of urls) {
    try {
      manifest = await tryManifestUrl(url);
      manifestUrl = url;
      break;
    } catch (e) {
      lastError = e;
    }
  }

  // 第 2 / 3 步：仓库形态时，去别的分支上找动作包
  let branchScanNote = '';
  if (!manifest && t.kind === 'repo') {
    const base = `https://raw.githubusercontent.com/${t.owner}/${t.repo}`;
    const tried = new Set(['HEAD', 'main', 'master']);

    let branches = [];
    const hit = await fetchBranches(ghRequest, t);
    if (hit.ok) branches = hit.branches;
    else branchScanNote = hit.error;

    for (const name of branches) {
      if (!name || tried.has(name)) continue;
      tried.add(name);
      const url = `${base}/${encodePath(name)}/manifest.json`;
      try {
        manifest = await tryManifestUrl(url);
        manifestUrl = url;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    // API 不可用时，试几个约定俗成的分支名
    if (!manifest) {
      for (const name of FALLBACK_BRANCHES) {
        if (tried.has(name)) continue;
        tried.add(name);
        const url = `${base}/${encodePath(name)}/manifest.json`;
        try {
          manifest = await tryManifestUrl(url);
          manifestUrl = url;
          branchScanNote = 'GitHub API 不可用，按常见分支名探测';
          break;
        } catch (e) {
          lastError = e;
        }
      }
    }
  }

  // 实际绑定到的分支：raw URL 里那一段；仓库地址按 default 分支时记 'HEAD'
  const branch = branchOfUrl(manifestUrl) || 'HEAD';

  if (!manifest) {
    if (t.kind === 'raw') {
      throw fail(`订阅地址拉取失败：${(lastError && lastError.message) || '未知原因'}`);
    }
    const detail = lastError ? lastError.message : '';
    const scan = branchScanNote ? `（分支探测：${branchScanNote}）` : '';
    if (/404|文件不存在/.test(detail)) {
      throw fail(
        `仓库 ${t.owner}/${t.repo} 的所有分支里都没找到 manifest.json。` +
          `如果动作包放在单独的分支上，请在面板里直接粘贴那个分支的 raw 地址。${scan}`
      );
    }
    throw fail(`拉取 manifest.json 失败：${detail || '请检查仓库地址与网络'}${scan}`);
  }

  // 内联的单包订阅
  if (manifest._inlinePack) {
    const pack = manifest._inlinePack;
    return {
      manifest: { format: REGISTRY_FORMAT, name: manifest.name, packs: [pack.id || t.repo] },
      packs: [pack],
      manifestUrl,
      branch
    };
  }

  const list = Array.isArray(manifest.packs) ? manifest.packs : [];
  const validRefs = [];
  list.forEach((item) => {
    if (typeof item === 'string' && item.trim()) validRefs.push({ ref: item.trim(), inline: null });
    else if (item && typeof item === 'object' && item.format === PACK_FORMAT) validRefs.push({ ref: null, inline: item });
    else if (item && typeof item === 'object' && typeof item.path === 'string') validRefs.push({ ref: item.path.trim(), inline: null });
  });

  if (validRefs.length === 0) {
    throw fail('manifest.json 里 packs 是空的，这个仓库没有可用的动作包');
  }

  const baseDir = manifestUrl.replace(/\/[^/]*$/, ''); // manifest 所在目录 = 仓库根（raw URL 结构决定）
  const packs = [];
  for (const item of validRefs) {
    if (item.inline) {
      const v = validatePack(item.inline, 'manifest 内联动作包');
      if (v) packs.push(v);
      continue;
    }
    const rel = item.ref;
    if (/^https?:\/\//i.test(rel)) {
      const text = await fetchText(ghRequest, rel, `拉取动作包 ${rel} 时`);
      pushPack(packs, text, rel);
      continue;
    }
    const clean = rel.replace(/^\.\//, '').replace(/^\/+/, '');
    const url = `${baseDir}/${encodePath(clean)}`;
    let text;
    try {
      text = await fetchText(ghRequest, url, '');
    } catch (e) {
      const detail = (e && e.message) || '未知原因';
      if (/404/.test(detail)) {
        throw fail(`manifest.json 里的 ${clean} 拉取失败（404），请确认这个文件在仓库里存在`);
      }
      throw fail(`manifest.json 里的 ${clean} 拉取失败：${detail}`);
    }
    pushPack(packs, text, clean);
  }

  if (packs.length === 0) {
    throw fail('manifest.json 里列出的动作包全部无法解析，订阅未添加');
  }
  return { manifest, packs, manifestUrl, branch };
}

function pushPack(packs, text, label) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    throw fail(`动作包 ${label} 不是合法的 JSON，请确认仓库里的文件没有写坏`);
  }
  const v = validatePack(obj, label);
  if (v) packs.push(v);
}

/** 校验一个动作包的最小结构；不合法时抛中文错误 */
function validatePack(obj, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail(`动作包 ${label} 的内容不是 JSON 对象`);
  }
  if (obj.format !== PACK_FORMAT) {
    throw fail(
      `动作包 ${label} 的 format 字段应为 "${PACK_FORMAT}"，实际是 ${JSON.stringify(obj.format == null ? null : obj.format)}`
    );
  }
  if (!Array.isArray(obj.categories) || obj.categories.length === 0) {
    throw fail(`动作包 ${label} 里没有 categories（三级结构的最外层），无法使用`);
  }
  return obj;
}

function shortUrl(url) {
  return String(url).replace('https://raw.githubusercontent.com/', '');
}

/** 给 UI 用的展示名：manifest.name || 仓库名 */
function displayName(manifest, target) {
  if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
  if (target && target.kind === 'repo') return `${target.owner}/${target.repo}`;
  return '未命名订阅';
}

/* ------------------------------------------------------------------ *
 * addSubscription
 * ------------------------------------------------------------------ */

/**
 * 串起全部流程：归一化 → 拉 manifest → 拉 packs → 拉该仓库全部分支 → api.installSubscription
 *
 * 分支语义（v0.1.1）：
 *   - 绑定一个 GitHub 仓库后，把该仓库**所有分支**里声明了 manifest.json 的都当订阅源收录，
 *     manifest 里每个动作包还带 `branches` 字段（这台机器现在跑的是哪个分支）。
 *   - 分支列表来自 GitHub API `GET /repos/{owner}/{repo}/branches`（主进程转发，绕开 CORS）。
 *   - API 拿不到（限流 / 断网 / 代理不通）时，只用 URL 里显式指定的分支或 default_branch，
 *     `branches` 记为 [`main`]，不阻断订阅。
 * @returns {Promise<{name:string, source:string, packs:object[], manifest:object, branches:string[]}>}
 */
async function addSubscription(api, input) {
  if (!api || typeof api.ghRequest !== 'function') {
    throw fail('内部错误：api.ghRequest 不可用');
  }
  if (typeof api.installSubscription !== 'function') {
    throw fail('内部错误：当前版本主进程不支持安装订阅（缺少 installSubscription）');
  }
  const target = normalizeRepoInput(input);
  const { manifest, packs, branch, manifestUrl } = await resolvePacks(api.ghRequest, target);
  const name = displayName(manifest, target);
  // 订阅源统一记成仓库地址（带分支的 raw 地址则保留原样），面板上更好认
  const source = target.kind === 'repo' && branch === 'HEAD'
    ? `https://github.com/${target.owner}/${target.repo}`
    : manifestUrl;

  // 动作包记下自己来自哪个分支（面板和排障都靠它）
  packs.forEach((p) => { p.branch = branch; });

  try {
    const res = await api.installSubscription({ name, source, packs });
    // 主进程失败场景：可能抛错，也可能返回 { ok:false, error }
    if (res && typeof res === 'object' && res.ok === false) {
      throw fail(`动作包已下载，但写入本地失败：${res.error || '主进程拒绝了这次安装'}`);
    }
  } catch (e) {
    if (e && e.isUserFacing) throw e;
    throw fail(`动作包已下载，但写入本地失败：${(e && e.message) || '未知错误'}`);
  }
  return { name, source, packs, manifest, branch, manifestUrl };
}

/**
 * 拉某个 GitHub 仓库的分支列表。
 * @returns {Promise<{ok:boolean, branches:string[], error:string}>}
 */
async function fetchBranches(ghRequest, target) {
  const t = target && typeof target === 'object' ? target : normalizeRepoInput(target);
  if (t.kind !== 'repo') return { ok: false, branches: [], error: '不是仓库地址，跳过分支探测' };
  const url = `https://api.github.com/repos/${t.owner}/${t.repo}/branches?per_page=100`;
  try {
    const res = await ghRequest({ url });
    const okRes = res && typeof res === 'object' && ('ok' in res) ? res.ok !== false : true;
    const text = typeof res === 'string' ? res : bodyToText(res);
    if (!okRes) return { ok: false, branches: [], error: `分支列表拉取失败：${describeFailure(res)}` };
    if (/rate limit/i.test(text)) return { ok: false, branches: [], error: 'GitHub API 触发限流，暂用默认分支' };
    let list;
    try { list = JSON.parse(text); } catch (_) {
      return { ok: false, branches: [], error: '分支列表不是合法 JSON' };
    }
    if (!Array.isArray(list)) {
      return { ok: false, branches: [], error: describeFailure({ error: text }) };
    }
    const names = list.map((b) => (b && typeof b.name === 'string' ? b.name.trim() : '')).filter(Boolean);
    return { ok: names.length > 0, branches: names, error: names.length ? '' : '仓库没有任何分支' };
  } catch (e) {
    return { ok: false, branches: [], error: (e && e.message) || '分支列表拉取异常' };
  }
}

/* ------------------------------------------------------------------ *
 * 导出（ESM：具名导出给按需引用，默认导出是整包 GH 对象）
 * ------------------------------------------------------------------ */

const GH = {
  REGISTRY_FORMAT,
  PACK_FORMAT,
  normalizeRepoInput,
  manifestUrls,
  resolvePacks,
  addSubscription,
  fetchBranches,
  branchOfUrl,
  FALLBACK_BRANCHES,
  validatePack,
  displayName,
};

export {
  REGISTRY_FORMAT,
  PACK_FORMAT,
  normalizeRepoInput,
  manifestUrls,
  resolvePacks,
  addSubscription,
  fetchBranches,
  branchOfUrl,
  FALLBACK_BRANCHES,
  validatePack,
  displayName,
};

export default GH;
