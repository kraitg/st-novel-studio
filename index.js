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
  summaryEveryN: 10, // 每 N 章自动总结
  compactEnabled: true, // 是否启用自动精简（关则始终细致总结）
  compactEveryN: 5, // 每 N 章自动精简一次（按章剧情链/人物链）
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

function genProgressBlockHtml() {
  const pct = Math.max(0, Math.min(100, Math.round(genUiProgress.pct || 0)));
  const elapsed = formatGenElapsed(
    genUiProgress.startedAt ? Date.now() - genUiProgress.startedAt : genUiProgress.lastElapsedMs,
  );
  return `<div class="ns-chapter__gen">
    <div class="ns-gen-meta">
      <span class="ns-gen-label"><i class="fa-solid fa-spinner fa-spin"></i> 生成中 <span class="ns-gen-pct">${pct}%</span></span>
      <span class="ns-gen-elapsed" title="本次生成时间">本次 ${esc(elapsed)}</span>
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

  // 只更新当前正在生成的节内进度条与耗时
  const $gen = $root.find('.ns-chapter__gen');
  if (!$gen.length) return;
  $gen.find('.ns-progress__bar').css('width', `${pct}%`);
  $gen.find('.ns-gen-pct').text(`${pct}%`);
  $gen.find('.ns-gen-elapsed').text(`本次 ${elapsed}`);
}

function startGenUiProgress(channel) {
  if (genUiProgress.timer) {
    clearInterval(genUiProgress.timer);
    genUiProgress.timer = null;
  }
  genUiProgress.channel = channel || 'novel';
  genUiProgress.startedAt = Date.now();
  genUiProgress.pct = 0;
  genUiProgress.lastElapsedMs = 0;
  genUiProgress.finishing = false;
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
    if (sanitizeEmptyDoneSections(proj)) touchProject(proj);
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
    acts: [], // 章-节层次结构 Act[]
    summaries: [], // 每大章一条表格总结
    plotChain: [], // 精简后的按章剧情链（替代大总结里的全书章节汇总表）
    liveProgress: null, // 最新进度动态总结 {actNo,secNo,characters,charChains,plot,updatedAt}
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
async function _genOnce({ system, user }, gid, shouldCancel) {
  const timeoutMs = getSettings().genTimeoutMs || 180000;
  const th = getTavernHelper();

  const doGen = () =>
    withClearedKeywordInject(async () => {
      await waitGenThrottle(shouldCancel);
      try {
        if (th && typeof th.generateRaw === 'function') {
          // 必须显式给出 user_input + 'user_input' 占位：
          // 若只放 RolePrompt 且不传 user_input，酒馆助手会在末尾再追加空 user_input，
          // Gemini 等模型常因此返回 content="" / completion_tokens=0。
          const result = await th.generateRaw({
            user_input: user,
            // 自定义顺序：仅 system + user，一次发完；不带角色卡/世界书/聊天历史/默认占位
            ordered_prompts: [
              { role: 'system', content: system },
              'user_input',
            ],
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
            });
          }
          return text;
        }
        const ctx = getST();
        if (ctx && typeof ctx.generateRaw === 'function') {
          const result = await ctx.generateRaw({ prompt: user, systemPrompt: system, prefill: '' });
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

/**
 * 生成(含重试)。504/502/503/超时/网络错误/空回复 → 指数退避重试。
 * 每次重试使用新的 generation_id，避免酒馆助手缓存同 id 的空结果。
 * @param {()=>boolean} shouldCancel 可选，返回 true 时中止重试。
 * @param {{ minLen?: number }} opts 空回复判定最短长度。
 */
async function novelGenerateWithId({ system, user }, gid, shouldCancel, opts = {}) {
  const s = getSettings();
  // 最多额外重试 1 次（合计 2 次），避免空回/限流时连打打爆配额
  const maxRetries = Math.min(2, Math.max(0, s.genMaxRetries ?? 1));
  const minLen = opts.minLen ?? 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (shouldCancel?.()) throw new Error('已中止');
    // 每次尝试使用独立 generation_id，防止空回被接口按 id 复用
    const attemptGid = attempt === 0 ? gid : `${gid}_r${attempt}_${Date.now()}`;
    try {
      const text = await _genOnce({ system, user }, attemptGid, shouldCancel);
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
      const retryable = isRetryableError(e);
      log.warn(`生成失败(第 ${attempt + 1} 次): ${e.message}${retryable ? ' [可重试]' : ' [不可重试]'}`);
      if (!retryable || attempt >= maxRetries) {
        throw e;
      }
    }
    // 指数退避；429 额外拉长到 ≥15s
    if (attempt < maxRetries) {
      const delay = calcRetryDelayMs(attempt, lastErr);
      log.info(`${delay}ms 后重试(${attempt + 2}/${maxRetries + 1})…`);
      await waitCancellable(delay, shouldCancel);
    }
  }
  throw lastErr || new Error('生成失败');
}

async function novelGenerate({ system, user }, opts = {}) {
  const gid = `novel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  novelState.currentGenId = gid;
  return novelGenerateWithId({ system, user }, gid, () => novelState.cancelRequested, opts);
}

/**
 * 清理生成通道状态。
 * @param {'novel'|'cont'} kind
 * @param {{ hard?: boolean }} opts hard=true 时 stopAll（仅用户点重新生成）；空回重试必须 soft，否则会 abort 下一次请求。
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

/**
 * 展示用人物链：精简批次用章总结节点 ∪ 余章总结 ∪ liveProgress 节级链。
 */
function collectCharChains(obj) {
  if (Array.isArray(obj?.liveProgress?.charChains)) {
    obj.liveProgress.charChains = obj.liveProgress.charChains.map((c) => ({
      name: c.name,
      chain: dedupeChainSteps(c.chain || []),
    }));
  }
  const through = Number(obj?.liveProgress?.compactMeta?.throughActNo) || 0;
  const curAct = Number(obj?.liveProgress?.actNo) || 0;
  const sums = Array.isArray(obj?.summaries) ? obj.summaries : [];
  // 已精简章：章级节点；余章（不含当前正在写的章）细致总结贡献章节点；当前章节级来自 liveProgress
  const compactSums = through > 0 ? sums.filter((s) => s.actNo <= through) : [];
  const remainderSums =
    through > 0
      ? sums.filter((s) => s.actNo > through && s.actNo !== curAct)
      : sums.filter((s) => !curAct || s.actNo !== curAct);
  let chains = charChainsFromSummaries({
    summaries: compactSums.length ? compactSums : remainderSums.length ? remainderSums : sums,
  });
  if (compactSums.length && remainderSums.length) {
    chains = mergeCharChains(chains, charChainsFromSummaries({ summaries: remainderSums }));
  } else if (!compactSums.length && remainderSums.length && curAct) {
    chains = charChainsFromSummaries({ summaries: remainderSums });
  }
  return mergeCharChains(chains, obj?.liveProgress?.charChains || []);
}

