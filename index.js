/**
 * Novel Studio (写小说) - SillyTavern / TauriTavern 第三方扩展
 *
 * 模块:
 *  - 全局关键字: 作为所有生成的系统引导词注入
 *  - 顶部状态栏: 连接状态 / AI来源+模型 / 预设
 *  - 写新小说: 背景 + 人物/道具设定 + 章节大纲, 手动/自动逐章生成; 每 N 章表格总结
 *  - 续写: 上传 txt 分段并发分析(角色档案+剧情梗概), 按大纲续写 / 自然续写
 *  - 一键导出: 把小说导出为 txt 下载
 *
 * 不使用相对 import(避免 TauriTavern 目录深度问题), 常量用字面量。
 */

const EXT_ID = 'novel-studio';
const EXT_NAME = 'Novel Studio 小说工坊';
const LOG_PREFIX = '[NovelStudio]';

/** 扩展设置命名空间。 */
const MODULE_NAME = 'novel_studio';

/** setExtensionPrompt 注入 key。 */
const INJECT_KEY = `${MODULE_NAME}_global_keyword`;

/** SillyTavern 常量(字面量)。 */
const PROMPT_TYPE = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const PROMPT_ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

/** 默认设置。 */
const DEFAULT_SETTINGS = Object.freeze({
  keywordEnabled: true,
  globalKeyword: '',
  // 写小说模块
  projects: [],
  activeProjectId: '',
  summaryEveryN: 10, // 每 N 章自动总结（章表格总结）
  dynamicSegmentSecs: 4, // 重新动态总结时，每段合并处理的节数（长文分割加速）
  // 请求可靠性（偏低频率，避免 429 / quota）
  genMaxRetries: 1,       // 额外重试次数（合计最多 2 次尝试，避免连打配额）
  genRetryBaseMs: 8000,   // 普通重试基础延迟(指数退避)
  genMinIntervalMs: 5000, // 两次 generateRaw 之间最小间隔
  genRateLimitMs: 15000,  // 遇到 429/限流时至少等待（接口提示约 10s 重置）
  genTimeoutMs: 180000,   // 单次生成超时(毫秒)
  // 续写/分析模块
  analyzeChunkSize: 6000,
  analyzeConcurrency: 1,  // 默认串行，降低并发打满配额
  contextTailChars: 2500,
  continuations: [],      // 续写会话列表(替代旧的单项 continuation)
  activeContinuationId: '',
});

/** 生成短 id。 */
function genId() {
  return `np_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 统一日志(F12 过滤 "NovelStudio")。 */
const log = {
  info: (...a) => console.log(LOG_PREFIX, ...a),
  warn: (...a) => console.warn(LOG_PREFIX, ...a),
  error: (...a) => console.error(LOG_PREFIX, ...a),
  debug: (...a) => console.debug(LOG_PREFIX, ...a),
};

/** 获取 SillyTavern 上下文。 */
function getST() {
  try {
    if (typeof globalThis.SillyTavern?.getContext === 'function') {
      return globalThis.SillyTavern.getContext();
    }
  } catch (e) {
    log.warn('SillyTavern.getContext() 调用失败:', e);
  }
  return null;
}

/** 探测酒馆助手(可选增强)。 */
function getTavernHelper() {
  return globalThis.TavernHelper ?? null;
}

/* ------------------------------------------------------------------ */
/* 预设 System Prompt 读取                                             */
/* ------------------------------------------------------------------ */

/**
 * 读取当前激活的 System Prompt / 预设中的系统向提示词。
 * 仅由本扩展在 generateRaw 的 system 里放入一次；工坊生成期间会清空扩展注入，避免与酒馆管道叠份。
 */
function readSysPrompt() {
  const ctx = getST();
  if (!ctx) return '';
  const chunks = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s) return;
    if (chunks.some((c) => c === s || c.includes(s) || s.includes(c))) return;
    chunks.push(s);
  };
  try {
    const sp = ctx.powerUserSettings?.sysprompt;
    if (sp && sp.enabled !== false && sp.content) push(sp.content);
  } catch (e) {
    log.warn('读取预设 System Prompt 失败:', e);
  }
  // Chat Completion 预设里已启用的非 marker 系统提示（有总长度预算，避免炸 token）
  try {
    const oai = ctx.chatCompletionSettings || ctx.oai_settings || {};
    const prompts = Array.isArray(oai.prompts) ? oai.prompts : [];
    let budget = 3500;
    for (const p of prompts) {
      if (!p || p.enabled === false || p.marker) continue;
      const role = String(p.role || '').toLowerCase();
      if (role && role !== 'system') continue;
      const c = String(p.content || '').trim();
      if (!c) continue;
      if (budget <= 0) break;
      const slice = c.length > budget ? c.slice(0, budget) : c;
      const before = chunks.length;
      push(slice);
      if (chunks.length > before) budget -= slice.length;
    }
  } catch (e) {
    log.debug('读取 Chat Completion 预设系统提示跳过:', e?.message || e);
  }
  return chunks.join('\n\n');
}

/**
 * 读取当前全局提示词（globalKeyword）文字内容。
 * 普通聊天走 setExtensionPrompt；小说工坊 generateRaw 只在 ordered_prompts 里放一次，避免重复。
 */
function readGlobalKeyword() {
  const s = getSettings();
  if (!s.keywordEnabled) return '';
  return (s.globalKeyword || '').trim();
}

/** >0 时跳过 GENERATION_STARTED 刷新注入，避免工坊 generateRaw 与显式 prompt 叠两份。 */
let suppressKeywordRefresh = 0;

/** 临时清空扩展注入，执行 fn 后恢复（供 generateRaw 独占提示词）。 */
async function withClearedKeywordInject(fn) {
  suppressKeywordRefresh += 1;
  const ctx = getST();
  try {
    if (ctx && typeof ctx.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECT_KEY, '', PROMPT_TYPE.IN_CHAT, 4, false, PROMPT_ROLE.SYSTEM);
    }
    return await fn();
  } finally {
    suppressKeywordRefresh = Math.max(0, suppressKeywordRefresh - 1);
    if (suppressKeywordRefresh === 0) refreshGlobalKeyword();
  }
}

/* ------------------------------------------------------------------ */
/* 状态读取: AI 来源/模型 + 预设                                        */
/* ------------------------------------------------------------------ */

function readApiAndModel() {
  const ctx = getST();
  if (!ctx) return { mainApi: '', source: '未知', model: '', connected: false };
  const mainApi = ctx.mainApi || '';
  const online = ctx.onlineStatus;
  const connected = !!online && online !== 'no_connection';
  let source = mainApi || '未知';
  let model = '';
  try {
    if (mainApi === 'openai') {
      const cc = ctx.chatCompletionSettings || {};
      source = cc.chat_completion_source || 'openai';
      model =
        (typeof ctx.getChatCompletionModel === 'function' ? ctx.getChatCompletionModel() : '') ||
        cc.custom_model ||
        cc.openai_model ||
        '';
    } else if (mainApi === 'textgenerationwebui') {
      const tg = ctx.textCompletionSettings || {};
      source = tg.type || 'textgenerationwebui';
      model = connected ? online : '';
    } else {
      model = connected ? online : '';
    }
  } catch (e) {
    log.warn('读取 API/模型失败:', e);
  }
  return { mainApi, source, model, connected };
}

function readPresetName() {
  const ctx = getST();
  if (!ctx || typeof ctx.getPresetManager !== 'function') return '';
  try {
    const pm = ctx.getPresetManager();
    if (pm && typeof pm.getSelectedPresetName === 'function') return pm.getSelectedPresetName() || '';
  } catch (e) {
    log.warn('读取预设名失败:', e);
  }
  return '';
}

function readStatus() {
  const { mainApi, source, model, connected } = readApiAndModel();
  return { mainApi, source, model, connected, preset: readPresetName() };
}

/* ------------------------------------------------------------------ */
/* 设置持久化 + 全局关键字注入                                          */
/* ------------------------------------------------------------------ */

function getSettings() {
  const ctx = getST();
  if (!ctx || !ctx.extensionSettings) {
    log.warn('extensionSettings 不可用, 使用临时设置(不会持久化)');
    if (!getSettings._fallback) getSettings._fallback = structuredClone(DEFAULT_SETTINGS);
    return getSettings._fallback;
  }
  const store = ctx.extensionSettings;
  if (!store[MODULE_NAME]) store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(store[MODULE_NAME], key)) store[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
  }
  // 迁移: 旧版每 20 章总结, 统一改为每 10 章
  if (store[MODULE_NAME].summaryEveryN === 20) store[MODULE_NAME].summaryEveryN = 10;
  // 迁移: 旧版单个 continuation 对象 → continuations 数组
  {
    const s = store[MODULE_NAME];
    if (s.continuation && !s.continuations?.length) {
      const old = s.continuation;
      if (!Array.isArray(s.continuations)) s.continuations = [];
      old.id = old.id || genId();
      old.title = old.title || '续写会话（迁移）';
      s.continuations.push(old);
      s.activeContinuationId = old.id;
      delete s.continuation;
    }
  }
  // 降频：对已保存的过快默认做一次抬高（暂无 UI，避免继续 429）
  {
    const s = store[MODULE_NAME];
    if (s._nsRateLimitV2 !== 1) {
      s.genMaxRetries = 1;
      s.genRetryBaseMs = Math.max(8000, Number(s.genRetryBaseMs) || 8000);
      s.genMinIntervalMs = Math.max(5000, Number(s.genMinIntervalMs) || 5000);
      s.genRateLimitMs = Math.max(15000, Number(s.genRateLimitMs) || 15000);
      // 旧默认并发 2 → 改为串行；用户若已手动调过更大值则保留
      if (Number(s.analyzeConcurrency) === 2) s.analyzeConcurrency = 1;
      s._nsRateLimitV2 = 1;
    }
  }
  return store[MODULE_NAME];
}

function saveSettings() {
  const ctx = getST();
  if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function refreshGlobalKeyword() {
  if (suppressKeywordRefresh > 0) return;
  const ctx = getST();
  if (!ctx || typeof ctx.setExtensionPrompt !== 'function') {
    log.warn('setExtensionPrompt 不可用, 无法注入全局关键字');
    return;
  }
  const s = getSettings();
  const text = s.keywordEnabled ? (s.globalKeyword || '').trim() : '';
  try {
    ctx.setExtensionPrompt(INJECT_KEY, text, PROMPT_TYPE.IN_CHAT, 4, false, PROMPT_ROLE.SYSTEM);
    log.debug('全局关键字注入已刷新:', text ? `"${text.slice(0, 40)}"` : '(空)');
  } catch (e) {
    log.warn('注入全局关键字失败:', e);
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function waitFor(predicate, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = !!predicate();
      } catch (e) {
        ok = false;
      }
      if (ok) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        log.warn(`等待 ${label} 超时(${timeout}ms), 降级运行`);
        resolve(false);
      }
    }, interval);
  });
}

function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
}

/** HTML 转义。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 复制到剪贴板(优先 Clipboard API, 降级 execCommand)。 */
async function copyToClipboard(text) {
  const s = String(text ?? '');
  if (!s) {
    toast('没有可复制的内容');
    return;
  }
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(s);
      toast('已复制到剪贴板');
      return;
    }
  } catch (e) {
    log.warn('Clipboard API 失败, 降级:', e);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? '已复制到剪贴板' : '复制失败, 请手动复制');
  } catch (e) {
    log.error('复制失败:', e);
    toast('复制失败, 请手动复制');
  }
}

/** 触发浏览器下载(保存到"下载"目录)。 */
function downloadText(filename, text) {
  try {
    const blob = new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'novel.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已开始下载');
    log.info('导出下载:', filename);
  } catch (e) {
    log.error('导出失败:', e);
    toast(`导出失败: ${e.message}`);
  }
}

/** 安全文件名。 */
function safeFileName(name) {
  return String(name || 'novel').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

/* ================================================================== */
/* 写小说模块                                                          */
/* ================================================================== */

const novelState = { generating: false, cancelRequested: false, currentGenId: '', activeFlatIdx: -1, activeActIdx: -1 };
let _novelDragAttach = null; // 写小说节拖拽重绑函数

/** 流式风格进度条状态（确定性 0→100% + 本次生成耗时）。 */
const genUiProgress = {
  channel: '', // 'novel' | 'cont'
  startedAt: 0,
  pct: 0,
  lastElapsedMs: 0,
  timer: null,
  finishing: false,
  statusMsg: '', // 节内工作状态文案
  targetFlatIdx: -1, // 状态挂在哪一节
  phase: '', // 'gen' | 'summary'
};

function formatGenElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 模拟流式推进：前期较快，接近完成时缓到约 95%，真正结束再到 100%。 */
function estimatedStreamPct(elapsedMs) {
  const t = Math.max(0, Number(elapsedMs) / 1000);
  if (t <= 0) return 0;
  if (t < 1.5) return Math.min(12, Math.round(t * 8));
  const soft = 12 + 83 * (1 - Math.exp(-(t - 1.5) / 28));
  return Math.min(95, Math.round(soft));
}

/** 某节是否正在显示节内工作条（生成或总结）。 */
function isSectionWorking(channel, flatIdx) {
  return (
    genUiProgress.channel === channel &&
    genUiProgress.targetFlatIdx === flatIdx &&
    flatIdx >= 0 &&
    (!!genUiProgress.startedAt || genUiProgress.finishing || !!genUiProgress.statusMsg)
  );
}

/** 更新当前生成节内的工作状态文案。 */
function setGenSectionStatus(msg) {
  genUiProgress.statusMsg = String(msg || '').trim();
  paintGenUiProgress();
}

function genProgressBlockHtml() {
  const pct = Math.max(0, Math.min(100, Math.round(genUiProgress.pct || 0)));
  const elapsed = formatGenElapsed(
    genUiProgress.startedAt ? Date.now() - genUiProgress.startedAt : genUiProgress.lastElapsedMs,
  );
  const status = genUiProgress.statusMsg || (genUiProgress.phase === 'summary' ? '总结中…' : '生成中…');
  return `<div class="ns-chapter__gen">
    <div class="ns-gen-status">${esc(status)}</div>
    <div class="ns-gen-meta">
      <span class="ns-gen-label"><i class="fa-solid fa-spinner fa-spin"></i> <span class="ns-gen-pct">${pct}%</span></span>
      <span class="ns-gen-elapsed" title="本次耗时">本次 ${esc(elapsed)}</span>
    </div>
    <div class="ns-progress"><div class="ns-progress__bar ns-progress__bar--stream" style="width:${pct}%"></div></div>
  </div>`;
}

function paintGenUiProgress() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const pct = Math.max(0, Math.min(100, Math.round(genUiProgress.pct || 0)));
  const elapsedMs = genUiProgress.startedAt
    ? Date.now() - genUiProgress.startedAt
    : genUiProgress.lastElapsedMs;
  genUiProgress.lastElapsedMs = elapsedMs;
  const elapsed = formatGenElapsed(elapsedMs);
  const rootSel =
    genUiProgress.channel === 'cont' ? `#${EXT_ID}-analyze` : `#${EXT_ID}-novel`;
  const $root = $(rootSel);
  if (!$root.length) return;

  const $gen = $root.find('.ns-chapter__gen');
  if (!$gen.length) return;
  $gen.find('.ns-progress__bar').css('width', `${pct}%`);
  $gen.find('.ns-gen-pct').text(`${pct}%`);
  $gen.find('.ns-gen-elapsed').text(`本次 ${elapsed}`);
  if (genUiProgress.statusMsg) {
    $gen.find('.ns-gen-status').text(genUiProgress.statusMsg);
  }
}

/**
 * 开始节内进度 UI。
 * @param {'novel'|'cont'} channel
 * @param {{ flatIdx?: number, phase?: 'gen'|'summary', status?: string }} opts
 */
function startGenUiProgress(channel, opts = {}) {
  if (genUiProgress.timer) {
    clearInterval(genUiProgress.timer);
    genUiProgress.timer = null;
  }
  genUiProgress.channel = channel || 'novel';
  genUiProgress.startedAt = Date.now();
  genUiProgress.pct = 0;
  genUiProgress.lastElapsedMs = 0;
  genUiProgress.finishing = false;
  if (typeof opts.flatIdx === 'number') genUiProgress.targetFlatIdx = opts.flatIdx;
  genUiProgress.phase = opts.phase || 'gen';
  if (opts.status) genUiProgress.statusMsg = opts.status;
  else if (!genUiProgress.statusMsg) {
    genUiProgress.statusMsg = genUiProgress.phase === 'summary' ? '总结中…' : '生成中…';
  }
  paintGenUiProgress();
  genUiProgress.timer = setInterval(() => {
    if (!genUiProgress.startedAt || genUiProgress.finishing) return;
    genUiProgress.pct = estimatedStreamPct(Date.now() - genUiProgress.startedAt);
    paintGenUiProgress();
  }, 200);
}

/** 切换到「总结」阶段（同一节上继续显示进度，不拆掉 UI）。 */
function switchGenUiToSummary(statusMsg) {
  if (genUiProgress.timer) {
    clearInterval(genUiProgress.timer);
    genUiProgress.timer = null;
  }
  genUiProgress.phase = 'summary';
  genUiProgress.finishing = false;
  genUiProgress.startedAt = Date.now();
  genUiProgress.pct = 0;
  genUiProgress.lastElapsedMs = 0;
  genUiProgress.statusMsg = statusMsg || '生成中… 正在更新最新进度/人物链…';
  paintGenUiProgress();
  genUiProgress.timer = setInterval(() => {
    if (!genUiProgress.startedAt || genUiProgress.finishing) return;
    genUiProgress.pct = estimatedStreamPct(Date.now() - genUiProgress.startedAt);
    paintGenUiProgress();
  }, 200);
}

function finishGenUiProgress() {
  if (!genUiProgress.startedAt && !genUiProgress.finishing) return genUiProgress.lastElapsedMs;
  if (genUiProgress.timer) {
    clearInterval(genUiProgress.timer);
    genUiProgress.timer = null;
  }
  genUiProgress.finishing = true;
  genUiProgress.lastElapsedMs = genUiProgress.startedAt
    ? Date.now() - genUiProgress.startedAt
    : genUiProgress.lastElapsedMs;
  genUiProgress.startedAt = 0;
  genUiProgress.pct = 100;
  paintGenUiProgress();
  return genUiProgress.lastElapsedMs;
}

function stopGenUiProgress() {
  if (genUiProgress.timer) {
    clearInterval(genUiProgress.timer);
    genUiProgress.timer = null;
  }
  genUiProgress.startedAt = 0;
  genUiProgress.pct = 0;
  genUiProgress.finishing = false;
  genUiProgress.channel = '';
  genUiProgress.statusMsg = '';
  genUiProgress.targetFlatIdx = -1;
  genUiProgress.phase = '';
}

/**
 * 面板折叠状态。默认全部折叠；仅用户手动点击会改变，重绘/开关面板不自动改。
 * modules.* = true 表示主模块展开；open[key] = true 表示对应子折叠块展开。
 */
const uiFoldState = {
  modules: { analyze: false, novel: false },
  open: Object.create(null),
};

function isUiOpen(key) {
  return !!uiFoldState.open[key];
}
function setUiOpen(key, open) {
  if (!key) return;
  if (open) uiFoldState.open[key] = true;
  else delete uiFoldState.open[key];
}
/** 章折叠：未手动设置过则默认折叠。 */
function isActFolded(act) {
  return typeof act?._folded === 'boolean' ? act._folded : true;
}
/** 折叠头/身 HTML 辅助（根据 uiFoldState 决定展开）。 */
function foldIconClass(key) {
  return isUiOpen(key) ? 'ns-collapse__icon ns-collapse__icon--open' : 'ns-collapse__icon';
}
function foldBodyStyle(key) {
  return isUiOpen(key) ? '' : ' style="display:none;"';
}

/* ---------------------------- 项目 CRUD ---------------------------- */

function getProjects() {
  const s = getSettings();
  if (!Array.isArray(s.projects)) s.projects = [];
  return s.projects;
}

/** 确保项目有 worldDefs 结构，并迁移旧 entities 字段。 */
function ensureWorldDefs(proj) {
  if (!proj) return;
  if (!proj.worldDefs) {
    proj.worldDefs = { chars: [], items: [], places: [], others: [], preload: false };
  }
  const wd = proj.worldDefs;
  if (!Array.isArray(wd.chars)) wd.chars = [];
  if (!Array.isArray(wd.items)) wd.items = [];
  if (!Array.isArray(wd.places)) wd.places = [];
  if (!Array.isArray(wd.others)) wd.others = [];
  if (typeof wd.preload !== 'boolean') wd.preload = false;
  if (typeof proj.worldBookName !== 'string') proj.worldBookName = '';
  // 迁移旧 entities
  if (Array.isArray(proj.entities) && proj.entities.length && !wd.chars.length) {
    wd.chars = proj.entities.filter(Boolean);
    proj.entities = [];
  }
}

/** 清理历史脏数据：done=true 但正文为空/过短的节改为未完成。 */
function sanitizeEmptyDoneSections(obj) {
  if (!obj?.acts) return;
  let changed = false;
  for (const act of obj.acts) {
    for (const sec of act.sections || []) {
      if (sec.done && !hasValidSectionContent(sec)) {
        sec.done = false;
        sec.content = '';
        changed = true;
      }
    }
  }
  return changed;
}

function getActiveProject() {
  const s = getSettings();
  const proj = getProjects().find((p) => p.id === s.activeProjectId) || null;
  if (proj) {
    ensureActs(proj);
    ensureWorldDefs(proj);
    if (!Array.isArray(proj.plotChain)) proj.plotChain = [];
    let dirty = sanitizeEmptyDoneSections(proj);
    if (stripLegacyCompactFields(proj)) dirty = true;
    if (dirty) touchProject(proj);
  }
  return proj;
}

function makeProject(title, source = 'manual') {
  const now = Date.now();
  return {
    id: genId(),
    title: title || `未命名小说 ${new Date(now).toLocaleString()}`,
    background: '',
    entities: [], // 旧版兼容字段(迁移后为空)
    worldDefs: { chars: [], items: [], places: [], others: [], preload: false }, // 世界设定分类
    worldBookName: '', // 已同步的酒馆世界书名称
    acts: [], // 章-节层次结构 Act[]
    summaries: [], // 每大章一条表格总结
    plotChain: [], // 动态大总结：按节剧情链（每节 1 节点）
    liveProgress: null, // 动态大总结：{actNo,secNo,charChains,updatedAt}
    analysis: null,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

/* ---------------------------- 章-节 数据模型 ---------------------------- */
/**
 * Act(章)  { id, title, overview, sections: Section[] }
 * Section(节) { id, outline, content, done, updatedAt }
 */

function makeSection(outline = '') {
  return { id: genId(), outline: String(outline || ''), content: '', done: false, updatedAt: 0 };
}
function makeAct(title = '', overview = '') {
  return { id: genId(), title: String(title || ''), overview: String(overview || ''), sections: [], _folded: true };
}

/**
 * 确保对象含 acts 层次结构。若为旧版(outline/chapters 平铺), 自动迁移:
 * 每个旧章 -> 1 大章(标题=大纲文本, 含 1 个节, 节正文=旧章正文)。
 * 迁移后删除旧字段。适用于 project 与 continuation。
 */
function ensureActs(obj) {
  if (!obj) return;
  if (Array.isArray(obj.acts)) {
    // 补齐 sections 字段
    for (const act of obj.acts) if (!Array.isArray(act.sections)) act.sections = [];
    return;
  }
  const acts = [];
  const oldOutline = Array.isArray(obj.outline) ? obj.outline : [];
  const oldChapters = Array.isArray(obj.chapters) ? obj.chapters : [];
  const n = Math.max(oldOutline.length, oldChapters.length);
  for (let i = 0; i < n; i++) {
    const c = oldChapters[i] || {};
    const act = makeAct(oldOutline[i] || c.outline || `第 ${i + 1} 章`, '');
    const sec = makeSection(oldOutline[i] || c.outline || '');
    sec.content = c.content || '';
    sec.done = !!c.done;
    sec.updatedAt = c.updatedAt || 0;
    act.sections.push(sec);
    acts.push(act);
  }
  obj.acts = acts;
  delete obj.outline;
  delete obj.chapters;
}

/** 展平所有节, 返回 [{act, actIdx, sec, secIdx, flatIdx}]。 */
function flatSections(obj) {
  const out = [];
  let flat = 0;
  (obj.acts || []).forEach((act, actIdx) => {
    (act.sections || []).forEach((sec, secIdx) => {
      out.push({ act, actIdx, sec, secIdx, flatIdx: flat++ });
    });
  });
  return out;
}

/** 已完成节数。 */
/** 已完成节数(仅计有效正文，空回不算完成)。 */
function doneSectionCount(obj) {
  return flatSections(obj).filter((f) => hasValidSectionContent(f.sec)).length;
}
/** 全部节数。 */
function totalSectionCount(obj) {
  return flatSections(obj).length;
}
/** 判断某大章是否所有节都已完成(且至少有一个节)。空回节视为未完成。 */
function isActComplete(act) {
  const secs = act.sections || [];
  return secs.length > 0 && secs.every((s) => hasValidSectionContent(s));
}
/** 章内是否已有可总结的正文(允许章未写完时强制总结)。 */
function actHasGeneratedContent(act) {
  return (act?.sections || []).some((s) => hasValidSectionContent(s));
}
/** 取全书最后一节已生成正文的位置。 */
function findLastDoneSection(obj) {
  const flat = flatSections(obj);
  for (let i = flat.length - 1; i >= 0; i--) {
    const f = flat[i];
    if (hasValidSectionContent(f.sec)) return f;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 章节锁定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 锁定某节及其之前所有节（展平顺序）的正文。
 * 传入 obj(proj/cont)、目标 actIdx、secIdx。
 */
function lockUpToSection(obj, targetActIdx, targetSecIdx) {
  const flat = flatSections(obj);
  const targetFlat = flat.find((f) => f.actIdx === targetActIdx && f.secIdx === targetSecIdx);
  if (!targetFlat) return;
  for (const f of flat) {
    if (f.flatIdx <= targetFlat.flatIdx) f.sec.locked = true;
  }
}

/**
 * 解锁某节及其之后所有节。
 */
function unlockFromSection(obj, targetActIdx, targetSecIdx) {
  const flat = flatSections(obj);
  const targetFlat = flat.find((f) => f.actIdx === targetActIdx && f.secIdx === targetSecIdx);
  if (!targetFlat) return;
  for (const f of flat) {
    if (f.flatIdx >= targetFlat.flatIdx) f.sec.locked = false;
  }
}

/** 检查节是否被锁定。 */
function isSectionLocked(sec) {
  return !!sec.locked;
}

function createProject(title) {
  const s = getSettings();
  const proj = makeProject(title, 'manual');
  getProjects().push(proj);
  s.activeProjectId = proj.id;
  saveSettings();
  log.info('新建小说:', proj.title, proj.id);
  return proj;
}

function deleteProject(id) {
  const s = getSettings();
  const list = getProjects();
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (s.activeProjectId === id) s.activeProjectId = list[0]?.id || '';
    saveSettings();
    log.info('已删除小说:', id);
  }
}

function touchProject(proj) {
  if (proj) proj.updatedAt = Date.now();
  saveSettings();
}

/* ---------------------------- 生成封装 ---------------------------- */

/** 后台生成(优先 TavernHelper.generateRaw, 降级原生), 不带角色卡/世界书/历史。 */
/** sleep 工具。 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 可中止的等待；shouldCancel 返回 true 时抛出「已中止」。 */
async function waitCancellable(ms, shouldCancel) {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 0) return;
  const step = 250;
  for (let waited = 0; waited < total; waited += step) {
    if (shouldCancel?.()) throw new Error('已中止');
    await sleep(Math.min(step, total - waited));
  }
}

/**
 * 给 containerSel 内的节绑定拖拽排序。
 * 用 pointer 事件(非 HTML5 drag)实现，绕过 Tauri 对 dragover/drop 的劫持。
 * 策略: 手柄 pointerdown 开始追踪 → pointermove 高亮目标 → pointerup 完成排序。
 */
function bindSectionDrag(containerSel, getSec, save, rerender) {
  const $ = globalThis.jQuery;
  if (!$) return null;
  const $root = $(containerSel);
  if (!$root.length) return null;
  const root = $root[0];

  // 卸载旧绑定
  const oldCleanup = $root.data('drag-cleanup');
  if (typeof oldCleanup === 'function') oldCleanup();

  let isDragging = false;
  let dragSrcAi = -1, dragSrcSi = -1;
  let pointerId = null;

  // 全局 pointermove / pointerup（绑在 document 上，持续追踪）
  function onDocPointerMove(e) {
    if (!isDragging) return;
    // 找鼠标下方的节
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const sec = el.closest?.('.ns-section');
    if (!sec) return;
    const tAi = Number(sec.dataset.a);
    const tSi = Number(sec.dataset.s);
    if (isNaN(tAi) || isNaN(tSi)) return;
    // 高亮目标(同章内才高亮)
    if (tAi === dragSrcAi && tSi !== dragSrcSi) {
      root.querySelectorAll('.ns-section').forEach((s) => s.classList.remove('ns-sec-dragover'));
      sec.classList.add('ns-sec-dragover');
    } else {
      sec.classList.remove('ns-sec-dragover');
    }
  }

  function onDocPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('pointermove', onDocPointerMove);
    document.removeEventListener('pointerup', onDocPointerUp);
    document.body.classList.remove('ns-dragging-active');

    // 找松开位置下方的节
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const sec = el?.closest?.('.ns-section');
    root.querySelectorAll('.ns-section').forEach((s) => s.classList.remove('ns-sec-dragover'));

    if (!sec) { dragSrcAi = -1; dragSrcSi = -1; return; }
    const tAi = Number(sec.dataset.a);
    const tSi = Number(sec.dataset.s);
    if (dragSrcAi === -1 || (dragSrcAi === tAi && dragSrcSi === tSi)) { dragSrcAi = -1; dragSrcSi = -1; return; }
    if (dragSrcAi !== tAi) { toast('节只能在同一章内排序'); dragSrcAi = -1; dragSrcSi = -1; return; }
    const secs = getSec(tAi);
    if (!secs || dragSrcSi >= secs.length || tSi >= secs.length) { dragSrcAi = -1; dragSrcSi = -1; return; }
    // 锁定节不可参与排序
    if (isSectionLocked(secs[dragSrcSi])) { toast('锁定节不可排序'); dragSrcAi = -1; dragSrcSi = -1; return; }
    if (isSectionLocked(secs[tSi])) { toast('锁定节不可排序'); dragSrcAi = -1; dragSrcSi = -1; return; }
    const fromSi = dragSrcSi;
    const toSi = tSi;
    dragSrcAi = -1; dragSrcSi = -1;
    const moved = secs.splice(fromSi, 1)[0];
    secs.splice(toSi, 0, moved);
    log.info(`节排序: 章${tAi + 1} 第${fromSi + 1}节 → 第${toSi + 1}节`);
    save();
    rerender();
  }

  // ── attachToSections: 每次重绘后给手柄绑 pointerdown ──────────────────
  const handleListeners = [];

  function cleanupHandles() {
    handleListeners.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
    handleListeners.length = 0;
  }

  function attachToSections() {
    cleanupHandles();
    const handles = root.querySelectorAll('.ns-drag-handle');
    handles.forEach((handle) => {
      const sec = handle.closest('.ns-section');
      if (!sec) return;
      const ai = Number(sec.dataset.a);
      const si = Number(sec.dataset.s);
      if (isNaN(ai) || isNaN(si)) return;

      const onPointerDown = (e) => {
        // 锁定节不可拖拽
        const secData = getSec(ai);
        if (secData && isSectionLocked(secData[si])) return;
        isDragging = true;
        dragSrcAi = ai;
        dragSrcSi = si;
        pointerId = e.pointerId;
        e.preventDefault(); // 阻止文字选中等默认行为
        document.body.classList.add('ns-dragging-active');
        document.addEventListener('pointermove', onDocPointerMove, { passive: true });
        document.addEventListener('pointerup', onDocPointerUp, { passive: true });
        log.debug(`拖拽开始: 章${ai + 1} 第${si + 1}节`);
      };

      handle.addEventListener('pointerdown', onPointerDown);
      handleListeners.push({ el: handle, type: 'pointerdown', fn: onPointerDown });
    });
    log.debug(`节拖拽绑定: ${handles.length} 个手柄 (${containerSel})`);
  }

  attachToSections();

  const fullCleanup = () => {
    cleanupHandles();
    document.removeEventListener('pointermove', onDocPointerMove);
    document.removeEventListener('pointerup', onDocPointerUp);
  };
  $root.data('drag-cleanup', fullCleanup);
  $root.data('drag-attach', attachToSections);
  return attachToSections;
}

/** 判断错误/状态是否属于可重试的瞬时故障(504/502/503/超时/网络等)。 */
function isRetryableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    /\b(408|429|500|502|503|504)\b/.test(msg) ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('gateway') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('abort') ||
    msg.includes('rate_limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('too many requests') ||
    msg.includes('exhausted your capacity') ||
    msg.includes('quota') ||
    msg.includes('空回复')
  );
}

/** 是否为限流/配额类错误（需更长等待）。 */
function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    /\b429\b/.test(msg) ||
    msg.includes('rate_limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('too many requests') ||
    msg.includes('exhausted your capacity') ||
    msg.includes('quota')
  );
}

/** 上次 generateRaw 结束时间（用于节流）。 */
let lastGenFinishedAt = 0;

/** 两次请求之间的最小间隔，避免打满配额。 */
async function waitGenThrottle(shouldCancel) {
  const s = getSettings();
  const minGap = Math.max(3000, Number(s.genMinIntervalMs) || 5000);
  const wait = lastGenFinishedAt + minGap - Date.now();
  if (wait <= 0) return;
  log.info(`请求节流：等待 ${wait}ms 后再发…`);
  await waitCancellable(wait, shouldCancel);
}

/** 计算重试等待：429 至少约 15s 起；普通/空回用更长指数退避。 */
function calcRetryDelayMs(attempt, err) {
  const s = getSettings();
  const baseMs = Math.max(6000, Number(s.genRetryBaseMs) || 8000);
  const rateMs = Math.max(12000, Number(s.genRateLimitMs) || 15000);
  const jitter = Math.floor(Math.random() * 1500);
  if (isRateLimitError(err)) {
    // 接口提示约 10s 重置；多等一点并随次数加长
    return rateMs * (attempt + 1) + jitter;
  }
  const msg = String(err?.message || '');
  // 空回也放慢，避免短时间连打
  const emptyBoost = msg.includes('空回复') ? 1.5 : 1;
  return Math.round(baseMs * Math.pow(2, attempt) * emptyBoost) + jitter;
}

/** 正文最短有效长度(过短视为空回，需重试)。 */
const MIN_SECTION_CHARS = 30;

/** 判断生成结果是否为"空回复"(需要重试)。 */
function isEmptyReply(text, minLen = 2) {
  const t = String(text ?? '').trim();
  return t.length < minLen;
}

/** 节正文是否有效(非空且达最短字数)。 */
function hasValidSectionContent(sec) {
  return !!sec && String(sec.content || '').trim().length >= MIN_SECTION_CHARS;
}