/** 人物链纯文本(注入 prompt，紧凑)。 */
function charChainsToText(chains) {
  const list = Array.isArray(chains) ? chains : [];
  if (!list.length) return '';
  const lines = ['【人物链】'];
  for (const c of list) {
    const traj = formatCharChain(c.chain);
    if (!c.name && !traj) continue;
    lines.push(`- ${c.name || '?'}: ${traj || '(无)'}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** 人物链 HTML：固定放在大总结最下方。 */
function charChainsToHtml(chains, obj) {
  const list = Array.isArray(chains) ? chains : [];
  const meta = obj?.liveProgress?.compactMeta;
  const hint =
    meta?.throughActNo > 0
      ? `（第1~${meta.throughActNo}章按章 · 第${meta.currentActNo || '?'}章第1~${meta.sectionThrough || '?'}节按节）`
      : '（从头至最新节 · 状态 A → B → C）';
  const rows = list.length
    ? list
        .map((c) => {
          const steps = Array.isArray(c.chain) ? c.chain.map((x) => String(x || '').trim()).filter(Boolean) : [];
          const traj = steps.length
            ? steps
                .map((s, i) => `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-chain-step">${esc(s)}</span>`)
                .join('')
            : '<span class="ns-muted">（无）</span>';
          return `<tr><td>${esc(c.name || '')}</td><td class="ns-char-chain">${traj}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="2" class="ns-muted">（暂无人物链。生成节或点「全部重新总结」后出现）</td></tr>`;
  return `
    <div class="ns-char-chains-block">
      <div class="ns-live-progress__title"><strong>人物链</strong><span class="ns-muted">${hint}</span></div>
      <table class="ns-table"><thead><tr><th>人物</th><th>变化轨迹</th></tr></thead><tbody>${rows}</tbody></table>
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
 * 用于人物链必须覆盖「从头到最新节」；超长时保头保尾、压缩中间。
 */
function collectSectionsCorpus(obj, actIdx, secIdx, { maxPerSec = 1800, maxTotal = 28000 } = {}) {
  const flat = flatSections(obj);
  const items = [];
  for (const f of flat) {
    if (f.actIdx > actIdx || (f.actIdx === actIdx && f.secIdx > secIdx)) break;
    if (!f.sec.done || !String(f.sec.content || '').trim()) continue;
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

/** 把 liveProgress 渲染成文本(注入 prompt，紧凑)。 */
function liveProgressToText(lp) {
  if (!lp) return '';
  const loc = `第${lp.actNo || '?'}章第${lp.secNo || '?'}节`;
  const lines = [`【最新进度(${loc})】`];
  const chars = Array.isArray(lp.characters) ? lp.characters : [];
  if (chars.length) {
    lines.push('人物:');
    for (const c of chars) {
      const d = String(c.detail || '').replace(/\n/g, ' ').trim();
      if (c.name || d) lines.push(`- ${c.name || '?'}: ${d}`);
    }
  }
  const plots = Array.isArray(lp.plot) ? lp.plot : [];
  if (plots.length) {
    lines.push('要点:');
    plots.forEach((p, i) => lines.push(`${i + 1}. ${String(p).replace(/\n/g, ' ').trim()}`));
  }
  return lines.join('\n');
}

/** 把 liveProgress 渲染成 HTML(人物档案 + 剧情；人物链单独在大总结最下方)。 */
function liveProgressToHtml(lp) {
  if (!lp) return '';
  const loc = `第 ${lp.actNo || '?'} 章 第 ${lp.secNo || '?'} 节`;
  const chars = Array.isArray(lp.characters) ? lp.characters : [];
  const plots = Array.isArray(lp.plot) ? lp.plot : [];
  const charRows = chars.length
    ? chars.map((c) => `<tr><td>${esc(c.name || '')}</td><td>${esc(c.detail || '')}</td></tr>`).join('')
    : `<tr><td colspan="2" class="ns-muted">（无）</td></tr>`;
  const plotRows = plots.length
    ? plots.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p)}</td></tr>`).join('')
    : '';
  const compactHint =
    lp.compactMeta?.throughActNo > 0
      ? `<div class="ns-muted" style="margin:2px 0 6px;">已自动精简：第1~${lp.compactMeta.throughActNo}章按章（每${lp.compactMeta.everyN || getCompactEveryN()}章一批）；第${lp.compactMeta.currentActNo || lp.actNo}章人物链为节级；余章为细致表。</div>`
      : `<div class="ns-muted" style="margin:4px 0 6px;">人物档案随每节更新。可在记忆栏开启「启用精简」并设置频率，满批次后自动压成章级链。</div>`;
  return `
    <div class="ns-live-progress">
      <div class="ns-live-progress__title"><strong>当前最新进度 · 动态总结</strong><span class="ns-muted">（${esc(loc)}）</span></div>
      ${compactHint}
      <table class="ns-table"><thead><tr><th>人物</th><th>当前状态/关系/目标</th></tr></thead><tbody>${charRows}</tbody></table>
      ${
        plotRows
          ? `<table class="ns-table"><thead><tr><th>序</th><th>本节剧情要点</th></tr></thead><tbody>${plotRows}</tbody></table>`
          : ''
      }
    </div>`;
}

/**
 * 大总结(注入 prompt 用，紧凑): 剧情链 + 余章总结 + 最新进度 + 人物链。
 * UI 展示请用 buildGrandSummaryHtml。
 */
function buildGrandSummary(obj) {
  const parts = [];
  const sums = Array.isArray(obj.summaries) ? obj.summaries : [];
  const plotChain = normalizePlotChain(obj.plotChain);
  const throughActNo =
    Number(obj.liveProgress?.compactMeta?.throughActNo) ||
    (plotChain.length ? Math.max(...plotChain.map((p) => p.actNo || 0)) : 0);
  const remainderSums = throughActNo > 0 ? sums.filter((s) => s.actNo > throughActNo) : sums;

  if (plotChain.length) parts.push(plotChainToText(plotChain));
  if (remainderSums.length) {
    const body = remainderSums
      .map((s) => `●第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}\n${summaryToCompact(s)}`)
      .join('\n');
    parts.push(
      plotChain.length
        ? `【余章总结(第${throughActNo + 1}章起)】\n${body}`
        : `【章节总结】\n${body}`,
    );
  } else if (!plotChain.length && sums.length) {
    const body = sums
      .map((s) => `●第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}\n${summaryToCompact(s)}`)
      .join('\n');
    parts.push(`【章节总结】\n${body}`);
  }
  if (obj.liveProgress) {
    parts.push(liveProgressToText(obj.liveProgress));
  } else {
    const excerpt = latestSectionExcerpt(obj, 600);
    if (excerpt) parts.push(excerpt);
  }
  const chains = collectCharChains(obj);
  const chainText = charChainsToText(chains);
  if (chainText) parts.push(chainText);
  return parts.join('\n\n');
}

/** 大总结 HTML(面板展示用)：人物链固定在最下方。 */
function buildGrandSummaryHtml(obj) {
  const parts = [];
  const sums = Array.isArray(obj?.summaries) ? obj.summaries : [];
  const plotChain = normalizePlotChain(obj?.plotChain);
  const throughActNo = Number(obj?.liveProgress?.compactMeta?.throughActNo) || (plotChain.length ? Math.max(...plotChain.map((p) => p.actNo || 0)) : 0);
  const remainderSums = throughActNo > 0 ? sums.filter((s) => s.actNo > throughActNo) : sums;

  if (plotChain.length) {
    parts.push(plotChainToHtml(plotChain));
  }
  if (remainderSums.length) {
    const body = remainderSums
      .map((s) => `● 第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}总结\n${summaryToTable(s)}`)
      .join('\n\n');
    const title = plotChain.length
      ? `【余章细致总结（第${throughActNo + 1}章起）】`
      : '【全书章节总结汇总】';
    parts.push(`<div class="ns-grand-archived"><strong>${title}</strong><br>${esc(body).replace(/\n/g, '<br>')}</div>`);
  } else if (!plotChain.length && sums.length) {
    const body = sums
      .map((s) => `● 第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}总结\n${summaryToTable(s)}`)
      .join('\n\n');
    parts.push(`<div class="ns-grand-archived"><strong>【全书章节总结汇总】</strong><br>${esc(body).replace(/\n/g, '<br>')}</div>`);
  }
  if (obj?.liveProgress) {
    parts.push(liveProgressToHtml(obj.liveProgress));
  } else {
    const excerpt = latestSectionExcerpt(obj);
    if (excerpt) parts.push(`<div class="ns-grand-archived">${esc(excerpt).replace(/\n/g, '<br>')}</div>`);
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

/** 构建「最新进度动态总结」提示词：人物链必须覆盖从头到本节的全部演变。 */
function buildLiveProgressPrompt(obj, actIdx, secIdx) {
  const act = obj.acts[actIdx];
  const sec = act.sections[secIdx];
  const prevChains = mergeCharChains(charChainsFromSummaries(obj), obj.liveProgress?.charChains || []);
  const system = [
    '你是小说动态进度归档助手。请根据【全书已有人物状态时间线素材】与【截至本节的正文】，更新「当前最新进度」。',
    '必须只输出一个合法 JSON 对象，不要输出任何多余文字或代码块标记。严格使用如下格式:',
    '{"characters":[{"name":"角色名","detail":"当前状态/关系/目标"}],"charChains":[{"name":"角色名","chain":["状态A","状态B","状态C"]}],"plot":["本节关键剧情要点1","要点2"]}',
    '规则(务必遵守):',
    '1. characters: 覆盖从头到本节出现过的主要人物，detail 为截至本节结束的最新状态(一句即可)。',
    '2. charChains: 只在「实质性剧情变化」时追加节点(身份变化/立场转变/重大事件后果等)。每个节点 12~36 字，只写变化点。',
    '3. 严禁用不同措辞反复描述同一处境(例如多次写清洁工恐惧清理、被威胁)；同一处境只保留 1 个节点。',
    '4. 若提供了【必须保留的既有人物链】：保留其不重复的有效节点；发现近义重复则合并为一条，可在末尾追加真正的新变化。',
    '5. plot: 只写本节推进的关键要点，3-6 条为宜。',
    '6. 不要编造从未出现的人物。',
  ].join('\n');
  const hist = allSummariesCharHistoryText(obj);
  const corpus = collectSectionsCorpus(obj, actIdx, secIdx);
  const user = [
    prevChains.length ? `【既有人物链(请去重近义复述后再输出完整链)】\n${charChainsToText(prevChains)}` : '',
    hist ? `【各章总结中的人物状态(按章序)】\n${hist}` : '',
    obj.liveProgress ? `【上一版最新进度人物档案】\n${liveProgressToText(obj.liveProgress)}` : '',
    corpus
      ? `【截至本节的全部正文素材(第1章第1节 → 第${actIdx + 1}章第${secIdx + 1}节)】\n${corpus}`
      : `【本节正文: 第${actIdx + 1}章 第${secIdx + 1}节】\n${sec.content || ''}`,
    '请输出更新后的 JSON。人物链须覆盖真实演变，且不得出现近义重复节点:',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

/**
 * 每节生成后更新动态最新进度(人物档案表 + 人物链)。
 * 人物链与既有链合并，保证从头到最新节的节点不被 AI 截断丢失。
 */
async function updateLiveProgress(obj, actIdx, secIdx, onProgress, { saveFn, isCancelled } = {}) {
  if (!obj || !obj.acts?.[actIdx]?.sections?.[secIdx]?.content) return;
  if (isCancelled?.()) return;
  try {
    onProgress?.(`正在更新最新进度/人物链(第${actIdx + 1}章 第${secIdx + 1}节，含全文历史)…`, true);
    const prevChains = mergeCharChains(charChainsFromSummaries(obj), obj.liveProgress?.charChains || []);
    const { system, user } = buildLiveProgressPrompt(obj, actIdx, secIdx);
    const gid = `live_${Date.now()}_${actIdx}_${secIdx}`;
    const raw = (await novelGenerateWithId({ system, user }, gid, isCancelled)).trim();
    if (isCancelled?.()) return;
    const parsed = parseLiveProgress(raw);
    // 合并后近义去重，避免同处境不同措辞反复追加
    let mergedChains = mergeCharChains(prevChains, parsed.charChains);
    for (const c of parsed.characters || []) {
      const d = String(c.detail || '').trim();
      if (!c.name || !d) continue;
      const hit = mergedChains.find((x) => normCharName(x.name) === normCharName(c.name));
      if (hit) appendChainStep(hit.chain, d);
      else mergedChains.push({ name: c.name, chain: [d] });
    }
    mergedChains = mergedChains.map((c) => ({ name: c.name, chain: dedupeChainSteps(c.chain) }));
    obj.liveProgress = {
      actNo: actIdx + 1,
      secNo: secIdx + 1,
      characters: parsed.characters,
      charChains: mergedChains,
      plot: parsed.plot,
      updatedAt: Date.now(),
    };
    saveFn?.();
    log.info(`已更新最新进度动态总结`, {
      loc: `${actIdx + 1}-${secIdx + 1}`,
      characters: parsed.characters.length,
      chains: mergedChains.length,
      chainNodes: mergedChains.reduce((n, c) => n + (c.chain?.length || 0), 0),
    });
    onProgress?.(`最新进度与人物链已更新(第${actIdx + 1}章 第${secIdx + 1}节)`, true);
  } catch (e) {
    log.warn('更新最新进度动态总结失败:', e);
    onProgress?.(`最新进度更新失败: ${e.message}`, true);
  }
}

/**
 * 从第1章第1节到最新节，整本重建人物链与最新进度(用于「全部重新总结」)。
 * 一次调用带齐全书素材，再与各章总结确定性合并。
 */
async function rebuildLiveProgressFull(obj, onProgress, { saveFn, isCancelled } = {}) {
  const last = findLastDoneSection(obj);
  if (!last) {
    obj.liveProgress = null;
    saveFn?.();
    return;
  }
  onProgress?.(`正在按「第1章第1节 → 第${last.actIdx + 1}章第${last.secIdx + 1}节」重建完整人物链…`, true);
  // 清空旧 live 链，避免脏数据；章总结链仍会作为前缀合并进去
  const keepChars = obj.liveProgress?.characters || [];
  obj.liveProgress = {
    actNo: last.actIdx + 1,
    secNo: last.secIdx + 1,
    characters: keepChars,
    charChains: charChainsFromSummaries(obj),
    plot: [],
    updatedAt: Date.now(),
  };
  saveFn?.();
  await updateLiveProgress(obj, last.actIdx, last.secIdx, onProgress, { saveFn, isCancelled });
}

/**
 * 定位「正在写」的光标：第一个尚无有效正文的节。
 * 若全书已写完，光标落在末节之后（便于把末章全部保留为节级）。
 */
function findWritingCursor(obj) {
  const flat = flatSections(obj);
  if (!flat.length) return null;
  const next = flat.find((f) => !hasValidSectionContent(f.sec));
  if (next) return { actIdx: next.actIdx, secIdx: next.secIdx, flatIdx: next.flatIdx };
  const last = flat[flat.length - 1];
  return { actIdx: last.actIdx, secIdx: last.secIdx + 1, flatIdx: last.flatIdx + 1 };
}

/** 是否启用自动精简。 */
function isCompactEnabled() {
  return getSettings()?.compactEnabled !== false;
}

/** 精简频率：每 N 章自动精简一次（至少为 1）。 */
function getCompactEveryN() {
  const n = Number(getSettings()?.compactEveryN);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(50, Math.floor(n));
}

/**
 * 应精简到第几章（含）：从开头连续已完成章数，按 N 向下取整。
 * 精简关闭时恒为 0（不压章）。
 * 例 N=5：写第6章时 through=5；写第5章时 through=0；写第11章时 through=10。
 */
function getCompactThroughActNo(obj) {
  if (!isCompactEnabled()) return 0;
  const N = getCompactEveryN();
  let completeCount = 0;
  for (const act of obj?.acts || []) {
    if (isActComplete(act)) completeCount += 1;
    else break;
  }
  return Math.floor(completeCount / N) * N;
}

/** 仅收集某一章 [fromSec, toSec] 闭区间内已写正文（节级精简用）。 */
function collectActSectionsCorpus(obj, actIdx, fromSec, toSec, { maxPerSec = 1600, maxTotal = 20000 } = {}) {
  const act = obj?.acts?.[actIdx];
  if (!act) return '';
  const items = [];
  const end = Math.min(toSec, (act.sections || []).length - 1);
  for (let si = Math.max(0, fromSec); si <= end; si++) {
    const sec = act.sections[si];
    if (!hasValidSectionContent(sec)) continue;
    let body = String(sec.content).trim();
    if (body.length > maxPerSec) {
      const head = Math.floor(maxPerSec * 0.45);
      const tail = maxPerSec - head - 20;
      body = `${body.slice(0, head)}\n…(中略)…\n${body.slice(-tail)}`;
    }
    items.push(`【第${actIdx + 1}章 第${si + 1}节】\n${body}`);
  }
  if (!items.length) return '';
  let full = items.join('\n\n');
  if (full.length > maxTotal) full = `${full.slice(0, Math.floor(maxTotal * 0.55))}\n…(中间节略)…\n${full.slice(-(maxTotal - Math.floor(maxTotal * 0.55) - 20))}`;
  return full;
}

/** 规整剧情链节点。 */
function normalizePlotChain(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => {
      if (typeof p === 'string') {
        const step = p.trim();
        return step ? { actNo: 0, actTitle: '', step } : null;
      }
      const actNo = Number(p?.actNo) || 0;
      const actTitle = String(p?.actTitle || '').trim();
      let step = String(p?.step || p?.detail || p?.plot || '').trim();
      if (!step && Array.isArray(p?.plot)) step = p.plot.map((x) => String(x || '').trim()).filter(Boolean).join('；');
      if (!step) return null;
      return { actNo, actTitle, step };
    })
    .filter(Boolean)
    .sort((a, b) => (a.actNo || 0) - (b.actNo || 0));
}

/**
 * 从各章表格总结生成按章剧情链（每章一个节点）。
 * 优先用剧情要点压缩为一句；无剧情则用人物状态兜底。
 */
function buildPlotChainFromSummaries(summaries) {
  const sums = Array.isArray(summaries) ? [...summaries].sort((a, b) => (a.actNo || 0) - (b.actNo || 0)) : [];
  return sums
    .map((s) => {
      const actNo = Number(s.actNo) || 0;
      if (!actNo) return null;
      const actTitle = String(s.actTitle || '').trim();
      const plots = Array.isArray(s.plot) ? s.plot.map((p) => String(p || '').trim()).filter(Boolean) : [];
      let core = '';
      if (plots.length) {
        core = plots.slice(0, 3).join('；');
      } else {
        const chars = Array.isArray(s.characters) ? s.characters : [];
        core = chars
          .slice(0, 3)
          .map((c) => `${c.name || ''}：${(c.detail || '').replace(/\n/g, ' ')}`)
          .filter((t) => t.replace(/[：:]/g, '').trim())
          .join('；');
      }
      core = core.replace(/\s+/g, ' ').trim();
      if (core.length > 72) core = `${core.slice(0, 70)}…`;
      if (!core) core = '(本章要点略)';
      const titleBit = actTitle ? `「${actTitle}」` : '';
      return { actNo, actTitle, step: `第${actNo}章${titleBit}：${core}` };
    })
    .filter(Boolean);
}

/** 合并 AI 返回的剧情链与章总结兜底（缺章用总结补全）。 */
function mergePlotChain(aiChain, summaries) {
  const fallback = buildPlotChainFromSummaries(summaries);
  const fromAi = normalizePlotChain(aiChain);
  if (!fromAi.length) return fallback;
  const map = new Map();
  for (const p of fallback) map.set(p.actNo, p);
  for (const p of fromAi) {
    if (!p.actNo) continue;
    const step = String(p.step || '').trim();
    if (!step) continue;
    const title = p.actTitle || map.get(p.actNo)?.actTitle || '';
    const normalized = step.startsWith(`第${p.actNo}章`)
      ? step
      : `第${p.actNo}章${title ? `「${title}」` : ''}：${step}`;
    map.set(p.actNo, {
      actNo: p.actNo,
      actTitle: title,
      step: normalized.length > 100 ? `${normalized.slice(0, 98)}…` : normalized,
    });
  }
  return [...map.values()].sort((a, b) => a.actNo - b.actNo);
}

/** 剧情链纯文本(注入 prompt，只保留链，不重复表格)。 */
function plotChainToText(chain) {
  const list = normalizePlotChain(chain);
  if (!list.length) return '';
  const lines = ['【剧情链】'];
  for (const p of list) {
    lines.push(`第${p.actNo || '?'}章: ${(p.step || '').replace(/\n/g, ' ').trim()}`);
  }
  return lines.join('\n');
}

/** 剧情链 HTML（替代冗长的全书章节总结汇总表）。 */
function plotChainToHtml(chain) {
  const list = normalizePlotChain(chain);
  if (!list.length) return '';
  const traj = list
    .map((p, i) => `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-plot-chain-step" title="${esc(p.step)}">${esc(p.step)}</span>`)
    .join('');
  const rows = list
    .map((p) => `<tr><td>第${p.actNo || '?'}章${p.actTitle ? esc('「' + p.actTitle + '」') : ''}</td><td>${esc(p.step)}</td></tr>`)
    .join('');
  return `
    <div class="ns-plot-chains-block">
      <div class="ns-live-progress__title"><strong>【全书剧情链】</strong><span class="ns-muted">（已满批次按章精简）</span></div>
      <div class="ns-plot-chain">${traj}</div>
      <table class="ns-table"><thead><tr><th>章</th><th>剧情节点</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

/**
 * 构建「精简总结」提示词：
 * - 第1~through 章：人物链/剧情按章（由章总结提供）
 * - 当前章已写各节：本章节级人物链节点
 * - 余章细致表格由 summaries 保留，不在此压扁
 */
function buildCompactLivePrompt(obj, actIdx, lastSecIdxInclusive, throughActNo) {
  const actNo = actIdx + 1;
  const baseObj = {
    summaries: (obj.summaries || []).filter((s) => s.actNo <= throughActNo),
  };
  const chapterChains = charChainsFromSummaries(baseObj);
  const corpus = collectActSectionsCorpus(obj, actIdx, 0, lastSecIdxInclusive);
  const system = [
    '你是小说记忆精简助手。目标：把已满批次的旧章压成「按章剧情链/人物链」，当前章保留节级人物链细节。',
    '必须只输出一个合法 JSON 对象，不要输出任何多余文字或代码块标记。格式:',
    '{"plotChain":[{"actNo":1,"step":"该章核心剧情一句话"}],"characters":[{"name":"角色名","detail":"截至本章已写最后一节的最新状态"}],"charChains":[{"name":"角色名","chain":["仅本章各节的新状态节点"]}],"plot":["当前章最后一节的要点"]}',
    '规则:',
    throughActNo > 0
      ? `1. plotChain: 必须覆盖第1~${throughActNo}章，每章恰好 1 个节点；step 为 20~48 字的核心剧情，按章序排列。`
      : '1. plotChain: 无已满批次时可为空数组 []。',
    throughActNo > 0
      ? `2. 第1~${throughActNo}章人物演变在【按章人物链】中；你输出的 charChains 只能包含第${actNo}章各节的新增节点，禁止把已精简章拆回节级。`
      : `2. charChains 仅含第${actNo}章各节节点。`,
    '3. characters: 覆盖主要人物的最新状态（一句）。',
    '4. plot: 只写本章已写最后一节的要点。',
    '5. 不要编造未出现人物；节点宜短。不要输出 sectionDigests 或按节剧情摘要表。',
  ].join('\n');
  const chapterPlotHint =
    throughActNo > 0 && baseObj.summaries.length
      ? `【第1~${throughActNo}章 · 待压成剧情链的章总结剧情】\n${baseObj.summaries
          .map((s) => {
            const plots = Array.isArray(s.plot) ? s.plot.map((p) => String(p || '').trim()).filter(Boolean) : [];
            return `● 第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}：${plots.join('；') || '(无剧情要点)'}`;
          })
          .join('\n')}`
      : '';
  const user = [
    throughActNo > 0
      ? `【按章人物链(第1~${throughActNo}章·勿写入你的 charChains)】\n${charChainsToText(chapterChains)}`
      : '',
    chapterPlotHint,
    throughActNo > 0 && baseObj.summaries.length
      ? `【第1~${throughActNo}章 · 章节人物摘要】\n${allSummariesCharHistoryText(baseObj)}`
      : '',
    corpus
      ? `【第${actNo}章已写正文(第1节 → 第${lastSecIdxInclusive + 1}节)】\n${corpus}`
      : '',
    throughActNo > 0
      ? `请输出 JSON。plotChain 覆盖第1~${throughActNo}章；charChains 仅含第${actNo}章节级节点。`
      : `请输出 JSON。charChains 仅含第${actNo}章节级节点。`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user, chapterChains };
}

/**
 * 自动精简大总结（按 compactEveryN 批次）：
 * - 第1~through 章 → 章级剧情链 + 章级人物链
 * - 余章（through+1 起，含当前章）→ 保留细致人物/剧情表
 * - 当前章已写前序节 → 节级人物链（不再单独展示节级剧情摘要）
 * 例 N=5、写第6章第8节：精简第1~5章；第6章保留节级人物链。
 * @returns {Promise<boolean>} 是否执行了精简（through>0）
 */
async function compactGrandSummary(obj, onProgress, { saveFn, isCancelled, summarizeAct, refreshSummariesUI, forceSummarizeCompacted = false } = {}) {
  if (!obj) return false;
  if (!isCompactEnabled()) {
    obj.plotChain = [];
    if (obj.liveProgress?.compactMeta) delete obj.liveProgress.compactMeta;
    saveFn?.();
    return false;
  }
  const N = getCompactEveryN();
  const cursor = findWritingCursor(obj);
  if (!cursor) return false;

  const throughActNo = getCompactThroughActNo(obj);
  const throughActIdx = throughActNo - 1;
  const lastSecInChapter = cursor.secIdx - 1;
  const currentActNo = cursor.actIdx + 1;

  // 未满一批：不建剧情链，仅保证当前章节级细节（由调用方 rebuild 亦可）
  if (throughActNo < N) {
    obj.plotChain = [];
    if (obj.liveProgress?.compactMeta) {
      delete obj.liveProgress.compactMeta;
    }
    saveFn?.();
    return false;
  }

  onProgress?.(
    `自动精简：每${N}章一批，将第1~${throughActNo}章压成章级剧情链/人物链；第${throughActNo + 1}章起保留细致总结…`,
    true,
  );

  // 1) 确保精简范围内各章有表格总结（用于压链）；余章保持细致表
  for (let i = 0; i <= throughActIdx; i++) {
    if (isCancelled?.()) throw new Error('已中止');
    if (!actHasGeneratedContent(obj.acts[i])) continue;
    const has = (obj.summaries || []).some((s) => s.actNo === i + 1);
    if (forceSummarizeCompacted || !has) {
      await summarizeAct?.(obj, i, onProgress, { force: forceSummarizeCompacted || !has });
      refreshSummariesUI?.();
    }
  }
  // 余章（含当前章若有正文）：保持/补齐细致总结
  for (let i = throughActNo; i < (obj.acts || []).length; i++) {
    if (isCancelled?.()) throw new Error('已中止');
    if (!actHasGeneratedContent(obj.acts[i])) continue;
    // 当前正在写的章：用 force 生成 partial 细致表（人物+剧情）
    const isCurrent = i === cursor.actIdx;
    const has = (obj.summaries || []).some((s) => s.actNo === i + 1);
    if (isCurrent || !has) {
      await summarizeAct?.(obj, i, onProgress, { force: isCurrent || forceSummarizeCompacted || !has });
      refreshSummariesUI?.();
    }
  }

  const compactSums = (obj.summaries || []).filter((s) => s.actNo <= throughActNo);
  const chapterChains = charChainsFromSummaries({ summaries: compactSums });

  const applyPlotChain = (aiPlotChain) => {
    obj.plotChain = mergePlotChain(aiPlotChain, compactSums);
  };

  const finishMeta = (secThrough) => ({
    throughActNo,
    currentActNo,
    sectionThrough: secThrough,
    everyN: N,
  });

  if (lastSecInChapter < 0 || cursor.actIdx < 0) {
    applyPlotChain(null);
    const lastSum =
      [...(obj.summaries || [])].reverse().find((s) => s.actNo === currentActNo) ||
      [...(obj.summaries || [])].reverse().find((s) => s.actNo > throughActNo) ||
      compactSums[compactSums.length - 1];
    obj.liveProgress = {
      actNo: currentActNo,
      secNo: Math.max(1, cursor.secIdx || 1),
      characters: lastSum?.characters || [],
      charChains: [],
      plot: lastSum?.plot || [],
      compactMeta: finishMeta(0),
      updatedAt: Date.now(),
    };
    saveFn?.();
    onProgress?.(`精简完成：第1~${throughActNo}章→章级剧情链；第${throughActNo + 1}章起为细致表。`, true);
    return true;
  }

  if (isCancelled?.()) throw new Error('已中止');
  onProgress?.(
    `正在更新第${currentActNo}章人物链，并精简第1~${throughActNo}章…`,
    true,
  );

  const { system, user } = buildCompactLivePrompt(obj, cursor.actIdx, lastSecInChapter, throughActNo);
  const gid = `compact_${Date.now()}_${cursor.actIdx}_${lastSecInChapter}`;
  const raw = (await novelGenerateWithId({ system, user }, gid, isCancelled)).trim();
  if (isCancelled?.()) throw new Error('已中止');

  const parsed = parseLiveProgress(raw);
  let aiPlotChain = null;
  try {
    const t = String(raw || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const j = JSON.parse(extractBalancedJson(t) || t);
    aiPlotChain = j.plotChain;
  } catch (e) {
    /* ignore */
  }
  applyPlotChain(aiPlotChain);

  let sectionChains = (parsed.charChains || [])
    .map((c) => ({ name: c.name, chain: dedupeChainSteps(c.chain || []) }))
    .filter((c) => c.name || c.chain.length);
  sectionChains = sectionChains.map((c) => {
    const base = chapterChains.find((x) => normCharName(x.name) === normCharName(c.name));
    if (!base?.chain?.length) return c;
    const chain = [...(c.chain || [])];
    while (chain.length && base.chain.some((b) => isSimilarChainStep(b, chain[0]))) chain.shift();
    return { name: c.name, chain };
  });

  obj.liveProgress = {
    actNo: currentActNo,
    secNo: lastSecInChapter + 1,
    characters: parsed.characters?.length
      ? parsed.characters
      : chapterChains.map((c) => ({
          name: c.name,
          detail: c.chain[c.chain.length - 1] || '',
        })),
    charChains: sectionChains,
    plot: parsed.plot || [],
    compactMeta: finishMeta(lastSecInChapter + 1),
    updatedAt: Date.now(),
  };
  saveFn?.();
  log.info('自动精简完成', { throughActNo, currentActNo, everyN: N, plotNodes: (obj.plotChain || []).length });
  onProgress?.(
    `精简完成：第1~${throughActNo}章→章级链；第${currentActNo}章保留节级人物链；余章保留细致表。`,
    true,
  );
  return true;
}

/**
 * 若已满精简批次则执行自动精简；否则按全文重建细致人物链。
 * 供「全部重新总结」与章完成钩子调用。
 */
async function applySummaryMemoryPolicy(obj, onProgress, opts = {}) {
  const through = getCompactThroughActNo(obj);
  const N = getCompactEveryN();
  if (isCompactEnabled() && through >= N) {
    await compactGrandSummary(obj, onProgress, opts);
  } else {
    obj.plotChain = [];
    if (obj.liveProgress?.compactMeta) delete obj.liveProgress.compactMeta;
    await rebuildLiveProgressFull(obj, onProgress, {
      saveFn: opts.saveFn,
      isCancelled: opts.isCancelled,
    });
  }
}

/** 记忆栏：精简开关 + 频率（写新小说 / 续写共用样式，设置全局生效）。 */
function memoryCompactControlsHtml() {
  const enabled = isCompactEnabled();
  const n = getCompactEveryN();
  return `
    <div class="ns-row ns-compact-settings" style="padding:4px 10px 8px;align-items:center;gap:8px;flex-wrap:wrap;">
      <label class="ns-switch" title="关闭后始终使用细致人物/剧情表与人物链，不会自动压成章级链">
        <input type="checkbox" class="ns-compact-enabled" ${enabled ? 'checked' : ''} /><span>启用精简</span>
      </label>
      <span class="ns-muted">每</span>
      <input type="number" class="ns-compact-every-n ns-input" min="1" max="50" step="1" value="${n}" style="width:64px;" ${enabled ? '' : 'disabled'} title="从开头连续写满 N 章后，自动把这批章压成章级剧情链与人物链" />
      <span class="ns-muted">章精简一次</span>
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

/**
 * 工坊写作 system 一次打包：预设 → 全局提示词 → 设定/总结 → 短指令。
 * generateRaw 只发这一段 system + 一段 user（并清空扩展注入、不带聊天历史）。
 */
function buildWorkshopSystemPack({ roleHint, extraRules = [], memoryObj = null, worldProj = null, reinforce = false } = {}) {
  const presetSys = readSysPrompt();
  const globalKw = readGlobalKeyword();
  const preloadOn = worldProj ? !!(worldProj.worldDefs?.preload) : true;
  const defs = worldProj ? entitiesText(worldProj) : '';
  const memory = memoryObj ? buildGrandSummary(memoryObj) : '';
  // 总结始终进 system；世界设定在预读取开启时进 system，关闭时改由 user 带一次
  const memBlock = joinPromptBlocks(preloadOn && defs ? defs : '', memory);

  return joinPromptBlocks(
    presetSys ? `【预设/系统提示】\n${presetSys}` : '',
    globalKw ? `【全局提示词】\n${globalKw}` : '',
    memBlock ? `【长期记忆】\n${memBlock}` : '',
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

  const system = buildWorkshopSystemPack({
    roleHint: '你是中文小说写作助手。按章-节结构写作。只输出本节正文，不要标题/大纲/解释；遵守设定与前文连贯。',
    memoryObj: proj,
    worldProj: proj,
    reinforce,
  });

  const user = joinPromptBlocks(
    proj.background ? `【背景】\n${clipTextHead(proj.background, 1200)}` : '',
    !preloadOn ? entitiesText(proj) : '',
    recentSectionContext(proj, flatIdx, 2),
    `【本章总览】第${actIdx + 1}章 ${act.title || ''}\n${act.overview || '(未填)'}`,
    `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${sec.outline || ''}`,
    reinforce
      ? `请重新完整撰写第${actIdx + 1}章第${secIdx + 1}节正文（须有实质内容）:`
      : `请写第${actIdx + 1}章第${secIdx + 1}节正文:`,
  );

  return { system, user };
}

/** 构建"整章总结"提示词(该章所有节, 要求 JSON 便于表格化)。 */
function buildActSummaryPrompt(proj, actIdx) {
  const act = proj.acts[actIdx];
  const system = [
    '你是小说剧情归档助手。请阅读某一章(含其所有节)的正文, 输出用于强化长期记忆的结构化总结。',
    '必须只输出一个合法 JSON 对象, 不要输出任何多余文字、代码块标记或额外的括号。严格使用如下格式(注意括号必须正确闭合、成对):',
    '{"characters":[{"name":"角色名","detail":"当前状态/关系/目标"}],"plot":["关键剧情要点1","要点2"]}',
  ].join('\n');
  const body = (act.sections || [])
    .map((s, i) => (s.content ? `【第${actIdx + 1}章 第${i + 1}节】\n${s.content}` : ''))
    .filter(Boolean)
    .join('\n\n');
  // 总结 prompt 只带最近一条总结(避免大总结太长影响 JSON 输出)
  const prev = latestSummaryText(proj);
  const user = [
    proj.background ? `【背景设定】\n${proj.background}` : '',
    prev ? `【此前总结(最新一章)】\n${prev}` : '',
    act.overview ? `【本章总览】\n${act.overview}` : '',
    `【待总结: 第${actIdx + 1}章 全部节】\n${body}`,
    '请输出 JSON 总结:',
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
async function generateSection(proj, actIdx, secIdx, flatIdx, onProgress, { skipSummary = false, reinforce = false } = {}) {
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

  novelState.activeFlatIdx = flatIdx;
  novelState.activeActIdx = actIdx;
  startGenUiProgress('novel');
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
    touchProject(proj);
    onProgress?.(
      `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}`,
      false,
    );
    await sleep(350);
    stopGenUiProgress();
    novelState.activeFlatIdx = -1;
    renderNovelChapters();
    // 仅在有效正文时更新动态总结
    await updateLiveProgress(proj, actIdx, secIdx, onProgress, {
      saveFn: () => touchProject(proj),
      isCancelled: () => novelState.cancelRequested,
    });
    refreshGrandSummary(proj, `#${EXT_ID}-novel`);
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
async function maybeSummarizeAct(proj, actIdx, onProgress, { force = false, skipAutoCompact = false } = {}) {
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
    // 整章完成且正好落在精简批次边界 → 自动精简
    if (!skipAutoCompact && !partial && actNo === getCompactThroughActNo(proj) && actNo >= getCompactEveryN()) {
      await compactGrandSummary(proj, onProgress, {
        saveFn: () => touchProject(proj),
        isCancelled: () => novelState.cancelRequested,
        summarizeAct: (o, i, p, opts) => maybeSummarizeAct(o, i, p, { ...opts, skipAutoCompact: true }),
        refreshSummariesUI: renderNovelSummaries,
        forceSummarizeCompacted: false,
      });
      refreshGrandSummary(proj, `#${EXT_ID}-novel`);
    }
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
    if (sanitizeEmptyDoneSections(cont)) saveContinuation();
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
async function generateContSection(cont, actIdx, secIdx, flatIdx, mode, onProgress, { skipSummary = false, reinforce = false } = {}) {
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

  contState.activeFlatIdx = flatIdx;
  contState.activeActIdx = actIdx;
  startGenUiProgress('cont');
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
    saveContinuation();
    onProgress?.(
      `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}`,
      false,
    );
    await sleep(350);
    stopGenUiProgress();
    contState.activeFlatIdx = -1;
    renderContinuationChapters();
    await updateLiveProgress(cont, actIdx, secIdx, onProgress, {
      saveFn: () => saveContinuation(),
      isCancelled: () => contState.cancelRequested,
    });
    refreshGrandSummary(getContinuation(), `#${EXT_ID}-analyze`);
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
async function maybeSummarizeContAct(cont, actIdx, onProgress, { force = false, skipAutoCompact = false } = {}) {
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
    if (!skipAutoCompact && !partial && actNo === getCompactThroughActNo(cont) && actNo >= getCompactEveryN()) {
      await compactGrandSummary(cont, onProgress, {
        saveFn: () => saveContinuation(),
        isCancelled: () => contState.cancelRequested,
        summarizeAct: (o, i, p, opts) => maybeSummarizeContAct(o, i, p, { ...opts, skipAutoCompact: true }),
        refreshSummariesUI: renderContSummaries,
        forceSummarizeCompacted: false,
      });
      refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
    }
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
      }
      delete act._folded;
    }
    if (!flatSections(cont).some((f) => f.sec.locked)) cont.summaries = [];
  }
  cont.liveProgress = null;
  cont.plotChain = [];
  contState.activeActIdx = -1;
  saveContinuation();
}

async function runContOutlineManual(cont) {
  if (contState.generating) return;
  collectContActsFromDOM(cont);
  if (!totalSectionCount(cont)) {
    setContHint('请先添加续写大纲(章与节)。');
    return;
  }
  let flat = flatSections(cont);
  let target = flat.find((f) => !hasValidSectionContent(f.sec));
  if (!target) {
    // 全部完成: 询问是否从头重新生成
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetContSections(cont);
    renderAnalyzeUI();
    flat = flatSections(cont);
    target = flat.find((f) => !hasValidSectionContent(f.sec));
    if (!target) return;
  }
  await withContGenerating(async () => {
    await generateContSection(cont, target.actIdx, target.secIdx, target.flatIdx, 'outline', setContHint);
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setContHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已续写${took}，请确认或重新生成。`);
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
        <div class="ns-panel__footer"><span class="ns-muted">${EXT_NAME} v2.2.1</span></div>
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

  // 记忆栏：精简开关 / 频率（写新小说与续写两处控件同步）
  $overlay.on('change', '.ns-compact-enabled', function () {
    const s = getSettings();
    s.compactEnabled = $(this).is(':checked');
    saveSettings();
    $overlay.find('.ns-compact-enabled').prop('checked', s.compactEnabled);
    $overlay.find('.ns-compact-every-n').prop('disabled', !s.compactEnabled);
    toast(s.compactEnabled ? `已启用精简（每${getCompactEveryN()}章）` : '已关闭精简，将始终使用细致总结');
  });
  $overlay.on('change', '.ns-compact-every-n', function () {
    const s = getSettings();
    const n = Number($(this).val());
    s.compactEveryN = Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 5;
    saveSettings();
    $overlay.find('.ns-compact-every-n').val(s.compactEveryN);
    if (s.compactEnabled !== false) toast(`精简频率已设为每 ${s.compactEveryN} 章`);
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

  return (cont.acts || [])
    .map((act, ai) => {
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const generating = contState.activeFlatIdx === flatIdx;
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = generating ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          const tag = generating
            ? `<span class="ns-tag ns-tag--gen">生成中</span>`
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
            <div class="ns-section ${generating ? 'ns-chapter--gen' : ''} ${locked ? 'ns-sec-locked' : ''}" data-a="${ai}" data-s="${si}">
              <div class="ns-chapter__head">
                ${dragHandle}
                <strong>第 ${si + 1} 节</strong>${tag}${outlineField}
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${!locked && (valid || sec.done) ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${!locked && !valid && !sec.done ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>生成本节</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  <button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${locked ? 'ct-sec-unlock' : 'ct-sec-lock'}" data-a="${ai}" data-s="${si}" title="${locked ? '解锁本节及之后所有节' : '锁定本节及之前所有节'}"><i class="fa-solid fa-${locked ? 'lock-open' : 'lock'}"></i></button>
                  ${!locked && sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文">清空</button>` : ''}
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
      <button class="ns-btn" data-act="ct-outline-manual">手动续写（逐节确认）</button>
      <button class="ns-btn" data-act="ct-outline-auto">自动续写（全部）</button>
      ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-outline-regen">全部重新生成</button>` : ''}
      <button class="ns-btn ns-btn--danger" data-act="ct-stop" ${contState.generating ? '' : 'disabled'}>中止</button>
      <button class="ns-btn ns-btn--danger" data-act="ct-clear" ${doneSec > 0 ? '' : 'disabled'} title="清除目前所有生成内容">清除生成内容</button>
    </div>`;

  const freeActions = `
    <div class="ns-row">
      <label class="ns-muted">续写章数<input type="number" id="${EXT_ID}-ct-target" class="ns-num" value="${cont.targetChapters || 5}" min="1" max="200" /></label>
      <button class="ns-btn" data-act="ct-free-start">开始自然续写</button>
      ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-free-regen">全部重新生成</button>` : ''}
      <button class="ns-btn ns-btn--danger" data-act="ct-stop" ${contState.generating ? '' : 'disabled'}>中止</button>
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
        <div class="ns-row" style="padding:4px 10px 0;">
          <button class="ns-btn ns-btn--sm" data-act="ct-resum" ${contState.generating ? 'disabled' : ''} title="重新生成各章总结；启用精简时会按频率自动压成章级链">全部重新总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-clear-sum" title="清空所有章节总结">清空总结</button>
        </div>
        ${memoryCompactControlsHtml()}
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
  $(`#${EXT_ID}-ct-hint`).text((busy ? '生成中… ' : '') + (msg || ''));
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
          setContHint('已清除所有生成内容。');
          renderAnalyzeUI();
          toast('已清除生成内容');
        }
        return;
      case 'ct-gen-sec':
        if (cont && !contState.generating) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && cont.acts[ai]?.sections[si]) {
            collectContActsFromDOM(cont);
            const secToRegen = cont.acts[ai].sections[si];
            secToRegen.done = false;
            secToRegen.content = '';
            saveContinuation();
            const flat = flatSections(cont);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            resetGenerationChannel('cont', { hard: true });
            await sleep(350);
            await withContGenerating(async () => {
              await generateContSection(cont, ai, si, f ? f.flatIdx : -1, cont.mode || 'outline', setContHint, {
                skipSummary: true,
                reinforce: true,
              });
              setContHint(
                `第 ${ai + 1} 章 第 ${si + 1} 节已重新生成` +
                  (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                  '。',
              );
            });
            renderAnalyzeUI();
          }
        }
        return;
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
          const n = getCompactEveryN();
          const compactHint = isCompactEnabled()
            ? `并按「每${n}章」自动精简：已满批次压成章级剧情链/人物链，余章与当前章保留细致表与节级链`
            : '精简已关闭，将全部使用细致人物/剧情表与人物链';
          if (!globalThis.confirm?.(`将重新生成各章细致总结，${compactHint}。确定继续？`)) return;
          await withContGenerating(async () => {
            await regenAllContSummaries(cont, setContHint);
            setContHint('全部重新总结完成。');
          });
          renderAnalyzeUI();
        }
        return;
      case 'ct-clear-sum':
        if (cont) {
          if (!globalThis.confirm?.('确定清空所有章节总结？（已生成的正文不受影响）')) return;
          cont.summaries = [];
          cont.plotChain = [];
          saveContinuation();
          renderAnalyzeUI();
          toast('已清空所有章节总结');
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
      <label class="ns-switch" title="开启后，世界设定与总结一并写入单次 System；关闭时总结仍在 System，设定改放 User。均只发送一次，不重复。">
        <input type="checkbox" id="${EXT_ID}-wd-preload" ${wd.preload ? 'checked' : ''} />
        <span>预读取（设定并入 System，与总结一次发送）</span>
      </label>
    </div>`;
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
  $(`#${EXT_ID}-nv-hint`).text((busy ? '生成中… ' : '') + (msg || ''));
}

/** 渲染章-节层次的章节列表 HTML(正在生成的节内嵌动画)。 */
function novelChapterListHtml(proj) {
  const flat = flatSections(proj);
  const flatByAS = {}; // `${actIdx}_${secIdx}` -> flatIdx
  flat.forEach((f) => (flatByAS[`${f.actIdx}_${f.secIdx}`] = f.flatIdx));

  return (proj.acts || [])
    .map((act, ai) => {
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const generating = novelState.activeFlatIdx === flatIdx;
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = generating ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          const tag = generating
            ? `<span class="ns-tag ns-tag--gen">生成中</span>`
            : valid
              ? `<span class="ns-tag ns-tag--done">已生成</span>`
              : sec.done
                ? `<span class="ns-tag">空回·待重生</span>`
                : `<span class="ns-tag">未生成</span>`;
          const locked = isSectionLocked(sec);
          return `
            <div class="ns-section ${generating ? 'ns-chapter--gen' : ''} ${locked ? 'ns-sec-locked' : ''}" data-a="${ai}" data-s="${si}">
              <div class="ns-chapter__head">
                ${locked ? '<span class="ns-lock-icon" title="已锁定"><i class="fa-solid fa-lock"></i></span>' : `<span class="ns-drag-handle" title="拖拽排序"><i class="fa-solid fa-grip-lines"></i></span>`}
                <strong>第 ${si + 1} 节</strong>
                ${tag}
                <textarea class="ns-sec-outline" data-a="${ai}" data-s="${si}" rows="1" placeholder="本节大纲…">${esc(sec.outline || '')}</textarea>
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${!locked && (valid || sec.done) ? `<button class="ns-btn ns-btn--sm" data-act="gen-sec" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${!locked && !valid && !sec.done ? `<button class="ns-btn ns-btn--sm" data-act="gen-sec" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''}>生成本节</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  <button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${locked ? 'sec-unlock' : 'sec-lock'}" data-a="${ai}" data-s="${si}" title="${locked ? '解锁本节及之后所有节' : '锁定本节及之前所有节'}"><i class="fa-solid fa-${locked ? 'lock-open' : 'lock'}"></i></button>
                  ${!locked && sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文">清空</button>` : ''}
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
          <button class="ns-btn" data-act="mode-manual" title="逐节生成，每节需确认或重新生成">手动模式（逐节确认）</button>
          <button class="ns-btn" data-act="mode-auto" title="一次性生成所有未完成节">自动模式（全部生成）</button>
          <button class="ns-btn ns-btn--danger" data-act="stop" ${novelState.generating ? '' : 'disabled'}>中止</button>
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
        <div class="ns-row" style="padding:4px 10px 0;">
          <button class="ns-btn ns-btn--sm" data-act="nv-resum" ${novelState.generating ? 'disabled' : ''} title="重新生成各章总结；启用精简时会按频率自动压成章级链">全部重新总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="nv-clear-sum" title="清空所有章节总结">清空总结</button>
        </div>
        ${memoryCompactControlsHtml()}
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
        <strong><i class="fa-solid fa-layer-group" style="margin-right:4px;"></i>大总结（全书汇总 + 最新进度）</strong>
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

/** 写小说: 强制重新总结所有已有正文的章，并按精简频率自动压链。 */
async function regenAllSummaries(proj, onProgress) {
  proj.summaries = [];
  proj.plotChain = [];
  touchProject(proj);
  for (let i = 0; i < (proj.acts || []).length; i++) {
    if (actHasGeneratedContent(proj.acts[i])) {
      await maybeSummarizeAct(proj, i, onProgress, { force: true, skipAutoCompact: true });
      renderNovelSummaries();
    }
  }
  // maybeSummarizeAct 在批次边界可能已自动精简；此处再统一套用记忆策略（含未满批的细致重建）
  await applySummaryMemoryPolicy(proj, onProgress, {
    saveFn: () => touchProject(proj),
    isCancelled: () => novelState.cancelRequested,
    summarizeAct: (o, i, p, opts) => maybeSummarizeAct(o, i, p, opts),
    refreshSummariesUI: renderNovelSummaries,
    forceSummarizeCompacted: false,
  });
  refreshGrandSummary(proj, `#${EXT_ID}-novel`);
  renderNovelSummaries();
}

/** 续写: 强制重新总结所有已有正文的章，并按精简频率自动压链。 */
async function regenAllContSummaries(cont, onProgress) {
  cont.summaries = [];
  cont.plotChain = [];
  saveContinuation();
  for (let i = 0; i < (cont.acts || []).length; i++) {
    if (actHasGeneratedContent(cont.acts[i])) {
      await maybeSummarizeContAct(cont, i, onProgress, { force: true, skipAutoCompact: true });
      renderContSummaries();
    }
  }
  await applySummaryMemoryPolicy(cont, onProgress, {
    saveFn: () => saveContinuation(),
    isCancelled: () => contState.cancelRequested,
    summarizeAct: (o, i, p, opts) => maybeSummarizeContAct(o, i, p, opts),
    refreshSummariesUI: renderContSummaries,
    forceSummarizeCompacted: false,
  });
  refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
  renderContSummaries();
}

/** 清空写小说所有节的正文/完成状态与总结, 用于从头重新生成。 */
function resetProjSections(proj) {
  for (const act of proj.acts || []) {
    for (const sec of act.sections || []) {
      if (isSectionLocked(sec)) continue; // 跳过锁定节
      sec.content = '';
      sec.done = false;
      sec.updatedAt = 0;
    }
    delete act._folded;
  }
  // 若有锁定节，不清空总结（锁定内容的总结需保留）
  if (!flatSections(proj).some((f) => f.sec.locked)) proj.summaries = [];
  proj.liveProgress = null;
  proj.plotChain = [];
  novelState.activeActIdx = -1;
  touchProject(proj);
}

/** 手动模式: 生成下一个未完成节。 */
async function runManualStep(proj) {
  if (novelState.generating) return;
  collectActsFromDOM(proj);
  if (!totalSectionCount(proj)) return void setNovelHint('请先添加章与节。');
  let flat = flatSections(proj);
  let target = flat.find((f) => !hasValidSectionContent(f.sec));
  if (!target) {
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetProjSections(proj);
    renderNovelUI();
    flat = flatSections(proj);
    target = flat.find((f) => !hasValidSectionContent(f.sec));
    if (!target) return;
  }
  await withGenerating(async () => {
    await generateSection(proj, target.actIdx, target.secIdx, target.flatIdx, setNovelHint);
    const took = genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
    setNovelHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已生成${took}，请确认或重新生成。`);
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
          setNovelHint('已清除所有生成内容。');
          renderNovelUI();
          toast('已清除生成内容');
        }
        break;
      case 'nv-resum':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          const n = getCompactEveryN();
          const compactHint = isCompactEnabled()
            ? `并按「每${n}章」自动精简：已满批次压成章级剧情链/人物链，余章与当前章保留细致表与节级链`
            : '精简已关闭，将全部使用细致人物/剧情表与人物链';
          if (!globalThis.confirm?.(`将重新生成各章细致总结，${compactHint}。确定继续？`)) return;
          await withGenerating(async () => {
            await regenAllSummaries(proj, setNovelHint);
            setNovelHint('全部重新总结完成。');
          });
          renderNovelUI();
        }
        break;
      case 'nv-clear-sum':
        if (proj) {
          if (!globalThis.confirm?.('确定清空所有章节总结？（已生成的正文不受影响）')) return;
          proj.summaries = [];
          proj.plotChain = [];
          touchProject(proj);
          renderNovelUI();
          toast('已清空所有章节总结');
        }
        break;
      case 'export':
        if (proj) exportProject(proj);
        break;
      case 'gen-sec':
        if (proj) {
          if (novelState.generating) return;
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && proj.acts[ai]?.sections[si]) {
            collectActsFromDOM(proj);
            const secToRegen = proj.acts[ai].sections[si];
            secToRegen.done = false;
            secToRegen.content = '';
            touchProject(proj);
            const flat = flatSections(proj);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            resetGenerationChannel('novel', { hard: true });
            await sleep(350);
            await withGenerating(async () => {
              await generateSection(proj, ai, si, f ? f.flatIdx : -1, setNovelHint, {
                skipSummary: true,
                reinforce: true,
              });
              setNovelHint(
                `第 ${ai + 1} 章 第 ${si + 1} 节已重新生成` +
                  (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                  '。',
              );
            });
            renderNovelUI();
          }
        }
        break;
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