/** 单次生成(不含重试)。带超时保护；超时只停本 gid，避免 stopAll 引发未处理 abort。 */
async function _genOnce({ system, user }, gid, shouldCancel, opts = {}) {
  const timeoutMs = getSettings().genTimeoutMs || 180000;
  const th = getTavernHelper();
  const wiBefore = String(opts.wiBefore || '').trim();
  const wiAfter = String(opts.wiAfter || '').trim();
  // 世界书按酒馆习惯夹在 system 前后；原生 generateRaw 则并入 systemPrompt
  const systemWithWi = joinPromptBlocks(
    wiBefore ? `【世界书】\n${wiBefore}` : '',
    system,
    wiAfter ? `【世界书·后置】\n${wiAfter}` : '',
  );

  const doGen = () =>
    withClearedKeywordInject(async () => {
      await waitGenThrottle(shouldCancel);
      try {
        if (th && typeof th.generateRaw === 'function') {
          // 必须显式给出 user_input + 'user_input' 占位：
          // 若只放 RolePrompt 且不传 user_input，酒馆助手会在末尾再追加空 user_input，
          // Gemini 等模型常因此返回 content="" / completion_tokens=0。
          const ordered = [];
          if (wiBefore) ordered.push({ role: 'system', content: `【世界书】\n${wiBefore}` });
          ordered.push({ role: 'system', content: system });
          if (wiAfter) ordered.push({ role: 'system', content: `【世界书·后置】\n${wiAfter}` });
          ordered.push('user_input');
          const result = await th.generateRaw({
            user_input: user,
            // 自定义顺序：世界书(扫描结果) + system + user；不带聊天历史/默认占位
            ordered_prompts: ordered,
            max_chat_history: 0,
            should_stream: false,
            should_silence: true,
            generation_id: gid,
          });
          const text = typeof result === 'string' ? result : (result?.content ?? String(result ?? ''));
          if (!String(text).trim()) {
            log.warn('generateRaw 返回空串', {
              gid,
              resultType: typeof result,
              sysLen: String(system || '').length,
              userLen: String(user || '').length,
              wiBefore: wiBefore.length,
              wiAfter: wiAfter.length,
            });
          }
          return text;
        }
        const ctx = getST();
        if (ctx && typeof ctx.generateRaw === 'function') {
          const result = await ctx.generateRaw({ prompt: user, systemPrompt: systemWithWi, prefill: '' });
          return typeof result === 'string' ? result : String(result ?? '');
        }
        throw new Error('无可用生成接口(TavernHelper.generateRaw / 原生 generateRaw 均不可用)');
      } finally {
        lastGenFinishedAt = Date.now();
      }
    });

  let timer;
  const genP = doGen();
  // 竞速失败后仍要吞掉后续 abort，避免 Unhandled rejection
  genP.catch(() => {});
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        if (th?.stopGenerationById) th.stopGenerationById(gid);
      } catch (e) {
        log.debug('超时停止生成忽略:', e?.message || e);
      }
      reject(new Error(`生成超时(${timeoutMs}ms) timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([genP, timeoutP]);
  } finally {
    clearTimeout(timer);
  }
}

/** 是否为网关超时/坏网关（502/504），需额外重试。 */
function isGatewayError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    /\b(502|504)\b/.test(msg) ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    msg.includes('gateway time-out')
  );
}

/**
 * 生成(含重试)。504/502 额外再试 2 次；其它可重试错误按 genMaxRetries。
 * 每次重试使用新的 generation_id，避免酒馆助手缓存同 id 的空结果。
 * @param {()=>boolean} shouldCancel 可选，返回 true 时中止重试。
 * @param {{ minLen?: number, worldBookName?: string, wiScanText?: string, wiBefore?: string, wiAfter?: string }} opts
 */
async function novelGenerateWithId({ system, user }, gid, shouldCancel, opts = {}) {
  const s = getSettings();
  // 普通额外重试（空回/网络等）；502/504 遇到后再抬到 2 次
  let maxRetries = Math.min(2, Math.max(0, s.genMaxRetries ?? 1));
  const gatewayRetries = 2;
  const minLen = opts.minLen ?? 2;
  let lastErr = null;

  // 按酒馆世界书接口扫描一次，供本轮所有重试注入（避免每轮重复扫描）
  let genOpts = { ...opts };
  if (opts.worldBookName && !opts.wiBefore && !opts.wiAfter) {
    try {
      const scan = opts.wiScanText || `${user}\n${String(system || '').slice(0, 2000)}`;
      const wi = await resolveWorkshopWorldInfo(opts.worldBookName, scan);
      genOpts = { ...genOpts, wiBefore: wi.before, wiAfter: wi.after };
      if (wi.before || wi.after) {
        log.info('本轮已注入世界书', {
          book: opts.worldBookName,
          before: wi.before.length,
          after: wi.after.length,
        });
      }
    } catch (e) {
      log.warn('世界书扫描失败，继续无世界书生成:', e?.message || e);
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (shouldCancel?.()) throw new Error('已中止');
    // 每次尝试使用独立 generation_id，防止空回被接口按 id 复用
    const attemptGid = attempt === 0 ? gid : `${gid}_r${attempt}_${Date.now()}`;
    try {
      if (attempt > 0) {
        setGenSectionStatus(`生成中… 第 ${attempt + 1}/${maxRetries + 1} 次尝试…`);
      }
      const text = await _genOnce({ system, user }, attemptGid, shouldCancel, genOpts);
      if (isEmptyReply(text, minLen)) {
        lastErr = new Error('空回复');
        log.warn(`生成得到空回复(len=${String(text ?? '').trim().length}), 第 ${attempt + 1} 次…`);
        if (attempt >= maxRetries) {
          throw new Error(`多次空回复(已重试 ${maxRetries + 1} 次)`);
        }
      } else {
        if (attempt > 0) log.info(`生成在第 ${attempt + 1} 次尝试成功`);
        return text;
      }
    } catch (e) {
      lastErr = e;
      if (isGatewayError(e)) {
        // 502/504：再尝试 2 次（合计最多 3 次）
        maxRetries = Math.max(maxRetries, gatewayRetries);
      }
      const retryable = isRetryableError(e);
      log.warn(`生成失败(第 ${attempt + 1} 次): ${e.message}${retryable ? ' [可重试]' : ' [不可重试]'}`);
      if (!retryable || attempt >= maxRetries) {
        throw e;
      }
    }
    // 指数退避；429 额外拉长；502/504 用普通退避
    if (attempt < maxRetries) {
      const delay = calcRetryDelayMs(attempt, lastErr);
      const codeHint = isGatewayError(lastErr) ? '502/504' : isRateLimitError(lastErr) ? '限流' : '瞬时错误';
      setGenSectionStatus(
        `生成中… 遇${codeHint}，${Math.round(delay / 1000)}s 后重试(${attempt + 2}/${maxRetries + 1})…`,
      );
      log.info(`${delay}ms 后重试(${attempt + 2}/${maxRetries + 1})…`);
      await waitCancellable(delay, shouldCancel);
    }
  }
  throw lastErr || new Error('生成失败');
}

async function novelGenerate({ system, user }, opts = {}) {
  const gid = `novel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  novelState.currentGenId = gid;
  const proj = getActiveProject();
  const worldBookName = opts.worldBookName ?? proj?.worldBookName ?? '';
  return novelGenerateWithId({ system, user }, gid, () => novelState.cancelRequested, {
    ...opts,
    worldBookName,
    wiScanText: opts.wiScanText || `${user}\n${String(system || '').slice(0, 2000)}`,
  });
}

/**
 * 清理生成通道状态。
 * @param {'novel'|'cont'} kind
 * @param {{ hard?: boolean }} opts hard=true 时 stopAll（仅「重新生成」）；空回重试/首写必须 soft，否则会 abort 下一次请求。
 */
function resetGenerationChannel(kind = 'novel', { hard = false } = {}) {
  if (hard) {
    const th = getTavernHelper();
    try {
      if (th?.stopAllGeneration) th.stopAllGeneration();
      else getST()?.stopGeneration?.();
    } catch (e) {
      log.debug('清理生成通道时忽略:', e?.message || e);
    }
  }
  if (kind === 'cont') {
    contState.cancelRequested = false;
    contState.currentGenId = '';
  } else {
    novelState.cancelRequested = false;
    novelState.currentGenId = '';
  }
}

/**
 * 「清除生成内容」后的运行时复位：停残留请求、清进度条/取消旗标，并放开节流。
 * 必须在用户再次点「生成本节」之前完成，避免 stopAll 波及下一次 generateRaw。
 */
async function resetRuntimeAfterClearContent(kind = 'novel') {
  stopGenUiProgress();
  const th = getTavernHelper();
  try {
    if (th?.stopAllGeneration) th.stopAllGeneration();
    else getST()?.stopGeneration?.();
  } catch (e) {
    log.debug('清除后停止残留生成忽略:', e?.message || e);
  }
  if (kind === 'cont') {
    contState.cancelRequested = false;
    contState.currentGenId = '';
    contState.activeFlatIdx = -1;
    contState.activeActIdx = -1;
    contState.generating = false;
  } else {
    novelState.cancelRequested = false;
    novelState.currentGenId = '';
    novelState.activeFlatIdx = -1;
    novelState.activeActIdx = -1;
    novelState.generating = false;
  }
  lastGenFinishedAt = 0;
  // 给酒馆助手一点时间消化 stopAll，避免紧接着的请求被当成 abort/空回
  await sleep(450);
}

function stopNovelGeneration() {
  novelState.cancelRequested = true;
  const th = getTavernHelper();
  try {
    if (th?.stopGenerationById && novelState.currentGenId) th.stopGenerationById(novelState.currentGenId);
    else if (th?.stopAllGeneration) th.stopAllGeneration();
    else getST()?.stopGeneration?.();
  } catch (e) {
    log.warn('中止生成失败:', e);
  }
  log.info('已请求中止生成');
}

/* ---------------------------- prompt 构建 ---------------------------- */

/** 拼接非空提示词块。 */
function joinPromptBlocks(...parts) {
  return parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 截断文本（保留末尾更利于承接）。 */
function clipTextTail(text, maxChars) {
  const t = String(text || '').trim();
  if (!maxChars || t.length <= maxChars) return t;
  return `…${t.slice(-maxChars)}`;
}

/** 截断文本（保留开头）。 */
function clipTextHead(text, maxChars) {
  const t = String(text || '').trim();
  if (!maxChars || t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…`;
}

/**
 * 取某节之前若干节正文作为前文(省 token)：
 * - 有动态总结时只取最近 1 节末尾；
 * - 否则最多 2 节，每节限长。
 */
function recentSectionContext(obj, flatIdx, count = 2) {
  const flat = flatSections(obj);
  const hasLive = !!obj?.liveProgress;
  const n = hasLive ? 1 : Math.max(1, count);
  const per = hasLive ? 900 : 1400;
  const parts = [];
  const start = Math.max(0, flatIdx - n);
  for (let i = start; i < flatIdx; i++) {
    const f = flat[i];
    if (!f?.sec?.content) continue;
    const body = clipTextTail(f.sec.content, per);
    parts.push(`【第${f.actIdx + 1}章第${f.secIdx + 1}节前文】\n${body}`);
  }
  return parts.join('\n\n');
}

/** 最新一条总结(紧凑)作为长期记忆参考。 */
function latestSummaryText(obj) {
  if (!obj.summaries || obj.summaries.length === 0) return '';
  const s = obj.summaries[obj.summaries.length - 1];
  return `【前章总结(第${s.actNo}章)】\n${summaryToCompact(s)}`;
}

/** 取最新已生成节正文末尾若干字(反映当前最新进度，无动态总结时兜底)。 */
function latestSectionExcerpt(obj, chars = 800) {
  const flat = flatSections(obj);
  for (let i = flat.length - 1; i >= 0; i--) {
    const f = flat[i];
    if (f.sec.done && f.sec.content) {
      const t = f.sec.content;
      return `【当前最新进度: 第${f.actIdx + 1}章 第${f.secIdx + 1}节(节选)】\n${t.slice(Math.max(0, t.length - chars))}`;
    }
  }
  return '';
}

/** 人物链格式化为「A → B → C」。 */
function formatCharChain(chain) {
  const steps = Array.isArray(chain) ? chain.map((x) => String(x || '').trim()).filter(Boolean) : [];
  return steps.join(' → ');
}

/** 规范化人名用于合并。 */
function normCharName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 规范化状态文本，便于相似度比较。 */
function normalizeChainStep(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[，。、；：！？,.!?;:\s　""''「」『』（）()【】\[\]…—\-·《》]/g, '')
    .replace(/(?:的|了|着|过|地|得|与|和|及|被|在|后|时|中|而|并|又|也|很|非常|极度|感到|深感)/g, '');
}

/** 字符 bigram 集合。 */
function charBigrams(s) {
  const t = normalizeChainStep(s);
  if (!t) return new Set();
  if (t.length === 1) return new Set([t]);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 两段状态描述的相似度 0~1（Jaccard + 包含关系）。 */
function chainStepSimilarity(a, b) {
  const na = normalizeChainStep(a);
  const nb = normalizeChainStep(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  // 较短段被较长段包含，且有足够信息量 → 视为同义复述
  if (shorter.length >= 6 && longer.includes(shorter)) {
    return 0.92;
  }
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 0;
  // 关键关键词重叠：取较长串的覆盖率
  const cover = Math.max(inter / A.size, inter / B.size);
  return Math.max(jaccard, cover * 0.85);
}

/** 是否为同义/近义复述（不应再追加为新节点）。 */
function isSimilarChainStep(a, b, threshold = 0.4) {
  return chainStepSimilarity(a, b) >= threshold;
}

/**
 * 压缩人物链：去掉同义反复；
 * - 与已有任一节点相似 → 不新增；
 * - 与末节点相似 → 用信息量更大或更新的表述替换末节点。
 */
function dedupeChainSteps(chain) {
  const out = [];
  for (const raw of chain || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    let simIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < out.length; i++) {
      const sim = chainStepSimilarity(out[i], s);
      if (sim > bestSim) {
        bestSim = sim;
        simIdx = i;
      }
    }
    if (bestSim >= 0.4 && simIdx >= 0) {
      // 与末节点近义：可微调措辞；与更早节点近义：直接丢弃（防止循环复述）
      if (simIdx === out.length - 1) {
        if (s.length > out[simIdx].length) out[simIdx] = s;
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

/** 仅当新状态与链中已有节点均不近义时才追加。 */
function appendChainStep(chain, step) {
  const s = String(step || '').trim();
  if (!s || !Array.isArray(chain)) return false;
  for (let i = 0; i < chain.length; i++) {
    if (isSimilarChainStep(chain[i], s)) {
      if (i === chain.length - 1 && s.length > chain[i].length) chain[i] = s;
      return false;
    }
  }
  chain.push(s);
  return true;
}

/**
 * 合并人物链：拼接后做近义去重，避免「同处境不同措辞」反复出现。
 * prev / next: [{name, chain:string[]}]
 */
function mergeCharChains(prev, next) {
  const map = new Map();
  const ingest = (list) => {
    for (const c of list || []) {
      const name = String(c?.name || '').trim();
      const key = normCharName(name);
      if (!key && !(c?.chain || []).length) continue;
      const mapKey = key || `anon_${map.size}`;
      if (!map.has(mapKey)) map.set(mapKey, { name: name || mapKey, chain: [] });
      const entry = map.get(mapKey);
      if (name) entry.name = name;
      for (const step of c?.chain || []) appendChainStep(entry.chain, step);
    }
  };
  ingest(prev);
  ingest(next);
  return [...map.values()]
    .map((c) => ({ name: c.name, chain: dedupeChainSteps(c.chain) }))
    .filter((c) => c.name || c.chain.length);
}

/**
 * 确认总结用：只在既有人物链末尾追加新节点，绝不改写/删除历史节点。
 * delta 中与历史近义的节点直接丢弃；若带 latest 则更新「最新状态/衣着」。
 */
function appendOnlyCharChains(prevChains, deltaChains) {
  const result = (prevChains || []).map((c) => ({
    name: String(c?.name || '').trim(),
    chain: Array.isArray(c?.chain) ? c.chain.map((x) => String(x || '').trim()).filter(Boolean) : [],
    latest: String(c?.latest || '').trim(),
  }));
  for (const d of deltaChains || []) {
    const name = String(d?.name || '').trim();
    const steps = Array.isArray(d?.chain)
      ? d.chain.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const latest = String(d?.latest || d?.detail || '').trim();
    if (!name && !steps.length && !latest) continue;
    let hit = result.find((x) => normCharName(x.name) === normCharName(name));
    if (!hit) {
      result.push({
        name: name || '?',
        chain: [...steps],
        latest: latest || steps[steps.length - 1] || '',
      });
      continue;
    }
    if (name) hit.name = name;
    for (const s of steps) {
      if (hit.chain.some((exist) => isSimilarChainStep(exist, s))) continue;
      hit.chain.push(s);
    }
    if (latest) hit.latest = latest;
    else if (!hit.latest && hit.chain.length) hit.latest = hit.chain[hit.chain.length - 1];
  }
  return result.filter((c) => c.name || c.chain.length);
}

/** 从最近一次章总结中取某人的状态描述。 */
function latestSummaryCharDetail(obj, name) {
  const key = normCharName(name);
  if (!key) return '';
  const sums = Array.isArray(obj?.summaries) ? [...obj.summaries] : [];
  sums.sort((a, b) => (a.actNo || 0) - (b.actNo || 0));
  for (let i = sums.length - 1; i >= 0; i--) {
    const chars = Array.isArray(sums[i]?.characters) ? sums[i].characters : [];
    const hit = chars.find((c) => normCharName(c?.name) === key);
    const d = String(hit?.detail || '').trim();
    if (d) return d;
  }
  return '';
}

/** 展示用：人物最新装备衣着/状态/特征。 */
function resolveCharLatest(c, obj) {
  const fromField = String(c?.latest || '').trim();
  if (fromField) return fromField;
  const fromSum = latestSummaryCharDetail(obj, c?.name);
  if (fromSum) return fromSum;
  const steps = Array.isArray(c?.chain) ? c.chain.map((x) => String(x || '').trim()).filter(Boolean) : [];
  return steps.length ? steps[steps.length - 1] : '';
}

/**
 * 确认总结用：只追加/更新「本节」剧情链节点，绝不改写其它节的历史节点。
 * 同 secNo 再次确认时仅替换本节节点。
 */
function appendOnlyPlotChainNode(obj, node) {
  if (!obj || !node?.step) return;
  if (!Array.isArray(obj.plotChain)) obj.plotChain = [];
  const list = normalizePlotChain(obj.plotChain);
  const secNo = Number(node.secNo) || 0;
  const actNo = Number(node.actNo) || 0;
  const secInAct = Number(node.secInAct) || 0;
  let step = String(node.step || '').trim();
  if (actNo && secInAct && !/第\d+章第\d+节/.test(step)) {
    step = `第${actNo}章第${secInAct}节：${step}`;
  }
  if (step.length > 100) step = `${step.slice(0, 98)}…`;
  const next = {
    secNo,
    actNo,
    secInAct,
    actTitle: String(node.actTitle || '').trim(),
    step,
  };
  const idx = list.findIndex((p) => (secNo && p.secNo === secNo) || (actNo && secInAct && p.actNo === actNo && p.secInAct === secInAct));
  if (idx >= 0) list[idx] = { ...list[idx], ...next, step };
  else list.push(next);
  obj.plotChain = list.sort(
    (a, b) => (a.secNo || 0) - (b.secNo || 0) || (a.actNo || 0) - (b.actNo || 0) || (a.secInAct || 0) - (b.secInAct || 0),
  );
}

/** 仅从各章总结按时间拼人物链（确定性，不依赖 AI）。 */
function charChainsFromSummaries(obj) {
  const map = new Map();
  for (const s of obj?.summaries || []) {
    for (const c of s.characters || []) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      const key = normCharName(name);
      if (!map.has(key)) map.set(key, { name, chain: [] });
      appendChainStep(map.get(key).chain, c.detail);
    }
  }
  return [...map.values()].map((c) => ({ name: c.name, chain: dedupeChainSteps(c.chain) }));
}

/** 清除旧版精简残留字段。 */
function stripLegacyCompactFields(obj) {
  if (!obj) return false;
  let changed = false;
  if (obj.liveProgress?.compactMeta) {
    delete obj.liveProgress.compactMeta;
    changed = true;
  }
  if (obj.liveProgress?.compactCharChains) {
    delete obj.liveProgress.compactCharChains;
    changed = true;
  }
  return changed;
}

/** 展示/注入用人物链：仅 liveProgress.charChains。 */
function collectCharChains(obj) {
  stripLegacyCompactFields(obj);
  if (Array.isArray(obj?.liveProgress?.charChains)) {
    obj.liveProgress.charChains = obj.liveProgress.charChains.map((c) => ({
      name: c.name,
      chain: dedupeChainSteps(c.chain || []),
      latest: String(c.latest || '').trim(),
    }));
  }
  return (obj?.liveProgress?.charChains || []).map((c) => ({
    name: c.name,
    chain: [...(c.chain || [])],
    latest: String(c.latest || '').trim(),
  }));
}

/** 人物链纯文本(注入 prompt，紧凑)。 */
function charChainsToText(chains, obj) {
  const list = Array.isArray(chains) ? chains : [];
  if (!list.length) return '';
  const lines = ['【人物链】'];
  for (const c of list) {
    const traj = formatCharChain(c.chain);
    const latest = resolveCharLatest(c, obj);
    if (!c.name && !traj && !latest) continue;
    lines.push(`- ${c.name || '?'}: ${traj || '(无)'}${latest ? `｜最新：${latest}` : ''}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** 人物链 HTML（人物 / 变化轨迹 / 最新装备衣着状态特征）。 */
function charChainsToHtml(chains, obj) {
  const list = Array.isArray(chains) ? chains : [];
  const rows = list.length
    ? list
        .map((c) => {
          const steps = Array.isArray(c.chain) ? c.chain.map((x) => String(x || '').trim()).filter(Boolean) : [];
          const traj = steps.length
            ? steps
                .map((s, i) => `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-chain-step">${esc(s)}</span>`)
                .join('')
            : '<span class="ns-muted">（无）</span>';
          const latest = resolveCharLatest(c, obj);
          return `<tr><td>${esc(c.name || '')}</td><td class="ns-char-chain">${traj}</td><td class="ns-char-latest">${latest ? esc(latest) : '<span class="ns-muted">（无）</span>'}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="3" class="ns-muted">（暂无人物链。生成节或点「重新动态总结」后出现）</td></tr>`;
  return `
    <div class="ns-char-chains-block">
      <div class="ns-live-progress__title"><strong>人物链</strong><span class="ns-muted">（变化轨迹 + 最近一次总结的装备/衣着/状态/特征）</span></div>
      <table class="ns-table"><thead><tr><th>人物</th><th>变化轨迹</th><th>最新人物装备衣着/状态/特征</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

/** 全部章节总结中的人物表(按章序，供人物链重建)。 */
function allSummariesCharHistoryText(obj) {
  const sums = Array.isArray(obj?.summaries) ? obj.summaries : [];
  if (!sums.length) return '';
  return sums
    .map((s) => {
      const chars = Array.isArray(s.characters) ? s.characters : [];
      const lines = chars.length
        ? chars.map((c) => `- ${c.name || ''}：${(c.detail || '').replace(/\n/g, ' ')}`).join('\n')
        : '- (无)';
      return `● 第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}${s.partial ? '(未完成)' : ''}人物\n${lines}`;
    })
    .join('\n\n');
}

/**
 * 收集截至 (actIdx,secIdx) 的全部已生成节正文素材(按时间序)。
 * 仅收录有效正文，不含大纲/总览；超长时保头保尾、压缩中间。
 */
function collectSectionsCorpus(obj, actIdx, secIdx, { maxPerSec = 1800, maxTotal = 28000 } = {}) {
  const flat = flatSections(obj);
  const items = [];
  for (const f of flat) {
    if (f.actIdx > actIdx || (f.actIdx === actIdx && f.secIdx > secIdx)) break;
    if (!hasValidSectionContent(f.sec)) continue;
    let body = String(f.sec.content).trim();
    if (body.length > maxPerSec) {
      const head = Math.floor(maxPerSec * 0.45);
      const tail = maxPerSec - head - 20;
      body = `${body.slice(0, head)}\n…(中略)…\n${body.slice(-tail)}`;
    }
    items.push({
      label: `第${f.actIdx + 1}章 第${f.secIdx + 1}节`,
      body,
      block: `【第${f.actIdx + 1}章 第${f.secIdx + 1}节】\n${body}`,
    });
  }
  if (!items.length) return '';
  const full = items.map((x) => x.block).join('\n\n');
  if (full.length <= maxTotal) return full;

  // 超预算：开头若干节 + 结尾若干节保留较完整，中间节短摘
  const keepHead = Math.min(4, items.length);
  const keepTail = Math.min(5, Math.max(0, items.length - keepHead));
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const isHead = i < keepHead;
    const isTail = i >= items.length - keepTail;
    if (isHead || isTail) {
      parts.push(items[i].block);
    } else {
      const b = items[i].body;
      parts.push(`【${items[i].label}】(中间节摘录)\n${b.slice(0, 320)}${b.length > 320 ? '…' : ''}`);
    }
  }
  let out = parts.join('\n\n');
  if (out.length > maxTotal) {
    out = [...items.slice(0, keepHead), ...items.slice(items.length - keepTail)].map((x) => x.block).join('\n\n');
  }
  return out;
}

/** 取某一节的正文（无效则空串）。 */
function sectionBodyText(obj, actIdx, secIdx) {
  const sec = obj?.acts?.[actIdx]?.sections?.[secIdx];
  return hasValidSectionContent(sec) ? String(sec.content).trim() : '';
}

/** 取展平序上某一节的前一节正文（短摘，仅作连贯参考）。 */
function previousSectionBodyText(obj, actIdx, secIdx, maxChars = 800) {
  const flat = flatSections(obj);
  const cur = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  if (cur <= 0) return '';
  for (let i = cur - 1; i >= 0; i--) {
    const body = sectionBodyText(obj, flat[i].actIdx, flat[i].secIdx);
    if (body) return clipTextTail(body, maxChars);
  }
  return '';
}

/**
 * 大总结(注入 prompt / 长期记忆)：章节总结 + 剧情链 + 人物链。
 * UI 展示请用 buildGrandSummaryHtml（链为主；章总结另有表格区）。
 */
function buildGrandSummary(obj) {
  stripLegacyCompactFields(obj);
  const parts = [];
  const sums = Array.isArray(obj?.summaries) ? [...obj.summaries] : [];
  sums.sort((a, b) => (a.actNo || 0) - (b.actNo || 0));
  if (sums.length) {
    const body = sums
      .map((s) => `●第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}${s.partial ? '(未完成)' : ''}\n${summaryToCompact(s)}`)
      .join('\n\n');
    parts.push(`【章节总结】\n${body}`);
  }
  const plotChain = normalizePlotChain(obj?.plotChain);
  if (plotChain.length) parts.push(plotChainToText(plotChain));
  const chainText = charChainsToText(collectCharChains(obj), obj);
  if (chainText) parts.push(chainText);
  return parts.join('\n\n');
}

/** 大总结 HTML：仅剧情链 + 人物链（无节/剧情节点表）。 */
function buildGrandSummaryHtml(obj) {
  stripLegacyCompactFields(obj);
  const parts = [];
  const plotChain = normalizePlotChain(obj?.plotChain);
  if (plotChain.length) {
    parts.push(plotChainToHtml(plotChain));
  } else {
    parts.push('<div class="ns-muted" style="margin:4px 0 8px;">（暂无剧情链。生成节或点「重新动态总结」后出现）</div>');
  }
  parts.push(charChainsToHtml(collectCharChains(obj), obj));
  return parts.length ? parts.join('') : '（暂无内容，生成节后自动汇总）';
}

/** 规整动态进度对象。 */
function normalizeLiveProgress(obj) {
  const { characters, plot } = normalizeSummaryObj(obj);
  let charChains = [];
  if (Array.isArray(obj?.charChains)) {
    charChains = obj.charChains
      .map((c) => {
        if (typeof c === 'string') return { name: c, chain: [] };
        const chain = Array.isArray(c?.chain)
          ? c.chain.map((x) => String(x || '').trim()).filter(Boolean)
          : typeof c?.chain === 'string'
            ? String(c.chain)
                .split(/\s*→\s*|\s*->\s*|\s*=>\s*/)
                .map((x) => x.trim())
                .filter(Boolean)
            : [];
        return { name: c?.name || '', chain };
      })
      .filter((c) => c.name || c.chain.length);
  }
  // 若未给人物链，用人物档案当前状态作为链的起点
  if (!charChains.length && characters.length) {
    charChains = characters.map((c) => ({ name: c.name, chain: c.detail ? [c.detail] : [] }));
  }
  charChains = charChains.map((c) => ({ name: c.name, chain: dedupeChainSteps(c.chain) }));
  return { characters, plot, charChains };
}

/** 解析动态进度 JSON。 */
function parseLiveProgress(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonStr = extractBalancedJson(t) || t;
  try {
    const r = normalizeLiveProgress(JSON.parse(jsonStr));
    if (r.characters.length || r.charChains.length || r.plot.length) return r;
  } catch (e) {
    /* fallthrough */
  }
  // 降级: 复用章节总结解析，再补人物链
  const base = parseSummary(text);
  return normalizeLiveProgress({ ...base, charChains: (base.characters || []).map((c) => ({ name: c.name, chain: c.detail ? [c.detail] : [] })) });
}

/** 解析动态总结 JSON（剧情链节点 + 人物链增量）。 */
function parseDynamicChainsPayload(raw) {
  let t = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const jsonStr = extractBalancedJson(t) || t;
  try {
    const j = JSON.parse(jsonStr);
    const plotChain = normalizePlotChain(j.plotChain || (j.plotStep ? [{ step: j.plotStep, secNo: j.secNo, actNo: j.actNo, secInAct: j.secInAct }] : []));
    let charChains = [];
    // 增量节点原样取出，不做近义改写（追加阶段再与历史比对）
    if (Array.isArray(j.charChains)) {
      charChains = j.charChains
        .map((c) => ({
          name: String(c?.name || '').trim(),
          chain: Array.isArray(c?.chain)
            ? c.chain.map((x) => String(x || '').trim()).filter(Boolean)
            : typeof c?.chain === 'string'
              ? [String(c.chain).trim()].filter(Boolean)
              : [],
          latest: String(c?.latest || c?.detail || c?.status || '').trim(),
        }))
        .filter((c) => c.name || c.chain.length || c.latest);
    }
    return { plotChain, charChains, characters: Array.isArray(j.characters) ? j.characters : [] };
  } catch (e) {
    const fallback = parseLiveProgress(raw);
    return { plotChain: [], charChains: fallback.charChains, characters: fallback.characters };
  }
}

/**
 * 单节增量：据本节正文追加剧情链节点 + 人物链新节点（禁止改写历史链）。
 */
function buildLiveProgressPrompt(obj, actIdx, secIdx) {
  const secBody = sectionBodyText(obj, actIdx, secIdx) || String(obj?.acts?.[actIdx]?.sections?.[secIdx]?.content || '').trim();
  const flat = flatSections(obj);
  const flatIdx = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  const secNo = flatIdx >= 0 ? flatIdx + 1 : 0;
  const prevChains = collectCharChains(obj);
  const prevPlot = normalizePlotChain(obj.plotChain);
  const incremental = prevChains.length > 0 || prevPlot.length > 0;
  const prevBody = incremental ? previousSectionBodyText(obj, actIdx, secIdx, 600) : '';

  const system = [
    '你是小说动态总结助手。只输出「本节」要追加的剧情链节点与人物链新节点。',
    '必须只输出一个合法 JSON 对象，不要输出任何多余文字或代码块标记。格式:',
    '{"plotChain":[{"secNo":1,"actNo":1,"secInAct":1,"step":"本节核心剧情一句话"}],"charChains":[{"name":"角色名","chain":["本节新增状态节点"],"latest":"装备/衣着/外貌特征/当前状态一句"}]}',
    '规则:',
    '1. 只能依据【本节正文】；严禁章总览、节大纲、未写出情节。',
    `2. plotChain: 恰好 1 个节点，只对应本节（secNo=${secNo || '全书序号'}, actNo=${actIdx + 1}, secInAct=${secIdx + 1}）；step 16~40 字。禁止输出或改写其它节。`,
    incremental
      ? '3. charChains: 只输出本节有进展角色的新增 chain 节点（通常每位 1 个，12~36 字）。历史节点已在【既有人物链】，禁止整链重抄、禁止改写/删除历史 chain；无进展角色不要写入。'
      : '3. charChains: 为本节出场主要人物建立起始 chain 节点（12~36 字）。',
    '4. latest: 该角色在本节结束时的最新「装备/衣着/外貌特征/身体与处境状态」，一句 16~48 字；本节出场或状态有变的角色必须给出。',
    '5. 不要编造未出现人物；不要输出 characters / plot 表字段。',
  ].join('\n');

  const user = [
    incremental ? `【既有剧情链(只读·禁止改写)】\n${plotChainToText(prevPlot) || '(空)'}` : '',
    incremental ? `【既有人物链(只读·本节只追加新节点)】\n${charChainsToText(prevChains) || '(空)'}` : '',
    prevBody ? `【上一节正文末尾(仅连贯参考)】\n${prevBody}` : '',
    `【本节正文: 全书第${secNo || '?'}节 · 第${actIdx + 1}章第${secIdx + 1}节 · 唯一归纳依据】\n${secBody || '(空)'}`,
    '请输出 JSON：本节 1 个剧情节点；人物链增量（含 latest 最新装备衣着/状态/特征）。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user, prevChains, incremental, secNo, secBody };
}

/**
 * 每节确认总结后：仅在剧情链/人物链上追加本节节点，不修改前文链。
 */
async function updateLiveProgress(obj, actIdx, secIdx, onProgress, { saveFn, isCancelled } = {}) {
  if (!obj || !hasValidSectionContent(obj.acts?.[actIdx]?.sections?.[secIdx])) return;
  if (isCancelled?.()) return;
  try {
    onProgress?.(`正在追加剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`, true);
    stripLegacyCompactFields(obj);
    const { system, user, prevChains, secNo, secBody } = buildLiveProgressPrompt(obj, actIdx, secIdx);
    const gid = `live_${Date.now()}_${actIdx}_${secIdx}`;
    const raw = (
      await novelGenerateWithId({ system, user }, gid, isCancelled, {
        worldBookName: obj.worldBookName || '',
        wiScanText: `${user}\n${String(system || '').slice(0, 1500)}`,
      })
    ).trim();
    if (isCancelled?.()) return;
    const parsed = parseDynamicChainsPayload(raw);

    // 人物链：只追加新节点，不动历史；更新 latest
    const deltas = [...(parsed.charChains || [])];
    for (const c of parsed.characters || []) {
      const d = String(c.detail || '').trim();
      if (c.name && d) deltas.push({ name: c.name, chain: [d], latest: d });
    }
    const mergedChains = appendOnlyCharChains(prevChains, deltas);

    // 剧情链：只写入本节节点
    const aiNode = (parsed.plotChain || []).find((p) => Number(p.secNo) === secNo) || parsed.plotChain[0] || null;
    let step = String(aiNode?.step || '').trim();
    if (!step) {
      const body = String(secBody || '').replace(/\s+/g, ' ').trim();
      step = body ? body.slice(0, 40) + (body.length > 40 ? '…' : '') : `第${actIdx + 1}章第${secIdx + 1}节推进`;
    }
    appendOnlyPlotChainNode(obj, {
      secNo: secNo || 0,
      actNo: actIdx + 1,
      secInAct: secIdx + 1,
      actTitle: String(obj.acts?.[actIdx]?.title || '').trim(),
      step,
    });

    obj.liveProgress = {
      actNo: actIdx + 1,
      secNo: secIdx + 1,
      charChains: mergedChains,
      updatedAt: Date.now(),
    };
    saveFn?.();
    log.info(`已追加动态大总结`, {
      loc: `${actIdx + 1}-${secIdx + 1}`,
      plotNodes: (obj.plotChain || []).length,
      chains: mergedChains.length,
      appendOnly: true,
    });
    onProgress?.(`已追加剧情链与人物链(第${actIdx + 1}章 第${secIdx + 1}节)`, true);
  } catch (e) {
    log.warn('更新动态大总结失败:', e);
    onProgress?.(`动态总结更新失败: ${e.message}`, true);
  }
}

/** 清除全部「待确认动态总结」标记。 */
function clearPendingLiveSummary(obj) {
  for (const act of obj?.acts || []) {
    for (const sec of act.sections || []) {
      if (sec) delete sec.pendingLiveSummary;
    }
  }
}

/** 标记某一节等待用户确认后再做动态大总结（同时清除其它节的待确认）。 */
function markPendingLiveSummary(obj, actIdx, secIdx) {
  clearPendingLiveSummary(obj);
  const sec = obj?.acts?.[actIdx]?.sections?.[secIdx];
  if (sec) sec.pendingLiveSummary = true;
}

/** 展平序列中，当前节之后第一个未写完且未锁定的节。 */
function findNextWritableSection(obj, actIdx, secIdx) {
  const flat = flatSections(obj);
  const cur = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  if (cur < 0) return null;
  return (
    flat.slice(cur + 1).find((f) => !isSectionLocked(f.sec) && !hasValidSectionContent(f.sec)) || null
  );
}

/**
 * 「生成本节」唯一目标：展平序上第一个未锁定且无有效正文的节。
 * 存在「待确认总结」时返回 null（避免跳节）。
 */
function resolveGenThisTarget(obj) {
  const flat = flatSections(obj);
  if (flat.some((f) => f.sec?.pendingLiveSummary && hasValidSectionContent(f.sec))) return null;
  return flat.find((f) => !isSectionLocked(f.sec) && !hasValidSectionContent(f.sec)) || null;
}

/** 动态总结分割段长（节数）。 */
function getDynamicSegmentSecs() {
  const n = Number(getSettings()?.dynamicSegmentSecs);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(12, Math.floor(n));
}

/** 收集展平序 [fromFlat, toFlat] 闭区间内已写正文。 */
function collectFlatSectionsCorpus(obj, fromFlat, toFlat, { maxPerSec = 1600, maxTotal = 24000 } = {}) {
  const flat = flatSections(obj);
  const items = [];
  const end = Math.min(toFlat, flat.length - 1);
  for (let i = Math.max(0, fromFlat); i <= end; i++) {
    const f = flat[i];
    if (!hasValidSectionContent(f.sec)) continue;
    let body = String(f.sec.content).trim();
    if (body.length > maxPerSec) {
      const head = Math.floor(maxPerSec * 0.45);
      const tail = maxPerSec - head - 20;
      body = `${body.slice(0, head)}\n…(中略)…\n${body.slice(-tail)}`;
    }
    items.push(`【全书第${i + 1}节 · 第${f.actIdx + 1}章第${f.secIdx + 1}节】\n${body}`);
  }
  if (!items.length) return '';
  let full = items.join('\n\n');
  if (full.length > maxTotal) {
    full = `${full.slice(0, Math.floor(maxTotal * 0.55))}\n…(中间节略)…\n${full.slice(-(maxTotal - Math.floor(maxTotal * 0.55) - 20))}`;
  }
  return full;
}

/** 保证剧情链覆盖全部已写节（缺节用正文兜底补齐）。 */
function ensureDynamicChainsComplete(obj) {
  if (!obj) return;
  stripLegacyCompactFields(obj);
  const doneCount = flatSections(obj).filter((f) => hasValidSectionContent(f.sec)).length;
  if (!doneCount) {
    obj.plotChain = [];
    return;
  }
  obj.plotChain = mergePlotChain(obj.plotChain, obj, doneCount);
  if (!obj.liveProgress) {
    const last = findLastDoneSection(obj);
    obj.liveProgress = {
      actNo: (last?.actIdx ?? 0) + 1,
      secNo: (last?.secIdx ?? 0) + 1,
      charChains: [],
      updatedAt: Date.now(),
    };
  }
  if (!Array.isArray(obj.liveProgress.charChains)) obj.liveProgress.charChains = [];
}

/**
 * 分割段提示词：一批节 → 本段剧情链（每节 1 节点）+ 本段人物链增量。
 */
function buildDynamicSegmentPrompt(obj, fromFlat, toFlat, prevChains) {
  const fromNo = fromFlat + 1;
  const toNo = toFlat + 1;
  const corpus = collectFlatSectionsCorpus(obj, fromFlat, toFlat);
  const system = [
    '你是小说动态总结助手。对给定正文分段归纳，只输出剧情链与人物链，不要输出人物表或剧情表。',
    '必须只输出一个合法 JSON 对象。格式:',
    '{"plotChain":[{"secNo":1,"actNo":1,"secInAct":1,"step":"该节核心剧情一句话"}],"charChains":[{"name":"角色名","chain":["本段内新增状态节点"],"latest":"装备/衣着/外貌特征/当前状态一句"}]}',
    '规则:',
    `1. plotChain: 必须覆盖全书第${fromNo}~${toNo}节，每节恰好 1 个节点；step 16~40 字；填写 secNo/actNo/secInAct。`,
    '2. charChains: 只输出本段正文中的人物演变新增节点（可按节推进；历史链已在既有人物链中，禁止整链重抄）。',
    '3. latest: 本段结束时该角色的最新「装备/衣着/外貌特征/状态」，一句 16~48 字。',
    '4. 只能依据正文；严禁章总览/节大纲；不要编造未出现人物。',
  ].join('\n');
  const user = [
    prevChains.length ? `【既有人物链(保留；本段只追加新节点)】\n${charChainsToText(prevChains)}` : '',
    `【本段正文：全书第${fromNo}~${toNo}节】\n${corpus || '(空)'}`,
    `请输出 JSON：plotChain 覆盖第${fromNo}~${toNo}节；charChains 含本段新增节点与 latest。`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

/**
 * 重新动态总结：清空并按「分割段」重建剧情链 + 人物链（不碰章总结）。
 * 长文按 dynamicSegmentSecs 分段请求，加快速度并保证链条完整。
 */
async function rebuildDynamicSummary(obj, onProgress, { saveFn, isCancelled } = {}) {
  const last = findLastDoneSection(obj);
  if (!last) {
    obj.plotChain = [];
    obj.liveProgress = null;
    saveFn?.();
    return;
  }
  stripLegacyCompactFields(obj);
  obj.plotChain = [];
  obj.liveProgress = {
    actNo: 1,
    secNo: 1,
    charChains: [],
    updatedAt: Date.now(),
  };
  saveFn?.();

  const doneSecs = flatSections(obj).filter((f) => hasValidSectionContent(f.sec));
  if (!doneSecs.length) return;

  const segSize = getDynamicSegmentSecs();
  const total = doneSecs.length;
  const segments = Math.ceil(total / segSize);
  let accChains = [];

  for (let s = 0; s < segments; s++) {
    if (isCancelled?.()) throw new Error('已中止');
    const from = s * segSize;
    const to = Math.min(total - 1, from + segSize - 1);
    const fromFlat = doneSecs[from].flatIdx;
    const toFlat = doneSecs[to].flatIdx;
    onProgress?.(
      `动态总结分段 ${s + 1}/${segments}：全书第${fromFlat + 1}~${toFlat + 1}节…`,
      true,
    );
    const { system, user } = buildDynamicSegmentPrompt(obj, fromFlat, toFlat, accChains);
    const gid = `dyn_seg_${Date.now()}_${fromFlat}_${toFlat}`;
    const raw = (
      await novelGenerateWithId({ system, user }, gid, isCancelled, {
        worldBookName: obj.worldBookName || '',
        wiScanText: `${user}\n${String(system || '').slice(0, 1500)}`,
      })
    ).trim();
    if (isCancelled?.()) throw new Error('已中止');
    const parsed = parseDynamicChainsPayload(raw);
    const through = toFlat + 1;
    obj.plotChain = mergePlotChain([...(obj.plotChain || []), ...(parsed.plotChain || [])], obj, through);
    accChains = appendOnlyCharChains(accChains, parsed.charChains);
    obj.liveProgress = {
      actNo: doneSecs[to].actIdx + 1,
      secNo: doneSecs[to].secIdx + 1,
      charChains: accChains,
      updatedAt: Date.now(),
    };
    saveFn?.();
  }

  ensureDynamicChainsComplete(obj);
  saveFn?.();
  onProgress?.(
    `动态总结完成：剧情链 ${normalizePlotChain(obj.plotChain).length} 节 · 人物链 ${accChains.length} 人（共 ${total} 节，分 ${segments} 段）。`,
    true,
  );
}

/** @deprecated 兼容旧名 → rebuildDynamicSummary */
async function rebuildLiveProgressFull(obj, onProgress, opts = {}) {
  return rebuildDynamicSummary(obj, onProgress, opts);
}

/** 规整剧情链节点（节单位：secNo=全书展平序号）。 */
function normalizePlotChain(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => {
      if (typeof p === 'string') {
        const step = p.trim();
        return step ? { secNo: 0, actNo: 0, secInAct: 0, actTitle: '', step } : null;
      }
      const secNo = Number(p?.secNo) || 0;
      const actNo = Number(p?.actNo) || 0;
      const secInAct = Number(p?.secInAct || p?.secIdx) || 0;
      const actTitle = String(p?.actTitle || '').trim();
      let step = String(p?.step || p?.detail || p?.plot || '').trim();
      if (!step && Array.isArray(p?.plot)) step = p.plot.map((x) => String(x || '').trim()).filter(Boolean).join('；');
      if (!step) return null;
      return { secNo, actNo, secInAct, actTitle, step };
    })
    .filter(Boolean)
    .sort((a, b) => (a.secNo || 0) - (b.secNo || 0) || (a.actNo || 0) - (b.actNo || 0) || (a.secInAct || 0) - (b.secInAct || 0));
}

/** 从已写节列表生成剧情链兜底（每节一个节点）。 */
function buildPlotChainFromSections(obj, throughSecCount) {
  const flat = flatSections(obj);
  const out = [];
  for (let i = 0; i < throughSecCount && i < flat.length; i++) {
    const f = flat[i];
    if (!hasValidSectionContent(f.sec)) break;
    const body = String(f.sec.content || '').replace(/\s+/g, ' ').trim();
    let step = body.slice(0, 48);
    if (body.length > 48) step += '…';
    if (!step) step = '(本节要点略)';
    out.push({
      secNo: i + 1,
      actNo: f.actIdx + 1,
      secInAct: f.secIdx + 1,
      actTitle: String(f.act?.title || '').trim(),
      step: `第${f.actIdx + 1}章第${f.secIdx + 1}节：${step}`,
    });
  }
  return out;
}

/** 合并 AI 返回的节级剧情链与正文兜底。 */
function mergePlotChain(aiChain, obj, throughSecCount) {
  const fallback = buildPlotChainFromSections(obj, throughSecCount);
  const fromAi = normalizePlotChain(aiChain);
  if (!fromAi.length) return fallback;
  const map = new Map();
  for (const p of fallback) map.set(p.secNo || `${p.actNo}-${p.secInAct}`, p);
  for (const p of fromAi) {
    const key = p.secNo || (p.actNo && p.secInAct ? p.actNo * 1000 + p.secInAct : 0);
    if (!key && !p.step) continue;
    const fb = map.get(p.secNo) || map.get(key) || {};
    const actNo = p.actNo || fb.actNo || 0;
    const secInAct = p.secInAct || fb.secInAct || 0;
    const secNo = p.secNo || fb.secNo || 0;
    let step = String(p.step || '').trim();
    if (!step) continue;
    if (actNo && secInAct && !/第\d+章第\d+节/.test(step)) {
      step = `第${actNo}章第${secInAct}节：${step}`;
    }
    map.set(secNo || key, {
      secNo,
      actNo,
      secInAct,
      actTitle: p.actTitle || fb.actTitle || '',
      step: step.length > 100 ? `${step.slice(0, 98)}…` : step,
    });
  }
  return [...map.values()].sort((a, b) => (a.secNo || 0) - (b.secNo || 0));
}

/** 剧情链纯文本。 */
function plotChainToText(chain) {
  const list = normalizePlotChain(chain);
  if (!list.length) return '';
  const lines = ['【剧情链(节)】'];
  for (const p of list) {
    const loc =
      p.actNo && p.secInAct
        ? `第${p.actNo}章第${p.secInAct}节`
        : p.secNo
          ? `全书第${p.secNo}节`
          : '节?';
    lines.push(`${loc}: ${(p.step || '').replace(/\n/g, ' ').trim()}`);
  }
  return lines.join('\n');
}

/** 剧情链 HTML（仅链路，无节/剧情节点表）。 */
function plotChainToHtml(chain) {
  const list = normalizePlotChain(chain);
  if (!list.length) return '';
  const traj = list
    .map((p, i) => {
      const loc =
        p.actNo && p.secInAct
          ? `第${p.actNo}章第${p.secInAct}节`
          : p.secNo
            ? `全书第${p.secNo}节`
            : '';
      const tip = loc ? `${loc}：${p.step}` : p.step;
      return `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-plot-chain-step" title="${esc(tip)}">${esc(p.step)}</span>`;
    })
    .join('');
  return `
    <div class="ns-plot-chains-block">
      <div class="ns-live-progress__title"><strong>剧情链</strong><span class="ns-muted">（每节 1 节点 · 悬停可看章节定位）</span></div>
      <div class="ns-plot-chain">${traj}</div>
    </div>`;
}

/** 把 summary 渲染成 Markdown 表格文本(面板展示)。 */
function summaryToTable(s) {
  const chars = Array.isArray(s.characters) ? s.characters : [];
  const plots = Array.isArray(s.plot) ? s.plot : [];
  const lines = [];
  lines.push('人物表:');
  lines.push('| 人物 | 状态/关系/目标 |');
  lines.push('| --- | --- |');
  if (chars.length) {
    for (const c of chars) lines.push(`| ${c.name || ''} | ${(c.detail || '').replace(/\n/g, ' ')} |`);
  } else {
    lines.push('| (无) | |');
  }
  lines.push('');
  lines.push('剧情表:');
  lines.push('| 序 | 关键剧情 |');
  lines.push('| --- | --- |');
  if (plots.length) {
    plots.forEach((p, i) => lines.push(`| ${i + 1} | ${String(p).replace(/\n/g, ' ')} |`));
  } else {
    lines.push('| 1 | |');
  }
  return lines.join('\n');
}

/** 总结紧凑文本(注入 AI，省 token)。 */
function summaryToCompact(s) {
  const chars = Array.isArray(s?.characters) ? s.characters : [];
  const plots = Array.isArray(s?.plot) ? s.plot : [];
  const lines = [];
  if (chars.length) {
    lines.push('人物:');
    for (const c of chars) {
      const d = String(c.detail || '').replace(/\n/g, ' ').trim();
      lines.push(`- ${c.name || '?'}: ${d}`);
    }
  }
  if (plots.length) {
    lines.push('剧情:');
    plots.forEach((p, i) => lines.push(`${i + 1}. ${String(p).replace(/\n/g, ' ').trim()}`));
  }
  return lines.join('\n') || '(空)';
}

/** 把 worldDefs 的四个板块拼成设定文本块（注入 prompt）。 */
function entitiesText(proj) {
  const wd = proj.worldDefs || {};
  const sections = [
    { key: 'chars', label: '人物设定' },
    { key: 'items', label: '道具设定' },
    { key: 'places', label: '地理设定' },
    { key: 'others', label: '其他设定' },
  ];
  const parts = [];
  for (const { key, label } of sections) {
    const list = (wd[key] || []).filter((e) => e && e.trim());
    if (list.length) parts.push(`【${label}】\n${list.map((e) => `- ${e.trim()}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/* ---------------------------- 世界书同步 / 生成注入 ---------------------------- */

const WI_ENTRY_MARK = 'ns-novel-studio';

/** 为项目生成稳定的世界书名。 */
function makeWorldBookName(proj) {
  if (proj?.worldBookName) return proj.worldBookName;
  const title = safeFileName(proj?.title || 'novel').slice(0, 40);
  const id = String(proj?.id || genId()).replace(/^np_/, '').slice(0, 10);
  return `NS_${title}_${id}`;
}

/** 从设定文本提取关键词（用于世界书 key）。 */
function extractWiKeys(text, label) {
  const t = String(text || '').trim();
  const keys = [];
  if (label) keys.push(label);
  const nameHit = t.match(/^([^:：\n]{1,24})\s*[:：]/);
  if (nameHit?.[1]) keys.push(nameHit[1].trim());
  const head = t.replace(/\s+/g, '').slice(0, 8);
  if (head && !keys.includes(head)) keys.push(head);
  return keys.filter(Boolean).slice(0, 6);
}

function buildWiEntryObject(ctx, uid, { keys, content, comment, order }) {
  const base =
    ctx?.worldInfoEntry?.template && typeof ctx.worldInfoEntry.template === 'object'
      ? { ...ctx.worldInfoEntry.template }
      : {};
  const pos = ctx?.constants?.wiPosition?.before ?? 0;
  return {
    ...base,
    uid,
    key: Array.isArray(keys) ? keys : [String(keys || '设定')],
    keysecondary: [],
    content: String(content || '').trim(),
    comment: `${WI_ENTRY_MARK}|${comment || ''}`,
    constant: true, // 工坊设定：激活世界书时始终注入
    selective: true,
    order: order ?? 100,
    position: pos,
    disable: false,
    excludeRecursion: false,
    probability: 100,
    useProbability: true,
  };
}

/** 确保世界书文件存在并返回 data。 */
async function ensureWorldBookFile(name) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  if (typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') {
    throw new Error('当前酒馆未暴露世界书 API（需要 loadWorldInfo / saveWorldInfo）');
  }
  let book = await ctx.loadWorldInfo(name);
  if (book) return book;
  if (typeof ctx.createWorldBook === 'function') {
    await ctx.createWorldBook(name, { interactive: false });
  } else if (typeof ctx.createNewWorldInfo === 'function') {
    await ctx.createNewWorldInfo(name);
  } else {
    await ctx.saveWorldInfo(name, { entries: {} }, true, { refreshEditor: true });
  }
  await ctx.updateWorldInfoList?.();
  book = await ctx.loadWorldInfo(name);
  if (!book) {
    book = { entries: {} };
    await ctx.saveWorldInfo(name, book, true, { refreshEditor: true });
  }
  return book;
}

/** 将当前项目全部设定同步到酒馆世界书（覆盖本书内由本扩展写入的条目）。 */
async function syncProjectToWorldInfo(proj) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  ensureWorldDefs(proj);
  collectWorldDefsFromDOM(proj);
  const name = makeWorldBookName(proj);
  const book = await ensureWorldBookFile(name);
  const entries = {};
  let uid = 0;
  let order = 100;
  const push = (content, comment, keys) => {
    const c = String(content || '').trim();
    if (!c) return;
    entries[uid] = buildWiEntryObject(ctx, uid, {
      keys: keys?.length ? keys : extractWiKeys(c, comment),
      content: c,
      comment,
      order: order++,
    });
    uid++;
  };

  if (proj.background?.trim()) {
    push(`【背景设定】\n${proj.background.trim()}`, '背景设定', ['背景设定', '背景']);
  }
  const sections = [
    { key: 'chars', label: '人物设定' },
    { key: 'items', label: '道具设定' },
    { key: 'places', label: '地理设定' },
    { key: 'others', label: '其他设定' },
  ];
  for (const { key, label } of sections) {
    const list = (proj.worldDefs[key] || []).filter((e) => e && String(e).trim());
    list.forEach((item, i) => {
      push(item, `${label}#${i + 1}`, extractWiKeys(item, label));
    });
  }
  if (!Object.keys(entries).length) {
    throw new Error('当前没有可同步的设定（请先填写背景或世界设定）');
  }

  book.entries = entries;
  await ctx.saveWorldInfo(name, book, true, { refreshEditor: true });
  await ctx.updateWorldInfoList?.();
  try {
    ctx.reloadWorldInfoEditor?.(name, true);
  } catch (e) {
    /* ignore */
  }

  proj.worldBookName = name;
  touchProject(proj);
  log.info('已同步设定至世界书', { name, entries: Object.keys(entries).length });
  return { name, count: Object.keys(entries).length };
}

/** 删除项目绑定的世界书。 */
async function deleteProjectWorldInfo(proj) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  const name = proj?.worldBookName || '';
  if (!name) throw new Error('当前项目尚未同步世界书');

  try {
    if (ctx.worldInfoEntry?.setGlobalSelection) {
      await ctx.worldInfoEntry.setGlobalSelection(name, false);
    }
  } catch (e) {
    log.debug('取消世界书全局选择忽略:', e?.message || e);
  }

  let deleted = false;
  if (typeof ctx.deleteWorldInfo === 'function') {
    await ctx.deleteWorldInfo(name);
    deleted = true;
  } else {
    // 兜底：走世界书 HTTP API（不同版本路径可能略有差异）
    const tries = [
      { url: '/api/worldinfo/delete', body: { name } },
      { url: '/api/worldinfo/delete', body: { worldInfoName: name } },
    ];
    for (const t of tries) {
      try {
        const res = await fetch(t.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t.body),
        });
        if (res.ok) {
          deleted = true;
          break;
        }
      } catch (e) {
        log.debug('删除世界书请求失败:', t.url, e?.message || e);
      }
    }
  }
  if (!deleted) {
    // 最后手段：清空条目并提示用户手动删文件
    try {
      await ctx.saveWorldInfo?.(name, { entries: {} }, true, { refreshEditor: true });
    } catch (e) {
      /* ignore */
    }
    throw new Error('无法通过 API 删除世界书文件，已尝试清空条目；请在世界书面板手动删除「' + name + '」');
  }
  await ctx.updateWorldInfoList?.();
  proj.worldBookName = '';
  touchProject(proj);
  log.info('已删除世界书', name);
  return name;
}

/** 临时把世界书加入全局启用列表，返回还原函数。 */
async function withWorldBookSelected(bookName, fn) {
  const ctx = getST();
  if (!ctx || !bookName) return fn(false);
  let added = false;
  const selected = Array.isArray(ctx.chatWorldInfo?.globalSelection)
    ? [...ctx.chatWorldInfo.globalSelection]
    : [];
  const already = selected.some((n) => String(n).toLowerCase() === String(bookName).toLowerCase());
  try {
    if (!already && ctx.worldInfoEntry?.setGlobalSelection) {
      await ctx.worldInfoEntry.setGlobalSelection(bookName, true);
      added = true;
    }
    return await fn(true);
  } finally {
    if (added && ctx.worldInfoEntry?.setGlobalSelection) {
      try {
        await ctx.worldInfoEntry.setGlobalSelection(bookName, false);
      } catch (e) {
        log.debug('还原世界书全局选择忽略:', e?.message || e);
      }
    }
  }
}

/**
 * 按酒馆世界书扫描接口取出 before/after 文本。
 * 优先 simulateWorldInfoActivation；失败则直接读取本书 constant 条目。
 */
async function resolveWorkshopWorldInfo(bookName, scanText) {
  const ctx = getST();
  if (!ctx || !bookName) return { before: '', after: '' };

  return withWorldBookSelected(bookName, async () => {
    const scan = String(scanText || '').trim().slice(0, 8000);
    try {
      if (typeof ctx.simulateWorldInfoActivation === 'function') {
        const wi = await ctx.simulateWorldInfoActivation({
          coreChat: [
            { name: 'System', mes: '小说工坊设定检索', is_user: false, is_system: true },
            { name: 'User', mes: scan || '世界设定 人物 道具 地理', is_user: true, is_system: false },
          ],
          dryRun: true,
          type: 'quiet',
        });
        // 兼容不同版本：字符串字段 / 条目数组
        const before =
          (typeof wi?.worldInfoBefore === 'string' && wi.worldInfoBefore) ||
          (Array.isArray(wi?.worldInfoBeforeEntries)
            ? wi.worldInfoBeforeEntries.filter(Boolean).join('\n')
            : '') ||
          '';
        const after =
          (typeof wi?.worldInfoAfter === 'string' && wi.worldInfoAfter) ||
          (Array.isArray(wi?.worldInfoAfterEntries)
            ? wi.worldInfoAfterEntries.filter(Boolean).join('\n')
            : '') ||
          '';
        if (before || after) {
          log.debug('世界书扫描命中', { before: before.length, after: after.length });
          return { before, after };
        }
      }
    } catch (e) {
      log.warn('simulateWorldInfoActivation 失败，降级直读条目:', e?.message || e);
    }

    // 降级：直读本书全部启用条目（同步时均为 constant）
    try {
      const book = await ctx.loadWorldInfo?.(bookName);
      const list = Object.values(book?.entries || {}).filter((e) => e && !e.disable && e.content);
      list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      const before = list.map((e) => String(e.content).trim()).filter(Boolean).join('\n\n');
      return { before, after: '' };
    } catch (e) {
      log.warn('直读世界书失败:', e?.message || e);
      return { before: '', after: '' };
    }
  });
}

/**
 * 工坊写作 system 一次打包：预设 → 全局提示词 → 设定/总结 → 短指令。
 * 若已同步世界书，设定改由世界书接口注入，此处不再重复塞 entitiesText。
 */
function buildWorkshopSystemPack({ roleHint, extraRules = [], memoryObj = null, worldProj = null, reinforce = false } = {}) {
  const presetSys = readSysPrompt();
  const globalKw = readGlobalKeyword();
  const preloadOn = worldProj ? !!(worldProj.worldDefs?.preload) : true;
  const useWi = !!(worldProj?.worldBookName);
  const defs = !useWi && worldProj ? entitiesText(worldProj) : '';
  // 长期记忆：章节总结 + 剧情链 + 人物链（buildGrandSummary 三者齐全）
  const memory = memoryObj ? buildGrandSummary(memoryObj) : '';
  const memBlock = joinPromptBlocks(preloadOn && defs ? defs : '', memory);

  return joinPromptBlocks(
    presetSys ? `【预设/系统提示】\n${presetSys}` : '',
    globalKw ? `【全局提示词】\n${globalKw}` : '',
    memBlock
      ? `【长期记忆】\n（含：章节总结 / 剧情链 / 人物链；写作时须承接，勿矛盾）\n${memBlock}`
      : '',
    roleHint,
    ...(extraRules || []),
    reinforce
      ? '重要：上一轮空回复。本次必须输出完整可读正文（至少数百字），禁止空白/省略号/极短占位。'
      : '',
  );
}

/** 构建"写某一节"的提示词：system 一次含预设/全局/总结；user 仅本章任务与短前文。 */
function buildSectionPrompt(proj, actIdx, secIdx, flatIdx, { reinforce = false } = {}) {
  const act = proj.acts[actIdx];
  const sec = act.sections[secIdx];
  const preloadOn = !!(proj?.worldDefs?.preload);
  const useWi = !!proj?.worldBookName;

  const system = buildWorkshopSystemPack({
    roleHint: '你是中文小说写作助手。按章-节结构写作。只输出本节正文，不要标题/大纲/解释；遵守设定与前文连贯。',
    memoryObj: proj,
    worldProj: proj,
    reinforce,
  });

  const user = joinPromptBlocks(
    // 已同步世界书时，背景/设定改由世界书扫描注入，避免重复占 token
    !useWi && proj.background ? `【背景】\n${clipTextHead(proj.background, 1200)}` : '',
    !useWi && !preloadOn ? entitiesText(proj) : '',
    recentSectionContext(proj, flatIdx, 2),
    `【本章总览】第${actIdx + 1}章 ${act.title || ''}\n${act.overview || '(未填)'}`,
    `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${sec.outline || ''}`,
    reinforce
      ? `请重新完整撰写第${actIdx + 1}章第${secIdx + 1}节正文（须有实质内容）:`
      : `请写第${actIdx + 1}章第${secIdx + 1}节正文:`,
  );

  return { system, user };
}

/** 构建"整章总结"提示词：只根据各节正文，不用章总览/节大纲。 */
function buildActSummaryPrompt(proj, actIdx) {
  const act = proj.acts[actIdx];
  const system = [
    '你是小说剧情归档助手。请阅读某一章各节的正文，输出用于强化长期记忆的结构化总结。',
    '必须只输出一个合法 JSON 对象, 不要输出任何多余文字、代码块标记或额外的括号。严格使用如下格式(注意括号必须正确闭合、成对):',
    '{"characters":[{"name":"角色名","detail":"当前状态/关系/目标"}],"plot":["关键剧情要点1","要点2"]}',
    '规则: 只能依据【正文】归纳；严禁依据章总览、节大纲或未写出的情节；不要把大纲当已发生剧情。',
  ].join('\n');
  const body = (act.sections || [])
    .map((s, i) => (hasValidSectionContent(s) ? `【第${actIdx + 1}章 第${i + 1}节正文】\n${String(s.content).trim()}` : ''))
    .filter(Boolean)
    .join('\n\n');
  // 总结 prompt 只带最近一条总结(避免大总结太长影响 JSON 输出)
  const prev = latestSummaryText(proj);
  const user = [
    prev ? `【此前总结(最新一章·仅对照)】\n${prev}` : '',
    body
      ? `【待总结正文: 第${actIdx + 1}章】\n${body}`
      : `【待总结正文: 第${actIdx + 1}章】\n(本章尚无有效正文)`,
    '请仅根据正文输出 JSON 总结:',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

/** 从文本中提取第一个"括号平衡"的 JSON 对象子串(容忍前后多余字符)。 */
function extractBalancedJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let escNext = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escNext) {
      escNext = false;
      continue;
    }
    if (ch === '\\') {
      escNext = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1); // 完整对象到此结束
    }
  }
  return s.slice(start); // 未闭合, 返回从 { 起的全部
}

/** 从对象中规整出 {characters:[{name,detail}], plot:[...]}。 */
function normalizeSummaryObj(obj) {
  const characters = Array.isArray(obj?.characters)
    ? obj.characters
        .map((c) => (typeof c === 'string' ? { name: c, detail: '' } : { name: c?.name || '', detail: c?.detail || '' }))
        .filter((c) => c.name || c.detail)
    : [];
  const plot = Array.isArray(obj?.plot) ? obj.plot.map((p) => String(p)).filter(Boolean) : [];
  return { characters, plot };
}

/** 解析总结: 尽力从(可能畸形的) JSON 提取, 失败再降级为文本。 */
function parseSummary(text) {
  let t = String(text || '').trim();
  // 去掉 markdown 代码块围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const jsonStr = extractBalancedJson(t) || t;

  // 1) 直接解析
  try {
    const r = normalizeSummaryObj(JSON.parse(jsonStr));
    if (r.characters.length || r.plot.length) return r;
  } catch (e) {
    /* 继续尝试纠错 */
  }

  // 2) 纠错: 去掉尾部多余的 ] 或 } 等, 反复尝试
  let candidate = jsonStr;
  for (let k = 0; k < 6 && candidate.length > 2; k++) {
    candidate = candidate.replace(/[\s,\]}]+$/, '');
    for (const suffix of ['}', ']}', '}]}', '"}]}', '"}]}]']) {
      try {
        const r = normalizeSummaryObj(JSON.parse(candidate + suffix));
        if (r.characters.length || r.plot.length) {
          log.debug('总结 JSON 已纠错解析');
          return r;
        }
      } catch (e) {
        /* 试下一个 */
      }
    }
    // 去掉最后一个不完整的字段再试
    candidate = candidate.replace(/,\s*("?[^,{}\[\]]*)?$/, '');
  }

  // 3) 分别用正则抽取 characters / plot 数组内容
  try {
    const charsM = t.match(/"characters"\s*:\s*\[([\s\S]*?)\]\s*(?:,\s*"plot"|\}|$)/);
    const plotM = t.match(/"plot"\s*:\s*\[([\s\S]*?)\]/);
    const characters = [];
    if (charsM) {
      const re = /\{\s*"name"\s*:\s*"([^"]*)"\s*,\s*"detail"\s*:\s*"([\s\S]*?)"\s*\}/g;
      let m;
      while ((m = re.exec(charsM[1]))) characters.push({ name: m[1], detail: m[2] });
    }
    const plot = [];
    if (plotM) {
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = re.exec(plotM[1]))) plot.push(m[1].replace(/\\"/g, '"'));
    }
    if (characters.length || plot.length) {
      log.debug('总结 JSON 已用正则回退解析');
      return { characters, plot };
    }
  } catch (e) {
    /* ignore */
  }

  // 4) 最终降级: 旧文本格式 "人物:" / "剧情:"
  const cm = t.match(/人物[:：]\s*([\s\S]*?)(?:\n剧情[:：]|$)/);
  const pm = t.match(/剧情[:：]\s*([\s\S]*)$/);
  log.warn('总结解析全部失败, 以纯文本降级展示');
  return {
    characters: cm?.[1]?.trim() ? [{ name: '综合', detail: cm[1].trim() }] : [],
    plot: pm?.[1]?.trim() ? [pm[1].trim()] : t ? [t] : [],
  };
}

/* ---------------------------- 节生成流程 ---------------------------- */

/** 生成某一节正文; flatIdx 为该节在展平序列中的下标(用于动画高亮)。 */
/** skipSummary=true 时跳过触发总结(单节重新生成时使用, 避免干扰生成流程) */
/** deferLiveProgress=true：不立刻动态大总结，等用户点「确认总结」 */
async function generateSection(proj, actIdx, secIdx, flatIdx, onProgress, { skipSummary = false, reinforce = false, deferLiveProgress = false } = {}) {
  const act = proj.acts[actIdx];
  const sec = act.sections[secIdx];
  if (isSectionLocked(sec)) {
    log.warn(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节已锁定，跳过生成`);
    return '';
  }
  // 开始写"某章第一节"时, 先对之前所有已完成但未总结的章做整章总结(重新生成时跳过)
  if (secIdx === 0 && !skipSummary) await summarizePendingActs(proj, actIdx, onProgress);

  // 生成前确保不带着空内容的 done 状态，避免后续流程把它当「已完成」
  sec.content = '';
  sec.done = false;
  delete sec.pendingLiveSummary;

  novelState.activeFlatIdx = flatIdx;
  novelState.activeActIdx = actIdx;
  startGenUiProgress('novel', {
    flatIdx,
    phase: 'gen',
    status: `生成中… 正在生成第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`,
  });
  renderNovelChapters();
  paintGenUiProgress();

  let text = '';
  try {
    const maxPasses = 2;
    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        const gap = calcRetryDelayMs(pass - 1, new Error('空回复'));
        onProgress?.(
          `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节空回，${Math.round(gap / 1000)}s 后加强提示重试…`,
          true,
        );
        await waitCancellable(gap, () => novelState.cancelRequested);
        resetGenerationChannel('novel', { hard: false });
      }
      const needReinforce = reinforce || pass > 0;
      const { system, user } = buildSectionPrompt(proj, actIdx, secIdx, flatIdx, { reinforce: needReinforce });
      onProgress?.(
        pass === 0
          ? `正在生成第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`
          : `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节空回，正在加强提示后重试…`,
        true,
      );
      try {
        text = (await novelGenerate({ system, user }, { minLen: MIN_SECTION_CHARS })).trim();
      } catch (e) {
        if (pass < maxPasses - 1 && /空回复/.test(String(e.message || ''))) {
          log.warn(`节生成空回，准备第 ${pass + 2} 轮:`, e.message);
          continue;
        }
        sec.content = '';
        sec.done = false;
        touchProject(proj);
        throw e;
      }
      if (!isEmptyReply(text, MIN_SECTION_CHARS)) break;
      log.warn(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节结果过短(${text.length}字)，重试…`);
      text = '';
    }

    if (isEmptyReply(text, MIN_SECTION_CHARS)) {
      sec.content = '';
      sec.done = false;
      touchProject(proj);
      throw new Error(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节生成结果为空，请稍后重新生成`);
    }

    const elapsedMs = finishGenUiProgress();
    sec.content = text;
    sec.done = true;
    sec.updatedAt = Date.now();
    if (deferLiveProgress) {
      markPendingLiveSummary(proj, actIdx, secIdx);
    } else {
      delete sec.pendingLiveSummary;
    }
    touchProject(proj);
    onProgress?.(
      deferLiveProgress
        ? `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}，请点击「确认总结」`
        : `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}`,
      false,
    );
    if (deferLiveProgress) {
      await sleep(350);
      stopGenUiProgress();
      novelState.activeFlatIdx = -1;
      renderNovelChapters();
    } else {
      // 自动模式：同节继续显示「更新动态总结」状态
      switchGenUiToSummary(
        `生成中… 正在更新剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
      );
      renderNovelChapters();
      paintGenUiProgress();
      try {
        await updateLiveProgress(proj, actIdx, secIdx, onProgress, {
          saveFn: () => touchProject(proj),
          isCancelled: () => novelState.cancelRequested,
        });
        refreshGrandSummary(proj, `#${EXT_ID}-novel`);
        finishGenUiProgress();
        await sleep(300);
      } finally {
        stopGenUiProgress();
        novelState.activeFlatIdx = -1;
        renderNovelChapters();
      }
    }
    return text;
  } catch (e) {
    finishGenUiProgress();
    await sleep(250);
    stopGenUiProgress();
    novelState.activeFlatIdx = -1;
    renderNovelChapters();
    throw e;
  }
}

/**
 * 用户确认后：更新动态大总结，并自动开始写下一节（手动/生成本节流程）。
 */
async function confirmLiveSummaryAndContinueNovel(proj, actIdx, secIdx) {
  if (!proj || novelState.generating) return;
  const sec = proj.acts?.[actIdx]?.sections?.[secIdx];
  if (!sec?.pendingLiveSummary || !hasValidSectionContent(sec)) {
    toast('当前节无需确认总结');
    return;
  }
  collectActsFromDOM(proj);
  const flatIdx =
    flatSections(proj).find((f) => f.actIdx === actIdx && f.secIdx === secIdx)?.flatIdx ?? -1;
  await withGenerating(async () => {
    novelState.activeFlatIdx = flatIdx;
    startGenUiProgress('novel', {
      flatIdx,
      phase: 'summary',
      status: `生成中… 正在更新剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
    });
    renderNovelChapters();
    paintGenUiProgress();
    try {
      await updateLiveProgress(proj, actIdx, secIdx, setNovelHint, {
        saveFn: () => touchProject(proj),
        isCancelled: () => novelState.cancelRequested,
      });
      if (novelState.cancelRequested) {
        setNovelHint('已中止。');
        return;
      }
      delete sec.pendingLiveSummary;
      touchProject(proj);
      refreshGrandSummary(proj, `#${EXT_ID}-novel`);
      finishGenUiProgress();
      await sleep(300);
    } finally {
      stopGenUiProgress();
      novelState.activeFlatIdx = -1;
      renderNovelChapters();
    }
    if (novelState.cancelRequested) return;

    const next = findNextWritableSection(proj, actIdx, secIdx);
    if (!next) {
      await summarizePendingActs(proj, proj.acts.length, setNovelHint);
      setNovelHint(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节总结已确认。没有下一节可写。`);
      return;
    }
    setNovelHint(`总结已确认，开始生成第 ${next.actIdx + 1} 章 第 ${next.secIdx + 1} 节…`, true);
    await generateSection(proj, next.actIdx, next.secIdx, next.flatIdx, setNovelHint, {
      deferLiveProgress: true,
    });
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setNovelHint(
      `第 ${next.actIdx + 1} 章 第 ${next.secIdx + 1} 节已生成${took}，请点击「确认总结」。`,
    );
  });
  renderNovelUI();
}

/** 对 beforeActIdx 之前所有"已完成且尚未总结"的章补做整章总结。 */
async function summarizePendingActs(proj, beforeActIdx, onProgress) {
  for (let i = 0; i < beforeActIdx; i++) {
    const a = proj.acts[i];
    if (a && isActComplete(a) && !proj.summaries.some((s) => s.actNo === i + 1)) {
      await maybeSummarizeAct(proj, i, onProgress);
    }
  }
}

/** 该大章已有表格总结则跳过, 否则生成并存档。force=true 时允许章未写完(有正文即可)强制重总结。 */
async function maybeSummarizeAct(proj, actIdx, onProgress, { force = false } = {}) {
  const actNo = actIdx + 1;
  const act = proj.acts[actIdx];
  if (!act) {
    log.debug(`第 ${actNo} 章不存在, 跳过总结`);
    return;
  }
  if (force) {
    if (!actHasGeneratedContent(act)) {
      log.debug(`第 ${actNo} 章尚无正文, 跳过强制总结`);
      return;
    }
    proj.summaries = (proj.summaries || []).filter((s) => s.actNo !== actNo);
  } else {
    if (!isActComplete(act)) {
      log.debug(`第 ${actNo} 章未完成或不存在, 跳过总结`);
      return;
    }
    if (proj.summaries.some((s) => s.actNo === actNo)) {
      log.debug(`第 ${actNo} 章已有总结, 跳过`);
      return;
    }
  }
  try {
    const partial = !isActComplete(act);
    log.info(`开始生成第 ${actNo} 章整章表格总结${partial ? '(未完成章·强制)' : ''}…`);
    onProgress?.(
      partial ? `正在强制总结第 ${actNo} 章(尚未写完，仅已有正文)…` : `第 ${actNo} 章已写完, 正在生成整章表格总结…`,
      true,
    );
    const { system, user } = buildActSummaryPrompt(proj, actIdx);
    const raw = (await novelGenerate({ system, user })).trim();
    log.debug(`第 ${actNo} 章总结原始返回:`, raw.slice(0, 200));
    const parsed = parseSummary(raw);
    if (!parsed.characters.length && !parsed.plot.length) {
      log.warn(`第 ${actNo} 章总结解析结果为空, 原始文本:`, raw.slice(0, 400));
    }
    proj.summaries.push({
      actNo,
      actTitle: proj.acts[actIdx].title || '',
      characters: parsed.characters,
      plot: parsed.plot,
      createdAt: Date.now(),
      partial: partial || undefined,
    });
    touchProject(proj);
    renderNovelSummaries(); // 实时刷新总结区
    log.info(`已生成第 ${actNo} 章表格总结`, { characters: parsed.characters.length, plot: parsed.plot.length, partial });
    onProgress?.(`第 ${actNo} 章表格总结已存档${partial ? '(未完成章)' : ''}`, true);
  } catch (e) {
    log.warn('整章总结失败:', e);
    onProgress?.(`整章总结失败: ${e.message}`, true);
  }
}

/* ================================================================== */
/* 续写: 上传文本分析                                                  */
/* ================================================================== */

const analyzeState = {
  running: false,
  cancelRequested: false,
  genIds: new Set(),
  uploadedText: '',
  uploadedName: '',
  result: null,
};

function splitTextIntoChunks(text, chunkSize) {
  const src = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];
  const size = Math.max(1000, chunkSize | 0);
  const chunks = [];
  let i = 0;
  while (i < src.length) {
    let end = Math.min(src.length, i + size);
    if (end < src.length) {
      const windowStart = i + Math.floor(size * 0.6);
      const slice = src.slice(windowStart, end);
      let rel = slice.lastIndexOf('\n');
      if (rel < 0) {
        const m = slice.match(/[。！？…”』】\n][^。！？…”』】\n]*$/);
        if (m) rel = m.index + 1;
      } else {
        rel = rel + 1;
      }
      if (rel > 0) end = windowStart + rel;
    }
    const piece = src.slice(i, end).trim();
    if (piece) chunks.push(piece);
    i = end;
  }
  return chunks;
}

async function runPool(items, concurrency, worker, onProgress, shouldCancel) {
  const total = items.length;
  const results = new Array(total);
  let next = 0;
  let done = 0;
  const conc = Math.max(1, concurrency | 0);
  async function runner() {
    while (true) {
      if (shouldCancel?.()) return;
      const idx = next++;
      if (idx >= total) return;
      results[idx] = await worker(items[idx], idx);
      done++;
      onProgress?.(done, total);
    }
  }
  const runners = [];
  for (let k = 0; k < Math.min(conc, total); k++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function buildChunkAnalyzePrompt(chunkText, index, totalChunks) {
  const system = [
    '你是小说分析助手。请阅读给定的小说片段, 提取信息用于建立角色档案和剧情梗概。',
    '严格按如下格式输出, 不要多余解释:',
    '角色:',
    '- <角色名>: <该片段中体现的身份/性格/关系/关键行为>',
    '剧情: <用要点概括该片段发生的关键事件, 保持时间顺序>',
  ].join('\n');
  const user = `【片段 ${index + 1}/${totalChunks}】\n${chunkText}\n\n请提取本片段的角色与剧情:`;
  return { system, user };
}

async function analyzeChunk(chunkText, index, totalChunks) {
  const { system, user } = buildChunkAnalyzePrompt(chunkText, index, totalChunks);
  const gid = `analyze_${Date.now()}_${index}`;
  analyzeState.genIds.add(gid);
  try {
    return (await novelGenerateWithId({ system, user }, gid, () => analyzeState.cancelRequested)).trim();
  } finally {
    analyzeState.genIds.delete(gid);
  }
}

function stopAnalyze() {
  analyzeState.cancelRequested = true;
  const th = getTavernHelper();
  try {
    if (th?.stopGenerationById && analyzeState.genIds.size) {
      for (const gid of analyzeState.genIds) th.stopGenerationById(gid);
    } else if (th?.stopAllGeneration) {
      th.stopAllGeneration();
    } else {
      getST()?.stopGeneration?.();
    }
  } catch (e) {
    log.warn('中止分析失败:', e);
  }
  log.info('已请求中止分析');
}

async function aggregateAnalyses(partials, onProgress) {
  const clean = partials.filter((p) => p && p.trim());
  if (clean.length === 0) return { characters: '', plot: '' };
  const BATCH = 15;
  let level = clean;
  let round = 0;
  while (level.length > BATCH) {
    round++;
    const merged = [];
    const groups = [];
    for (let i = 0; i < level.length; i += BATCH) groups.push(level.slice(i, i + BATCH));
    for (let g = 0; g < groups.length; g++) {
      if (analyzeState.cancelRequested) throw new Error('已中止');
      onProgress?.(`聚合中(第 ${round} 轮, ${g + 1}/${groups.length})…`);
      merged.push(await mergeGroup(groups[g], false));
    }
    level = merged;
  }
  onProgress?.('生成最终角色档案与剧情梗概…');
  return parseAnalysisResult(await mergeGroup(level, true));
}

async function mergeGroup(group, isFinal) {
  const system = isFinal
    ? [
        '你是小说分析归档助手。请把多段分析结果整合为完整、去重、连贯的最终结果。',
        '严格按如下格式输出:',
        '角色档案:',
        '- <角色名>: <综合身份、性格、人物关系、成长/结局等, 一段话>',
        '剧情梗概: <按时间顺序概括全书主要剧情脉络, 分段落, 尽量完整>',
      ].join('\n')
    : [
        '你是小说分析助手。请把多段分析结果合并去重, 保留所有角色与关键剧情, 输出更紧凑的中间结果。',
        '格式:',
        '角色:',
        '- <角色名>: <综合描述>',
        '剧情: <按顺序概括, 要点式>',
      ].join('\n');
  const user = `以下是多段分析结果, 请合并:\n\n${group.join('\n\n---\n\n')}`;
  const gid = `aggregate_${Date.now()}`;
  analyzeState.genIds.add(gid);
  try {
    return (await novelGenerateWithId({ system, user }, gid, () => analyzeState.cancelRequested)).trim();
  } finally {
    analyzeState.genIds.delete(gid);
  }
}

function parseAnalysisResult(text) {
  const t = String(text || '');
  const cm = t.match(/角色档案[:：]?\s*([\s\S]*?)(?:\n剧情梗概[:：]|\n剧情[:：]|$)/);
  const pm = t.match(/剧情梗概[:：]?\s*([\s\S]*)$/) || t.match(/剧情[:：]?\s*([\s\S]*)$/);
  return {
    characters: (cm?.[1] || '').trim() || t.trim(),
    plot: (pm?.[1] || '').trim(),
  };
}

async function runAnalysis({ text, title }, onProgress) {
  if (analyzeState.running) return null;
  const settings = getSettings();
  const chunkSize = settings.analyzeChunkSize || 6000;
  const concurrency = settings.analyzeConcurrency || 1;
  const full = String(text || '').trim();
  if (!full) throw new Error('文本为空');
  const chunks = splitTextIntoChunks(full, chunkSize);
  if (chunks.length === 0) throw new Error('分段失败');

  analyzeState.running = true;
  analyzeState.cancelRequested = false;
  analyzeState.genIds.clear();
  syncMiniBallBusy();
  const t0 = Date.now();
  try {
    onProgress?.(`共 ${full.length} 字, 切为 ${chunks.length} 段, 并发 ${concurrency}, 开始提取…`, 0);
    let failed = 0;
    const partials = await runPool(
      chunks,
      concurrency,
      async (chunk, i) => {
        try {
          return await analyzeChunk(chunk, i, chunks.length);
        } catch (e) {
          failed++;
          log.warn(`第 ${i + 1} 段分析失败, 已跳过:`, e.message);
          return '';
        }
      },
      (done, total) => onProgress?.(`提取中 ${done}/${total} 段…`, Math.round((done / total) * 80)),
      () => analyzeState.cancelRequested,
    );
    if (analyzeState.cancelRequested) throw new Error('已中止');
    onProgress?.(failed ? `提取完成(${failed} 段失败已跳过), 开始聚合…` : '提取完成, 开始聚合…', 82);
    const { characters, plot } = await aggregateAnalyses(partials, (m) => onProgress?.(m, 92));
    if (analyzeState.cancelRequested) throw new Error('已中止');

    const result = {
      title: title || analyzeState.uploadedName || '导入的小说',
      characters,
      plot,
      totalChars: full.length,
      chunkCount: chunks.length,
      analyzedAt: Date.now(),
    };
    analyzeState.result = result;

    const tailN = getSettings().contextTailChars || 2500;
    const sourceTail = full.slice(Math.max(0, full.length - tailN));
    // 分析完成后新建一个续写会话并激活
    const newCont = {
      id: genId(),
      title: result.title,
      characters,
      plot,
      sourceTail,
      totalChars: full.length,
      analyzedAt: result.analyzedAt,
      mode: 'outline',
      targetChapters: 5,
      acts: [],
      summaries: [],
    };
    getContinuations().push(newCont);
    getSettings().activeContinuationId = newCont.id;
    saveSettings();

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    onProgress?.(`分析完成! 用时 ${secs}s`, 100);
    log.info('分析完成', { chars: full.length, chunks: chunks.length, secs });
    return result;
  } finally {
    analyzeState.running = false;
    analyzeState.cancelRequested = false;
    analyzeState.genIds.clear();
    syncMiniBallBusy();
  }
}

/* ================================================================== */
/* 续写: 生成                                                          */
/* ================================================================== */

const contState = { generating: false, cancelRequested: false, currentGenId: '', activeFlatIdx: -1, activeActIdx: -1 };
let _contDragAttach = null; // 续写节拖拽重绑函数

/** 获取所有续写会话列表。 */
function getContinuations() {
  const s = getSettings();
  if (!Array.isArray(s.continuations)) s.continuations = [];
  return s.continuations;
}

/** 获取当前激活的续写会话(按 activeContinuationId 查找，找不到取第一个)。 */
function getContinuation() {
  const s = getSettings();
  const list = getContinuations();
  const cont = list.find((c) => c.id === s.activeContinuationId) || list[0] || null;
  if (cont) {
    ensureActs(cont);
    if (!Array.isArray(cont.summaries)) cont.summaries = [];
    if (!Array.isArray(cont.plotChain)) cont.plotChain = [];
    let dirty = sanitizeEmptyDoneSections(cont);
    if (stripLegacyCompactFields(cont)) dirty = true;
    if (dirty) saveContinuation();
  }
  return cont;
}

/** 新建续写会话并激活。 */
function createContinuation(title) {
  const s = getSettings();
  const cont = {
    id: genId(),
    title: title || `续写会话 ${new Date().toLocaleString()}`,
    characters: '',
    plot: '',
    sourceTail: '',
    totalChars: 0,
    analyzedAt: 0,
    mode: 'outline',
    targetChapters: 5,
    acts: [],
    summaries: [],
    plotChain: [],
    liveProgress: null,
  };
  getContinuations().push(cont);
  s.activeContinuationId = cont.id;
  saveSettings();
  log.info('新建续写会话:', cont.title, cont.id);
  return cont;
}

/** 删除续写会话。 */
function deleteContinuation(id) {
  const s = getSettings();
  const list = getContinuations();
  const idx = list.findIndex((c) => c.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (s.activeContinuationId === id) s.activeContinuationId = list[0]?.id || '';
    saveSettings();
    log.info('已删除续写会话:', id);
  }
}

function saveContinuation() {
  saveSettings();
}
function contDoneCount(cont) {
  return doneSectionCount(cont);
}

/** 取展平序列中某节之前最近一节正文的结尾。 */
function contRecentTail(cont, flatIdx, chars = 1200) {
  const flat = flatSections(cont);
  for (let i = flatIdx - 1; i >= 0; i--) {
    const f = flat[i];
    if (f && f.sec.content) return f.sec.content.slice(Math.max(0, f.sec.content.length - chars));
  }
  return '';
}

/** 构建续写某节的提示词。mode: outline=按大纲 / free=自然续写。一次性打包预设/全局/总结。 */
function buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode, { reinforce = false } = {}) {
  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];

  const system = buildWorkshopSystemPack({
    roleHint:
      mode === 'free'
        ? '你是中文小说续写助手。自然续写：据原文走向与人物推进剧情。只输出续写正文，不要标题/解释。'
        : '你是中文小说续写助手。按大纲续写：先理解本章总览，再围绕本节大纲展开。只输出正文，不要标题/解释。',
    memoryObj: cont,
    reinforce,
    extraRules: [
      cont.characters ? `【角色档案】\n${clipTextHead(cont.characters, 1800)}` : '',
      cont.plot ? `【剧情梗概】\n${clipTextHead(cont.plot, 1200)}` : '',
    ].filter(Boolean),
  });

  const recentTail = contRecentTail(cont, flatIdx, 1000);
  const user = joinPromptBlocks(
    !recentTail && cont.sourceTail ? `【原文末尾】\n${clipTextTail(cont.sourceTail, 1200)}` : '',
    recentTail ? `【上一节结尾】\n${recentTail}` : '',
    mode === 'outline' ? `【本章总览】第${actIdx + 1}章 ${act.title || ''}\n${act.overview || '(未填)'}` : '',
    mode === 'outline' ? `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${sec.outline || ''}` : '',
    reinforce
      ? `请重新完整续写第${actIdx + 1}章第${secIdx + 1}节正文（须有实质内容）:`
      : `请续写第${actIdx + 1}章第${secIdx + 1}节正文:`,
  );

  return { system, user };
}

function stopContinuation() {
  contState.cancelRequested = true;
  const th = getTavernHelper();
  try {
    if (th?.stopGenerationById && contState.currentGenId) th.stopGenerationById(contState.currentGenId);
    else if (th?.stopAllGeneration) th.stopAllGeneration();
    else getST()?.stopGeneration?.();
  } catch (e) {
    log.warn('中止续写失败:', e);
  }
  log.info('已请求中止续写');
}

/** 清空所有内容, 开始新项目。 */
function resetAllContent() {
  const s = getSettings();
  s.continuations = [];
  s.activeContinuationId = '';
  analyzeState.uploadedText = '';
  analyzeState.uploadedName = '';
  analyzeState.result = null;
  s.projects = [];
  s.activeProjectId = '';
  saveSettings();
  renderAnalyzeUI();
  renderNovelUI();
  toast('已清空所有内容，可以开始新项目');
  log.info('已清空所有内容');
}

/** skipSummary=true 时跳过触发总结(单节重新生成时使用) */
/** deferLiveProgress=true：不立刻动态大总结，等用户点「确认总结」 */
async function generateContSection(cont, actIdx, secIdx, flatIdx, mode, onProgress, { skipSummary = false, reinforce = false, deferLiveProgress = false } = {}) {
  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];
  if (isSectionLocked(sec)) {
    log.warn(`续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节已锁定，跳过生成`);
    return '';
  }
  // 开始写"某章第一节"时, 先对之前已完成但未总结的章做整章总结(重新生成时跳过)
  if (secIdx === 0 && !skipSummary) await summarizePendingContActs(cont, actIdx, onProgress);

  sec.content = '';
  sec.done = false;
  delete sec.pendingLiveSummary;

  contState.activeFlatIdx = flatIdx;
  contState.activeActIdx = actIdx;
  startGenUiProgress('cont', {
    flatIdx,
    phase: 'gen',
    status: `生成中… 正在续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`,
  });
  renderContinuationChapters();
  paintGenUiProgress();

  let text = '';
  try {
    const maxPasses = 2;
    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        const gap = calcRetryDelayMs(pass - 1, new Error('空回复'));
        onProgress?.(
          `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节空回，${Math.round(gap / 1000)}s 后加强提示重试…`,
          true,
        );
        await waitCancellable(gap, () => contState.cancelRequested);
        resetGenerationChannel('cont', { hard: false });
      }
      const needReinforce = reinforce || pass > 0;
      const { system, user } = buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode, { reinforce: needReinforce });
      onProgress?.(
        pass === 0
          ? `正在续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`
          : `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节空回，正在加强提示后重试…`,
        true,
      );
      const gid = `cont_${Date.now()}_${flatIdx}_p${pass}`;
      contState.currentGenId = gid;
      try {
        text = (await novelGenerateWithId({ system, user }, gid, () => contState.cancelRequested, { minLen: MIN_SECTION_CHARS })).trim();
      } catch (e) {
        if (pass < maxPasses - 1 && /空回复/.test(String(e.message || ''))) {
          log.warn(`续写空回，准备第 ${pass + 2} 轮:`, e.message);
          continue;
        }
        sec.content = '';
        sec.done = false;
        saveContinuation();
        throw e;
      }
      if (!isEmptyReply(text, MIN_SECTION_CHARS)) break;
      log.warn(`续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节结果过短(${text.length}字)，重试…`);
      text = '';
    }

    if (isEmptyReply(text, MIN_SECTION_CHARS)) {
      sec.content = '';
      sec.done = false;
      saveContinuation();
      throw new Error(`续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节生成结果为空，请稍后重新生成`);
    }

    const elapsedMs = finishGenUiProgress();
    sec.content = text;
    sec.done = true;
    sec.updatedAt = Date.now();
    if (deferLiveProgress) {
      markPendingLiveSummary(cont, actIdx, secIdx);
    } else {
      delete sec.pendingLiveSummary;
    }
    saveContinuation();
    onProgress?.(
      deferLiveProgress
        ? `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}，请点击「确认总结」`
        : `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}`,
      false,
    );
    if (deferLiveProgress) {
      await sleep(350);
      stopGenUiProgress();
      contState.activeFlatIdx = -1;
      renderContinuationChapters();
    } else {
      switchGenUiToSummary(
        `生成中… 正在更新剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
      );
      renderContinuationChapters();
      paintGenUiProgress();
      try {
        await updateLiveProgress(cont, actIdx, secIdx, onProgress, {
          saveFn: () => saveContinuation(),
          isCancelled: () => contState.cancelRequested,
        });
        refreshGrandSummary(getContinuation(), `#${EXT_ID}-analyze`);
        finishGenUiProgress();
        await sleep(300);
      } finally {
        stopGenUiProgress();
        contState.activeFlatIdx = -1;
        renderContinuationChapters();
      }
    }
    return text;
  } catch (e) {
    finishGenUiProgress();
    await sleep(250);
    stopGenUiProgress();
    contState.activeFlatIdx = -1;
    renderContinuationChapters();
    throw e;
  }
}

/** 续写：确认动态大总结后自动写下一节。 */
async function confirmLiveSummaryAndContinueCont(cont, actIdx, secIdx) {
  if (!cont || contState.generating) return;
  const sec = cont.acts?.[actIdx]?.sections?.[secIdx];
  if (!sec?.pendingLiveSummary || !hasValidSectionContent(sec)) {
    toast('当前节无需确认总结');
    return;
  }
  collectContActsFromDOM(cont);
  const mode = cont.mode || 'outline';
  const flatIdx =
    flatSections(cont).find((f) => f.actIdx === actIdx && f.secIdx === secIdx)?.flatIdx ?? -1;
  await withContGenerating(async () => {
    contState.activeFlatIdx = flatIdx;
    startGenUiProgress('cont', {
      flatIdx,
      phase: 'summary',
      status: `生成中… 正在更新剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
    });
    renderContinuationChapters();
    paintGenUiProgress();
    try {
      await updateLiveProgress(cont, actIdx, secIdx, setContHint, {
        saveFn: () => saveContinuation(),
        isCancelled: () => contState.cancelRequested,
      });
      if (contState.cancelRequested) {
        setContHint('已中止。');
        return;
      }
      delete sec.pendingLiveSummary;
      saveContinuation();
      refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
      finishGenUiProgress();
      await sleep(300);
    } finally {
      stopGenUiProgress();
      contState.activeFlatIdx = -1;
      renderContinuationChapters();
    }
    if (contState.cancelRequested) return;

    const next = findNextWritableSection(cont, actIdx, secIdx);
    if (!next) {
      await summarizePendingContActs(cont, cont.acts.length, setContHint);
      setContHint(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节总结已确认。没有下一节可写。`);
      return;
    }
    setContHint(`总结已确认，开始续写第 ${next.actIdx + 1} 章 第 ${next.secIdx + 1} 节…`, true);
    await generateContSection(cont, next.actIdx, next.secIdx, next.flatIdx, mode, setContHint, {
      deferLiveProgress: true,
    });
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setContHint(
      `第 ${next.actIdx + 1} 章 第 ${next.secIdx + 1} 节已续写${took}，请点击「确认总结」。`,
    );
  });
  renderAnalyzeUI();
}

/** 续写: 对 beforeActIdx 之前所有已完成且未总结的章补做整章总结。 */
async function summarizePendingContActs(cont, beforeActIdx, onProgress) {
  for (let i = 0; i < beforeActIdx; i++) {
    const a = cont.acts[i];
    if (a && isActComplete(a) && !cont.summaries.some((s) => s.actNo === i + 1)) {
      await maybeSummarizeContAct(cont, i, onProgress);
    }
  }
}

/** 续写: 生成整章表格总结并存档。 */
/** 续写: 生成整章表格总结并存档。force=true 时允许章未写完强制重总结。 */
async function maybeSummarizeContAct(cont, actIdx, onProgress, { force = false } = {}) {
  const actNo = actIdx + 1;
  const act = cont.acts[actIdx];
  if (!act) return;
  if (force) {
    if (!actHasGeneratedContent(act)) return;
    cont.summaries = (cont.summaries || []).filter((s) => s.actNo !== actNo);
  } else {
    if (!isActComplete(act)) return;
    if (cont.summaries.some((s) => s.actNo === actNo)) return;
  }
  try {
    const partial = !isActComplete(act);
    log.info(`开始生成续写第 ${actNo} 章整章表格总结${partial ? '(未完成章·强制)' : ''}…`);
    onProgress?.(
      partial ? `正在强制总结续写第 ${actNo} 章(尚未写完，仅已有正文)…` : `正在为续写第 ${actNo} 章生成整章表格总结…`,
      true,
    );
    const { system, user } = buildActSummaryPrompt(cont, actIdx);
    const raw = (await novelGenerateWithId({ system, user }, `cont_sum_${Date.now()}`, () => contState.cancelRequested)).trim();
    log.debug(`续写第 ${actNo} 章总结原始返回:`, raw.slice(0, 200));
    const parsed = parseSummary(raw);
    if (!parsed.characters.length && !parsed.plot.length) {
      log.warn(`续写第 ${actNo} 章总结解析为空, 原始文本:`, raw.slice(0, 400));
    }
    cont.summaries.push({
      actNo,
      actTitle: cont.acts[actIdx].title || '',
      characters: parsed.characters,
      plot: parsed.plot,
      createdAt: Date.now(),
      partial: partial || undefined,
    });
    saveContinuation();
    renderContSummaries();
    log.info(`已生成续写第 ${actNo} 章表格总结`, { characters: parsed.characters.length, plot: parsed.plot.length, partial });
    onProgress?.(`第 ${actNo} 章表格总结已存档${partial ? '(未完成章)' : ''}`, true);
  } catch (e) {
    log.warn('续写整章总结失败:', e);
  }
}

/** 只刷新续写总结区。 */
function renderContSummaries() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const cont = getContinuation();
  if (!cont) return;
  const $box = $(`#${EXT_ID}-analyze .ns-summaries`);
  if ($box.length) $box.html((cont.summaries || []).map((s) => renderSummaryTable(s, 'ct-sum')).join(''));
  // 同步刷新大总结（保留折叠状态）
  refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
}

async function withContGenerating(fn) {
  contState.generating = true;
  contState.cancelRequested = false;
  syncMiniBallBusy();
  const $ = globalThis.jQuery;
  $?.(`#${EXT_ID}-analyze [data-act="ct-stop"]`).prop('disabled', false);
  try {
    await fn();
  } catch (e) {
    log.error('续写异常:', e);
    const took = genUiProgress.lastElapsedMs ? ` · 已耗时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setContHint(`续写失败: ${e.message}${took}`);
    toast(`续写失败: ${e.message}`);
  } finally {
    contState.generating = false;
    contState.cancelRequested = false;
    contState.currentGenId = '';
    contState.activeActIdx = -1;
    $?.(`#${EXT_ID}-analyze [data-act="ct-stop"]`).prop('disabled', true);
    syncMiniBallBusy();
  }
}

/** 清空续写所有节的正文与完成状态、清空总结, 用于从头重新生成。
 *  自然续写(free)模式下章由生成自动创建, 直接清空 acts。 */
function resetContSections(cont) {
  if ((cont.mode || 'outline') === 'free') {
    cont.acts = [];
    cont.summaries = [];
    cont.liveProgress = null;
    cont.plotChain = [];
  } else {
    for (const act of cont.acts || []) {
      for (const sec of act.sections || []) {
        if (isSectionLocked(sec)) continue; // 跳过锁定节
        sec.content = '';
        sec.done = false;
        sec.updatedAt = 0;
        delete sec.pendingLiveSummary;
      }
      delete act._folded;
    }
    if (!flatSections(cont).some((f) => f.sec.locked)) cont.summaries = [];
  }
  cont.liveProgress = null;
  cont.plotChain = [];
  clearPendingLiveSummary(cont);
  contState.activeActIdx = -1;
  contState.activeFlatIdx = -1;
  saveContinuation();
}

async function runContOutlineManual(cont) {
  if (contState.generating) return;
  collectContActsFromDOM(cont);
  if (!totalSectionCount(cont)) {
    setContHint('请先添加续写大纲(章与节)。');
    return;
  }
  const pending = flatSections(cont).find((f) => f.sec.pendingLiveSummary && hasValidSectionContent(f.sec));
  if (pending) {
    setContHint(`请先点击第 ${pending.actIdx + 1} 章 第 ${pending.secIdx + 1} 节的「确认总结」。`);
    toast('请先确认总结');
    renderContinuationChapters();
    return;
  }
  let flat = flatSections(cont);
  let target = flat.find((f) => !hasValidSectionContent(f.sec));
  if (!target) {
    // 全部完成: 询问是否从头重新生成
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetContSections(cont);
    await resetRuntimeAfterClearContent('cont');
    renderAnalyzeUI();
    flat = flatSections(cont);
    target = flat.find((f) => !hasValidSectionContent(f.sec));
    if (!target) return;
  }
  await withContGenerating(async () => {
    await generateContSection(cont, target.actIdx, target.secIdx, target.flatIdx, 'outline', setContHint, {
      deferLiveProgress: true,
    });
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setContHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已续写${took}，请点击「确认总结」。`);
  });
  renderAnalyzeUI();
}

async function runContOutlineAuto(cont) {
  if (contState.generating) return;
  collectContActsFromDOM(cont);
  if (!totalSectionCount(cont)) {
    setContHint('请先添加续写大纲(章与节)。');
    return;
  }
  // 全部完成: 询问是否从头重新生成
  if (!flatSections(cont).some((f) => !hasValidSectionContent(f.sec))) {
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetContSections(cont);
    await resetRuntimeAfterClearContent('cont');
    renderAnalyzeUI();
  }
  await withContGenerating(async () => {
    while (true) {
      if (contState.cancelRequested) {
        setContHint('已中止。');
        break;
      }
      const flat = flatSections(cont);
      const target = flat.find((f) => !hasValidSectionContent(f.sec));
      if (!target) break;
      await generateContSection(cont, target.actIdx, target.secIdx, target.flatIdx, 'outline', setContHint);
      renderContinuationChapters();
    }
    if (!contState.cancelRequested) {
      await summarizePendingContActs(cont, cont.acts.length, setContHint);
      setContHint('大纲续写全部完成。');
    }
  });
  renderAnalyzeUI();
}

/** 自然续写: 每次新增一大章(内含一节), 逐章自主续写直到达到目标章数。 */
async function runContFree(cont) {
  if (contState.generating) return;
  const target = Math.max(1, cont.targetChapters || 1);
  await withContGenerating(async () => {
    while (cont.acts.length < target) {
      if (contState.cancelRequested) {
        setContHint('已中止。');
        break;
      }
      const act = makeAct(`第 ${cont.acts.length + 1} 章`, '');
      act.sections.push(makeSection(''));
      cont.acts.push(act);
      saveContinuation();
      const flat = flatSections(cont);
      const target2 = flat[flat.length - 1];
      await generateContSection(cont, target2.actIdx, target2.secIdx, target2.flatIdx, 'free', setContHint);
      renderContinuationChapters();
    }
    if (!contState.cancelRequested) {
      await summarizePendingContActs(cont, cont.acts.length, setContHint);
      setContHint(`自然续写完成，共 ${cont.acts.length} 章。`);
    }
  });
  renderAnalyzeUI();
}

/* ================================================================== */
/* GUI: 全屏面板                                                       */
/* ================================================================== */

const PANEL_ID = `${EXT_ID}-panel`;
const OVERLAY_ID = `${EXT_ID}-overlay`;
const MINI_ID = `${EXT_ID}-mini-ball`;
const ENTRY_FLOAT_ID = `${EXT_ID}-float-button`;

/** 面板 UI 状态：最小化圆球位置等。 */
const panelUiState = {
  minimized: false,
  miniPos: null, // { left, top } | null → 用默认右下角
  _miniBound: false,
};

function isPanelBusy() {
  let ideaBusy = false;
  try {
    ideaBusy = !!ideaState.generating;
  } catch (_) {
    /* ideaState 可能尚未初始化 */
  }
  return !!(novelState.generating || contState.generating || analyzeState.running || ideaBusy);
}

function setEntryFloatVisible(visible) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${ENTRY_FLOAT_ID}`).css('display', visible ? 'flex' : 'none');
}

function syncMiniBallBusy() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $ball = $(`#${MINI_ID}`);
  if (!$ball.length) return;
  const busy = isPanelBusy();
  $ball.toggleClass('ns-mini-ball--busy', busy);
  $ball.attr('title', busy ? `${EXT_NAME} · 后台工作中（点击还原）` : `${EXT_NAME}（点击还原，可拖动）`);
}

function clampMiniPos(left, top, size = 52) {
  const maxL = Math.max(0, window.innerWidth - size);
  const maxT = Math.max(0, window.innerHeight - size);
  return {
    left: Math.max(0, Math.min(maxL, left)),
    top: Math.max(0, Math.min(maxT, top)),
  };
}

function ensureMiniBall() {
  const $ = globalThis.jQuery;
  if (!$) return null;
  let $ball = $(`#${MINI_ID}`);
  if ($ball.length) return $ball;

  $ball = $(`
    <div id="${MINI_ID}" class="ns-mini-ball" style="display:none;" title="${EXT_NAME}（点击还原，可拖动）">
      <i class="fa-solid fa-feather-pointed"></i>
      <span class="ns-mini-ball__ring" aria-hidden="true"></span>
    </div>`);
  $('body').append($ball);

  if (!panelUiState._miniBound) {
    panelUiState._miniBound = true;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origL = 0;
    let origT = 0;

    $ball.on('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      moved = false;
      const rect = this.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origL = rect.left;
      origT = rect.top;
      try {
        this.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      e.preventDefault();
    });

    $ball.on('pointermove', function (e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const pos = clampMiniPos(origL + dx, origT + dy);
      $(this).css({ left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto', bottom: 'auto' });
    });

    $ball.on('pointerup pointercancel', function (e) {
      if (!dragging) return;
      dragging = false;
      try {
        this.releasePointerCapture?.(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (!moved) {
        restorePanel();
        return;
      }
      const rect = this.getBoundingClientRect();
      panelUiState.miniPos = clampMiniPos(rect.left, rect.top);
    });
  }
  return $ball;
}

function showMiniBall() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $ball = ensureMiniBall();
  if (!$ball) return;
  let left;
  let top;
  if (panelUiState.miniPos) {
    ({ left, top } = clampMiniPos(panelUiState.miniPos.left, panelUiState.miniPos.top));
  } else {
    left = Math.max(0, window.innerWidth - 70);
    top = Math.max(0, window.innerHeight - 120);
  }
  $ball.css({
    display: 'flex',
    left: `${left}px`,
    top: `${top}px`,
    right: 'auto',
    bottom: 'auto',
  });
  syncMiniBallBusy();
}

function hideMiniBall() {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${MINI_ID}`).css('display', 'none');
}

function minimizePanel() {
  const $ = globalThis.jQuery;
  if (!$) return;
  ensurePanel();
  panelUiState.minimized = true;
  $(`#${OVERLAY_ID}`).css('display', 'none');
  setEntryFloatVisible(false);
  showMiniBall();
  syncMiniBallBusy();
  log.info('面板已最小化（后台继续运行）');
}

function restorePanel() {
  panelUiState.minimized = false;
  hideMiniBall();
  openPanel();
}

function ensurePanel() {
  const $ = globalThis.jQuery;
  if (!$) {
    log.error('jQuery 不可用');
    return null;
  }
  if ($(`#${OVERLAY_ID}`).length) return $(`#${OVERLAY_ID}`);

  const html = `
    <div id="${OVERLAY_ID}" class="ns-overlay" style="display:none;">
      <div id="${PANEL_ID}" class="ns-panel">
        <div class="ns-panel__header">
          <div class="ns-panel__title">
            <i class="fa-solid fa-feather-pointed"></i>
            <span>${EXT_NAME}</span>
          </div>
          <div class="ns-panel__actions">
            <button class="ns-btn ns-btn--icon" id="${EXT_ID}-minimize" title="最小化到圆球（后台继续）"><i class="fa-solid fa-minus"></i></button>
            <button class="ns-btn ns-btn--icon" id="${EXT_ID}-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
        <div class="ns-statusbar" id="${EXT_ID}-statusbar">
          <div class="ns-status-item" title="连接状态"><span class="ns-dot" id="${EXT_ID}-conn-dot"></span><span id="${EXT_ID}-conn-text">未连接</span></div>
          <div class="ns-status-item" title="当前 AI 来源与模型"><i class="fa-solid fa-robot"></i><span id="${EXT_ID}-ai-text">AI: —</span></div>
          <div class="ns-status-item" title="当前预设"><i class="fa-solid fa-sliders"></i><span id="${EXT_ID}-preset-text">预设: —</span></div>
        </div>
        <div class="ns-panel__body">
          <div class="ns-module-wrap">
            <div class="ns-module-head" data-act="module-fold" data-target="${EXT_ID}-analyze-body">
              <i class="fa-solid fa-chevron-right ns-module-icon"></i>
              <span><i class="fa-solid fa-book-open" style="margin-right:6px;"></i>续写小说</span>
            </div>
            <div class="ns-module-body" id="${EXT_ID}-analyze-body" style="display:none;">
              <div class="ns-card" id="${EXT_ID}-analyze"></div>
            </div>
          </div>
          <div class="ns-module-wrap">
            <div class="ns-module-head" data-act="module-fold" data-target="${EXT_ID}-novel-body">
              <i class="fa-solid fa-chevron-right ns-module-icon"></i>
              <span><i class="fa-solid fa-feather-pointed" style="margin-right:6px;"></i>写新小说</span>
            </div>
            <div class="ns-module-body" id="${EXT_ID}-novel-body" style="display:none;">
              <div class="ns-card" id="${EXT_ID}-novel"></div>
            </div>
          </div>
          <div class="ns-card">
            <div class="ns-card__head">
              <h4>全局关键字</h4>
              <label class="ns-switch" title="启用后作为系统引导词注入每次生成">
                <input type="checkbox" id="${EXT_ID}-kw-enabled" /><span>启用注入</span>
              </label>
            </div>
            <p class="ns-muted">作为所有 AI 生成内容的引导词, 以系统角色注入每次生成。</p>
            <textarea id="${EXT_ID}-kw-text" class="ns-textarea" rows="3" placeholder="例如: 保持第三人称叙述, 文风冷峻…"></textarea>
            <div class="ns-row"><button class="ns-btn" id="${EXT_ID}-kw-save">保存</button><span class="ns-muted" id="${EXT_ID}-kw-hint"></span></div>
          </div>
          <div class="ns-card" id="${EXT_ID}-idea"></div>
        </div>
        <div class="ns-panel__footer"><span class="ns-muted">${EXT_NAME} v2.3.0</span></div>
      </div>
    </div>`;
  $('body').append(html);
  const $overlay = $(`#${OVERLAY_ID}`);

  // 点击遮罩不再关闭，避免误触回到主界面；仅点关闭按钮退出
  $(`#${EXT_ID}-minimize`).on('click', minimizePanel);
  $(`#${EXT_ID}-close`).on('click', closePanel);
  $(`#${EXT_ID}-kw-save`).on('click', () => {
    const s = getSettings();
    s.globalKeyword = String($(`#${EXT_ID}-kw-text`).val() ?? '');
    s.keywordEnabled = $(`#${EXT_ID}-kw-enabled`).is(':checked');
    saveSettings();
    refreshGlobalKeyword();
    $(`#${EXT_ID}-kw-hint`).text(`已保存 · ${s.keywordEnabled ? '已启用' : '已关闭'} · ${new Date().toLocaleTimeString()}`);
    toast('全局关键字已保存');
  });
  $(`#${EXT_ID}-kw-enabled`).on('change', () => {
    getSettings().keywordEnabled = $(`#${EXT_ID}-kw-enabled`).is(':checked');
    saveSettings();
    refreshGlobalKeyword();
  });

  // 主模块折叠/展开（仅手动；状态写入 uiFoldState，重开面板时恢复）
  $overlay.on('click', '[data-act="module-fold"]', function () {
    const targetId = $(this).data('target');
    const $body = $(`#${targetId}`);
    const $icon = $(this).find('.ns-module-icon');
    const isHidden = $body.is(':hidden');
    $body.toggle();
    $icon.toggleClass('ns-module-icon--open', isHidden);
    const modKey =
      targetId === `${EXT_ID}-analyze-body` ? 'analyze' : targetId === `${EXT_ID}-novel-body` ? 'novel' : '';
    if (modKey) uiFoldState.modules[modKey] = isHidden;
  });

  log.info('面板 DOM 已创建');
  return $overlay;
}

function refreshStatus() {
  refreshStatusBar();
}

function refreshStatusBar() {
  const $ = globalThis.jQuery;
  if (!$ || !$(`#${OVERLAY_ID}`).length) return;
  const s = readStatus();
  const $dot = $(`#${EXT_ID}-conn-dot`);
  $dot.removeClass('ns-dot--on ns-dot--off').addClass(s.connected ? 'ns-dot--on' : 'ns-dot--off');
  $(`#${EXT_ID}-conn-text`).text(s.connected ? '已连接' : '未连接');
  let aiText = `AI: ${s.source || '—'}`;
  if (s.model) aiText += ` / ${s.model}`;
  $(`#${EXT_ID}-ai-text`).text(aiText).attr('title', aiText);
  const presetText = `预设: ${s.preset || '—'}`;
  $(`#${EXT_ID}-preset-text`).text(presetText).attr('title', presetText);
}

function toast(msg) {
  try {
    if (globalThis.toastr?.info) {
      globalThis.toastr.info(msg, EXT_NAME);
      return;
    }
  } catch (e) {
    /* ignore */
  }
  log.info('toast:', msg);
}

function fillKeywordForm() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const s = getSettings();
  $(`#${EXT_ID}-kw-text`).val(s.globalKeyword || '');
  $(`#${EXT_ID}-kw-enabled`).prop('checked', !!s.keywordEnabled);
  $(`#${EXT_ID}-kw-hint`).text('');
}

/** 按 uiFoldState 恢复主模块折叠（不改动任何子项状态）。 */
function applyModuleFoldState() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const pairs = [
    [`${EXT_ID}-analyze-body`, 'analyze'],
    [`${EXT_ID}-novel-body`, 'novel'],
  ];
  for (const [id, key] of pairs) {
    const open = !!uiFoldState.modules[key];
    $(`#${id}`).css('display', open ? '' : 'none');
    $(`[data-act="module-fold"][data-target="${id}"] .ns-module-icon`).toggleClass('ns-module-icon--open', open);
  }
}

function openPanel() {
  const $overlay = ensurePanel();
  if (!$overlay) return;
  panelUiState.minimized = false;
  hideMiniBall();
  setEntryFloatVisible(false);
  refreshStatus();
  fillKeywordForm();
  // 节拖拽排序 — 必须先绑再 render，render 末尾会调 attach 绑定节
  _novelDragAttach = bindSectionDrag(
    `#${EXT_ID}-novel`,
    (ai) => { const proj = getActiveProject(); return proj?.acts[ai]?.sections; },
    () => { const proj = getActiveProject(); if (proj) touchProject(proj); },
    () => renderNovelChapters(),
  );
  _contDragAttach = bindSectionDrag(
    `#${EXT_ID}-analyze`,
    (ai) => { const cont = getContinuation(); return cont?.acts[ai]?.sections; },
    () => saveContinuation(),
    () => renderContinuationChapters(),
  );
  bindAnalyzeEvents();
  renderAnalyzeUI();    // renderAnalyzeUI 末尾调 _contDragAttach() 绑节
  bindNovelEvents();
  renderNovelUI();      // renderNovelUI 末尾调 _novelDragAttach() 绑节
  bindIdeaEvents();
  renderIdeaUI();
  applyModuleFoldState(); // 恢复用户上次的主模块折叠，首次均为折叠
  $overlay.css('display', 'flex');
  log.info('面板已打开');
}

function closePanel() {
  const $ = globalThis.jQuery;
  if (!$) return;
  panelUiState.minimized = false;
  hideMiniBall();
  $(`#${OVERLAY_ID}`).css('display', 'none');
  setEntryFloatVisible(true);
  log.info('面板已关闭');
}

/** 章节全文查看弹窗。 */
function showViewer(title, content) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const ID = `${EXT_ID}-viewer`;
  $(`#${ID}`).remove();
  const $v = $(`
    <div id="${ID}" class="ns-viewer">
      <div class="ns-viewer__box">
        <div class="ns-viewer__head"><strong>${esc(title)}</strong>
          <span class="ns-muted" style="margin-left:auto; margin-right:12px;">共 ${String(content || '').length} 字</span>
          <button class="ns-btn ns-btn--icon" data-close="1"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="ns-viewer__body">${esc(content).replace(/\n/g, '<br>')}</div>
      </div>
    </div>`);
  $v.on('click', (e) => {
    if (e.target.id === ID || $(e.target).closest('[data-close]').length) $v.remove();
  });
  $('body').append($v);
}
function showSectionViewer(ai, si, content) {
  showViewer(`第 ${ai + 1} 章 第 ${si + 1} 节 全文`, content);
}

/* ---------------------------- 续写: 上传分析 UI ---------------------------- */

function renderAnalyzeUI() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-analyze`);
  if (!$root.length) return;
  const s = getSettings();
  const conts = getContinuations();
  const activeCont = getContinuation();
  const contOptions = conts
    .map((c) => `<option value="${esc(c.id)}" ${activeCont && c.id === activeCont.id ? 'selected' : ''}>${esc(c.title)}</option>`)
    .join('');

  $root.html(`
    <div class="ns-card__head">
      <h4>续写小说 · 上传分析</h4>
      <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="az-reset" title="清空续写与所有写作项目, 开始新项目">
        <i class="fa-solid fa-arrows-rotate"></i> 清空所有内容，开始新项目
      </button>
    </div>
    <div class="ns-row" style="margin-bottom:10px;">
      <select id="${EXT_ID}-cont-select" class="ns-select">${contOptions || '<option value="">（无会话）</option>'}</select>
      <button class="ns-btn ns-btn--sm" data-act="cont-new">新建续写</button>
      ${activeCont ? `<button class="ns-btn ns-btn--sm ns-btn--danger" data-act="cont-del">删除当前</button>` : ''}
    </div>
    <div class="ns-field">
      <label>小说标题</label>
      <input type="text" id="${EXT_ID}-az-title" class="ns-outline-input" placeholder="导入的小说" />
    </div>
    <div class="ns-field">
      <label>上传小说</label>
      <div class="ns-row">
        <button class="ns-btn" data-act="az-pick"><i class="fa-solid fa-file-arrow-up"></i> 点击上传 txt 文档</button>
        <span class="ns-muted" id="${EXT_ID}-az-fileinfo">${
          analyzeState.uploadedText ? `已上传：${esc(analyzeState.uploadedName)}（${analyzeState.uploadedText.length} 字）` : '尚未上传'
        }</span>
      </div>
      <input type="file" id="${EXT_ID}-az-file" accept=".txt,text/plain" style="display:none;" />
    </div>
    <div class="ns-field">
      <div class="ns-row">
        <label class="ns-muted">每段字数<input type="number" id="${EXT_ID}-az-chunk" class="ns-num" value="${s.analyzeChunkSize || 6000}" min="1000" step="500" /></label>
        <label class="ns-muted">并发<input type="number" id="${EXT_ID}-az-conc" class="ns-num" value="${s.analyzeConcurrency || 1}" min="1" max="10" /></label>
        <button class="ns-btn" data-act="az-start">开始分析</button>
        <button class="ns-btn ns-btn--danger" data-act="az-stop" ${analyzeState.running ? '' : 'disabled'}>中止</button>
      </div>
    </div>
    <div class="ns-field" id="${EXT_ID}-az-progress-wrap" style="display:none;">
      <div class="ns-progress"><div class="ns-progress__bar" id="${EXT_ID}-az-bar" style="width:0%"></div></div>
      <div class="ns-muted" id="${EXT_ID}-az-hint"></div>
    </div>
    <div class="ns-field" id="${EXT_ID}-az-result">${renderAnalyzeResult()}</div>
  `);
  _contDragAttach?.(); // 整块重绘后重新绑定拖拽
}

function renderAnalyzeResult() {
  const cont = getContinuation();
  const r = analyzeState.result || cont;
  if (!r) return '';
  const when = new Date(r.analyzedAt).toLocaleString();
  return `
    <div class="ns-result">
      <div class="ns-result__meta ns-muted">分析结果 · ${esc(r.title)} · ${r.totalChars || 0} 字 · ${esc(when)}</div>
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="az-toggle" data-fold-key="ct-chars"><i class="fa-solid fa-chevron-right ${foldIconClass('ct-chars')}"></i><strong>角色档案</strong></div>
        <div class="ns-collapse__body"${foldBodyStyle('ct-chars')}>${esc(r.characters).replace(/\n/g, '<br>') || '（空）'}</div>
      </div>
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="az-toggle" data-fold-key="ct-plot"><i class="fa-solid fa-chevron-right ${foldIconClass('ct-plot')}"></i><strong>剧情梗概</strong></div>
        <div class="ns-collapse__body"${foldBodyStyle('ct-plot')}>${esc(r.plot).replace(/\n/g, '<br>') || '（空）'}</div>
      </div>
    </div>
    ${renderContinuationUI()}
  `;
}

/** 生成续写章节列表 HTML(正在生成的章节内嵌进度动画)。 */
/** 续写章-节列表 HTML(仅按大纲模式可编辑章节结构; 自然模式只读)。 */
function contChapterListHtml(cont) {
  const mode = cont.mode || 'outline';
  const flat = flatSections(cont);
  const flatByAS = {};
  flat.forEach((f) => (flatByAS[`${f.actIdx}_${f.secIdx}`] = f.flatIdx));
  const genThis = resolveGenThisTarget(cont);
  let genThisShown = false;

  return (cont.acts || [])
    .map((act, ai) => {
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const working = isSectionWorking('cont', flatIdx) || contState.activeFlatIdx === flatIdx;
          const summarizing = working && genUiProgress.phase === 'summary';
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = working ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          const pendingSum = !!sec.pendingLiveSummary && valid;
          // 全书只渲染一次；生成中且非本节工作时隐藏，避免相邻空节同时出现按钮
          const showGenThis =
            !genThisShown &&
            !!genThis &&
            genThis.flatIdx === flatIdx &&
            !pendingSum &&
            !(contState.generating && !working);
          if (showGenThis) genThisShown = true;
          const tag = working
            ? `<span class="ns-tag ns-tag--gen">${summarizing ? '总结中' : '生成中'}</span>`
            : pendingSum
              ? `<span class="ns-tag ns-tag--pending">待确认总结</span>`
              : valid
                ? `<span class="ns-tag ns-tag--done">已生成</span>`
                : sec.done
                  ? `<span class="ns-tag">空回·待重生</span>`
                  : `<span class="ns-tag">未生成</span>`;
          const outlineField =
            mode === 'outline'
              ? `<textarea class="ns-ct-sec-outline" data-a="${ai}" data-s="${si}" rows="1" placeholder="本节大纲…">${esc(sec.outline || '')}</textarea>`
              : `<span class="ns-chapter__outline">${esc(sec.outline || '')}</span>`;
          const locked = isSectionLocked(sec);
          const dragHandle = mode === 'outline' && !locked ? `<span class="ns-drag-handle" title="拖拽排序"><i class="fa-solid fa-grip-lines"></i></span>` : (locked ? '<span class="ns-lock-icon" title="已锁定"><i class="fa-solid fa-lock"></i></span>' : '');
          return `
            <div class="ns-section ${working ? 'ns-chapter--gen' : ''} ${pendingSum ? 'ns-section--pending-sum' : ''} ${locked ? 'ns-sec-locked' : ''}" data-a="${ai}" data-s="${si}">
              <div class="ns-chapter__head">
                ${dragHandle}
                <strong>第 ${si + 1} 节</strong>${tag}${outlineField}
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${pendingSum ? `<button class="ns-btn ns-btn--sm ns-btn--confirm-sum" data-act="ct-confirm-live-sum" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''} title="确认后更新动态大总结，并自动续写下一节">确认总结</button>` : ''}
                ${!locked && valid && !showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${!locked && showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>生成本节</button>` : ''}
                ${working ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-stop">中止</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  <button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${locked ? 'ct-sec-unlock' : 'ct-sec-lock'}" data-a="${ai}" data-s="${si}" title="${locked ? '解锁本节及之后所有节' : '锁定本节及之前所有节'}"><i class="fa-solid fa-${locked ? 'lock-open' : 'lock'}"></i></button>
                  ${!locked && sec.content ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--ghost" data-act="ct-sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文"><i class="fa-solid fa-broom"></i></button>` : ''}
                  ${!locked ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-sec-del" data-a="${ai}" data-s="${si}" title="删除本节"><i class="fa-solid fa-trash"></i></button>` : ''}
                </span>
              </div>
            </div>`;
        })
        .join('');

      const actEditable =
        mode === 'outline'
          ? `<input type="text" class="ns-ct-act-title" data-a="${ai}" value="${esc(act.title || '')}" placeholder="章标题" />
             <button class="ns-btn ns-btn--icon ns-btn--sm" data-act="ct-act-del" data-a="${ai}" title="删除本章"><i class="fa-solid fa-trash"></i></button>`
          : `<span class="ns-chapter__outline">${esc(act.title || '')}</span>`;
      const overviewField =
        mode === 'outline'
          ? `<textarea class="ns-textarea ns-ct-act-overview" data-a="${ai}" rows="2" placeholder="章总览：本章走向（生成节时预读）">${esc(act.overview || '')}</textarea>`
          : act.overview
            ? `<div class="ns-muted">章总览：${esc(act.overview)}</div>`
            : '';
      const addSecBtn = mode === 'outline' ? `<div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="ct-sec-add" data-a="${ai}"><i class="fa-solid fa-plus"></i> 添加节</button></div>` : '';
      const folded = isActFolded(act);
      return `
        <div class="ns-act ${folded ? 'ns-act--folded' : ''}" data-a="${ai}">
          <div class="ns-act__head">
            <button class="ns-btn ns-btn--icon ns-btn--sm ns-act-fold" data-act="ct-act-fold" data-a="${ai}" title="折叠/展开本章"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'} ns-act-fold__icon"></i></button>
            <strong>第 ${ai + 1} 章</strong>${actEditable}
            <span class="ns-tag ${isActComplete(act) ? 'ns-tag--done' : ''}">${(act.sections || []).filter((s) => hasValidSectionContent(s)).length}/${(act.sections || []).length} 节</span>
          </div>
          <div class="ns-act__body" ${folded ? 'style="display:none;"' : ''}>
            ${overviewField}
            <div class="ns-sections">${secHtml || '<p class="ns-muted">本章暂无节。</p>'}</div>
            ${addSecBtn}
          </div>
        </div>`;
    })
    .join('');
}

function renderContinuationChapters() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const cont = getContinuation();
  if (!cont) return;
  const $list = $(`#${EXT_ID}-analyze .ns-chapters`);
  if ($list.length) {
    $list.html(contChapterListHtml(cont));
    _contDragAttach?.(); // 重绘后重新绑定拖拽
  }
}

/** 从 DOM 收集续写章-节结构(仅大纲模式有可编辑字段)。 */
function collectContActsFromDOM(cont) {
  const $ = globalThis.jQuery;
  if (!$ || (cont.mode || 'outline') !== 'outline') return;
  $(`#${EXT_ID}-analyze .ns-act`).each(function (ai) {
    const act = cont.acts[ai];
    if (!act) return;
    const t = $(this).find('.ns-ct-act-title').val();
    if (t != null) act.title = String(t);
    const ov = $(this).find('.ns-ct-act-overview').val();
    if (ov != null) act.overview = String(ov);
    $(this)
      .find('.ns-section')
      .each(function (si) {
        const sec = act.sections[si];
        const o = $(this).find('.ns-ct-sec-outline').val();
        if (sec && o != null) sec.outline = String(o);
      });
  });
  saveContinuation();
}

function renderContinuationUI() {
  const cont = getContinuation();
  if (!cont) return '';
  const mode = cont.mode || 'outline';
  const doneSec = contDoneCount(cont);
  const chapterList = contChapterListHtml(cont);

  // 操作按钮(放在模块下方, 编辑完再点)
  const outlineActions = `
    <div class="ns-row">
      <button class="ns-btn ns-btn--sm" data-act="ct-save-acts">保存大纲</button>
      <button class="ns-btn" data-act="ct-outline-manual" title="逐节续写：写完后需点「确认总结」，再自动续写下一节">手动续写（逐节确认）</button>
      <button class="ns-btn" data-act="ct-outline-auto">自动续写（全部）</button>
      ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-outline-regen">全部重新生成</button>` : ''}
      <button class="ns-btn ns-btn--danger" data-act="ct-clear" ${doneSec > 0 ? '' : 'disabled'} title="清除目前所有生成内容">清除生成内容</button>
    </div>`;

  const freeActions = `
    <div class="ns-row">
      <label class="ns-muted">续写章数<input type="number" id="${EXT_ID}-ct-target" class="ns-num" value="${cont.targetChapters || 5}" min="1" max="200" /></label>
      <button class="ns-btn" data-act="ct-free-start">开始自然续写</button>
      ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-free-regen">全部重新生成</button>` : ''}
      <button class="ns-btn ns-btn--danger" data-act="ct-clear" ${doneSec > 0 ? '' : 'disabled'} title="清除目前所有生成内容">清除生成内容</button>
    </div>
    <p class="ns-muted">AI 将根据原文走向与人物剧情，自主逐章续写（每章一节），直到达到设定章数。</p>`;

  const summaryList = (cont.summaries || []).length
    ? cont.summaries.map((s) => renderSummaryTable(s, 'ct-sum')).join('')
    : '';

  return `
    <div class="ns-cont">
      <div class="ns-card__head">
        <h4>开始续写</h4>
        <div class="ns-tabs">
          <button class="ns-tab ${mode === 'outline' ? 'ns-tab--active' : ''}" data-act="ct-mode" data-mode="outline">按大纲续写</button>
          <button class="ns-tab ${mode === 'free' ? 'ns-tab--active' : ''}" data-act="ct-mode" data-mode="free">自然续写</button>
        </div>
      </div>
      <div class="ns-field">
        <div class="ns-card__head">
          <label>续写章节（章 - 节，已完成 ${doneSec} 节）</label>
          <span class="ns-muted" id="${EXT_ID}-ct-hint"></span>
        </div>
        <div class="ns-row">
          <button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-export" ${doneSec ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 导出续写(txt)</button>
        </div>
        <div class="ns-chapters">${chapterList || '<p class="ns-muted">尚无续写内容。按大纲续写请点下方「添加章」。</p>'}</div>
        ${mode === 'outline' ? `<div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="ct-act-add"><i class="fa-solid fa-plus"></i> 添加章</button></div>` : ''}
      </div>
      <div class="ns-field">${mode === 'outline' ? outlineActions : freeActions}</div>
      ${doneSec > 0 || summaryList ? `
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="ct-summaries">
          <i class="fa-solid fa-chevron-right ${foldIconClass('ct-summaries')}"></i>
          <strong>整章表格总结（记忆）</strong>
        </div>
        <div class="ns-row" style="padding:4px 10px 0;flex-wrap:wrap;gap:6px;">
          <button class="ns-btn ns-btn--sm" data-act="ct-resum" ${contState.generating ? 'disabled' : ''} title="仅重新生成各章表格总结，不动大总结">全部重新总结</button>
          <button class="ns-btn ns-btn--sm" data-act="ct-redyn" ${contState.generating ? 'disabled' : ''} title="仅按正文分段重建剧情链与人物链，不动章总结">重新动态总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-clear-sum" title="清空章节总结与动态大总结">清空总结</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--summary"${foldBodyStyle('ct-summaries')}>
          ${grandSummaryHtml(cont, 'ct-grand')}
          <div class="ns-summaries">${summaryList}</div>
        </div>
      </div>` : ''}
    </div>`;
}

function setContHint(msg, busy) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const text = (busy ? '生成中… ' : '') + (msg || '');
  if (busy && (genUiProgress.channel === 'cont' || $(`#${EXT_ID}-analyze .ns-chapter__gen`).length)) {
    setGenSectionStatus(text.trim() || '生成中…');
    $(`#${EXT_ID}-ct-hint`).text('');
    return;
  }
  $(`#${EXT_ID}-ct-hint`).text(text);
}

/** 导出续写内容为 txt(章-节)。 */
function exportContinuation(cont) {
  const lines = [`《${cont.title || '续写'}》续写`, ''];
  (cont.acts || []).forEach((act, ai) => {
    lines.push(`第 ${ai + 1} 章 ${act.title || ''}`.trim());
    if (act.overview) lines.push(`（章总览：${act.overview}）`);
    lines.push('');
    (act.sections || []).forEach((sec, si) => {
      if (sec.content) {
        lines.push(`— 第 ${si + 1} 节 —`, '', sec.content, '');
      }
    });
    lines.push('');
  });
  downloadText(`${safeFileName(cont.title || '续写')}_续写.txt`, lines.join('\n'));
}

function bindAnalyzeEvents() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-analyze`);
  if (!$root.length || $root.data('bound')) return;
  $root.data('bound', true);

  // 续写会话下拉切换
  $root.on('change', `#${EXT_ID}-cont-select`, function () {
    getSettings().activeContinuationId = $(this).val();
    contState.activeActIdx = -1;
    analyzeState.result = null;
    saveSettings();
    renderAnalyzeUI();
  });

  $root.on('click', `[data-act="az-pick"]`, () => $(`#${EXT_ID}-az-file`).trigger('click'));

  $root.on('change', `#${EXT_ID}-az-file`, function () {
    const file = this.files && this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      analyzeState.uploadedText = content;
      analyzeState.uploadedName = file.name;
      $(`#${EXT_ID}-az-fileinfo`).text(`已上传：${file.name}（${content.length} 字）`);
      if (!$(`#${EXT_ID}-az-title`).val()) $(`#${EXT_ID}-az-title`).val(file.name.replace(/\.txt$/i, ''));
      log.info('已读取文件:', file.name, content.length, '字');
    };
    reader.onerror = () => toast('文件读取失败');
    reader.readAsText(file, 'utf-8');
    this.value = '';
  });

  $root.on('change', `#${EXT_ID}-az-chunk`, function () {
    getSettings().analyzeChunkSize = Math.max(1000, Number($(this).val()) || 6000);
    saveSettings();
  });
  $root.on('change', `#${EXT_ID}-az-conc`, function () {
    getSettings().analyzeConcurrency = Math.max(1, Math.min(10, Number($(this).val()) || 1));
    saveSettings();
  });

  $root.on('click', '[data-act]', async function () {
    const act = $(this).data('act');
    const idx = Number($(this).data('idx'));

    if (act === 'az-stop') return void stopAnalyze();
    if (act === 'az-start') {
      if (analyzeState.running) return;
      const text = String(analyzeState.uploadedText || '').trim();
      const title = String($(`#${EXT_ID}-az-title`).val() || '').trim();
      if (!text) return void toast('请先点击上传 txt 文档');
      $(`#${EXT_ID}-analyze [data-act="az-stop"]`).prop('disabled', false);
      try {
        const result = await runAnalysis({ text, title }, setAnalyzeProgress);
        if (result) {
          toast('分析完成');
          $(`#${EXT_ID}-az-result`).html(renderAnalyzeResult());
        }
      } catch (e) {
        log.error('分析失败:', e);
        setAnalyzeProgress(`分析失败: ${e.message}`);
        toast(`分析失败: ${e.message}`);
      } finally {
        $(`#${EXT_ID}-analyze [data-act="az-stop"]`).prop('disabled', true);
      }
      return;
    }
    if (act === 'az-toggle' || act === 'summary-toggle') {
      const $head = $(this);
      const $body = $head.parent().find('.ns-collapse__body').first();
      const isHidden = $body.is(':hidden');
      $body.toggle();
      $head.find('.ns-collapse__icon').toggleClass('ns-collapse__icon--open', isHidden);
      const foldKey = $head.data('fold-key');
      if (foldKey) setUiOpen(String(foldKey), isHidden);
      return;
    }
    if (act === 'az-reset') {
      if (analyzeState.running || contState.generating) return void toast('请先等待或中止当前生成');
      if (!globalThis.confirm?.('将清空续写内容、上传分析结果以及所有写新小说项目，开始新项目。此操作不可撤销，确定继续？')) return;
      resetAllContent();
      return;
    }
    if (act === 'cont-new') {
      const title = globalThis.prompt?.('续写会话标题', '新的续写会话');
      if (title !== null) {
        createContinuation(title || '');
        contState.activeActIdx = -1;
        analyzeState.result = null;
        renderAnalyzeUI();
      }
      return;
    }
    if (act === 'cont-del') {
      const c0 = getContinuation();
      if (c0 && globalThis.confirm?.(`确定删除续写会话《${c0.title}》？此操作不可撤销。`)) {
        deleteContinuation(c0.id);
        contState.activeActIdx = -1;
        analyzeState.result = null;
        renderAnalyzeUI();
      }
      return;
    }

    // 续写相关
    const cont = getContinuation();
    switch (act) {
      case 'ct-mode':
        if (cont) {
          cont.mode = $(this).data('mode') === 'free' ? 'free' : 'outline';
          contState.activeActIdx = -1;
          saveContinuation();
          renderAnalyzeUI();
        }
        return;
      case 'ct-act-fold': {
        const ai = Number($(this).data('a'));
        const $act = $(this).closest('.ns-act');
        const $body = $act.find('.ns-act__body').first();
        const isHidden = $body.is(':hidden');
        $body.toggle();
        $act.toggleClass('ns-act--folded', !isHidden);
        $(this).find('.ns-act-fold__icon').removeClass('fa-chevron-right fa-chevron-down').addClass(isHidden ? 'fa-chevron-down' : 'fa-chevron-right');
        if (cont && cont.acts[ai]) {
          cont.acts[ai]._folded = !isHidden;
          saveContinuation();
        }
        return;
      }
      case 'ct-act-add':
        if (cont) {
          collectContActsFromDOM(cont);
          const act = makeAct('', '');
          act.sections.push(makeSection(''));
          cont.acts.push(act);
          saveContinuation();
          renderAnalyzeUI();
        }
        return;
      case 'ct-act-del':
        if (cont) {
          const ai = Number($(this).data('a'));
          if (Number.isInteger(ai) && globalThis.confirm?.(`确定删除续写第 ${ai + 1} 章及其所有节？`)) {
            collectContActsFromDOM(cont);
            cont.acts.splice(ai, 1);
            saveContinuation();
            renderAnalyzeUI();
          }
        }
        return;
      case 'ct-sec-add':
        if (cont) {
          const ai = Number($(this).data('a'));
          if (Number.isInteger(ai) && cont.acts[ai]) {
            collectContActsFromDOM(cont);
            cont.acts[ai].sections.push(makeSection(''));
            saveContinuation();
            renderContinuationChapters();
          }
        }
        return;
      case 'ct-sec-lock':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          lockUpToSection(cont, ai, si);
          saveContinuation();
          renderContinuationChapters();
          toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前所有内容`);
        }
        return;
      case 'ct-sec-unlock':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          unlockFromSection(cont, ai, si);
          saveContinuation();
          renderContinuationChapters();
          toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后所有内容`);
        }
        return;
      case 'ct-sec-del':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && cont.acts[ai]) {
            const sec = cont.acts[ai].sections[si];
            if (sec?.content && !globalThis.confirm?.(`确定删除第 ${ai + 1} 章 第 ${si + 1} 节？（该节已有正文）`)) return;
            collectContActsFromDOM(cont);
            cont.acts[ai].sections.splice(si, 1);
            saveContinuation();
            renderContinuationChapters();
          }
        }
        return;
      case 'ct-sec-clear':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          const sec = cont.acts[ai]?.sections[si];
          if (sec && globalThis.confirm?.(`确定清空第 ${ai + 1} 章 第 ${si + 1} 节的正文？（节大纲保留）`)) {
            collectContActsFromDOM(cont);
            sec.content = '';
            sec.done = false;
            sec.updatedAt = 0;
            delete sec.pendingLiveSummary;
            saveContinuation();
            renderContinuationChapters();
          }
        }
        return;
      case 'ct-save-acts':
        if (cont) {
          collectContActsFromDOM(cont);
          setContHint('续写大纲(章-节)已保存。');
          renderAnalyzeUI();
        }
        return;
      case 'ct-outline-manual':
        if (cont) await runContOutlineManual(cont);
        return;
      case 'ct-outline-auto':
        if (cont) await runContOutlineAuto(cont);
        return;
      case 'ct-outline-regen':
        if (cont) {
          if (contState.generating) return;
          if (!globalThis.confirm?.('将清空所有已生成的续写正文并按当前大纲重新生成，确定继续？')) return;
          collectContActsFromDOM(cont);
          for (const act of cont.acts) for (const sec of act.sections) {
            sec.content = '';
            sec.done = false;
          }
          cont.summaries = [];
          cont.liveProgress = null;
          saveContinuation();
          renderAnalyzeUI();
          await runContOutlineAuto(cont);
        }
        return;
      case 'ct-free-start':
        if (cont) {
          cont.targetChapters = Math.max(1, Number($(`#${EXT_ID}-ct-target`).val()) || 5);
          saveContinuation();
          await runContFree(cont);
        }
        return;
      case 'ct-free-regen':
        if (cont) {
          if (contState.generating) return;
          if (!globalThis.confirm?.('将删除现有自然续写章节并重新生成，确定继续？')) return;
          cont.targetChapters = Math.max(1, Number($(`#${EXT_ID}-ct-target`).val()) || 5);
          cont.acts = [];
          cont.summaries = [];
          cont.liveProgress = null;
          saveContinuation();
          renderAnalyzeUI();
          await runContFree(cont);
        }
        return;
      case 'ct-stop':
        return void stopContinuation();
      case 'ct-clear':
        if (cont) {
          if (contState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('确定清除目前所有生成内容？（大纲保留，仅清空已生成正文与总结）')) return;
          resetContSections(cont);
          await resetRuntimeAfterClearContent('cont');
          setContHint('已清除所有生成内容。');
          renderAnalyzeUI();
          toast('已清除生成内容');
        }
        return;
      case 'ct-gen-sec':
        if (cont && !contState.generating) {
          const ai = Number($(this).attr('data-a'));
          const si = Number($(this).attr('data-s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && cont.acts[ai]?.sections[si]) {
            collectContActsFromDOM(cont);
            const secToRegen = cont.acts[ai].sections[si];
            // 区分首写/清后重生 vs 重新生成：后者才 stopAll + 空回加强，避免误伤下一次请求
            const isRegen = hasValidSectionContent(secToRegen) || !!secToRegen.done;
            secToRegen.done = false;
            secToRegen.content = '';
            delete secToRegen.pendingLiveSummary;
            saveContinuation();
            const flat = flatSections(cont);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            resetGenerationChannel('cont', { hard: isRegen });
            await sleep(isRegen ? 500 : 80);
            await withContGenerating(async () => {
              await generateContSection(cont, ai, si, f ? f.flatIdx : -1, cont.mode || 'outline', setContHint, {
                skipSummary: isRegen,
                reinforce: isRegen,
                deferLiveProgress: true,
              });
              setContHint(
                `第 ${ai + 1} 章 第 ${si + 1} 节已${isRegen ? '重新' : ''}生成` +
                  (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                  '，请点击「确认总结」。',
              );
            });
            renderAnalyzeUI();
          }
        }
        return;
      case 'ct-confirm-live-sum': {
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si)) {
            await confirmLiveSummaryAndContinueCont(cont, ai, si);
          }
        }
        return;
      }
      case 'ct-view-sec': {
        const ai = Number($(this).data('a'));
        const si = Number($(this).data('s'));
        if (cont && cont.acts[ai]?.sections[si]) showSectionViewer(ai, si, cont.acts[ai].sections[si].content || '');
        return;
      }
      case 'ct-copy-sec': {
        const ai = Number($(this).data('a'));
        const si = Number($(this).data('s'));
        if (cont && cont.acts[ai]?.sections[si]) await copyToClipboard(cont.acts[ai].sections[si].content || '');
        return;
      }
      case 'ct-export':
        if (cont) exportContinuation(cont);
        return;
      case 'ct-resum':
        if (cont) {
          if (contState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将重新生成各章表格总结（不影响大总结的剧情链/人物链）。确定继续？')) return;
          await withContGenerating(async () => {
            await regenAllContSummaries(cont, setContHint);
            setContHint('各章表格总结已重新生成。');
          });
          renderAnalyzeUI();
        }
        return;
      case 'ct-redyn':
        if (cont) {
          if (contState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将按正文分段重建大总结（剧情链 + 人物链），不重新生成章总结。确定继续？')) return;
          await withContGenerating(async () => {
            await regenDynamicSummaryCont(cont, setContHint);
            setContHint('动态大总结已重建。');
          });
          renderAnalyzeUI();
        }
        return;
      case 'ct-clear-sum':
        if (cont) {
          if (!globalThis.confirm?.('确定清空所有章节总结与大总结？（已生成的正文不受影响）')) return;
          cont.summaries = [];
          cont.plotChain = [];
          cont.liveProgress = null;
          clearPendingLiveSummary(cont);
          saveContinuation();
          renderAnalyzeUI();
          toast('已清空章节总结与大总结');
        }
        return;
      default:
        return;
    }
  });
}

function setAnalyzeProgress(msg, pct) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-az-progress-wrap`).css('display', 'block');
  if (typeof pct === 'number') $(`#${EXT_ID}-az-bar`).css('width', `${Math.max(0, Math.min(100, pct))}%`);
  if (msg != null) $(`#${EXT_ID}-az-hint`).text(msg);
}

/* ================================================================== */
/* 创意灵感                                                            */
/* ================================================================== */

const ideaState = {
  open: false, // 卡片是否展开
  source: 'novel', // 'novel' | 'cont'
  tone: 'develop', // 'develop' | 'new' | 'twist' | 'custom'
  customTone: '', // 自定义基调文本
  generating: false,
  currentGenId: '',
  results: [], // string[] 三个章节概览
};

const IDEA_TONES = {
  develop: '前文剧情续写发展',
  new: '全新剧情开始',
  twist: '剧情转折',
  custom: '自定义',
};

/** 读取所选来源的最新正文与最新总结。 */
function readIdeaContext() {
  const src = ideaState.source;
  let obj = null;
  let label = '';
  if (src === 'cont') {
    obj = getContinuation();
    label = '续写会话';
  } else {
    obj = getActiveProject();
    label = '写新小说当前项目';
  }
  if (!obj) return { ok: false, label };
  // 最新已生成节正文(展平序列中最后一个 done)
  const flat = flatSections(obj);
  let latestText = '';
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].sec.done && flat[i].sec.content) {
      latestText = flat[i].sec.content;
      break;
    }
  }
  const latestSummary = latestSummaryText(obj); // 最新整章总结(表格文本)
  const bg = obj.background || (obj.characters ? `【角色档案】\n${obj.characters}\n\n【剧情梗概】\n${obj.plot || ''}` : '');
  return { ok: true, label, latestText, latestSummary, bg, title: obj.title || '' };
}

/** 构建创意 prompt(按基调, 要求输出 3 个章节概览的 JSON)。 */
function buildIdeaPrompt(ctx, tone) {
  const presetDesc = {
    develop: '顺着前文的走向自然发展, 承接现有剧情与人物状态, 推进下一段情节。',
    new: '开启一段相对独立的全新剧情线或新场景/新事件, 可引入新元素, 但与已有设定不冲突。',
    twist: '制造出人意料的剧情转折(反转/危机/隐藏真相揭露等), 打破当前平稳走向, 但符合人物逻辑。',
  };
  const isCustom = tone === 'custom';
  const toneName = isCustom ? '自定义' : IDEA_TONES[tone];
  const toneDesc = isCustom ? (ideaState.customTone || '').trim() || '由用户自定义的剧情基调' : presetDesc[tone];
  const system = [
    '你是小说剧情策划。请基于给定的背景/记忆/前文, 按指定基调, 构思后续章节的方向。',
    `本次基调: ${toneName} —— ${toneDesc}`,
    '请给出 3 个不同的章节概览方案(每个 2-4 句, 说明该章大致发生什么、推动什么)。',
    '必须只输出一个合法 JSON 对象, 不要多余文字或代码块标记, 格式: {"ideas":["概览1","概览2","概览3"]}',
  ].join('\n');
  const user = [
    ctx.bg ? `【背景/设定】\n${ctx.bg}` : '',
    ctx.latestSummary || '',
    ctx.latestText ? `【最新正文(节选)】\n${ctx.latestText.slice(-2000)}` : '',
    '请按上述基调输出 3 个章节概览的 JSON:',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

/** 解析创意结果为字符串数组。 */
function parseIdeas(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonStr = extractBalancedJson(t) || t;
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj.ideas)) return obj.ideas.map((x) => String(x)).filter(Boolean);
  } catch (e) {
    /* 回退 */
  }
  // 回退: 按数组元素正则抽取
  const m = t.match(/"ideas"\s*:\s*\[([\s\S]*?)\]/);
  if (m) {
    const arr = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let x;
    while ((x = re.exec(m[1]))) arr.push(x[1].replace(/\\"/g, '"'));
    if (arr.length) return arr;
  }
  // 再回退: 按行/编号拆分
  const lines = t.split('\n').map((l) => l.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
  return lines.slice(0, 3);
}

function stopIdea() {
  const th = getTavernHelper();
  try {
    if (th?.stopGenerationById && ideaState.currentGenId) th.stopGenerationById(ideaState.currentGenId);
    else if (th?.stopAllGeneration) th.stopAllGeneration();
    else getST()?.stopGeneration?.();
  } catch (e) {
    log.warn('中止创意失败:', e);
  }
}

/** 生成创意概览。 */
async function runIdea() {
  if (ideaState.generating) return;
  const ctx = readIdeaContext();
  if (!ctx.ok) {
    setIdeaHint(`没有可用的${ctx.label}内容, 请先创建/生成内容。`);
    return;
  }
  ideaState.generating = true;
  syncMiniBallBusy();
  renderIdeaUI();
  try {
    const { system, user } = buildIdeaPrompt(ctx, ideaState.tone);
    const gid = `idea_${Date.now()}`;
    ideaState.currentGenId = gid;
    setIdeaHint('正在构思…');
    const raw = (await novelGenerateWithId({ system, user }, gid)).trim();
    ideaState.results = parseIdeas(raw);
    setIdeaHint(ideaState.results.length ? `已生成 ${ideaState.results.length} 个方案` : '未解析出方案, 请重试');
    log.info('创意灵感结果:', ideaState.results);
  } catch (e) {
    log.error('创意生成失败:', e);
    setIdeaHint(`生成失败: ${e.message}`);
    toast(`创意生成失败: ${e.message}`);
  } finally {
    ideaState.generating = false;
    ideaState.currentGenId = '';
    syncMiniBallBusy();
    renderIdeaUI();
  }
}

function setIdeaHint(msg) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-idea-hint`).text(msg || '');
}

/** 渲染创意灵感卡片。 */
function renderIdeaUI() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-idea`);
  if (!$root.length) return;

  const head = `
    <div class="ns-card__head ns-idea-head" data-act="idea-fold" style="cursor:pointer;">
      <h4><i class="fa-solid fa-lightbulb"></i> 创意灵感</h4>
      <i class="fa-solid fa-chevron-${ideaState.open ? 'down' : 'right'} ns-collapse__icon ${ideaState.open ? 'ns-collapse__icon--open' : ''}"></i>
    </div>`;

  if (!ideaState.open) {
    $root.html(head);
    return;
  }

  const toneBtns = Object.entries(IDEA_TONES)
    .map(
      ([k, label]) =>
        `<button class="ns-tab ${ideaState.tone === k ? 'ns-tab--active' : ''}" data-act="idea-tone" data-tone="${k}">${label}</button>`,
    )
    .join('');

  const resultHtml = ideaState.results.length
    ? ideaState.results
        .map(
          (idea, i) => `
        <div class="ns-idea-item">
          <div class="ns-idea-item__text">${esc(idea)}</div>
          <div class="ns-chapter__actions">
            <button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="idea-copy" data-i="${i}"><i class="fa-solid fa-copy"></i> 复制</button>
          </div>
        </div>`,
        )
        .join('')
    : `<p class="ns-muted">选择来源与基调后，点「创意+」生成 3 个章节概览。</p>`;

  $root.html(`
    ${head}
    <div class="ns-idea-body">
      <div class="ns-field">
        <label>数据来源</label>
        <div class="ns-tabs">
          <button class="ns-tab ${ideaState.source === 'novel' ? 'ns-tab--active' : ''}" data-act="idea-source" data-src="novel">写新小说</button>
          <button class="ns-tab ${ideaState.source === 'cont' ? 'ns-tab--active' : ''}" data-act="idea-source" data-src="cont">续写会话</button>
        </div>
      </div>
      <div class="ns-field">
        <label>基调方向</label>
        <div class="ns-tabs">${toneBtns}</div>
        ${
          ideaState.tone === 'custom'
            ? `<textarea id="${EXT_ID}-idea-custom" class="ns-textarea" rows="2" placeholder="输入你想要的剧情基调，如：走向悲剧结局 / 加入悬疑推理线 / 主角黑化…">${esc(ideaState.customTone || '')}</textarea>`
            : ''
        }
      </div>
      <div class="ns-row">
        <button class="ns-btn" data-act="idea-gen" ${ideaState.generating ? 'disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> 创意+</button>
        ${ideaState.results.length ? `<button class="ns-btn ns-btn--ghost" data-act="idea-gen" ${ideaState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
        ${ideaState.generating ? `<button class="ns-btn ns-btn--danger" data-act="idea-stop">中止</button>` : ''}
        <span class="ns-muted" id="${EXT_ID}-idea-hint"></span>
      </div>
      ${ideaState.generating ? `<div class="ns-progress"><div class="ns-progress__bar ns-progress__bar--indef"></div></div>` : ''}
      <div class="ns-idea-results">${resultHtml}</div>
    </div>
  `);
}

function bindIdeaEvents() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-idea`);
  if (!$root.length || $root.data('bound')) return;
  $root.data('bound', true);

  $root.on('click', '[data-act]', async function () {
    const act = $(this).data('act');
    switch (act) {
      case 'idea-fold':
        ideaState.open = !ideaState.open;
        renderIdeaUI();
        break;
      case 'idea-source':
        ideaState.source = $(this).data('src') === 'cont' ? 'cont' : 'novel';
        renderIdeaUI();
        break;
      case 'idea-tone':
        // 切换前先保存当前自定义输入
        {
          const v = $(`#${EXT_ID}-idea-custom`).val();
          if (v != null) ideaState.customTone = String(v);
        }
        ideaState.tone = $(this).data('tone');
        renderIdeaUI();
        break;
      case 'idea-gen': {
        const v = $(`#${EXT_ID}-idea-custom`).val();
        if (v != null) ideaState.customTone = String(v);
        if (ideaState.tone === 'custom' && !ideaState.customTone.trim()) {
          setIdeaHint('请先输入自定义基调内容');
          break;
        }
        await runIdea();
        break;
      }
      case 'idea-stop':
        stopIdea();
        break;
      case 'idea-copy': {
        const i = Number($(this).data('i'));
        if (ideaState.results[i] != null) await copyToClipboard(ideaState.results[i]);
        break;
      }
      default:
        break;
    }
  });
}

/* ---------------------------- 写小说 UI ---------------------------- */

const WORLD_DEF_TABS = [
  { key: 'chars',  label: '人物', icon: 'fa-user-pen',    placeholder: '如：林川 - 主角，冷静果断，持有断罪之剑' },
  { key: 'items',  label: '道具', icon: 'fa-wand-sparkles', placeholder: '如：断罪之剑 - 上古神器，能斩断因果' },
  { key: 'places', label: '地理', icon: 'fa-map-location-dot', placeholder: '如：天平市 - 现代都市，血族三大家族的领地' },
  { key: 'others', label: '其他', icon: 'fa-layer-group',  placeholder: '如：血族议事规则 - 每季度召开…' },
];

function renderEntityRows(entities, tabKey) {
  const list = Array.isArray(entities) && entities.length ? entities : [''];
  const tab = WORLD_DEF_TABS.find((t) => t.key === tabKey) || WORLD_DEF_TABS[0];
  return list
    .map(
      (item, i) => `
      <div class="ns-outline-row">
        <span class="ns-outline-no"><i class="fa-solid ${tab.icon}"></i></span>
        <textarea class="ns-entity-input" data-tab="${tabKey}" rows="1" placeholder="${tab.placeholder}">${esc(item)}</textarea>
        <button class="ns-btn ns-btn--icon ns-btn--sm" data-act="entity-del" data-tab="${tabKey}" data-idx="${i}" title="删除本行"><i class="fa-solid fa-trash"></i></button>
      </div>`,
    )
    .join('');
}

/** 渲染世界设定区（四板块标签页 + 预读取勾选）。 */
function renderWorldDefsUI(proj) {
  const wd = proj.worldDefs || {};
  const activeTab = proj._worldDefTab || 'chars';
  const isAll = activeTab === 'all';

  // 标签：全部 + 四分类
  const allTabHtml = `<button class="ns-tab ${isAll ? 'ns-tab--active' : ''}" data-act="wd-tab" data-tab="all"><i class="fa-solid fa-list"></i> 全部</button>`;
  const catTabHtml = WORLD_DEF_TABS.map((t) =>
    `<button class="ns-tab ${activeTab === t.key ? 'ns-tab--active' : ''}" data-act="wd-tab" data-tab="${t.key}"><i class="fa-solid ${t.icon}"></i> ${t.label}</button>`
  ).join('');

  let listHtml;
  if (isAll) {
    // 全部：汇总四板块，每类加小标题，只读
    const sections = WORLD_DEF_TABS
      .map(({ key, label, icon, placeholder }) => {
        const list = (wd[key] || []).filter((e) => e && e.trim());
        if (!list.length) return '';
        const rows = list.map((item, i) => `
          <div class="ns-outline-row">
            <span class="ns-outline-no"><i class="fa-solid ${icon}"></i></span>
            <span class="ns-wd-readonly">${esc(item)}</span>
          </div>`).join('');
        return `<div class="ns-wd-section"><div class="ns-wd-section__label">${label}</div>${rows}</div>`;
      })
      .filter(Boolean);
    listHtml = sections.length
      ? sections.join('')
      : '<p class="ns-muted">暂无设定条目。切换到各分类标签进行添加。</p>';
  } else {
    listHtml = renderEntityRows(wd[activeTab] || [], activeTab);
  }

  return `
    <div class="ns-wd-tabs">${allTabHtml}${catTabHtml}</div>
    <div class="ns-entity-list" id="${EXT_ID}-wd-list">${listHtml}</div>
    ${!isAll ? `<div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="entity-add" data-tab="${activeTab}"><i class="fa-solid fa-plus"></i> 添加</button></div>` : ''}
    <div class="ns-row" style="margin-top:6px;">
      <label class="ns-switch" title="开启后，世界设定与总结一并写入单次 System；关闭时总结仍在 System，设定改放 User。均只发送一次，不重复。已同步世界书时设定改由世界书注入。">
        <input type="checkbox" id="${EXT_ID}-wd-preload" ${wd.preload ? 'checked' : ''} ${proj.worldBookName ? 'disabled' : ''} />
        <span>预读取（设定并入 System，与总结一次发送）</span>
      </label>
    </div>
    <div class="ns-row" style="margin-top:8px; flex-wrap:wrap; gap:6px; align-items:center;">
      <button class="ns-btn ns-btn--sm" data-act="wd-sync-wi" title="将当前背景与全部世界设定同步为酒馆世界书，生成时按酒馆接口扫描注入">
        <i class="fa-solid fa-book"></i> 同步至世界书
      </button>
      ${proj.worldBookName
        ? `<button class="ns-btn ns-btn--sm ns-btn--danger" data-act="wd-del-wi" title="删除本项目绑定的世界书"><i class="fa-solid fa-trash"></i> 删除世界书</button>`
        : ''}
    </div>
    <p class="ns-muted" style="margin-top:4px;">
      ${proj.worldBookName
        ? `已绑定世界书：${esc(proj.worldBookName)}（每次生成按酒馆世界书扫描注入，不再重复塞设定正文）`
        : '同步后将创建/覆盖一本专用世界书；写作与总结生成时会按酒馆接口扫描并注入。'}
    </p>`;
}

/** 从 DOM 收集当前活动板块的条目并写入 worldDefs。
 *  forceTab: 强制指定要保存到哪个板块（不传时读 proj._worldDefTab）。
 */
function collectWorldDefsFromDOM(proj, forceTab) {
  const $ = globalThis.jQuery;
  if (!$) return;
  ensureWorldDefs(proj);
  const wd = proj.worldDefs;
  const activeTab = forceTab || proj._worldDefTab || 'chars';
  // "全部"是只读视图，不收集
  if (activeTab !== 'all') {
    const vals = [];
    $(`#${EXT_ID}-wd-list .ns-entity-input`).each(function () {
      vals.push(String($(this).val() ?? ''));
    });
    wd[activeTab] = vals;
  }
  // 读取预读取勾选（始终同步）
  const $cb = $(`#${EXT_ID}-wd-preload`);
  if ($cb.length) wd.preload = $cb.is(':checked');
}

function collectEntitiesFromDOM() {
  // 兼容旧调用 - 收集当前 worldDefs 活动板块
  const proj = getActiveProject();
  if (proj) collectWorldDefsFromDOM(proj);
}

function refreshEntityList(entities) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const proj = getActiveProject();
  if (!proj) return;
  $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
}

function setNovelHint(msg, busy) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const text = (busy ? '生成中… ' : '') + (msg || '');
  if (busy && (genUiProgress.channel === 'novel' || $(`#${EXT_ID}-novel .ns-chapter__gen`).length)) {
    setGenSectionStatus(text.trim() || '生成中…');
    $(`#${EXT_ID}-nv-hint`).text('');
    return;
  }
  $(`#${EXT_ID}-nv-hint`).text(text);
}

/** 渲染章-节层次的章节列表 HTML(正在生成的节内嵌动画)。 */
function novelChapterListHtml(proj) {
  const flat = flatSections(proj);
  const flatByAS = {}; // `${actIdx}_${secIdx}` -> flatIdx
  flat.forEach((f) => (flatByAS[`${f.actIdx}_${f.secIdx}`] = f.flatIdx));
  const genThis = resolveGenThisTarget(proj);
  let genThisShown = false;

  return (proj.acts || [])
    .map((act, ai) => {
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const working = isSectionWorking('novel', flatIdx) || novelState.activeFlatIdx === flatIdx;
          const summarizing = working && genUiProgress.phase === 'summary';
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = working ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          const pendingSum = !!sec.pendingLiveSummary && valid;
          // 全书只渲染一次；生成中且非本节工作时隐藏，避免相邻空节同时出现按钮
          const showGenThis =
            !genThisShown &&
            !!genThis &&
            genThis.flatIdx === flatIdx &&
            !pendingSum &&
            !(novelState.generating && !working);
          if (showGenThis) genThisShown = true;
          const tag = working
            ? `<span class="ns-tag ns-tag--gen">${summarizing ? '总结中' : '生成中'}</span>`
            : pendingSum
              ? `<span class="ns-tag ns-tag--pending">待确认总结</span>`
              : valid
                ? `<span class="ns-tag ns-tag--done">已生成</span>`
                : sec.done
                  ? `<span class="ns-tag">空回·待重生</span>`
                  : `<span class="ns-tag">未生成</span>`;
          const locked = isSectionLocked(sec);
          return `
            <div class="ns-section ${working ? 'ns-chapter--gen' : ''} ${pendingSum ? 'ns-section--pending-sum' : ''} ${locked ? 'ns-sec-locked' : ''}" data-a="${ai}" data-s="${si}">
              <div class="ns-chapter__head">
                ${locked ? '<span class="ns-lock-icon" title="已锁定"><i class="fa-solid fa-lock"></i></span>' : `<span class="ns-drag-handle" title="拖拽排序"><i class="fa-solid fa-grip-lines"></i></span>`}
                <strong>第 ${si + 1} 节</strong>
                ${tag}
                <textarea class="ns-sec-outline" data-a="${ai}" data-s="${si}" rows="1" placeholder="本节大纲…">${esc(sec.outline || '')}</textarea>
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${pendingSum ? `<button class="ns-btn ns-btn--sm ns-btn--confirm-sum" data-act="confirm-live-sum" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''} title="确认后更新动态大总结，并自动生成下一节">确认总结</button>` : ''}
                ${!locked && valid && !showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="gen-sec" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${!locked && showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="gen-sec" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''}>生成本节</button>` : ''}
                ${working ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="stop">中止</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  <button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${locked ? 'sec-unlock' : 'sec-lock'}" data-a="${ai}" data-s="${si}" title="${locked ? '解锁本节及之后所有节' : '锁定本节及之前所有节'}"><i class="fa-solid fa-${locked ? 'lock-open' : 'lock'}"></i></button>
                  ${!locked && sec.content ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--ghost" data-act="sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文"><i class="fa-solid fa-broom"></i></button>` : ''}
                  ${!locked ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="sec-del" data-a="${ai}" data-s="${si}" title="删除本节"><i class="fa-solid fa-trash"></i></button>` : ''}
                </span>
              </div>
            </div>`;
        })
        .join('');

      // 折叠状态: 仅沿用用户手动设置(act._folded)；未设置则默认折叠，生成过程不自动改
      const folded = isActFolded(act);
      return `
        <div class="ns-act ${folded ? 'ns-act--folded' : ''}" data-a="${ai}">
          <div class="ns-act__head">
            <button class="ns-btn ns-btn--icon ns-btn--sm ns-act-fold" data-act="act-fold" data-a="${ai}" title="折叠/展开本章"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'} ns-act-fold__icon"></i></button>
            <strong>第 ${ai + 1} 章</strong>
            <input type="text" class="ns-act-title" data-a="${ai}" value="${esc(act.title || '')}" placeholder="章标题" />
            <span class="ns-tag ${isActComplete(act) ? 'ns-tag--done' : ''}">${(act.sections || []).filter((s) => hasValidSectionContent(s)).length}/${(act.sections || []).length} 节</span>
            <button class="ns-btn ns-btn--icon ns-btn--sm" data-act="act-del" data-a="${ai}" title="删除本章"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="ns-act__body" ${folded ? 'style="display:none;"' : ''}>
            <textarea class="ns-textarea ns-act-overview" data-a="${ai}" rows="2" placeholder="章总览：本章整体走向/关键事件（生成节时会预读）">${esc(act.overview || '')}</textarea>
            <div class="ns-sections">${secHtml || '<p class="ns-muted">本章暂无节。</p>'}</div>
            <div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="sec-add" data-a="${ai}"><i class="fa-solid fa-plus"></i> 添加节</button></div>
          </div>
        </div>`;
    })
    .join('');
}

function renderNovelChapters() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const proj = getActiveProject();
  if (!proj) return;
  const $list = $(`#${EXT_ID}-novel .ns-chapters`);
  if ($list.length) {
    $list.html(novelChapterListHtml(proj));
    _novelDragAttach?.(); // 重绘后重新绑定拖拽
  }
}

/** 只刷新写小说总结区。 */
function renderNovelSummaries() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const proj = getActiveProject();
  if (!proj) return;
  // 刷新章节总结列表
  const html = proj.summaries.length
    ? proj.summaries.map((s) => renderSummaryTable(s, 'nv-sum')).join('')
    : '<p class="ns-muted">暂无总结。每写完一整章将自动生成该章表格总结。</p>';
  const $box = $(`#${EXT_ID}-novel .ns-summaries`);
  if ($box.length) $box.html(html);
  // 同步刷新大总结（保留折叠状态）
  refreshGrandSummary(proj, `#${EXT_ID}-novel`);
}

/** 从 DOM 收集章-节结构(章标题/章总览/节大纲), 保留已生成正文。 */
function collectActsFromDOM(proj) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-novel .ns-act`).each(function (ai) {
    const act = proj.acts[ai];
    if (!act) return;
    act.title = String($(this).find('.ns-act-title').val() ?? '');
    act.overview = String($(this).find('.ns-act-overview').val() ?? '');
    $(this)
      .find('.ns-section')
      .each(function (si) {
        const sec = act.sections[si];
        if (sec) sec.outline = String($(this).find('.ns-sec-outline').val() ?? sec.outline);
      });
  });
}

/** 导出整本小说为 txt(章-节)。 */
function exportProject(proj) {
  const lines = [`《${proj.title || '小说'}》`, ''];
  if (proj.background) lines.push('【背景设定】', proj.background, '');
  const defsText = entitiesText(proj);
  if (defsText) { lines.push(defsText, ''); }
  (proj.acts || []).forEach((act, ai) => {
    lines.push(`第 ${ai + 1} 章 ${act.title || ''}`.trim());
    if (act.overview) lines.push(`（章总览：${act.overview}）`);
    lines.push('');
    (act.sections || []).forEach((sec, si) => {
      if (sec.content) {
        lines.push(`— 第 ${si + 1} 节 —`);
        lines.push('');
        lines.push(sec.content);
        lines.push('');
      }
    });
    lines.push('');
  });
  downloadText(`${safeFileName(proj.title || '小说')}.txt`, lines.join('\n'));
}

function renderNovelUI() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-novel`);
  if (!$root.length) return;

  const projects = getProjects();
  const proj = getActiveProject();

  const projectOptions = projects
    .map((p) => `<option value="${esc(p.id)}" ${proj && p.id === proj.id ? 'selected' : ''}>${esc(p.title)}</option>`)
    .join('');

  let body = '';
  if (!proj) {
    body = `<p class="ns-muted">还没有小说。点击「新建小说」开始。</p>`;
  } else {
    const done = doneSectionCount(proj);
    const total = totalSectionCount(proj);
    const chapterList = novelChapterListHtml(proj);
    const summaryList = proj.summaries.length
      ? proj.summaries.map((s) => renderSummaryTable(s, 'nv-sum')).join('')
      : `<p class="ns-muted">暂无总结。每写完一整章将自动生成该章表格总结。</p>`;

    body = `
      <div class="ns-collapse ns-collapse--edit">
        <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="nv-bg"><i class="fa-solid fa-chevron-right ${foldIconClass('nv-bg')}"></i><strong>背景设定</strong></div>
        <div class="ns-collapse__body ns-collapse__body--edit"${foldBodyStyle('nv-bg')}>
          <textarea id="${EXT_ID}-nv-bg" class="ns-textarea" rows="3" placeholder="世界观、设定、主要人物、写作要求等">${esc(proj.background)}</textarea>
        </div>
      </div>
      <div class="ns-collapse ns-collapse--edit">
        <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="nv-world"><i class="fa-solid fa-chevron-right ${foldIconClass('nv-world')}"></i><strong>世界设定（人物 / 道具 / 地理 / 其他）</strong></div>
        <div class="ns-collapse__body ns-collapse__body--edit" id="${EXT_ID}-wd-body"${foldBodyStyle('nv-world')}>
          ${renderWorldDefsUI(proj)}
        </div>
      </div>
      <div class="ns-row" style="margin-bottom:10px;">
        <button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>
      </div>
      <div class="ns-field">
        <div class="ns-card__head">
          <label>大纲（章 - 节层次，共 ${proj.acts.length} 章 / ${total} 节）</label>
        </div>
        <div class="ns-chapters">${chapterList}</div>
        <div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="act-add"><i class="fa-solid fa-plus"></i> 添加章</button></div>
      </div>
      <div class="ns-field">
        <div class="ns-card__head"><label>生成</label><span class="ns-muted" id="${EXT_ID}-nv-hint"></span></div>
        <div class="ns-row">
          <button class="ns-btn ns-btn--sm" data-act="save-outline" title="仅保存章-节大纲">保存大纲</button>
          <button class="ns-btn" data-act="mode-manual" title="逐节生成：写完后需点「确认总结」，再自动写下一节">手动模式（逐节确认）</button>
          <button class="ns-btn" data-act="mode-auto" title="一次性生成所有未完成节">自动模式（全部生成）</button>
          <button class="ns-btn ns-btn--danger" data-act="nv-clear" ${done ? '' : 'disabled'} title="清除目前所有生成内容">清除生成内容</button>
          <button class="ns-btn ns-btn--ghost" data-act="export" ${done ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 一键导出(txt)</button>
          <span class="ns-muted">进度：${done}/${total} 节</span>
        </div>
      </div>
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="nv-summaries">
          <i class="fa-solid fa-chevron-right ${foldIconClass('nv-summaries')}"></i>
          <strong>整章表格总结（记忆）</strong>
        </div>
        <div class="ns-row" style="padding:4px 10px 0;flex-wrap:wrap;gap:6px;">
          <button class="ns-btn ns-btn--sm" data-act="nv-resum" ${novelState.generating ? 'disabled' : ''} title="仅重新生成各章表格总结，不动大总结">全部重新总结</button>
          <button class="ns-btn ns-btn--sm" data-act="nv-redyn" ${novelState.generating ? 'disabled' : ''} title="仅按正文分段重建剧情链与人物链，不动章总结">重新动态总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="nv-clear-sum" title="清空章节总结与动态大总结">清空总结</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--summary"${foldBodyStyle('nv-summaries')}>
          ${grandSummaryHtml(proj, 'nv-grand')}
          <div class="ns-summaries">${summaryList}</div>
        </div>
      </div>
    `;
  }

  $root.html(`
    <div class="ns-card__head">
      <h4>写新小说</h4>
      <div class="ns-row">
        <select id="${EXT_ID}-nv-select" class="ns-select">${projectOptions || '<option value="">（无）</option>'}</select>
        <button class="ns-btn ns-btn--sm" data-act="new-project">新建小说</button>
        ${proj ? `<button class="ns-btn ns-btn--sm ns-btn--danger" data-act="del-project">删除</button>` : ''}
      </div>
    </div>
    ${body}`);
  _novelDragAttach?.(); // 整块重绘后重新绑定拖拽
}

/** 渲染大总结折叠块（状态由 uiFoldState 决定，默认折叠）。 */
function grandSummaryHtml(obj, foldKey = 'grand') {
  const body = buildGrandSummaryHtml(obj);
  return `
    <div class="ns-collapse ns-grand-summary" style="margin-bottom:4px;">
      <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="${foldKey}">
        <i class="fa-solid fa-chevron-right ${foldIconClass(foldKey)}"></i>
        <strong><i class="fa-solid fa-layer-group" style="margin-right:4px;"></i>大总结（剧情链 + 人物链）</strong>
      </div>
      <div class="ns-collapse__body ns-grand-summary__body"${foldBodyStyle(foldKey)}>${body}</div>
    </div>`;
}

/** 只更新大总结文本内容（不重建折叠结构，保留展开/折叠状态）。 */
function refreshGrandSummary(obj, containerSel) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $body = $(`${containerSel} .ns-grand-summary__body`);
  if (!$body.length) return;
  $body.html(buildGrandSummaryHtml(obj));
}

/** 渲染一条整章总结为表格（可折叠；状态由 uiFoldState 决定，默认折叠）。 */
function renderSummaryTable(s, foldPrefix = 'sum') {
  const chars = Array.isArray(s.characters) ? s.characters : [];
  const plots = Array.isArray(s.plot) ? s.plot : [];
  const charRows = chars.length
    ? chars.map((c) => `<tr><td>${esc(c.name || '')}</td><td>${esc(c.detail || '')}</td></tr>`).join('')
    : `<tr><td colspan="2" class="ns-muted">（无）</td></tr>`;
  const plotRows = plots.length
    ? plots.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="ns-muted">（无）</td></tr>`;
  const title = s.actNo ? `第 ${s.actNo} 章总结 ${s.actTitle ? '· ' + esc(s.actTitle) : ''}` : `第 ${s.fromChapter}-${s.toChapter} 章总结`;
  const foldKey = `${foldPrefix}-${s.actNo || `${s.fromChapter}-${s.toChapter}`}`;
  return `
    <div class="ns-summary ns-collapse">
      <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="${foldKey}">
        <i class="fa-solid fa-chevron-right ${foldIconClass(foldKey)}"></i>
        <strong>${title}</strong>
      </div>
      <div class="ns-collapse__body"${foldBodyStyle(foldKey)}>
        <table class="ns-table"><thead><tr><th>人物</th><th>状态/关系/目标</th></tr></thead><tbody>${charRows}</tbody></table>
        <table class="ns-table"><thead><tr><th>序</th><th>关键剧情</th></tr></thead><tbody>${plotRows}</tbody></table>
      </div>
    </div>`;
}

/** 写小说: 仅强制重新生成各章表格总结（不动剧情链/人物链）。 */
async function regenAllSummaries(proj, onProgress) {
  proj.summaries = [];
  touchProject(proj);
  for (let i = 0; i < (proj.acts || []).length; i++) {
    if (actHasGeneratedContent(proj.acts[i])) {
      await maybeSummarizeAct(proj, i, onProgress, { force: true });
      renderNovelSummaries();
    }
  }
  renderNovelSummaries();
}

/** 续写: 仅强制重新生成各章表格总结（不动剧情链/人物链）。 */
async function regenAllContSummaries(cont, onProgress) {
  cont.summaries = [];
  saveContinuation();
  for (let i = 0; i < (cont.acts || []).length; i++) {
    if (actHasGeneratedContent(cont.acts[i])) {
      await maybeSummarizeContAct(cont, i, onProgress, { force: true });
      renderContSummaries();
    }
  }
  renderContSummaries();
}

/** 写小说: 仅重新动态大总结（剧情链+人物链，分段加速）。 */
async function regenDynamicSummaryNovel(proj, onProgress) {
  await rebuildDynamicSummary(proj, onProgress, {
    saveFn: () => touchProject(proj),
    isCancelled: () => novelState.cancelRequested,
  });
  refreshGrandSummary(proj, `#${EXT_ID}-novel`);
}

/** 续写: 仅重新动态大总结（剧情链+人物链，分段加速）。 */
async function regenDynamicSummaryCont(cont, onProgress) {
  await rebuildDynamicSummary(cont, onProgress, {
    saveFn: () => saveContinuation(),
    isCancelled: () => contState.cancelRequested,
  });
  refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
}

/** 清空写小说所有节的正文/完成状态与总结, 用于从头重新生成。 */
function resetProjSections(proj) {
  for (const act of proj.acts || []) {
    for (const sec of act.sections || []) {
      if (isSectionLocked(sec)) continue; // 跳过锁定节
      sec.content = '';
      sec.done = false;
      sec.updatedAt = 0;
      delete sec.pendingLiveSummary;
    }
    delete act._folded;
  }
  // 若有锁定节，不清空总结（锁定内容的总结需保留）
  if (!flatSections(proj).some((f) => f.sec.locked)) proj.summaries = [];
  proj.liveProgress = null;
  proj.plotChain = [];
  clearPendingLiveSummary(proj);
  novelState.activeActIdx = -1;
  novelState.activeFlatIdx = -1;
  touchProject(proj);
}

/** 手动模式: 生成下一个未完成节。 */
async function runManualStep(proj) {
  if (novelState.generating) return;
  collectActsFromDOM(proj);
  if (!totalSectionCount(proj)) return void setNovelHint('请先添加章与节。');
  const pending = flatSections(proj).find((f) => f.sec.pendingLiveSummary && hasValidSectionContent(f.sec));
  if (pending) {
    setNovelHint(`请先点击第 ${pending.actIdx + 1} 章 第 ${pending.secIdx + 1} 节的「确认总结」。`);
    toast('请先确认总结');
    renderNovelChapters();
    return;
  }
  let flat = flatSections(proj);
  let target = flat.find((f) => !hasValidSectionContent(f.sec));
  if (!target) {
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetProjSections(proj);
    await resetRuntimeAfterClearContent('novel');
    renderNovelUI();
    flat = flatSections(proj);
    target = flat.find((f) => !hasValidSectionContent(f.sec));
    if (!target) return;
  }
  await withGenerating(async () => {
    await generateSection(proj, target.actIdx, target.secIdx, target.flatIdx, setNovelHint, {
      deferLiveProgress: true,
    });
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setNovelHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已生成${took}，请点击「确认总结」。`);
  });
  renderNovelUI();
}

/** 自动模式: 依次生成所有未完成节。 */
async function runAutoAll(proj) {
  if (novelState.generating) return;
  collectActsFromDOM(proj);
  if (!totalSectionCount(proj)) return void setNovelHint('请先添加章与节。');
  // 全部完成: 询问是否从头重新生成
  if (!flatSections(proj).some((f) => !hasValidSectionContent(f.sec))) {
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetProjSections(proj);
    await resetRuntimeAfterClearContent('novel');
    renderNovelUI();
  }
  await withGenerating(async () => {
    while (true) {
      if (novelState.cancelRequested) {
        setNovelHint('已中止。');
        break;
      }
      const flat = flatSections(proj);
      const target = flat.find((f) => !hasValidSectionContent(f.sec));
      if (!target) break;
      await generateSection(proj, target.actIdx, target.secIdx, target.flatIdx, setNovelHint);
      renderNovelChapters();
    }
    if (!novelState.cancelRequested) {
      // 全书写完: 补总结所有已完成但未总结的章(含最后一章)
      await summarizePendingActs(proj, proj.acts.length, setNovelHint);
      setNovelHint('全部节生成完成。');
    }
  });
  renderNovelUI();
}

async function withGenerating(fn) {
  novelState.generating = true;
  novelState.cancelRequested = false;
  syncMiniBallBusy();
  const $ = globalThis.jQuery;
  $?.(`#${EXT_ID}-novel [data-act="stop"]`).prop('disabled', false);
  try {
    await fn();
  } catch (e) {
    log.error('生成流程异常:', e);
    const took = genUiProgress.lastElapsedMs ? ` · 已耗时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setNovelHint(`生成失败: ${e.message}${took}`);
    toast(`生成失败: ${e.message}`);
  } finally {
    novelState.generating = false;
    novelState.cancelRequested = false;
    novelState.currentGenId = '';
    novelState.activeActIdx = -1;
    $?.(`#${EXT_ID}-novel [data-act="stop"]`).prop('disabled', true);
    syncMiniBallBusy();
  }
}

function bindNovelEvents() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-novel`);
  if (!$root.length || $root.data('bound')) return;
  $root.data('bound', true);

  $root.on('change', `#${EXT_ID}-nv-select`, function () {
    getSettings().activeProjectId = $(this).val();
    novelState.activeActIdx = -1;
    saveSettings();
    renderNovelUI();
  });

  // 预读取勾选即时保存
  $root.on('change', `#${EXT_ID}-wd-preload`, function () {
    const proj = getActiveProject();
    if (proj) {
      ensureWorldDefs(proj);
      proj.worldDefs.preload = $(this).is(':checked');
      touchProject(proj);
      setNovelHint(
        proj.worldDefs.preload
          ? '预读取已开启：设定+总结在 System 一次发送。'
          : '预读取已关闭：总结在 System，设定在 User（仍各只发一次）。',
      );
    }
  });

  $root.on('click', '[data-act]', async function () {
    const act = $(this).data('act');
    const idx = Number($(this).data('idx'));
    const proj = getActiveProject();

    switch (act) {
      case 'summary-toggle': {
        const $head = $(this);
        const $body = $head.parent().find('.ns-collapse__body').first();
        const isHidden = $body.is(':hidden');
        $body.toggle();
        $head.find('.ns-collapse__icon').toggleClass('ns-collapse__icon--open', isHidden);
        const foldKey = $head.data('fold-key');
        if (foldKey) setUiOpen(String(foldKey), isHidden);
        break;
      }
      case 'act-fold': {
        const ai = Number($(this).data('a'));
        const $act = $(this).closest('.ns-act');
        const $body = $act.find('.ns-act__body').first();
        const isHidden = $body.is(':hidden');
        $body.toggle();
        $act.toggleClass('ns-act--folded', !isHidden);
        $(this).find('.ns-act-fold__icon').removeClass('fa-chevron-right fa-chevron-down').addClass(isHidden ? 'fa-chevron-down' : 'fa-chevron-right');
        // 记住折叠状态, 避免重绘丢失
        if (proj && proj.acts[ai]) {
          proj.acts[ai]._folded = !isHidden; // isHidden(展开前隐藏)=true 表示这次是展开 -> folded=false
          touchProject(proj);
        }
        break;
      }
      case 'new-project': {
        const title = globalThis.prompt?.('小说标题', '我的新小说');
        if (title !== null) {
          createProject(title || '');
          renderNovelUI();
        }
        break;
      }
      case 'del-project':
        if (proj && globalThis.confirm?.(`确定删除《${proj.title}》? 此操作不可撤销。`)) {
          deleteProject(proj.id);
          renderNovelUI();
        }
        break;
      case 'act-add':
        if (proj) {
          collectActsFromDOM(proj);
          const act = makeAct('', '');
          act.sections.push(makeSection(''));
          proj.acts.push(act);
          touchProject(proj);
          renderNovelUI();
        }
        break;
      case 'act-del':
        if (proj) {
          const ai = Number($(this).data('a'));
          if (Number.isInteger(ai) && globalThis.confirm?.(`确定删除第 ${ai + 1} 章及其所有节？`)) {
            collectActsFromDOM(proj);
            proj.acts.splice(ai, 1);
            touchProject(proj);
            renderNovelUI();
          }
        }
        break;
      case 'sec-add':
        if (proj) {
          const ai = Number($(this).data('a'));
          if (Number.isInteger(ai) && proj.acts[ai]) {
            collectActsFromDOM(proj);
            proj.acts[ai].sections.push(makeSection(''));
            touchProject(proj);
            renderNovelChapters();
          }
        }
        break;
      case 'sec-lock':
        if (proj) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          lockUpToSection(proj, ai, si);
          touchProject(proj);
          renderNovelChapters();
          toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前所有内容`);
        }
        break;
      case 'sec-unlock':
        if (proj) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          unlockFromSection(proj, ai, si);
          touchProject(proj);
          renderNovelChapters();
          toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后所有内容`);
        }
        break;
      case 'sec-del':
        if (proj) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && proj.acts[ai]) {
            const sec = proj.acts[ai].sections[si];
            if (sec?.content && !globalThis.confirm?.(`确定删除第 ${ai + 1} 章 第 ${si + 1} 节？（该节已有正文）`)) break;
            collectActsFromDOM(proj);
            proj.acts[ai].sections.splice(si, 1);
            touchProject(proj);
            renderNovelChapters();
          }
        }
        break;
      case 'sec-clear':
        if (proj) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          const sec = proj.acts[ai]?.sections[si];
          if (sec && globalThis.confirm?.(`确定清空第 ${ai + 1} 章 第 ${si + 1} 节的正文？（节大纲保留）`)) {
            collectActsFromDOM(proj);
            sec.content = '';
            sec.done = false;
            sec.updatedAt = 0;
            delete sec.pendingLiveSummary;
            touchProject(proj);
            renderNovelChapters();
          }
        }
        break;
      case 'wd-tab':
        if (proj) {
          collectWorldDefsFromDOM(proj); // 先保存当前板块
          proj._worldDefTab = $(this).data('tab');
          ensureWorldDefs(proj);
          // 用精准 id 重绘整个设定区内容
          $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
        }
        break;
      case 'wd-sync-wi':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          try {
            collectWorldDefsFromDOM(proj);
            proj.background = String($(`#${EXT_ID}-nv-bg`).val() ?? proj.background ?? '');
            const r = await syncProjectToWorldInfo(proj);
            $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
            setNovelHint(`已同步至世界书「${r.name}」（${r.count} 条）`);
            toast(`已同步世界书：${r.name}（${r.count} 条）`);
          } catch (e) {
            log.error('同步世界书失败:', e);
            toast(`同步世界书失败: ${e.message}`);
          }
        }
        break;
      case 'wd-del-wi':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          const name = proj.worldBookName || '';
          if (!name) return void toast('当前项目尚未同步世界书');
          if (!globalThis.confirm?.(`确定删除世界书「${name}」？\n删除后生成将改回直接注入扩展内设定。`)) break;
          try {
            await deleteProjectWorldInfo(proj);
            $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
            setNovelHint('已删除绑定世界书。');
            toast('世界书已删除');
          } catch (e) {
            log.error('删除世界书失败:', e);
            toast(`删除世界书失败: ${e.message}`);
            $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
          }
        }
        break;
      case 'entity-add':
        if (proj) {
          const tab = $(this).data('tab') || proj._worldDefTab || 'chars';
          proj._worldDefTab = tab; // 同步内存状态
          collectWorldDefsFromDOM(proj, tab); // 先保存当前输入（传 tab 确保存到正确板块）
          ensureWorldDefs(proj);
          if (!Array.isArray(proj.worldDefs[tab])) proj.worldDefs[tab] = [];
          proj.worldDefs[tab].push('');
          $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj)); // 整体重绘保持一致
          $(`#${EXT_ID}-wd-list .ns-entity-input`).last().focus();
        }
        break;
      case 'entity-del':
        if (proj) {
          const tab = $(this).data('tab') || proj._worldDefTab || 'chars';
          proj._worldDefTab = tab; // 同步内存状态
          collectWorldDefsFromDOM(proj, tab);
          ensureWorldDefs(proj);
          const di = Number($(this).data('idx'));
          if (Number.isInteger(di) && proj.worldDefs[tab]) proj.worldDefs[tab].splice(di, 1);
          $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
        }
        break;
      case 'save-bg':
        if (proj) {
          proj.background = String($(`#${EXT_ID}-nv-bg`).val() ?? '');
          collectWorldDefsFromDOM(proj);
          touchProject(proj);
          setNovelHint('已保存背景与世界设定。');
          toast('背景/设定已保存');
        }
        break;
      case 'save-outline':
        if (proj) {
          collectActsFromDOM(proj);
          touchProject(proj);
          setNovelHint('章-节大纲已保存。');
          toast('大纲已保存');
          renderNovelUI();
        }
        break;
      case 'mode-manual':
        if (proj) await runManualStep(proj);
        break;
      case 'mode-auto':
        if (proj) await runAutoAll(proj);
        break;
      case 'stop':
        stopNovelGeneration();
        break;
      case 'nv-clear':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('确定清除目前所有生成内容？（章-节大纲保留，仅清空已生成正文与总结）')) return;
          resetProjSections(proj);
          await resetRuntimeAfterClearContent('novel');
          setNovelHint('已清除所有生成内容。');
          renderNovelUI();
          toast('已清除生成内容');
        }
        break;
      case 'nv-resum':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将重新生成各章表格总结（不影响大总结的剧情链/人物链）。确定继续？')) return;
          await withGenerating(async () => {
            await regenAllSummaries(proj, setNovelHint);
            setNovelHint('各章表格总结已重新生成。');
          });
          renderNovelUI();
        }
        break;
      case 'nv-redyn':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将按正文分段重建大总结（剧情链 + 人物链），不重新生成章总结。确定继续？')) return;
          await withGenerating(async () => {
            await regenDynamicSummaryNovel(proj, setNovelHint);
            setNovelHint('动态大总结已重建。');
          });
          renderNovelUI();
        }
        break;
      case 'nv-clear-sum':
        if (proj) {
          if (!globalThis.confirm?.('确定清空所有章节总结与大总结？（已生成的正文不受影响）')) return;
          proj.summaries = [];
          proj.plotChain = [];
          proj.liveProgress = null;
          clearPendingLiveSummary(proj);
          touchProject(proj);
          renderNovelUI();
          toast('已清空章节总结与大总结');
        }
        break;
      case 'export':
        if (proj) exportProject(proj);
        break;
      case 'gen-sec':
        if (proj) {
          if (novelState.generating) return;
          const ai = Number($(this).attr('data-a'));
          const si = Number($(this).attr('data-s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && proj.acts[ai]?.sections[si]) {
            collectActsFromDOM(proj);
            const secToRegen = proj.acts[ai].sections[si];
            // 区分首写/清后重生 vs 重新生成：后者才 stopAll + 空回加强，避免误伤下一次请求
            const isRegen = hasValidSectionContent(secToRegen) || !!secToRegen.done;
            secToRegen.done = false;
            secToRegen.content = '';
            delete secToRegen.pendingLiveSummary;
            touchProject(proj);
            const flat = flatSections(proj);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            resetGenerationChannel('novel', { hard: isRegen });
            await sleep(isRegen ? 500 : 80);
            await withGenerating(async () => {
              await generateSection(proj, ai, si, f ? f.flatIdx : -1, setNovelHint, {
                skipSummary: isRegen,
                reinforce: isRegen,
                deferLiveProgress: true,
              });
              setNovelHint(
                `第 ${ai + 1} 章 第 ${si + 1} 节已${isRegen ? '重新' : ''}生成` +
                  (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                  '，请点击「确认总结」。',
              );
            });
            renderNovelUI();
          }
        }
        break;
      case 'confirm-live-sum': {
        if (proj) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si)) {
            await confirmLiveSummaryAndContinueNovel(proj, ai, si);
          }
        }
        break;
      }
      case 'view-sec': {
        const ai = Number($(this).data('a'));
        const si = Number($(this).data('s'));
        if (proj && proj.acts[ai]?.sections[si]) showSectionViewer(ai, si, proj.acts[ai].sections[si].content || '');
        break;
      }
      case 'copy-sec': {
        const ai = Number($(this).data('a'));
        const si = Number($(this).data('s'));
        if (proj && proj.acts[ai]?.sections[si]) await copyToClipboard(proj.acts[ai].sections[si].content || '');
        break;
      }
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 按钮注入                                                             */
/* ------------------------------------------------------------------ */

const MENU_BTN_ID = `${EXT_ID}-menu-button`;

function injectWandMenuButton() {
  const $ = globalThis.jQuery;
  if (!$) return false;
  const $menu = $('#extensionsMenu');
  if (!$menu.length) return false;
  if ($(`#${MENU_BTN_ID}`).length) return true;
  const $item = $(`
    <div id="${MENU_BTN_ID}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="打开 ${EXT_NAME}">
      <i class="fa-solid fa-feather-pointed"></i><span>开始创意</span>
    </div>`);
  $item.on('click', () => {
    log.info('点击: 扩展栏"开始创意"');
    openPanel();
  });
  $menu.append($item);
  log.info('已注入扩展栏按钮');
  return true;
}

function injectFloatingButton() {
  const $ = globalThis.jQuery;
  if (!$) return false;
  const FLOAT_ID = ENTRY_FLOAT_ID;
  if ($(`#${FLOAT_ID}`).length) return true;
  const $btn = $(`<div id="${FLOAT_ID}" class="ns-float-btn" title="开始创意 (${EXT_NAME})"><i class="fa-solid fa-feather-pointed"></i></div>`);
  $btn.on('click', () => {
    log.info('点击: 悬浮"开始创意"');
    openPanel();
  });
  $('body').append($btn);
  log.info('已注入悬浮兜底按钮');
  return true;
}

/* ------------------------------------------------------------------ */
/* 事件订阅                                                             */
/* ------------------------------------------------------------------ */

function subscribeStatusEvents() {
  const ctx = getST();
  if (!ctx || !ctx.eventSource) {
    log.warn('无法订阅事件, 状态栏仅在打开面板时刷新');
    return;
  }
  const es = ctx.eventSource;
  const E = ctx.eventTypes || ctx.event_types || {};
  const onChange = debounce(() => refreshStatusBar(), 200);
  const names = [
    E.ONLINE_STATUS_CHANGED,
    E.CHATCOMPLETION_SOURCE_CHANGED,
    E.CHATCOMPLETION_MODEL_CHANGED,
    E.MAIN_API_CHANGED,
    E.OAI_PRESET_CHANGED_AFTER,
    E.PRESET_CHANGED,
    E.CONNECTION_PROFILE_LOADED,
    E.SETTINGS_UPDATED,
  ].filter(Boolean);
  let count = 0;
  for (const ev of names) {
    try {
      es.on(ev, onChange);
      count++;
    } catch (e) {
      log.warn('订阅事件失败:', ev, e);
    }
  }
  log.info(`已订阅 ${count} 个状态事件`);
}

function subscribeGenerationInject() {
  const ctx = getST();
  if (!ctx || !ctx.eventSource) return;
  const es = ctx.eventSource;
  const E = ctx.eventTypes || ctx.event_types || {};
  if (E.GENERATION_STARTED) {
    es.on(E.GENERATION_STARTED, refreshGlobalKeyword);
    log.info('已订阅 GENERATION_STARTED');
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
  log.info('开始初始化…');
  const hasJQuery = await waitFor(() => !!globalThis.jQuery, { label: 'jQuery' });
  if (!hasJQuery) {
    log.error('未检测到 jQuery, 无法注入 UI');
    return;
  }
  const hasST = await waitFor(() => !!getST(), { timeout: 10000, label: 'SillyTavern context' });
  log.info('SillyTavern context 就绪:', hasST);
  log.info('TavernHelper 就绪:', !!getTavernHelper());

  const menuOk = await waitFor(() => injectWandMenuButton(), { timeout: 15000, interval: 500, label: '#extensionsMenu' });
  if (!menuOk) log.warn('扩展栏注入失败, 仅用悬浮按钮');
  injectFloatingButton();

  subscribeStatusEvents();
  subscribeGenerationInject();
  refreshGlobalKeyword();
  log.info('初始化完成');
}

boot().catch((e) => log.error('初始化异常:', e));

export { openPanel, closePanel, minimizePanel, restorePanel };
