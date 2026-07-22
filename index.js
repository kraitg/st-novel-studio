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
  /** 名词库：主切换 cont=续写小说 / novel=新小说 */
  nounBoardMode: 'cont',
  /** 主工作区当前功能：'' | cont | novel | keyword | idea */
  studioActiveView: '',
  /** 名词库复制板：各来源开关（次级筛选） */
  nounBoardSources: {
    contChars: true,
    contFactions: true,
    novelChars: true,
    novelItems: true,
    novelPlaces: true,
    novelOthers: true,
  },
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

/**
 * 从全局提示词中尽量识别字数要求（如「每节800字」「1000-1500字」「不少于1200字」）。
 * 返回给提示词用的短说明；识别不到则空串（仍要求模型遵守全文全局提示词）。
 */
function extractLengthHintFromKeyword(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return '';
  const ranges = [
    /(?:每节|每章|每段|本节|每回|字数|篇幅)?(?:要求|控制在|保持|约|大约|不少于|至少|达到)?(\d{3,5})[-~～—到至](\d{3,5})字/,
    /(\d{3,5})[-~～—到至](\d{3,5})字/,
  ];
  for (const re of ranges) {
    const m = t.match(re);
    if (m) return `约 ${m[1]}-${m[2]} 字`;
  }
  const singles = [
    /(?:每节|每章|每段|本节|每回)(?:正文)?(?:约|大约|不少于|至少|达到|写到|控制在)?(\d{3,5})字/,
    /(?:字数|篇幅)(?:要求|为|约|大约|不少于|至少|达到|控制在)?(\d{3,5})字/,
    /(?:不少于|至少|达到|约|大约)(\d{3,5})字/,
    /(\d{3,5})字(?:左右|上下|以上)?/,
  ];
  for (const re of singles) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 200) return `约 ${n} 字`;
    }
  }
  return '';
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

/**
 * 用上传文件名作为小说/项目标题（不用正文内容推断）。
 */
function inferUploadedNovelTitle(_text, fileName = '') {
  const fromFile = String(fileName || '')
    .replace(/\.[^.]+$/i, '')
    .trim();
  return fromFile || '导入的小说';
}

/** 比较项目名与上传文件名是否同属一书（忽略扩展名与首尾空白）。 */
function titlesMatchProject(a, b) {
  const norm = (t) =>
    String(t || '')
      .replace(/\.[^.]+$/i, '')
      .trim()
      .replace(/\s+/g, '');
  const na = norm(a);
  const nb = norm(b);
  return !!(na && nb && na === nb);
}

/* ================================================================== */
/* 写小说模块                                                          */
/* ================================================================== */

const novelState = {
  generating: false,
  cancelRequested: false,
  currentGenId: '',
  activeFlatIdx: -1,
  activeActIdx: -1,
  /** 当前工作区 DOM 对应的项目 id；切换项目时把 DOM 写回此 id，避免串设定 */
  renderedProjectId: '',
};
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

/**
 * 模拟流式推进：按阶段期望耗时逼近 95%，真正结束再到 100%。
 * gen≈正文生成(约 50s 半程)；summary≈动态总结(约 18s)；wait≈冷却重试(慢爬)。
 */
function estimatedStreamPct(elapsedMs, phase = 'gen') {
  const t = Math.max(0, Number(elapsedMs) / 1000);
  if (t <= 0) return 1;
  const p = phase || genUiProgress.phase || 'gen';
  const tau = p === 'summary' ? 18 : p === 'wait' ? 10 : 50;
  // 前 2s 略快给反馈，之后按指数逼近 95%
  const soft = 96 * (1 - Math.exp(-t / tau));
  return Math.min(95, Math.max(2, Math.round(soft)));
}

/** 某节是否正在显示节内工作条（生成或总结）。仅看进行中/收尾，不单靠残留 statusMsg。 */
function isSectionWorking(channel, flatIdx) {
  return (
    genUiProgress.channel === channel &&
    genUiProgress.targetFlatIdx === flatIdx &&
    flatIdx >= 0 &&
    (!!genUiProgress.startedAt || !!genUiProgress.finishing)
  );
}

/** 更新当前生成节内的工作状态文案。 */
function setGenSectionStatus(msg, { phase } = {}) {
  genUiProgress.statusMsg = String(msg || '').trim();
  if (phase) genUiProgress.phase = phase;
  paintGenUiProgress();
}

function genProgressBlockHtml() {
  const pct = Math.max(0, Math.min(100, Math.round(genUiProgress.pct || 0)));
  const elapsed = formatGenElapsed(
    genUiProgress.startedAt ? Date.now() - genUiProgress.startedAt : genUiProgress.lastElapsedMs,
  );
  const summarizing = genUiProgress.phase === 'summary';
  const status = genUiProgress.statusMsg || (summarizing ? '总结中…' : '生成中…');
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
  // 同步节操作栏上的中止文案（与「生成本节」同行）
  const summarizing = genUiProgress.phase === 'summary';
  const outlining = /大纲/.test(genUiProgress.statusMsg || '');
  $root.find('.ns-chapter--gen .ns-chapter__actions [data-act="stop"], .ns-chapter--gen .ns-chapter__actions [data-act="ct-stop"]').text(
    summarizing ? '中止总结' : outlining ? '中止大纲' : '中止',
  );
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
    genUiProgress.pct = estimatedStreamPct(Date.now() - genUiProgress.startedAt, genUiProgress.phase);
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
    genUiProgress.pct = estimatedStreamPct(Date.now() - genUiProgress.startedAt, 'summary');
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
  // 成功收尾时清掉「瞬时错误/重试」残留文案，避免正文已出仍显示失败态
  if (/瞬时错误|空回|重试|冷却中|限流|502|504/.test(genUiProgress.statusMsg || '')) {
    genUiProgress.statusMsg =
      genUiProgress.phase === 'summary' ? '总结完成' : '生成完成';
  }
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

/** 总结栏内工作状态（重新章节总结 / 动态大总结）。 */
const summaryBarUi = { cont: '', novel: '' };

function setSummaryBarStatus(kind, msg) {
  const k = kind === 'cont' ? 'cont' : 'novel';
  summaryBarUi[k] = String(msg || '').trim();
  paintSummaryBarStatus(k);
}

function clearSummaryBarStatus(kind) {
  setSummaryBarStatus(kind, '');
}

function paintSummaryBarStatus(kind) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const k = kind === 'cont' ? 'cont' : 'novel';
  const id = k === 'cont' ? `${EXT_ID}-ct-summary-work` : `${EXT_ID}-nv-summary-work`;
  const msg = summaryBarUi[k];
  const $el = $(`#${id}`);
  if (!$el.length) return;
  if (!msg) {
    $el.hide();
    $el.find('.ns-summary-work__text').text('');
    return;
  }
  $el.show();
  $el.find('.ns-summary-work__text').text(msg);
}

function summaryBarHtml(kind) {
  const k = kind === 'cont' ? 'cont' : 'novel';
  const id = k === 'cont' ? `${EXT_ID}-ct-summary-work` : `${EXT_ID}-nv-summary-work`;
  const msg = summaryBarUi[k];
  return `<div class="ns-summary-work" id="${id}"${msg ? '' : ' style="display:none;"'} role="status">
    <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
    <span class="ns-summary-work__text">${esc(msg || '')}</span>
  </div>`;
}

/** 总结进度：写进总结栏，并可选同步顶部 hint。 */
function makeSummaryBarProgress(kind, fallbackHint) {
  const foldKey = kind === 'cont' ? 'ct-summaries' : 'nv-summaries';
  const grandKey = kind === 'cont' ? 'ct-grand' : 'nv-grand';
  return (msg, busy) => {
    const text = String(msg || '')
      .replace(/^生成中…\s*/, '')
      .trim();
    if (busy || text) {
      setUiOpen(foldKey, true);
      setUiOpen(grandKey, true);
      setSummaryBarStatus(kind, text || '总结中…');
    } else if (!text) {
      clearSummaryBarStatus(kind);
    }
    fallbackHint?.(msg, busy);
  };
}

/**
 * 面板折叠状态。默认全部折叠；仅用户手动点击会改变，重绘/开关面板不自动改。
 * modules.* 已由左侧操作栏 studioActiveView 取代，保留字段避免旧逻辑报错。
 * open[key] = true 表示对应子折叠块展开。
 */
const uiFoldState = {
  modules: { analyze: false, novel: false },
  open: Object.create(null),
};

const STUDIO_VIEWS = [
  { key: 'cont', label: '续写小说', icon: 'fa-book-open' },
  { key: 'novel', label: '写新小说', icon: 'fa-feather-pointed' },
  { key: 'keyword', label: '全局提示词', icon: 'fa-key' },
  { key: 'idea', label: '创意灵感', icon: 'fa-lightbulb' },
];

function getStudioActiveView() {
  const v = getSettings().studioActiveView;
  if (v === 'cont' || v === 'novel' || v === 'keyword' || v === 'idea') return v;
  return '';
}

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
/** 全书已生成正文字数（各节 content 去首尾空白后累加）。 */
function generatedContentCharCount(obj) {
  let n = 0;
  for (const f of flatSections(obj)) {
    const t = String(f?.sec?.content || '').trim();
    if (t) n += t.length;
  }
  return n;
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
/**
 * 自然续写：章是否已可做表格总结。
 * 跳过标记的节（outlineSkipped/bodySkipped）不要求有正文，其余节须全部有正文。
 */
function isFreeActReadyForTableSummary(act) {
  const secs = act?.sections || [];
  if (!secs.length) return false;
  let any = false;
  for (const s of secs) {
    if (s?.outlineSkipped || s?.bodySkipped) continue;
    if (!hasValidSectionContent(s)) return false;
    any = true;
  }
  return any;
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

/**
 * 自然续写：锁定本节及之前（大纲 + 正文一并锁定）。
 */
function lockFreeUpToSection(cont, targetActIdx, targetSecIdx) {
  const flat = flatSections(cont);
  const targetFlat = flat.find((f) => f.actIdx === targetActIdx && f.secIdx === targetSecIdx);
  if (!targetFlat) return;
  for (const f of flat) {
    if (f.flatIdx <= targetFlat.flatIdx) {
      f.sec.locked = true;
      f.sec.outlineLocked = true;
    }
  }
}

/**
 * 自然续写：解锁本节及之后（大纲 + 正文一并解锁）。
 */
function unlockFreeFromSection(cont, targetActIdx, targetSecIdx) {
  const flat = flatSections(cont);
  const targetFlat = flat.find((f) => f.actIdx === targetActIdx && f.secIdx === targetSecIdx);
  if (!targetFlat) return;
  for (const f of flat) {
    if (f.flatIdx >= targetFlat.flatIdx) {
      f.sec.locked = false;
      delete f.sec.outlineLocked;
    }
  }
}

/** 检查节是否被锁定。 */
function isSectionLocked(sec) {
  return !!sec.locked;
}

/** 自然续写：节大纲是否锁定（重新生成大纲时跳过）。 */
function isOutlineLocked(sec) {
  return !!(sec && sec.outlineLocked);
}

/** 自然续写：大纲或正文任一锁定即视为已锁定（合并锁）。 */
function isFreeSectionLocked(sec) {
  return isSectionLocked(sec) || isOutlineLocked(sec);
}

/** 重新生成大纲时应跳过该节（大纲锁定或节内容锁定）。 */
function shouldSkipFreeOutlineRegen(sec) {
  return isOutlineLocked(sec) || isSectionLocked(sec);
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
  // 用户主动中止：不可当瞬时错误去重试
  if (isCancelError(err)) return false;
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

/** 用户主动中止（统一文案「已中止」）。 */
function isCancelError(err) {
  return /已中止/.test(String(err?.message || err || ''));
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

/**
 * 原「限制请求频率」已移除；保留空实现以兼容旧调用点。
 */
let autoSectionRpmDepth = 0;
function isAutoSectionRpmActive() {
  return false;
}
function getRateLimitPerMinute() {
  return 5;
}
function pruneRpmWindow() {}
function getRpmWaitMs() {
  return 0;
}
function recordRpmRequest() {}
async function withAutoSectionRpm(fn) {
  return fn();
}
async function waitSectionRpmLimit() {}

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
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : getSettings().genTimeoutMs || 180000;
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
      await waitSectionRpmLimit(shouldCancel);
      await waitGenThrottle(shouldCancel);
      recordRpmRequest();
      try {
        if (th && typeof th.generateRaw === 'function') {
          // 必须显式给出 user_input + 'user_input' 占位：
          // 若只放 RolePrompt 且不传 user_input，酒馆助手会在末尾再追加空 user_input，
          // Gemini 等模型常因此返回 content="" / completion_tokens=0。
          // 世界书并入单一 system（与原生 generateRaw 一致）：多段 system 在部分
          // Gemini/search 线路上更易空 completion。
          const ordered = [{ role: 'system', content: systemWithWi || system || ' ' }, 'user_input'];
          const result = await th.generateRaw({
            user_input: user,
            // 自定义顺序：合并后的 system + user；不带聊天历史/默认占位
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
              sysLen: String(systemWithWi || system || '').length,
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
  // 普通额外重试（空回/网络等）；502/504 遇到后再抬到 2 次；opts.maxRetries 可抬高（自然续写）
  let maxRetries =
    opts.maxRetries != null
      ? Math.max(0, Math.min(6, Number(opts.maxRetries) || 0))
      : Math.min(2, Math.max(0, s.genMaxRetries ?? 1));
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
      if (shouldCancel?.()) throw new Error('已中止');
      if (isEmptyReply(text, minLen)) {
        lastErr = new Error('空回复');
        log.warn(`生成得到空回复(len=${String(text ?? '').trim().length}), 第 ${attempt + 1} 次…`, {
          sysLen: String(system || '').length,
          userLen: String(user || '').length,
        });
        if (attempt >= maxRetries) {
          throw new Error(`多次空回复(已重试 ${maxRetries + 1} 次)`);
        }
      } else {
        if (attempt > 0) log.info(`生成在第 ${attempt + 1} 次尝试成功`);
        // 成功后立刻清掉「瞬时错误/重试」文案，避免正文已生成仍显示失败态
        if (genUiProgress.startedAt || genUiProgress.finishing) {
          setGenSectionStatus(
            genUiProgress.phase === 'summary' ? '总结中…' : '生成中…',
            { phase: genUiProgress.phase === 'summary' ? 'summary' : 'gen' },
          );
        }
        return text;
      }
    } catch (e) {
      if (shouldCancel?.() || isCancelError(e)) throw new Error('已中止');
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
    // 指数退避；429/abort 额外拉长。空回不再强制 14s×N（与外层重试叠成「长时间等待」）
    if (attempt < maxRetries) {
      let delay = calcRetryDelayMs(attempt, lastErr);
      const errMsg = String(lastErr?.message || '');
      if (/abort/i.test(errMsg)) {
        // 上一轮 abort 残留时立刻重发极易再空回
        delay = Math.max(delay, 8000 * (attempt + 1));
      }
      const codeHint = isGatewayError(lastErr)
        ? '502/504'
        : isRateLimitError(lastErr)
          ? '限流'
          : /空回复/.test(errMsg)
            ? '空回'
            : /abort/i.test(errMsg)
              ? '中断'
              : '瞬时错误';
      setGenSectionStatus(
        `生成中… 遇${codeHint}，${Math.round(delay / 1000)}s 后重试(${attempt + 2}/${maxRetries + 1})…`,
        { phase: 'wait' },
      );
      log.info(`${delay}ms 后重试(${attempt + 2}/${maxRetries + 1})…`);
      await waitCancellable(delay, shouldCancel);
      // 给通道喘口气，避免 abort/空回残留立刻连打
      await sleep(/abort|空回复/i.test(errMsg) ? 600 : 250);
    }
  }
  throw lastErr || new Error('生成失败');
}

async function novelGenerate({ system, user }, opts = {}) {
  const gid = `novel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  novelState.currentGenId = gid;
  const proj = getActiveProject();
  // 总结类 JSON 任务应 skipWorldInfo，避免 WI 撑爆导致空回
  const worldBookName = opts.skipWorldInfo
    ? ''
    : (opts.worldBookName ?? proj?.worldBookName ?? '');
  return novelGenerateWithId({ system, user }, gid, () => novelState.cancelRequested, {
    ...opts,
    worldBookName,
    wiScanText: opts.wiScanText || `${user}\n${String(system || '').slice(0, 2000)}`,
  });
}

/**
 * 清理生成通道状态。
 * @param {'novel'|'cont'} kind
 * @param {{ hard?: boolean }} opts
 *   hard=true：仅停止「当前记录的 generation_id」（不要 stopAll）。
 *   stopAll 会留下 AbortSignal，紧接着的 generateRaw 常直接空回/aborted；
 *   空回重试、首写、重新生成在发请求前都只能 soft / 按 id 停，绝不能 stopAll。
 */
function resetGenerationChannel(kind = 'novel', { hard = false } = {}) {
  const state = kind === 'cont' ? contState : novelState;
  if (hard) {
    const th = getTavernHelper();
    const gid = state.currentGenId;
    try {
      if (gid && th?.stopGenerationById) th.stopGenerationById(gid);
      // 无 gid 时也不调用 stopAll：会误伤即将发出的下一次请求
    } catch (e) {
      log.debug('清理生成通道时忽略:', e?.message || e);
    }
  }
  state.cancelRequested = false;
  state.currentGenId = '';
}

/**
 * 发新请求前的安全复位：清旗标；若有残留 gid 只停该 id；短暂等待。
 * 禁止 stopAll（保存大纲后点「重新生成」曾因此整链空回，直到一次无 stopAll 的首写才恢复）。
 */
async function prepareGenerationChannel(kind = 'novel', { hadPriorContent = false } = {}) {
  resetGenerationChannel(kind, { hard: !!hadPriorContent });
  await sleep(hadPriorContent ? 120 : 40);
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

/** 人物链节点正文（兼容旧版纯字符串）。 */
function chainStepText(x) {
  if (typeof x === 'string') return x.trim();
  return String(x?.step || x?.text || '').trim();
}

/** 人物链节点所属全书节号（0=未知/旧数据）。 */
function chainStepSecNo(x) {
  if (x && typeof x === 'object') return Number(x.secNo) || 0;
  return 0;
}

/** 规整人物链节点为 {secNo, step}[]。 */
function normalizeCharChainSteps(chain) {
  if (!Array.isArray(chain)) return [];
  return chain
    .map((x) => {
      const step = chainStepText(x);
      if (!step) return null;
      return { secNo: chainStepSecNo(x), step };
    })
    .filter(Boolean);
}

/** 人物链格式化为「A → B → C」。 */
function formatCharChain(chain) {
  const steps = normalizeCharChainSteps(chain).map((x) => x.step);
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
 * 保留 secNo 标记。
 */
function dedupeChainSteps(chain) {
  const out = [];
  for (const raw of normalizeCharChainSteps(chain)) {
    const s = raw.step;
    let simIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < out.length; i++) {
      const sim = chainStepSimilarity(out[i].step, s);
      if (sim > bestSim) {
        bestSim = sim;
        simIdx = i;
      }
    }
    if (bestSim >= 0.4 && simIdx >= 0) {
      if (simIdx === out.length - 1) {
        if (s.length > out[simIdx].step.length) {
          out[simIdx] = { secNo: raw.secNo || out[simIdx].secNo, step: s };
        } else if (raw.secNo && !out[simIdx].secNo) {
          out[simIdx].secNo = raw.secNo;
        }
      }
      continue;
    }
    out.push({ secNo: raw.secNo, step: s });
  }
  return out;
}

/** 仅当新状态与链中已有节点均不近义时才追加。 */
function appendChainStep(chain, step, secNo = 0) {
  const s = chainStepText(step);
  if (!s || !Array.isArray(chain)) return false;
  for (let i = 0; i < chain.length; i++) {
    if (isSimilarChainStep(chainStepText(chain[i]), s)) {
      if (i === chain.length - 1 && s.length > chainStepText(chain[i]).length) {
        chain[i] = { secNo: secNo || chainStepSecNo(chain[i]), step: s };
      }
      return false;
    }
  }
  chain.push({ secNo: Number(secNo) || 0, step: s });
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
 * 确认总结用：按节写入人物链。
 * - replace=false：只追加本节节点，不改其它节
 * - replace=true：先去掉该 secNo 的旧节点，再写入新节点（重生本节）
 */
function appendOnlyCharChains(prevChains, deltaChains, { secNo = 0, replace = false } = {}) {
  const result = (prevChains || []).map((c) => ({
    name: String(c?.name || '').trim(),
    chain: normalizeCharChainSteps(c?.chain),
    latest: String(c?.latest || '').trim(),
  }));

  if (replace && secNo > 0) {
    for (const c of result) {
      const before = c.chain.length;
      c.chain = c.chain.filter((s) => s.secNo !== secNo);
      // 旧数据无 secNo：若整条链都未打标，且本角色会出现在 delta 里，去掉末节点视作旧版本节
      if (before && c.chain.length === before && c.chain.every((s) => !s.secNo)) {
        const willTouch = (deltaChains || []).some((d) => normCharName(d?.name) === normCharName(c.name));
        if (willTouch) c.chain.pop();
      }
    }
  }

  for (const d of deltaChains || []) {
    const name = String(d?.name || '').trim();
    const steps = normalizeCharChainSteps(d?.chain).map((s) => s.step);
    const latest = String(d?.latest || d?.detail || '').trim();
    if (!name && !steps.length && !latest) continue;
    let hit = result.find((x) => normCharName(x.name) === normCharName(name));
    if (!hit) {
      result.push({
        name: name || '?',
        chain: steps.map((step) => ({ secNo: secNo || 0, step })),
        latest: latest || steps[steps.length - 1] || '',
      });
      continue;
    }
    if (name) hit.name = name;
    for (const s of steps) {
      if (hit.chain.some((exist) => isSimilarChainStep(exist.step, s))) continue;
      hit.chain.push({ secNo: secNo || 0, step: s });
    }
    if (latest) hit.latest = latest;
    else if (!hit.latest && hit.chain.length) hit.latest = hit.chain[hit.chain.length - 1].step;
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
  const steps = normalizeCharChainSteps(c?.chain);
  return steps.length ? steps[steps.length - 1].step : '';
}

/** 剧情链时间信息展示文本。 */
function formatPlotTime(p) {
  if (!p) return '';
  const parts = [];
  const timeNow = String(p.timeNow || '').trim();
  const timeElapsed = String(p.timeElapsed || '').trim();
  const dayNight = String(p.dayNight || '').trim();
  if (timeNow) parts.push(`此刻 ${timeNow}`);
  if (timeElapsed) parts.push(`已过 ${timeElapsed}`);
  if (dayNight) parts.push(dayNight);
  return parts.join(' · ');
}

/**
 * 确认总结用：写入「本节」剧情链节点（同 secNo 则整节点替换，含时间信息）。
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
    timeNow: String(node.timeNow || '').trim(),
    timeElapsed: String(node.timeElapsed || '').trim(),
    dayNight: String(node.dayNight || '').trim(),
  };
  const idx = list.findIndex((p) => (secNo && p.secNo === secNo) || (actNo && secInAct && p.actNo === actNo && p.secInAct === secInAct));
  if (idx >= 0) list[idx] = { ...list[idx], ...next };
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
    chain: normalizeCharChainSteps(c.chain),
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
          const steps = normalizeCharChainSteps(c.chain);
          const traj = steps.length
            ? steps
                .map((s, i) => `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-chain-step" title="${s.secNo ? esc('全书第' + s.secNo + '节') : ''}">${esc(s.step)}</span>`)
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

/**
 * 写作注入用紧凑大总结：剧情链末尾 + 人物链末几步；可选近章总结。
 * 自然续写跨章应 skipChapterSummaries：章表总结很肥，易把 Gemini 打到 completion_tokens=0。
 */
function buildGrandSummaryForWrite(
  obj,
  {
    maxChars = 1600,
    plotKeep = 8,
    chainStepKeep = 2,
    skipChapterSummaries = false,
    latestOnly = false,
  } = {},
) {
  stripLegacyCompactFields(obj);
  const parts = [];
  if (!skipChapterSummaries) {
    const sums = Array.isArray(obj?.summaries) ? [...obj.summaries] : [];
    sums.sort((a, b) => (a.actNo || 0) - (b.actNo || 0));
    if (sums.length) {
      const recent = sums.slice(-1);
      const body = recent
        .map((s) => `●第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}${s.partial ? '(未完成)' : ''}\n${summaryToCompact(s)}`)
        .join('\n\n');
      parts.push(`【近章总结】\n${clipTextHead(body, 500)}`);
    }
  }
  const plotChain = normalizePlotChain(obj?.plotChain);
  if (plotChain.length) {
    const slice = plotChain.slice(-Math.max(2, plotKeep));
    parts.push(plotChainToText(slice));
  }
  const chains = collectCharChains(obj).map((c) => ({
    name: c.name,
    latest: c.latest,
    chain: latestOnly ? [] : normalizeCharChainSteps(c.chain).slice(-Math.max(1, chainStepKeep)),
  }));
  const chainText = latestOnly
    ? (() => {
        const lines = chains
          .filter((c) => c.name || c.latest)
          .slice(0, 12)
          .map((c) => `- ${c.name || '?'}：${resolveCharLatest(c, obj) || '(状态未知)'}`);
        return lines.length ? `【人物近况】\n${lines.join('\n')}` : '';
      })()
    : charChainsToText(chains, obj);
  if (chainText) parts.push(chainText);
  const joined = parts.join('\n\n');
  return maxChars ? clipTextTail(joined, maxChars) : joined;
}

/**
 * 按优先级拼装提示块，总长不超过 budget（字符），防止 Gemini 空 completion。
 * parts: [{ text, prio }] prio 越小越优先保留。
 */
function joinPromptBlocksBudget(parts, budget) {
  const items = (parts || [])
    .map((p) => ({ text: String(p?.text || '').trim(), prio: Number(p?.prio) || 99 }))
    .filter((p) => p.text);
  items.sort((a, b) => a.prio - b.prio);
  const out = [];
  let used = 0;
  for (const it of items) {
    const sep = out.length ? 2 : 0;
    const room = budget - used - sep;
    if (room < 40) break;
    const chunk = it.text.length <= room ? it.text : `${it.text.slice(0, Math.max(20, room - 1))}…`;
    out.push(chunk);
    used += chunk.length + sep;
  }
  return out.join('\n\n');
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
 * 单节动态总结提示词。
 * replace=true：本节为重新生成，输出用于「替换」本节旧节点的内容。
 * slim=true：空回重试用，进一步压缩上下文（不注入世界书/全局提示词）。
 */
function buildLiveProgressPrompt(obj, actIdx, secIdx, { replace = false, slim = false } = {}) {
  const rawBody =
    sectionBodyText(obj, actIdx, secIdx) || String(obj?.acts?.[actIdx]?.sections?.[secIdx]?.content || '').trim();
  // 总结只需节选（头尾）；全文易撑爆上下文导致 Gemini completion_tokens=0
  const bodyCap = slim ? 1400 : 2800;
  const secBody = (() => {
    const t = String(rawBody || '').trim();
    if (!bodyCap || t.length <= bodyCap) return t;
    const head = Math.floor(bodyCap * 0.45);
    const tail = bodyCap - head - 20;
    return `${t.slice(0, head)}\n…(中略)…\n${t.slice(-tail)}`;
  })();
  const flat = flatSections(obj);
  const flatIdx = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  const secNo = flatIdx >= 0 ? flatIdx + 1 : 0;
  const prevChains = collectCharChains(obj);
  const prevPlot = normalizePlotChain(obj.plotChain);
  const incremental = !slim && (prevChains.length > 0 || prevPlot.length > 0);
  const prevBody = incremental && !slim ? previousSectionBodyText(obj, actIdx, secIdx, 400) : '';
  const prevTimeHint = (() => {
    const before = prevPlot.filter((p) => p.secNo && p.secNo < secNo);
    const last = before[before.length - 1];
    if (!last) return '';
    const t = formatPlotTime(last);
    return t ? `上一节时间参考：${t}` : '';
  })();
  const prevPlotText = incremental
    ? clipTextTail(plotChainToText(prevPlot.slice(-slim ? 2 : 5)) || '(空)', slim ? 400 : 900)
    : '';
  const prevChainText = incremental
    ? clipTextTail(charChainsToText(prevChains) || '(空)', slim ? 500 : 1200)
    : '';

  const system = [
    replace
      ? '你是小说动态总结助手。本节正文已重新生成：请输出用于「替换」本节旧节点的剧情链与人物链（不要追加在旧节节点之后）。'
      : '你是小说动态总结助手。只输出「本节」要追加的剧情链节点与人物链新节点。',
    '必须只输出一个合法 JSON 对象，不要输出任何多余文字或代码块标记。格式:',
    '{"plotChain":[{"secNo":1,"actNo":1,"secInAct":1,"step":"本节核心剧情一句话","timeNow":"故事内当前时刻","timeElapsed":"相对开篇或上节已过多久","dayNight":"白天|黑夜|黎明|黄昏"}],"charChains":[{"name":"角色名","chain":["本节状态节点"],"latest":"装备/衣着/外貌特征/当前状态一句"}]}',
    '规则:',
    '1. 只能依据【本节正文】；严禁章总览、节大纲、未写出情节。',
    `2. plotChain: 恰好 1 个节点，只对应本节（secNo=${secNo || '全书序号'}, actNo=${actIdx + 1}, secInAct=${secIdx + 1}）；step 16~40 字。禁止输出其它节。`,
    '3. 时间字段必填：timeNow=故事内当前时刻（如「三日后午后」「元历三年冬」）；timeElapsed=已过时间（如「过了两时辰」「距上节约一夜」）；dayNight=白天/黑夜/黎明/黄昏之一（可据正文推断）。',
    replace
      ? '4. charChains: 只输出本节出场/有进展角色在「本节新正文」下的状态节点（通常每位 1 个）。系统会替换掉这些角色在本节的旧节点；禁止整链重抄其它节。'
      : incremental
        ? '4. charChains: 只输出本节有进展角色的新增 chain 节点（通常每位 1 个，12~36 字）。历史节点已在【既有人物链】，禁止整链重抄；无进展角色不要写入。'
        : '4. charChains: 为本节出场主要人物建立起始 chain 节点（12~36 字）。',
    '5. latest: 该角色在本节结束时的最新「装备/衣着/外貌特征/身体与处境状态」，一句 16~48 字。',
    '6. 不要编造未出现人物；不要输出 characters / plot 表字段。',
    slim ? '7. 重要：上一轮空回复。本次必须输出完整 JSON（含 plotChain 与 charChains），禁止空白。' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    prevPlotText
      ? `【既有剧情链(${replace ? '其它节只读·本节将整节点替换' : '只读·禁止改写其它节'})】\n${prevPlotText}`
      : '',
    prevChainText
      ? `【既有人物链(${replace ? '其它节只读·本节节点将替换' : '只读·本节只追加新节点'})】\n${prevChainText}`
      : '',
    prevTimeHint,
    prevBody ? `【上一节正文末尾(仅连贯参考)】\n${prevBody}` : '',
    `【本节正文: 全书第${secNo || '?'}节 · 第${actIdx + 1}章第${secIdx + 1}节 · 唯一归纳依据${replace ? ' · 重新生成' : ''}】\n${secBody || '(空)'}`,
    replace
      ? '请输出 JSON：替换本节的 1 个剧情节点（含时间）与人物链本节节点（含 latest）。'
      : '请输出 JSON：本节 1 个剧情节点（含时间）；人物链增量（含 latest）。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user, prevChains, incremental, secNo, secBody: rawBody, replace };
}

/** 把动态总结解析结果写入对象（AI 空/缺字段时用正文兜底剧情节点）。 */
function applyLiveProgressParsed(obj, actIdx, secIdx, parsed, { secNo, secBody, prevChains, replace }) {
  const deltas = [...(parsed?.charChains || [])];
  for (const c of parsed?.characters || []) {
    const d = String(c.detail || '').trim();
    if (c.name && d) deltas.push({ name: c.name, chain: [d], latest: d });
  }
  const mergedChains = appendOnlyCharChains(prevChains, deltas, { secNo, replace });

  const aiNode =
    (parsed?.plotChain || []).find((p) => Number(p.secNo) === secNo) || parsed?.plotChain?.[0] || null;
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
    timeNow: String(aiNode?.timeNow || '').trim(),
    timeElapsed: String(aiNode?.timeElapsed || '').trim(),
    dayNight: String(aiNode?.dayNight || '').trim(),
  });

  obj.liveProgress = {
    actNo: actIdx + 1,
    secNo: secIdx + 1,
    charChains: mergedChains,
    updatedAt: Date.now(),
  };
  return mergedChains;
}

/**
 * 每节确认总结后更新剧情链/人物链。
 * 不注入世界书（JSON 短任务叠 WI 极易空回）；空回会瘦身重试，最终仍用正文兜底剧情链。
 */
async function updateLiveProgress(obj, actIdx, secIdx, onProgress, { saveFn, isCancelled } = {}) {
  if (!obj || !hasValidSectionContent(obj.acts?.[actIdx]?.sections?.[secIdx])) return;
  if (isCancelled?.()) return;
  const flat = flatSections(obj);
  const flatIdx = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  const secNo = flatIdx >= 0 ? flatIdx + 1 : 0;
  const replace =
    secNo > 0 &&
    (normalizePlotChain(obj.plotChain).some((p) => p.secNo === secNo) ||
      collectCharChains(obj).some((c) => normalizeCharChainSteps(c.chain).some((s) => s.secNo === secNo)));
  onProgress?.(
    replace
      ? `正在替换本节剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`
      : `正在追加剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
    true,
  );
  stripLegacyCompactFields(obj);
  const prevChainsBase = collectCharChains(obj);
  const secBodyFull =
    sectionBodyText(obj, actIdx, secIdx) || String(obj?.acts?.[actIdx]?.sections?.[secIdx]?.content || '').trim();

  let raw = '';
  let usedFallback = false;
  try {
    const maxPass = 3;
    for (let pass = 0; pass < maxPass; pass++) {
      if (isCancelled?.()) return;
      const slim = pass > 0;
      const { system, user, prevChains, secBody } = buildLiveProgressPrompt(obj, actIdx, secIdx, {
        replace,
        slim,
      });
      if (pass > 0) {
        onProgress?.(
          `动态总结空回，瘦身重试 ${pass + 1}/${maxPass}（第${actIdx + 1}章第${secIdx + 1}节）…`,
          true,
        );
        await sleep(900 * pass);
      }
      const gid = `live_${Date.now()}_${actIdx}_${secIdx}_p${pass}`;
      try {
        // 动态总结禁止注入世界书：WI + JSON 任务是空回主因
        raw = (
          await novelGenerateWithId({ system, user }, gid, isCancelled, {
            minLen: 12,
          })
        ).trim();
        if (!isEmptyReply(raw, 12)) {
          const parsed = parseDynamicChainsPayload(raw);
          const hasPlot = (parsed.plotChain || []).some((p) => String(p?.step || '').trim());
          const hasChar = (parsed.charChains || []).some(
            (c) => c.name || (c.chain || []).length || c.latest,
          );
          if (hasPlot || hasChar) {
            const merged = applyLiveProgressParsed(obj, actIdx, secIdx, parsed, {
              secNo,
              secBody: secBody || secBodyFull,
              prevChains: prevChains || prevChainsBase,
              replace,
            });
            saveFn?.();
            log.info(replace ? `已替换本节动态总结` : `已追加动态大总结`, {
              loc: `${actIdx + 1}-${secIdx + 1}`,
              plotNodes: (obj.plotChain || []).length,
              chains: merged.length,
              replace,
              pass,
            });
            onProgress?.(
              replace
                ? `已替换本节剧情链与人物链(第${actIdx + 1}章 第${secIdx + 1}节)`
                : `已追加剧情链与人物链(第${actIdx + 1}章 第${secIdx + 1}节)`,
              true,
            );
            return;
          }
          log.warn('动态总结 JSON 无有效节点，重试…', { pass, preview: raw.slice(0, 120) });
        } else {
          log.warn(`动态总结空回复 pass=${pass + 1}`, {
            sysLen: system.length,
            userLen: user.length,
          });
        }
      } catch (e) {
        if (/已中止/.test(String(e?.message || ''))) throw e;
        log.warn(`动态总结生成失败 pass=${pass + 1}:`, e?.message || e);
      }
    }
    usedFallback = true;
  } catch (e) {
    if (/已中止/.test(String(e?.message || ''))) throw e;
    log.warn('更新动态大总结失败，改用正文兜底:', e?.message || e);
    usedFallback = true;
  }

  // 空回/失败：至少写入剧情链节点，避免确认后链条空白
  applyLiveProgressParsed(
    obj,
    actIdx,
    secIdx,
    { plotChain: [], charChains: [], characters: [] },
    { secNo, secBody: secBodyFull, prevChains: prevChainsBase, replace },
  );
  saveFn?.();
  log.warn(`动态总结已用正文兜底(第${actIdx + 1}章第${secIdx + 1}节)`, { usedFallback });
  onProgress?.(
    `动态总结空回，已用正文兜底写入剧情链(第${actIdx + 1}章 第${secIdx + 1}节)；人物链可稍后点「重新动态总结」补全`,
    true,
  );
}

/**
 * 整章动态总结（自然续写确认用）：一次请求覆盖本章各节，避免连打多节空回。
 */
async function updateLiveProgressForAct(obj, actIdx, onProgress, { saveFn, isCancelled, hardFail = false } = {}) {
  const act = obj?.acts?.[actIdx];
  if (!act) return;
  const doneSecs = (act.sections || [])
    .map((sec, secIdx) => ({ sec, secIdx }))
    .filter((x) => hasValidSectionContent(x.sec));
  if (!doneSecs.length) return;
  if (doneSecs.length === 1) {
    await updateLiveProgress(obj, actIdx, doneSecs[0].secIdx, onProgress, { saveFn, isCancelled });
    return;
  }

  const flat = flatSections(obj);
  const fromFlat = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === doneSecs[0].secIdx);
  const toFlat = flat.findIndex(
    (f) => f.actIdx === actIdx && f.secIdx === doneSecs[doneSecs.length - 1].secIdx,
  );
  if (fromFlat < 0 || toFlat < 0) {
    for (const { secIdx } of doneSecs) {
      if (isCancelled?.()) return;
      await updateLiveProgress(obj, actIdx, secIdx, onProgress, { saveFn, isCancelled });
      await sleep(600);
    }
    return;
  }

  onProgress?.(`正在为第${actIdx + 1}章更新剧情链/人物链（${doneSecs.length} 节一并归纳）…`, true);
  stripLegacyCompactFields(obj);
  // 既有链：只带本章之前的，避免把本章旧节点重复喂给模型
  const prevChains = collectCharChains(obj)
    .map((c) => ({
      name: c.name,
      latest: c.latest,
      chain: normalizeCharChainSteps(c.chain).filter((s) => !s.secNo || s.secNo < fromFlat + 1),
    }))
    .filter((c) => c.name || c.chain.length);
  const plotBefore = normalizePlotChain(obj.plotChain).filter((p) => p.secNo && p.secNo < fromFlat + 1);

  let parsed = null;
  for (let pass = 0; pass < 3; pass++) {
    if (isCancelled?.()) return;
    const slim = pass > 0;
    const corpus = collectFlatSectionsCorpus(obj, fromFlat, toFlat, {
      maxPerSec: slim ? 900 : 1400,
      maxTotal: slim ? 6000 : 10000,
    });
    const system = [
      '你是小说动态总结助手。对给定「一整章」正文归纳剧情链与人物链。',
      '必须只输出一个合法 JSON 对象。格式:',
      '{"plotChain":[{"secNo":1,"actNo":1,"secInAct":1,"step":"该节核心剧情一句话","timeNow":"故事内当前时刻","timeElapsed":"相对上节已过多久","dayNight":"白天|黑夜|黎明|黄昏"}],"charChains":[{"name":"角色名","chain":["本章内新增状态节点"],"latest":"装备/衣着/外貌特征/当前状态一句"}]}',
      '规则:',
      `1. plotChain: 必须覆盖全书第${fromFlat + 1}~${toFlat + 1}节，每节恰好 1 个节点；step 16~40 字。`,
      '2. 时间字段尽量每节都填 timeNow / timeElapsed / dayNight。',
      '3. charChains: 只输出本章有进展角色的新增节点；禁止整链重抄历史。',
      '4. 只能依据正文；不要输出 characters/plot 表字段。',
      slim ? '5. 重要：上一轮空回复。本次必须输出完整 JSON，禁止空白。' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const user = joinPromptBlocks(
      !slim && prevChains.length
        ? `【既有人物链(只读·本章只追加)】\n${clipTextTail(charChainsToText(prevChains), slim ? 400 : 1000)}`
        : '',
      !slim && plotBefore.length
        ? `【既有剧情链末尾(只读)】\n${clipTextTail(plotChainToText(plotBefore.slice(-4)), 700)}`
        : '',
      `【本章正文：全书第${fromFlat + 1}~${toFlat + 1}节 · 第${actIdx + 1}章】\n${corpus || '(空)'}`,
      `请输出 JSON：plotChain 覆盖第${fromFlat + 1}~${toFlat + 1}节；charChains 含本章增量与 latest。`,
    );
    if (pass > 0) {
      onProgress?.(`第${actIdx + 1}章动态总结空回，瘦身重试 ${pass + 1}/3…`, true);
      await sleep(1000 * pass);
    }
    const gid = `live_act_${Date.now()}_${actIdx}_p${pass}`;
    try {
      const raw = (
        await novelGenerateWithId({ system, user }, gid, isCancelled, { minLen: 12 })
      ).trim();
      if (isEmptyReply(raw, 12)) {
        log.warn(`整章动态总结空回 pass=${pass + 1}`);
        continue;
      }
      const p = parseDynamicChainsPayload(raw);
      if ((p.plotChain || []).length || (p.charChains || []).length) {
        parsed = p;
        break;
      }
    } catch (e) {
      if (/已中止/.test(String(e?.message || ''))) throw e;
      log.warn(`整章动态总结失败 pass=${pass + 1}:`, e?.message || e);
    }
  }

  const through = toFlat + 1;
  if (parsed) {
    obj.plotChain = mergePlotChain([...(plotBefore || []), ...(parsed.plotChain || [])], obj, through);
    // 去掉本章旧人物链节点再追加
    let chains = collectCharChains(obj).map((c) => ({
      name: c.name,
      latest: c.latest,
      chain: normalizeCharChainSteps(c.chain).filter((s) => !s.secNo || s.secNo < fromFlat + 1),
    }));
    // 按节号尽量标注：若模型未给 secNo，整章增量统一挂到章末节
    const tagSec = through;
    chains = appendOnlyCharChains(chains, parsed.charChains || [], { secNo: tagSec, replace: false });
    obj.liveProgress = {
      actNo: actIdx + 1,
      secNo: doneSecs[doneSecs.length - 1].secIdx + 1,
      charChains: chains,
      updatedAt: Date.now(),
    };
  } else {
    log.warn(`第${actIdx + 1}章动态总结空回，正文兜底剧情链`);
    if (hardFail) {
      throw new Error(`第 ${actIdx + 1} 章大总结空回`);
    }
    obj.plotChain = mergePlotChain(plotBefore, obj, through);
    if (!obj.liveProgress) {
      obj.liveProgress = {
        actNo: actIdx + 1,
        secNo: doneSecs[doneSecs.length - 1].secIdx + 1,
        charChains: prevChains,
        updatedAt: Date.now(),
      };
    } else {
      obj.liveProgress.charChains = prevChains.length ? prevChains : collectCharChains(obj);
      obj.liveProgress.updatedAt = Date.now();
    }
    onProgress?.(
      `第${actIdx + 1}章动态总结空回，已用正文兜底剧情链；可点「重新动态总结」补人物链`,
      true,
    );
  }
  ensureDynamicChainsComplete(obj);
  saveFn?.();
  if (parsed) {
    onProgress?.(
      `已更新第${actIdx + 1}章剧情链/人物链（${normalizePlotChain(obj.plotChain).filter((p) => p.secNo >= fromFlat + 1 && p.secNo <= through).length} 节）`,
      true,
    );
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

/**
 * 标记某一节等待用户确认后再做动态大总结。
 * @param {{ exclusive?: boolean }} opts exclusive=true（默认）时清除其它待确认；自然续写可多章末节同时待确认。
 */
function markPendingLiveSummary(obj, actIdx, secIdx, { exclusive = true } = {}) {
  if (exclusive) clearPendingLiveSummary(obj);
  const sec = obj?.acts?.[actIdx]?.sections?.[secIdx];
  if (sec) sec.pendingLiveSummary = true;
}

/** 自然续写批次：兼容旧 targetChapters。 */
function ensureContFreeBatch(cont) {
  if (!cont) return;
  if (!Number.isFinite(Number(cont.targetActs)) || Number(cont.targetActs) < 1) {
    cont.targetActs = Math.max(1, Number(cont.targetChapters) || 1);
  } else {
    cont.targetActs = Math.max(1, Math.min(200, Math.floor(Number(cont.targetActs))));
  }
  if (!Number.isFinite(Number(cont.targetSecsPerAct)) || Number(cont.targetSecsPerAct) < 1) {
    cont.targetSecsPerAct = 1;
  } else {
    cont.targetSecsPerAct = Math.max(1, Math.min(50, Math.floor(Number(cont.targetSecsPerAct))));
  }
  cont.targetChapters = cont.targetActs; // 兼容旧字段
  ensureContFreePlotSpeed(cont);
  ensureFreePlotArcState(cont);
}

function readContFreeBatchFromDOM(cont) {
  const $ = globalThis.jQuery;
  if (!$ || !cont) return;
  const acts = Number($(`#${EXT_ID}-ct-free-acts`).val());
  const secs = Number($(`#${EXT_ID}-ct-free-secs`).val());
  if (Number.isFinite(acts) && acts >= 1) cont.targetActs = Math.min(200, Math.floor(acts));
  if (Number.isFinite(secs) && secs >= 1) cont.targetSecsPerAct = Math.min(50, Math.floor(secs));
  const $tone = $(`#${EXT_ID}-ct-free-tone`);
  if ($tone.length) cont.freeTone = String($tone.val() ?? '').trim();
  ensureContFreeBatch(cont);
}

/** 自然续写基调（写入提示词）。 */
function readContFreeTone(cont) {
  return String(cont?.freeTone || '').trim();
}

/**
 * 基调注入硬上限。用户常在此写剧情走向，不宜压得过短；
 * 仅防止数千字整段塞入导致 Gemini 空 completion。
 * 已有锁定正文后续写时尽量用满，避免新批次漂离基调。
 */
const FREE_TONE_HARD_MAX = 400;

/** 自然续写是否已有可承接的正文（锁定后开新批次的关键信号）。 */
function hasContPriorBody(cont) {
  return flatSections(cont).some((f) => hasValidSectionContent(f.sec));
}

/**
 * 按场景决定基调预算：已有正文后续写尽量拉满；仅极简重试才收。
 */
function resolveFreeToneBudget(cont, actIdx, secIdx, { ultra = false, slim = false } = {}) {
  if (ultra) return 160;
  if (slim) return 240;
  const hasPrior = hasContPriorBody(cont);
  // 锁定/已写正文后续批次：基调遵从优先，预算尽量满
  if (hasPrior) {
    if (cont?.freeToneTight) return 340;
    return FREE_TONE_HARD_MAX;
  }
  // 断点续跑 / 跨章：上下文更肥，但仍保留足够走向说明
  if (cont?.freeToneTight) return 280;
  if ((actIdx | 0) > 0 && (secIdx | 0) >= 1) return 280;
  if ((actIdx | 0) > 0) return 320;
  return 360;
}

/**
 * 整理续写基调供提示词使用：保留剧情走向全文前段，不过度打散。
 * 保证 hint.length ≤ maxChars ≤ FREE_TONE_HARD_MAX。
 * @returns {{ raw: string, hint: string, clipped: boolean }}
 */
function formatContFreeToneForPrompt(cont, { maxChars = 360 } = {}) {
  const raw = readContFreeTone(cont);
  if (!raw) return { raw: '', hint: '', clipped: false };
  const cap = Math.max(80, Math.min(FREE_TONE_HARD_MAX, Number(maxChars) || 360));
  let t = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 多行：按行拼接，尽量保留完整走向条目，直到预算用尽
  const lines = t
    .split(/\n+/)
    .map((l) => l.replace(/^[\d一二三四五六七八九十]+[.、．)）]\s*/, '').trim())
    .filter(Boolean);

  let packed = '';
  if (lines.length >= 2) {
    for (const line of lines) {
      const piece = line.length > cap ? `${line.slice(0, Math.max(40, cap - 1))}…` : line;
      const next = packed ? `${packed}\n${piece}` : piece;
      if (next.length > cap) {
        if (!packed) packed = clipTextHead(piece, cap);
        break;
      }
      packed = next;
    }
  } else {
    // 单段：整段保留到上限（优先保住开头的剧情走向）
    packed = clipTextHead(t, cap);
  }

  if (!packed) packed = clipTextHead(t, cap);
  packed = clipTextHead(packed, cap);
  if (packed.length > FREE_TONE_HARD_MAX) packed = clipTextHead(packed, FREE_TONE_HARD_MAX);
  return {
    raw,
    hint: packed,
    clipped: raw.length > packed.length,
  };
}

/**
 * 构建基调注入：始终进 system 约束块，保证剧情走向遵从性。
 * 绝不把未裁剪的超长原文整段塞进 user。
 */
function buildContFreeToneInject(cont, actIdx, secIdx, { ultra = false, slim = false } = {}) {
  const budget = resolveFreeToneBudget(cont, actIdx, secIdx, { ultra, slim });
  const { raw, hint, clipped } = formatContFreeToneForPrompt(cont, { maxChars: budget });
  if (!hint) {
    return { hasTone: false, systemRule: '', roleLine: '', hint: '', rawLen: 0, budget, tight: false };
  }
  const hasPrior = hasContPriorBody(cont);
  const tight = !!cont?.freeToneTight || ((actIdx | 0) > 0 && (secIdx | 0) >= 1) || !!ultra;
  return {
    hasTone: true,
    systemRule: `【续写基调·剧情走向·必须遵守】\n${hint}${
      clipped ? '\n（原文较长，已保留前段走向；须落实其中情节安排与氛围）' : ''
    }${hasPrior ? '\n（后续批次须在已写正文基础上落实基调，禁止偏离已确立的走向）' : ''}`,
    roleLine: hasPrior
      ? '必须落实【续写基调】中的剧情走向、氛围与约束，并与已写正文保持同一故事线；剧情收束/开新与批次无关，由基调与【剧情速度】共同决定。'
      : '必须落实【续写基调】中的剧情走向、氛围与约束；剧情收束/开新与批次无关，由基调与【剧情速度】共同决定。',
    hint,
    rawLen: raw.length,
    budget,
    clipped,
    tight,
  };
}

/** @deprecated 兼容旧调用，请改用 buildContFreeToneInject */
function contFreeToneSystemRule(cont, { maxChars = 360 } = {}) {
  const { hint, clipped } = formatContFreeToneForPrompt(cont, { maxChars });
  if (!hint) return '';
  return `【续写基调·剧情走向·必须遵守】\n${hint}${clipped ? '\n（原文较长，已保留前段走向）' : ''}`;
}

/** 自然续写剧情速度：slow | medium | fast */
function normalizeFreePlotSpeed(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'slow' || s === '慢' || s === '慢速') return 'slow';
  if (s === 'fast' || s === '快' || s === '快速') return 'fast';
  return 'medium';
}

function ensureContFreePlotSpeed(cont) {
  if (!cont) return 'medium';
  cont.freePlotSpeed = normalizeFreePlotSpeed(cont.freePlotSpeed);
  return cont.freePlotSpeed;
}

function readContFreePlotSpeed(cont) {
  return ensureContFreePlotSpeed(cont);
}

function freePlotSpeedLabel(speed) {
  const s = normalizeFreePlotSpeed(speed);
  return s === 'slow' ? '慢速' : s === 'fast' ? '快速' : '中等';
}

/**
 * 当前剧情速度下，同一段剧情收束并开新前的最低节数（跨章且跨批次累计）。
 * 慢速 20 / 中等 10 / 快速 5。
 * @returns {number}
 */
function getFreePlotArcMinSecs(cont) {
  const s = readContFreePlotSpeed(cont);
  if (s === 'slow') return 20;
  if (s === 'fast') return 5;
  return 10;
}

/** 重置当前剧情弧起点（仅清除全部生成内容时调用；开新批次不得重置）。 */
function resetFreePlotArcState(cont) {
  if (!cont) return;
  cont.freePlotArcStartFlatIdx = 0;
}

function ensureFreePlotArcState(cont) {
  if (!cont) return;
  if (!Number.isFinite(Number(cont.freePlotArcStartFlatIdx)) || Number(cont.freePlotArcStartFlatIdx) < 0) {
    cont.freePlotArcStartFlatIdx = 0;
  } else {
    cont.freePlotArcStartFlatIdx = Math.floor(Number(cont.freePlotArcStartFlatIdx));
  }
}

/**
 * 当前节相对本段剧情弧的进度（全书扁平滑窗，天然跨章、跨批次）。
 * @returns {{flatIdx:number,start:number,into:number,minSecs:number,remain:number,canClose:boolean,bookSecNo:number}}
 */
function resolveFreePlotArcProgress(cont, actIdx, secIdx) {
  ensureFreePlotArcState(cont);
  ensureContFreePlotSpeed(cont);
  const flat = flatSections(cont);
  let flatIdx = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  if (flatIdx < 0) {
    let n = 0;
    outer: for (let ai = 0; ai < (cont?.acts || []).length; ai++) {
      const secs = cont.acts[ai]?.sections || [];
      for (let si = 0; si < secs.length; si++) {
        if (ai === actIdx && si === secIdx) {
          flatIdx = n;
          break outer;
        }
        n++;
      }
    }
  }
  if (flatIdx < 0) flatIdx = 0;
  const start = Math.max(0, Math.min(Number(cont.freePlotArcStartFlatIdx) || 0, flatIdx));
  const into = flatIdx - start + 1;
  const minSecs = getFreePlotArcMinSecs(cont);
  return {
    flatIdx,
    start,
    into,
    minSecs,
    remain: Math.max(0, minSecs - into),
    canClose: into >= minSecs,
    bookSecNo: flatIdx + 1,
  };
}

/**
 * 硬性节数配额：跨章且跨批次累计；未满禁止收束并开新。
 * @returns {string}
 */
function buildFreePlotArcQuotaHint(cont, actIdx, secIdx) {
  const a = resolveFreePlotArcProgress(cont, actIdx, secIdx);
  const speedLabel = freePlotSpeedLabel(readContFreePlotSpeed(cont));
  const crossRule =
    `节数须跨章且跨批次累计：凡本段剧情弧起点之后的每一节（含此前各批已生成的章/节）一律计入；` +
    `禁止因「本批开始/本批结束/新开一批」而把计数清零或提前收束开新。`;
  if (!a.canClose) {
    return (
      `【剧情弧·硬性节数】【剧情速度·${speedLabel}】：同一段剧情至少描写 ${a.minSecs} 节后，才允许收束并开启新剧情。` +
      crossRule +
      `当前全书第 ${a.bookSecNo} 节，本段累计 ${a.into}/${a.minSecs}（还差 ${a.remain} 节）。` +
      `未满前：严禁收束前段剧情，严禁开启新剧情；本节必须继续同一未决事件。`
    );
  }
  return (
    `【剧情弧·硬性节数】【剧情速度·${speedLabel}】：最低 ${a.minSecs} 节已跨章/跨批次满足（全书第 ${a.bookSecNo} 节，本段第 ${a.into} 节）。` +
    `此后可依【续写基调】收束并开新，也可继续深化同一线；若本节收束旧线并开启新线，须在大纲中明确写清。`
  );
}

/**
 * 大纲写完后：仅当已满节数且明确「开启新剧情」时，才把弧起点挪到本节。
 * 开新批次不会触发重置。
 */
function maybeAdvanceFreePlotArcAfterOutline(cont, flatIdx, outline) {
  if (!cont || !Number.isFinite(flatIdx) || flatIdx < 0) return false;
  ensureFreePlotArcState(cont);
  const start = Number(cont.freePlotArcStartFlatIdx) || 0;
  const into = flatIdx - start + 1;
  const minSecs = getFreePlotArcMinSecs(cont);
  if (into < minSecs) return false;
  const t = String(outline || '');
  // 收紧匹配，避免「新冲突升级」等常规措辞误触发跨批清零
  if (
    !/开启新剧情|另起一段剧情|另开新线|转入新剧情|新故事开端|下一段全新剧情|开始新的剧情线|开新的主线/.test(
      t,
    )
  ) {
    return false;
  }
  cont.freePlotArcStartFlatIdx = flatIdx;
  log.info('剧情弧换线，节数计数重置', { flatIdx, into, minSecs });
  return true;
}

/**
 * 剧情速度提示（自然续写大纲/正文）。
 * @returns {string}
 */
function buildFreePlotSpeedHint(cont, { forOutline = true } = {}) {
  const speed = readContFreePlotSpeed(cont);
  const minSecs = getFreePlotArcMinSecs(cont);
  if (speed === 'slow') {
    return forOutline
      ? `【剧情速度·慢速】注重细节。同一段剧情至少 ${minSecs} 节（跨章且跨批次累计）后才可收束开新；未满只深化当前未决事件。`
      : `【剧情速度·慢速】细节取胜；未满 ${minSecs} 节（跨批累计）禁止收束开新。`;
  }
  if (speed === 'fast') {
    return forOutline
      ? `【剧情速度·快速】每节明显推进。同一段剧情至少 ${minSecs} 节（跨章且跨批次累计）后才可收束开新；未满继续推当前线。`
      : `【剧情速度·快速】节内快推；未满 ${minSecs} 节（跨批累计）禁止收束开新。`;
  }
  return forOutline
    ? `【剧情速度·中等】常规起承转合。同一段剧情至少 ${minSecs} 节（跨章且跨批次累计）后才可收束开新；未满禁止「一批/一章收束、下批开新」。`
    : `【剧情速度·中等】节奏平稳；未满 ${minSecs} 节（跨批累计）禁止收束开新。`;
}

/**
 * 章界提示：与硬性节数配合。
 * @returns {string}
 */
function buildFreeChapterArcHint(cont, actIdx, secIdx) {
  const a = resolveFreePlotArcProgress(cont, actIdx, secIdx);
  const secInAct = Math.max(1, (secIdx | 0) + 1);
  const secsPerAct = Math.max(
    1,
    Number(cont.freeBatchSecs) ||
      cont.acts?.[actIdx]?.sections?.length ||
      Number(cont.targetSecsPerAct) ||
      1,
  );
  const isChapterOpen = (secIdx | 0) === 0 && (actIdx | 0) > 0;
  const isChapterEnd = secInAct >= secsPerAct;
  if (!isChapterOpen && !isChapterEnd) return '';

  if (!a.canClose) {
    if (isChapterOpen) {
      return `【章界】未满 ${a.minSecs} 节（跨批累计 ${a.into}/${a.minSecs}）：开章必须延续未决事件，禁止因新章/新批另起全新剧情。`;
    }
    return `【章界】未满 ${a.minSecs} 节（跨批累计）：章末/批末禁止收束前段，须留给后续批次继续。`;
  }
  if (isChapterOpen) {
    return '【章界】已满最低节数：开章可续旧线，也可依基调开新。';
  }
  return '【章界】已满最低节数：章末可收束开新（须写清），也可未完待续到下一批。';
}

/**
 * 本批位置 + 速度/硬性节数提示。
 * @returns {string}
 */
function buildFreeBatchPaceHint(cont, actIdx, secIdx, { forOutline = true } = {}) {
  const p = resolveFreeBatchPace(cont, actIdx, secIdx);
  const { batchActs, secsPerAct, actInBatch, secInAct, totalSecs, flatInBatch } = p;
  const isLastSec = secInAct >= secsPerAct;
  const isLastAct = actInBatch === batchActs;
  const hasPrior = typeof hasContPriorBody === 'function' ? hasContPriorBody(cont) : false;
  const hasTone = !!String(readContFreeTone(cont) || '').trim();

  return [
    `【写作位置】全书第 ${(actIdx | 0) + 1} 章第 ${secInAct} 节` +
      `（本批排期 ${batchActs}章×${secsPerAct}节 · ${flatInBatch}/${totalSecs}，此排期≠剧情弧节数）。`,
    buildFreePlotArcQuotaHint(cont, actIdx, secIdx),
    '【剧情与批次无关】新开一批不会清零剧情弧节数；收束/开新只看跨章跨批累计是否达到【剧情速度】硬性节数，以及【续写基调】。',
    buildFreePlotSpeedHint(cont, { forOutline }),
    buildFreeChapterArcHint(cont, actIdx, secIdx),
    hasTone
      ? '有【续写基调】时：在硬性节数（跨批累计）允许的前提下落实基调。'
      : '未填基调时：严格按硬性节数（跨批累计）与【剧情速度】执行。',
    hasPrior ? '须承接前文人物状态与未决线（含此前各批）。' : '',
    forOutline
      ? `只输出第 ${secInAct} 节这一节的大纲（约 80～100 字）；禁止连写多节。`
      : `只写第 ${secInAct} 节正文；勿提前写下一节内容。`,
    !isLastSec
      ? '不要写出下一节的具体情节大纲。'
      : !isLastAct
        ? '不要写出下一章各节大纲。'
        : '不要写出下一批各章大纲；批末未满硬性节数时禁止收束开新。',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatContFreeBatchLabel(cont) {
  ensureContFreeBatch(cont);
  return `${cont.targetActs}章/${cont.targetSecsPerAct}节`;
}

/** 展平序列中，当前节之后第一个未写完且未锁定的节。 */
function findNextWritableSection(obj, actIdx, secIdx) {
  const flat = flatSections(obj);
  const cur = flat.findIndex((f) => f.actIdx === actIdx && f.secIdx === secIdx);
  if (cur < 0) return null;
  const isFree = obj?.mode === 'free';
  return (
    flat.slice(cur + 1).find((f) => {
      const locked = isFree ? isFreeSectionLocked(f.sec) : isSectionLocked(f.sec);
      return !locked && !hasValidSectionContent(f.sec);
    }) || null
  );
}

/**
 * 「生成本节」目标：已生成内容之后、连续最多 2 个未锁定且无有效正文的节。
 * 存在「待确认总结」时返回空（避免跳节）。
 * @returns {Array<{actIdx:number,secIdx:number,flatIdx:number,sec:object}>}
 */
function resolveGenThisTargets(obj, limit = 2) {
  const flat = flatSections(obj);
  const isFree = obj?.mode === 'free';
  const max = Math.max(1, Math.min(4, Number(limit) || 2));
  // 自然续写无「确认总结」门闩；大纲/写新小说仍需先确认
  if (!isFree && flat.some((f) => f.sec?.pendingLiveSummary && hasValidSectionContent(f.sec))) {
    return [];
  }
  const out = [];
  for (const f of flat) {
    const locked = isFree ? isFreeSectionLocked(f.sec) : isSectionLocked(f.sec);
    if (locked || hasValidSectionContent(f.sec)) continue;
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** 兼容：取「生成本节」第一个目标。 */
function resolveGenThisTarget(obj) {
  return resolveGenThisTargets(obj, 2)[0] || null;
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
  const corpus = collectFlatSectionsCorpus(obj, fromFlat, toFlat, { maxPerSec: 1400, maxTotal: 12000 });
  const prevPlot = normalizePlotChain(obj.plotChain).filter((p) => p.secNo && p.secNo < fromNo);
  const lastTime = prevPlot.length ? formatPlotTime(prevPlot[prevPlot.length - 1]) : '';
  const system = [
    '你是小说动态总结助手。对给定正文分段归纳，只输出剧情链与人物链，不要输出人物表或剧情表。',
    '必须只输出一个合法 JSON 对象。格式:',
    '{"plotChain":[{"secNo":1,"actNo":1,"secInAct":1,"step":"该节核心剧情一句话","timeNow":"故事内当前时刻","timeElapsed":"相对开篇或上节已过多久","dayNight":"白天|黑夜|黎明|黄昏"}],"charChains":[{"name":"角色名","chain":["本段内新增状态节点"],"latest":"装备/衣着/外貌特征/当前状态一句"}]}',
    '规则:',
    `1. plotChain: 必须覆盖全书第${fromNo}~${toNo}节，每节恰好 1 个节点；step 16~40 字；填写 secNo/actNo/secInAct。`,
    '2. 时间字段尽量每节都填：timeNow（如「三日后午后」「元历三年冬夜」）、timeElapsed（如「过了两时辰」「距上节约一夜」）、dayNight（白天/黑夜/黎明/黄昏等）。正文有时间线索必须写；无明写也可据情节合理推断，勿全部留空。',
    '3. charChains: 只输出本段正文中的人物演变新增节点（可按节推进；历史链已在既有人物链中，禁止整链重抄）。',
    '4. latest: 本段结束时该角色的最新「装备/衣着/外貌特征/状态」，一句 16~48 字。',
    '5. 只能依据正文；严禁章总览/节大纲；不要编造未出现人物。',
  ].join('\n');
  const user = [
    prevChains.length
      ? `【既有人物链(保留；本段只追加新节点)】\n${clipTextTail(charChainsToText(prevChains), 1200)}`
      : '',
    lastTime ? `【上段末时间参考】${lastTime}` : '',
    prevPlot.length
      ? `【既有剧情链末尾(只读·时间连贯参考)】\n${clipTextTail(plotChainToText(prevPlot.slice(-5)), 800)}`
      : '',
    `【本段正文：全书第${fromNo}~${toNo}节】\n${corpus || '(空)'}`,
    `请输出 JSON：plotChain 覆盖第${fromNo}~${toNo}节（每节含 timeNow/timeElapsed/dayNight）；charChains 含本段新增节点与 latest。`,
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
    let parsed = { plotChain: [], charChains: [] };
    for (let pass = 0; pass < 3; pass++) {
      if (isCancelled?.()) throw new Error('已中止');
      const slim = pass > 0;
      const { system, user } = buildDynamicSegmentPrompt(obj, fromFlat, toFlat, slim ? [] : accChains);
      if (pass > 0) {
        onProgress?.(`分段 ${s + 1}/${segments} 空回，瘦身重试 ${pass + 1}/3…`, true);
        await sleep(900 * pass);
      }
      const gid = `dyn_seg_${Date.now()}_${fromFlat}_${toFlat}_p${pass}`;
      try {
        // 动态总结禁止世界书，避免短 JSON 任务被 WI 撑空
        const raw = (
          await novelGenerateWithId({ system, user }, gid, isCancelled, { minLen: 12 })
        ).trim();
        if (isEmptyReply(raw, 12)) continue;
        const p = parseDynamicChainsPayload(raw);
        if ((p.plotChain || []).length || (p.charChains || []).length) {
          parsed = p;
          break;
        }
      } catch (e) {
        if (/已中止/.test(String(e?.message || ''))) throw e;
        log.warn(`动态总结分段失败 pass=${pass + 1}:`, e?.message || e);
      }
    }
    if (isCancelled?.()) throw new Error('已中止');
    const through = toFlat + 1;
    if (!(parsed.plotChain || []).length && !(parsed.charChains || []).length) {
      log.warn(`动态总结分段 ${s + 1} 空回，正文兜底剧情链`);
    }
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

/** 规整剧情链节点（节单位：secNo=全书展平序号；含时间字段）。 */
function normalizePlotChain(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => {
      if (typeof p === 'string') {
        const step = p.trim();
        return step
          ? { secNo: 0, actNo: 0, secInAct: 0, actTitle: '', step, timeNow: '', timeElapsed: '', dayNight: '' }
          : null;
      }
      const secNo = Number(p?.secNo) || 0;
      const actNo = Number(p?.actNo) || 0;
      const secInAct = Number(p?.secInAct || p?.secIdx) || 0;
      const actTitle = String(p?.actTitle || '').trim();
      let step = String(p?.step || p?.detail || p?.plot || '').trim();
      if (!step && Array.isArray(p?.plot)) step = p.plot.map((x) => String(x || '').trim()).filter(Boolean).join('；');
      if (!step) return null;
      const timeNow = String(p?.timeNow || p?.currentTime || '').trim();
      const timeElapsed = String(p?.timeElapsed || p?.elapsed || '').trim();
      let dayNight = String(p?.dayNight || p?.dayOrNight || '').trim();
      if (dayNight && !/昼|夜|白天|黑夜|黎明|黄昏|凌晨|傍晚|正午|午夜/.test(dayNight)) {
        // 保留模型原词，仅去掉过长噪声
        if (dayNight.length > 8) dayNight = dayNight.slice(0, 8);
      }
      return { secNo, actNo, secInAct, actTitle, step, timeNow, timeElapsed, dayNight };
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
      timeNow: p.timeNow || fb.timeNow || '',
      timeElapsed: p.timeElapsed || fb.timeElapsed || '',
      dayNight: p.dayNight || fb.dayNight || '',
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
    const time = formatPlotTime(p);
    lines.push(`${loc}: ${(p.step || '').replace(/\n/g, ' ').trim()}${time ? `（${time}）` : ''}`);
  }
  return lines.join('\n');
}

/** 剧情链 HTML（链路 + 时间信息，无节表）。 */
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
      const time = formatPlotTime(p);
      const tip = [loc, p.step, time].filter(Boolean).join(' · ');
      const timeHtml = time ? `<span class="ns-plot-time">${esc(time)}</span>` : '';
      return `${i ? '<span class="ns-chain-arrow">→</span>' : ''}<span class="ns-plot-chain-step" title="${esc(tip)}">${esc(p.step)}${timeHtml}</span>`;
    })
    .join('');
  return `
    <div class="ns-plot-chains-block">
      <div class="ns-live-progress__title"><strong>剧情链</strong><span class="ns-muted">（每节 1 节点 · 含当前时间/已过时间/昼夜）</span></div>
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

/** 将续写会话的角色档案/剧情梗概表格同步到酒馆世界书。 */
async function syncContinuationToWorldInfo(cont) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  ensureContProfiles(cont);
  collectContProfilesFromDOM(cont);
  const name = makeWorldBookName(cont);
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

  (cont.charProfiles || []).forEach((c, i) => {
    const nameLabel = String(c.name || '').trim() || `角色${i + 1}`;
    const body = contCharProfilesText({ charProfiles: [c] });
    if (!body && !String(c.name || '').trim()) return;
    // 世界书「主要关键字」栏 ← 角色档案 keywords；无则回落姓名
    let keys = parseContCharKeywords(c.keywords, nameLabel);
    if (!keys.length) keys = [nameLabel];
    push(`【角色档案·${nameLabel}】\n${body}`, `角色·${nameLabel}`, keys);
  });

  CONT_PLOT_TEXT_FIELDS.forEach((f) => {
    const v = String(cont.plotProfile?.[f.key] || '').trim();
    if (!v) return;
    push(`【剧情梗概·${f.label}】\n${v}`, `剧情·${f.label}`, [f.label, '剧情梗概', '世界观']);
  });
  (Array.isArray(cont.plotProfile?.factions) ? cont.plotProfile.factions : []).forEach((fa, i) => {
    if (!contFactionHasContent(fa)) return;
    const title = String(fa.name || '').trim() || `组织${i + 1}`;
    const body = [
      `组织${i + 1}：${title}`,
      String(fa.members || '').trim() ? `主要成员：${String(fa.members).trim()}` : '',
      String(fa.goal || '').trim() ? `目的：${String(fa.goal).trim()}` : '',
      String(fa.morality || '').trim() ? `道德：${String(fa.morality).trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    push(`【势力阵营·${title}】\n${body}`, `势力·${title}`, [title, '势力阵营', '组织']);
  });

  if (!Object.keys(entries).length) {
    throw new Error('当前没有可同步的档案（请先填写角色档案或剧情梗概）');
  }

  book.entries = entries;
  await ctx.saveWorldInfo(name, book, true, { refreshEditor: true });
  await ctx.updateWorldInfoList?.();
  try {
    ctx.reloadWorldInfoEditor?.(name, true);
  } catch (e) {
    /* ignore */
  }

  cont.worldBookName = name;
  cont.characters = contCharProfilesText(cont);
  cont.plot = contPlotProfileText(cont);
  saveContinuation();
  log.info('已同步续写档案至世界书', { name, entries: Object.keys(entries).length });
  return { name, count: Object.keys(entries).length };
}

/** 列出酒馆可用世界书名称。 */
function listWorldInfoNames() {
  const ctx = getST();
  if (!ctx) return [];
  try {
    if (typeof ctx.getWorldInfoNames === 'function') {
      const names = ctx.getWorldInfoNames();
      if (Array.isArray(names)) return names.map((n) => String(n || '').trim()).filter(Boolean);
    }
  } catch (e) {
    log.warn('getWorldInfoNames 失败:', e);
  }
  if (Array.isArray(ctx.world_names)) return ctx.world_names.map((n) => String(n || '').trim()).filter(Boolean);
  try {
    if (Array.isArray(globalThis.world_names)) {
      return globalThis.world_names.map((n) => String(n || '').trim()).filter(Boolean);
    }
  } catch (_) {
    /* ignore */
  }
  return [];
}

/** 弹出选择世界书名称；取消返回 null。 */
async function pickWorldBookName(preferred = '') {
  const ctx = getST();
  try {
    await ctx?.updateWorldInfoList?.();
  } catch (_) {
    /* ignore */
  }
  const names = listWorldInfoNames();
  const pref = String(preferred || '').trim();
  if (!names.length) {
    if (pref) return pref;
    throw new Error('未找到可用世界书，请先在酒馆世界书面板创建或同步一本');
  }
  const defaultName = names.find((n) => n === pref) || names.find((n) => n.toLowerCase() === pref.toLowerCase()) || names[0];
  const preview = names.slice(0, 35).join('\n');
  const more = names.length > 35 ? `\n…共 ${names.length} 本` : '';
  const picked = globalThis.prompt?.(
    `输入要导入的世界书名称：\n\n可用世界书：\n${preview}${more}`,
    defaultName,
  );
  if (picked === null) return null;
  const name = String(picked || '').trim();
  if (!name) throw new Error('未选择世界书');
  const hit = names.find((n) => n === name) || names.find((n) => n.toLowerCase() === name.toLowerCase());
  return hit || name;
}

function listWorldInfoEntries(book) {
  const entries = book?.entries && typeof book.entries === 'object' ? book.entries : {};
  return Object.values(entries)
    .filter((e) => e && typeof e === 'object' && !e.disable)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (Number(a.uid) || 0) - (Number(b.uid) || 0));
}

function stripWiEntryMark(comment) {
  return String(comment || '')
    .replace(new RegExp(`^${WI_ENTRY_MARK}\\|?`), '')
    .trim();
}

function parseWiMarkdownFields(text) {
  const fields = {};
  const re = /\*\*([^*]+)\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*[^*]+\*\*\s*[:：]|\n##\s|$)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    fields[String(m[1] || '').trim()] = String(m[2] || '').trim();
  }
  return fields;
}

/** 从世界书条目正文还原角色档案。 */
function parseContCharFromWiContent(content, { comment = '', keys = [] } = {}) {
  let text = String(content || '').trim();
  if (!text) return null;
  const fromComment = (String(comment || '').match(/^角色·(.+)$/) || [])[1] || '';
  const fromHeader = (text.match(/^【角色档案·([^\]]+)】/) || [])[1] || '';
  text = text.replace(/^【角色档案·[^\]]+】\s*\n?/, '').trim();
  const keyList = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean);

  if (!/\*\*[^*]+\*\*\s*[:：]/.test(text)) {
    const name = fromComment || fromHeader || keyList[0] || extractNounLabel(text) || '未命名';
    return makeContCharProfile({
      name,
      keywords: parseContCharKeywords([...keyList, name].join('、'), name).join('、'),
      stages: [makeContCharStage({ label: '阶段1', background: text, identity: clipTextHead(text, 240) })],
    });
  }

  let name = fromComment || fromHeader || '';
  let gender = '';
  let keywords = keyList.join('、');
  const stages = [];
  const parts = text.split(/\n\s*---+\s*\n/);
  parts.forEach((part, i) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const isDesc = /^##\s*描述/.test(raw);
    const fields = parseWiMarkdownFields(raw);
    if (fields['名称']) name = fields['名称'];
    if (fields['性别']) gender = fields['性别'];
    if (fields['主要关键字']) keywords = fields['主要关键字'];
    const st = makeContCharStage({
      label: isDesc ? CONT_CHAR_SUMMARY_LABEL : fields['阶段'] || `阶段${stages.length + 1}`,
    });
    for (const f of CONT_CHAR_STAGE_FIELDS) {
      if (f.key === 'label') continue;
      if (fields[f.label]) st[f.key] = fields[f.label];
    }
    if (!CONT_CHAR_STAGE_FIELDS.some((f) => f.key !== 'label' && String(st[f.key] || '').trim()) && i === 0) {
      st.background = raw.replace(/^##\s*描述\s*/m, '').trim();
    }
    stages.push(st);
  });
  if (!stages.length) stages.push(makeContCharStage({ label: '阶段1', background: text }));
  return makeContCharProfile({
    name: name || keyList[0] || '未命名',
    gender,
    keywords: parseContCharKeywords(keywords || name, name || keyList[0] || '').join('、'),
    stages,
  });
}

function parseContFactionFromWiContent(content, comment = '') {
  let text = String(content || '').trim().replace(/^【势力阵营·[^\]]+】\s*\n?/, '');
  const titleFromComment = (String(comment || '').match(/^势力·(.+)$/) || [])[1] || '';
  const titleFromLine = (text.match(/^组织\d*[：:]\s*(.+)$/m) || [])[1] || '';
  const pick = (label) => {
    const m = text.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`));
    return m ? m[1].trim() : '';
  };
  return makeContFaction({
    name: titleFromComment || titleFromLine || extractNounLabel(text) || '未命名组织',
    members: pick('主要成员'),
    goal: pick('目的'),
    morality: normalizeFactionMorality(pick('道德')),
  });
}

/**
 * 从世界书导入到写新小说：背景 + 人物/道具/地理/其他设定。
 * 同时兼容续写同步过去的角色/剧情条目（写入人物/其他）。
 */
async function importProjectFromWorldInfo(proj, bookName) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  if (typeof ctx.loadWorldInfo !== 'function') throw new Error('当前酒馆未暴露 loadWorldInfo');
  const name = String(bookName || '').trim();
  if (!name) throw new Error('未指定世界书');
  const book = await ctx.loadWorldInfo(name);
  if (!book) throw new Error(`世界书「${name}」不存在或无法读取`);

  ensureWorldDefs(proj);
  syncNovelSettingsFromDOM(proj);
  const wd = proj.worldDefs;
  const lists = {
    chars: [...(wd.chars || [])],
    items: [...(wd.items || [])],
    places: [...(wd.places || [])],
    others: [...(wd.others || [])],
  };
  const pushUnique = (key, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (lists[key].some((x) => String(x || '').trim() === t)) return;
    lists[key].push(t);
  };

  let imported = 0;
  for (const e of listWorldInfoEntries(book)) {
    const content = String(e.content || '').trim();
    if (!content) continue;
    const comment = stripWiEntryMark(e.comment);
    imported++;

    if (comment === '背景设定' || /^【背景设定】/.test(content)) {
      proj.background = content.replace(/^【背景设定】\s*\n?/, '').trim();
      continue;
    }
    const sec = comment.match(/^(人物设定|道具设定|地理设定|其他设定)/);
    if (sec) {
      const map = { 人物设定: 'chars', 道具设定: 'items', 地理设定: 'places', 其他设定: 'others' };
      pushUnique(map[sec[1]], content);
      continue;
    }
    if (comment.startsWith('角色·') || /^【角色档案[·・]/.test(content)) {
      const body = content.replace(/^【角色档案·[^\]]+】\s*\n?/, '').trim();
      const label = comment.replace(/^角色·/, '') || extractNounLabel(body);
      pushUnique('chars', label && body && !body.startsWith(label) ? `${label}\n${body}` : body || label);
      continue;
    }
    if (comment.startsWith('势力·') || /^【势力阵营/.test(content)) {
      pushUnique('others', content.replace(/^【势力阵营·[^\]]+】\s*\n?/, '').trim());
      continue;
    }
    if (comment.startsWith('剧情·') || /^【剧情梗概/.test(content)) {
      pushUnique('others', content.replace(/^【剧情梗概·[^\]]+】\s*\n?/, '').trim());
      continue;
    }
    // 未识别：按关键字粗分，否则进其他
    const keys = Array.isArray(e.key) ? e.key.map(String) : [];
    if (keys.some((k) => /人物|角色|角色名/.test(k))) pushUnique('chars', content);
    else if (keys.some((k) => /道具|物品|装备/.test(k))) pushUnique('items', content);
    else if (keys.some((k) => /地理|地点|城|国|州/.test(k))) pushUnique('places', content);
    else pushUnique('others', content);
  }

  wd.chars = lists.chars;
  wd.items = lists.items;
  wd.places = lists.places;
  wd.others = lists.others;
  proj.worldBookName = name;
  touchProject(proj);
  log.info('已从世界书导入设定', { name, imported });
  return { name, count: imported };
}

/**
 * 从世界书导入到续写：角色档案 + 剧情梗概/势力。
 * 同时兼容写新小说同步过去的人物设定条目。
 */
async function importContinuationFromWorldInfo(cont, bookName) {
  const ctx = getST();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  if (typeof ctx.loadWorldInfo !== 'function') throw new Error('当前酒馆未暴露 loadWorldInfo');
  const name = String(bookName || '').trim();
  if (!name) throw new Error('未指定世界书');
  const book = await ctx.loadWorldInfo(name);
  if (!book) throw new Error(`世界书「${name}」不存在或无法读取`);

  ensureContProfiles(cont);
  collectContProfilesFromDOM(cont);

  const charMap = new Map();
  (cont.charProfiles || []).forEach((c) => {
    const n = String(c?.name || '').trim();
    if (n) charMap.set(n, makeContCharProfile(c));
  });
  const plot = makeContPlotProfile(cont.plotProfile || {});
  const factionMap = new Map();
  (plot.factions || []).forEach((fa) => {
    const n = String(fa?.name || '').trim();
    if (n) factionMap.set(n, makeContFaction(fa));
  });

  let imported = 0;
  for (const e of listWorldInfoEntries(book)) {
    const content = String(e.content || '').trim();
    if (!content) continue;
    const comment = stripWiEntryMark(e.comment);
    const keys = Array.isArray(e.key) ? e.key : [];
    imported++;

    if (comment.startsWith('角色·') || /^【角色档案[·・]/.test(content)) {
      const row = parseContCharFromWiContent(content, { comment, keys });
      if (row?.name) charMap.set(String(row.name).trim(), row);
      continue;
    }
    if (comment.startsWith('势力·') || /^【势力阵营/.test(content)) {
      const fa = parseContFactionFromWiContent(content, comment);
      if (fa?.name) factionMap.set(String(fa.name).trim(), fa);
      continue;
    }
    const plotHit = comment.match(/^剧情·(.+)$/) || content.match(/^【剧情梗概·([^\]]+)】/);
    if (plotHit) {
      const label = plotHit[1].trim();
      const body = content.replace(/^【剧情梗概·[^\]]+】\s*\n?/, '').trim();
      const field = CONT_PLOT_TEXT_FIELDS.find((f) => f.label === label);
      if (field) plot[field.key] = body;
      else plot.extra = [String(plot.extra || '').trim(), `【${label}】\n${body}`].filter(Boolean).join('\n\n');
      continue;
    }
    // 写新小说同步格式：人物设定#n / 关键字含「人物设定」
    if (/^人物设定/.test(comment) || /^【人物设定】/.test(content) || keys.map(String).includes('人物设定')) {
      const row = parseContCharFromWiContent(content, {
        comment: `角色·${extractNounLabel(content)}`,
        keys,
      });
      if (row?.name) charMap.set(String(row.name).trim(), row);
      continue;
    }
  }

  const chars = [...charMap.values()];
  if (chars.length) cont.charProfiles = chars.map((c) => makeContCharProfile(c));
  plot.factions = [...factionMap.values()].filter(contFactionHasContent);
  cont.plotProfile = makeContPlotProfile(plot);
  cont.characters = contCharProfilesText(cont);
  cont.plot = contPlotProfileText(cont);
  cont.worldBookName = name;
  saveContinuation();
  log.info('已从世界书导入续写档案', { name, chars: chars.length, factions: plot.factions.length, imported });
  return { name, count: imported, chars: chars.length, factions: plot.factions.length };
}

/** 删除项目/续写绑定的世界书。saveFn 缺省时按写新小说 touchProject。 */
async function deleteProjectWorldInfo(proj, saveFn) {
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
  if (typeof saveFn === 'function') saveFn();
  else touchProject(proj);
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
 * 优先 simulateWorldInfoActivation；工坊绑定书会再直读全书启用条目并取更完整的一方，
 * 避免关键字扫描只命中个别角色导致人物错乱。
 */
async function resolveWorkshopWorldInfo(bookName, scanText) {
  const ctx = getST();
  if (!ctx || !bookName) return { before: '', after: '' };

  return withWorldBookSelected(bookName, async () => {
    const scan = String(scanText || '').trim().slice(0, 8000);
    let before = '';
    let after = '';
    try {
      if (typeof ctx.simulateWorldInfoActivation === 'function') {
        const wi = await ctx.simulateWorldInfoActivation({
          coreChat: [
            { name: 'System', mes: '小说工坊设定检索', is_user: false, is_system: true },
            { name: 'User', mes: scan || '世界设定 人物 道具 地理 角色档案 剧情梗概', is_user: true, is_system: false },
          ],
          dryRun: true,
          type: 'quiet',
        });
        // 兼容不同版本：字符串字段 / 条目数组
        before =
          (typeof wi?.worldInfoBefore === 'string' && wi.worldInfoBefore) ||
          (Array.isArray(wi?.worldInfoBeforeEntries)
            ? wi.worldInfoBeforeEntries.filter(Boolean).join('\n')
            : '') ||
          '';
        after =
          (typeof wi?.worldInfoAfter === 'string' && wi.worldInfoAfter) ||
          (Array.isArray(wi?.worldInfoAfterEntries)
            ? wi.worldInfoAfterEntries.filter(Boolean).join('\n')
            : '') ||
          '';
        if (before || after) {
          log.debug('世界书扫描命中', { before: before.length, after: after.length });
        }
      }
    } catch (e) {
      log.warn('simulateWorldInfoActivation 失败，降级直读条目:', e?.message || e);
    }

    // 直读绑定书全部启用条目：工坊同步条目均为 constant，应整本注入
    try {
      const book = await ctx.loadWorldInfo?.(bookName);
      const list = Object.values(book?.entries || {}).filter((e) => e && !e.disable && e.content);
      list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      const direct = list.map((e) => String(e.content).trim()).filter(Boolean).join('\n\n');
      if (direct && direct.length >= before.length) {
        if (direct.length > before.length) {
          log.info('世界书改用直读全书条目', {
            book: bookName,
            scanned: before.length,
            direct: direct.length,
            entries: list.length,
          });
        }
        before = direct;
      }
    } catch (e) {
      log.warn('直读世界书失败:', e?.message || e);
    }

    return { before, after };
  });
}

/**
 * 工坊写作 system 一次打包：预设 → 全局提示词 → 设定/总结 → 短指令。
 * 若已同步世界书，设定改由世界书接口注入，此处不再重复塞 entitiesText。
 * slim/memoryMaxChars：压缩体积，降低 Gemini 等模型空回（completion_tokens=0）概率。
 */
function buildWorkshopSystemPack({
  roleHint,
  extraRules = [],
  memoryObj = null,
  worldProj = null,
  reinforce = false,
  slim = false,
  memoryMaxChars = 0,
  presetMaxChars = 0,
  /** >0 时裁剪全局提示词（自然续写防 Gemini completion_tokens=0；字数要求另用 lengthHint 强调） */
  globalKwMaxChars = 0,
  /** true：用紧凑大总结（近章+链尾），适合自然续写长篇 */
  compactMemory = false,
  /** 紧凑记忆：剧情链保留节点数 */
  plotKeep = 0,
  /** 紧凑记忆：人物链每人保留步数 */
  chainStepKeep = 0,
  /** 紧凑记忆：跳过章表总结（自然续写续写批次建议 true，改用链+前文） */
  memorySkipChapterSummaries = false,
  /** true：不注入酒馆预设 system（自然续写极简重试） */
  omitPreset = false,
  /** 自定义空回强化文案（大纲任务勿用「正文」字样） */
  reinforceText = '',
} = {}) {
  let presetSys = omitPreset ? '' : readSysPrompt();
  let globalKw = readGlobalKeyword();
  const lenHint = extractLengthHintFromKeyword(globalKw);
  const preloadOn = worldProj ? !!(worldProj.worldDefs?.preload) : true;
  const useWi = !!(worldProj?.worldBookName);
  const defs = !useWi && worldProj ? entitiesText(worldProj) : '';
  const memCap = memoryMaxChars || (slim ? 1600 : compactMemory ? 1600 : 0);
  let memory = '';
  if (memoryObj) {
    memory = compactMemory || slim
      ? buildGrandSummaryForWrite(memoryObj, {
          maxChars: memCap || 1600,
          plotKeep: plotKeep || (slim ? 3 : 6),
          chainStepKeep: chainStepKeep || (slim ? 1 : 2),
          skipChapterSummaries: !!memorySkipChapterSummaries,
        })
      : buildGrandSummary(memoryObj);
  }
  const presetCap = presetMaxChars || (slim ? 1000 : 0);
  if (memCap && !compactMemory && !slim) memory = clipTextTail(memory, memCap);
  if (presetCap) presetSys = clipTextHead(presetSys, presetCap);
  // 自然续写可裁全局提示词：全文过长是 Gemini 空 completion 主因之一；字数用 lenHint 保底
  if (globalKwMaxChars > 0 && globalKw) {
    const clipped = clipTextHead(globalKw, globalKwMaxChars);
    globalKw =
      clipped === globalKw
        ? globalKw
        : `${clipped}\n（…已截断；字数要求：${lenHint || '按全文全局提示词写足篇幅'}）`;
  }
  const memBlock = joinPromptBlocks(preloadOn && defs ? clipTextHead(defs, slim ? 800 : 4000) : '', memory);

  return joinPromptBlocks(
    presetSys ? `【预设/系统提示】\n${presetSys}` : '',
    globalKw
      ? `【全局提示词·必须严格遵守】\n（含字数、文风；不得写成过短占位${lenHint ? `；识别到字数：${lenHint}` : ''}）\n${globalKw}`
      : '',
    memBlock
      ? `【长期记忆】\n（含：章节总结 / 剧情链 / 人物链；写作时须承接，勿矛盾）\n${memBlock}`
      : '',
    roleHint,
    ...(extraRules || []),
    reinforce
      ? reinforceText ||
        '重要：上一轮空回复。本次必须输出完整可读正文，并严格达到【全局提示词】字数要求，禁止空白/省略号/极短占位。'
      : '',
  );
}

/** 构建"写某一节"的提示词：system 一次含预设/全局/总结；user 含任务与字数强调。 */
function buildSectionPrompt(proj, actIdx, secIdx, flatIdx, { reinforce = false } = {}) {
  const act = proj.acts[actIdx];
  const sec = act.sections[secIdx];
  const preloadOn = !!(proj?.worldDefs?.preload);
  const useWi = !!proj?.worldBookName;
  const globalKw = readGlobalKeyword();
  const lenHint = extractLengthHintFromKeyword(globalKw);
  const lengthLine = globalKw
    ? `字数与文风：严格按【全局提示词】执行${lenHint ? `（识别到字数要求：${lenHint}）` : ''}；本节必须写够篇幅，禁止短节/敷衍占位。`
    : `字数：本节须有实质篇幅，禁止短节占位。`;

  const system = buildWorkshopSystemPack({
    roleHint:
      '你是中文小说写作助手。按章-节结构写作。必须严格遵守【全局提示词】（含字数）。只输出本节正文，不要标题/大纲/解释；遵守设定与前文连贯。禁止调用搜索/联网/工具；必须直接输出正文，禁止返回空消息。',
    memoryObj: proj,
    worldProj: proj,
    reinforce,
  });

  const user = joinPromptBlocks(
    // 已同步世界书时，背景/设定改由世界书扫描注入，避免重复占 token
    !useWi && proj.background ? `【背景】\n${clipTextHead(proj.background, 1200)}` : '',
    !useWi && !preloadOn ? entitiesText(proj) : '',
    recentSectionContext(proj, flatIdx, 2),
    `【本章总览】第${actIdx + 1}章 ${act.title || ''}\n${clipTextHead(act.overview || '(未填)', 2000)}`,
    `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${clipTextHead(sec.outline || '', 2500)}`,
    reinforce
      ? `请重新完整撰写第${actIdx + 1}章第${secIdx + 1}节正文。\n${lengthLine}`
      : `请写第${actIdx + 1}章第${secIdx + 1}节正文。\n${lengthLine}`,
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
        .filter((c) => (c.name || c.detail) && !isJunkAnalyzeCharName(c.name))
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
  // 残缺 JSON 不要整段塞进表格（会变成 {"characters" 这种脏行）
  if (/^\s*\{/.test(t) || /"characters"\s*:/.test(t)) {
    log.warn('总结解析失败且内容像残缺 JSON，返回空结果');
    return { characters: [], plot: [] };
  }
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
      await prepareGenerationChannel('novel', { hadPriorContent: false });
      await sleep(400);
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
    const raw = (await novelGenerate({ system, user }, { skipWorldInfo: true, minLen: 12 })).trim();
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
  /** 上传文档时自动新建的续写会话 id；分析完成后写入该会话，避免再开一份。 */
  pendingContId: '',
  result: null,
  /** 分析进度（最小化再打开重绘后需恢复） */
  progressMsg: '',
  progressPct: 0,
};

/* ---------------------------- 续写: 角色档案 / 剧情梗概（表格） ---------------------------- */

/** 空缺占位：提取/整理后不得留空。 */
const CONT_CHAR_EMPTY_PLACEHOLDER = '不详';
const CONT_CHAR_SUMMARY_LABEL = '综合现状';

/** 角色级稳定字段（各阶段块展示时会重复写出名称/性别，与样例一致）。 */
const CONT_CHAR_CORE_FIELDS = [
  { key: 'name', label: '名称', short: true },
  { key: 'gender', label: '性别', short: true },
  { key: 'keywords', label: '主要关键字' },
];

/**
 * 解析角色主要关键字（顿号/逗号/空白分隔）。
 * @returns {string[]}
 */
function parseContCharKeywords(raw, fallbackName = '') {
  const parts = String(raw || '')
    .split(/[,，、;；|/／\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keys = [];
  const seen = new Set();
  const add = (k) => {
    const t = String(k || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    keys.push(t);
  };
  for (const p of parts) add(p);
  if (fallbackName) add(fallbackName);
  return keys.slice(0, 16);
}

/**
 * 角色阶段字段（与用户样例一致；最后一阶段固定为「综合现状」）。
 * 导出时每个阶段写出名称/性别及下列字段，阶段之间用分隔线分开。
 */
const CONT_CHAR_STAGE_FIELDS = [
  { key: 'label', label: '阶段', short: true },
  { key: 'title', label: '称号', short: true },
  { key: 'psyche', label: '人格心理' },
  { key: 'age', label: '年龄', short: true },
  { key: 'lookAge', label: '貌龄', short: true },
  { key: 'identity', label: '身份' },
  { key: 'personality', label: '性格' },
  { key: 'background', label: '背景' },
  { key: 'appearance', label: '外貌' },
  { key: 'ability', label: '技能' },
  { key: 'events', label: '重要事件' },
  { key: 'status', label: '剧情状况' },
  { key: 'weakness', label: '弱点' },
  { key: 'speech', label: '话语示例' },
];

/** 导出时阶段字段顺序（不含 label；与样例观感一致）。 */
const CONT_CHAR_STAGE_EXPORT_KEYS = [
  'title',
  'psyche',
  'age',
  'lookAge',
  'identity',
  'personality',
  'background',
  'appearance',
  'ability',
  'events',
  'status',
  'weakness',
  'speech',
];

/** @deprecated 兼容旧代码引用：核心+阶段字段并集（不含 stages） */
const CONT_CHAR_FIELDS = [
  ...CONT_CHAR_CORE_FIELDS,
  ...CONT_CHAR_STAGE_FIELDS.filter((f) => f.key !== 'label'),
];

function isCharSummaryStage(st) {
  const l = String(st?.label || '').trim();
  return /综合现状|综合描述|^描述$|##\s*描述/i.test(l);
}

/** 剧情梗概文本维度（不含势力阵营；阵营为独立列表）。 */
const CONT_PLOT_TEXT_FIELDS = [
  { key: 'worldview', label: '世界观' },
  { key: 'background', label: '背景设定' },
  { key: 'development', label: '剧情发展' },
  { key: 'themes', label: '主题主线' },
  { key: 'timeline', label: '时间线' },
  { key: 'extra', label: '其他' },
];

/** @deprecated 兼容旧引用；阵营请用 CONT_FACTION_FIELDS + plotProfile.factions */
const CONT_PLOT_FIELDS = [
  ...CONT_PLOT_TEXT_FIELDS.slice(0, 4),
  { key: 'factions', label: '势力阵营' },
  ...CONT_PLOT_TEXT_FIELDS.slice(4),
];

/** 单个势力/组织字段。 */
const CONT_FACTION_FIELDS = [
  { key: 'name', label: '组织名称', short: true },
  { key: 'members', label: '主要成员', hint: '甲、乙、丙…' },
  { key: 'goal', label: '目的', hint: '该组织的目标/纲领' },
  {
    key: 'morality',
    label: '道德',
    short: true,
    hint: '善良 / 中立 / 邪恶，或中立偏善良、中立偏邪恶等',
  },
];

const CONT_MORALITY_OPTIONS = ['善良', '中立', '邪恶', '中立偏善良', '中立偏邪恶', '混乱善良', '混乱邪恶'];

function makeContFaction(seed = {}) {
  const row = {};
  for (const f of CONT_FACTION_FIELDS) row[f.key] = String(seed?.[f.key] ?? '');
  return row;
}

function contFactionHasContent(f) {
  return CONT_FACTION_FIELDS.some((x) => String(f?.[x.key] || '').trim());
}

function normalizeFactionMorality(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (/中立\s*偏\s*善|偏善|善良偏向|善意中立/.test(t)) return '中立偏善良';
  if (/中立\s*偏\s*恶|偏恶|邪恶偏向|恶意中立/.test(t)) return '中立偏邪恶';
  if (/混乱\s*善|chaotic\s*good/i.test(low)) return '混乱善良';
  if (/混乱\s*恶|chaotic\s*evil/i.test(low)) return '混乱邪恶';
  if (/^善|^good|正义|正面/.test(t) || low === 'good') return '善良';
  if (/^恶|^evil|反派|黑暗/.test(t) || low === 'evil') return '邪恶';
  if (/^中|^neutral|中立/.test(t) || low === 'neutral') return '中立';
  return t;
}

/** 旧字符串势力 → 组织列表。 */
function migrateFactionsFromText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const chunks = t
    .split(/\n\s*(?:---+|===+)\s*\n|\n{2,}|(?=组织\s*\d+|势力\s*\d+)/)
    .map((x) => x.trim())
    .filter(Boolean);
  const list = [];
  const parseOne = (block) => {
    const pick = (labels) => {
      for (const lb of labels) {
        const m = block.match(new RegExp(`${lb}\\s*[:：]\\s*([^\\n]+)`, 'i'));
        if (m) return m[1].trim();
      }
      return '';
    };
    const name =
      pick(['组织名称', '组织', '势力', '阵营', '名称', 'name']) ||
      (block.match(/^【?\s*([^\n【】:：]{1,40})\s*】?/) || [])[1] ||
      '';
    const members = pick(['主要成员', '成员', '成员名单', 'members']);
    const goal = pick(['目的', '目标', '纲领', 'goal', 'purpose']);
    const morality = normalizeFactionMorality(pick(['道德', '阵营倾向', '对齐', 'morality', 'alignment']));
    if (name || members || goal || morality) {
      return makeContFaction({
        name: String(name || '').replace(/^组织\s*\d+\s*/, '').trim(),
        members,
        goal,
        morality,
      });
    }
    return makeContFaction({ name: '', goal: block.slice(0, 500), members: '', morality: '' });
  };
  for (const c of chunks.length ? chunks : [t]) {
    const f = parseOne(c);
    if (contFactionHasContent(f)) list.push(f);
  }
  return list.length ? list : [makeContFaction({ goal: t })];
}

function normalizeContFactionFromObj(obj) {
  if (!obj) return makeContFaction();
  if (typeof obj === 'string') {
    const list = migrateFactionsFromText(obj);
    return list[0] || makeContFaction({ name: obj });
  }
  const seed = { ...obj };
  if (!seed.name && (obj.组织 || obj.势力 || obj.faction || obj.org)) {
    seed.name = obj.组织 || obj.势力 || obj.faction || obj.org;
  }
  if (!seed.members && (obj.主要成员 || obj.成员 || obj.member)) {
    const raw = obj.主要成员 || obj.成员 || obj.member;
    seed.members = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean).join('、') : raw;
  }
  if (Array.isArray(seed.members)) {
    seed.members = seed.members.map((x) => String(x).trim()).filter(Boolean).join('、');
  }
  if (!seed.goal && (obj.目的 || obj.目标 || obj.purpose)) seed.goal = obj.目的 || obj.目标 || obj.purpose;
  if (!seed.morality && (obj.道德 || obj.alignment || obj.align)) {
    seed.morality = obj.道德 || obj.alignment || obj.align;
  }
  seed.morality = normalizeFactionMorality(seed.morality);
  return makeContFaction(seed);
}

function makeContCharStage(seed = {}) {
  const row = {};
  for (const f of CONT_CHAR_STAGE_FIELDS) row[f.key] = String(seed?.[f.key] ?? '');
  // 兼容旧 MBTI → 人格心理；旧 extra → 重要事件
  if (!String(row.psyche || '').trim()) {
    const legacyMbti = String(seed?.mbti || seed?.MBTI || '').trim();
    if (legacyMbti) row.psyche = legacyMbti;
  }
  if (seed?.extra && !row.events) {
    const ex = String(seed.extra).trim();
    if (ex) row.events = ex;
  }
  return finalizeContCharStage(row);
}

/** 旧 flat 档案 → 单阶段。 */
function migrateFlatFieldsToStage(flat = {}) {
  const f = flat && typeof flat === 'object' ? flat : {};
  const statusBits = [];
  if (f.status) statusBits.push(String(f.status));
  if (f.clothing) statusBits.push(`装备：${f.clothing}`);
  return makeContCharStage({
    label: f.label || '阶段1',
    title: f.title || '',
    psyche: f.psyche || f.mbti || '',
    age: f.age || '',
    lookAge: f.lookAge || '',
    identity: f.identity || f.setting || '',
    personality: f.personality || '',
    background: f.background || '',
    appearance: f.appearance || '',
    ability: f.ability || '',
    events: f.events || f.change || '',
    status: statusBits.join('\n'),
    weakness: f.weakness || '',
    speech: f.speech || '',
  });
}

function makeContCharProfile(seed = {}) {
  const src = seed && typeof seed === 'object' ? seed : {};
  const row = {
    name: String(src.name ?? ''),
    gender: String(src.gender ?? ''),
    keywords: String(src.keywords ?? src.keys ?? ''),
    stages: [],
  };
  // 旧版角色级 title → 并入首阶段
  const legacyTitle = String(src.title ?? '').trim();
  if (Array.isArray(src.stages) && src.stages.length) {
    row.stages = src.stages.map((s) => makeContCharStage(s));
    if (legacyTitle && row.stages[0] && !String(row.stages[0].title || '').trim()) {
      row.stages[0].title = legacyTitle;
    }
  } else {
    const hasFlat =
      CONT_CHAR_STAGE_FIELDS.some((f) => f.key !== 'label' && String(src[f.key] || '').trim()) ||
      ['setting', 'change', 'clothing', 'habit', 'status', 'ability', 'personality', 'age', 'title'].some(
        (k) => String(src[k] || '').trim(),
      );
    const st = hasFlat || row.name || row.gender ? migrateFlatFieldsToStage(src) : makeContCharStage({ label: '阶段1' });
    if (legacyTitle && !String(st.title || '').trim()) st.title = legacyTitle;
    row.stages = [st];
  }
  if (!row.stages.length) row.stages = [makeContCharStage({ label: '阶段1' })];
  return finalizeContCharProfile(row);
}

function makeContPlotProfile(seed = {}) {
  const src = seed && typeof seed === 'object' && !Array.isArray(seed) ? seed : {};
  const row = {};
  for (const f of CONT_PLOT_TEXT_FIELDS) row[f.key] = String(src[f.key] ?? '');
  if (Array.isArray(src.factions)) {
    row.factions = src.factions.map(normalizeContFactionFromObj).filter(contFactionHasContent);
  } else if (typeof src.factions === 'string' && String(src.factions).trim()) {
    row.factions = migrateFactionsFromText(src.factions);
  } else {
    row.factions = [];
  }
  return row;
}

function contPlotProfileHasContent(p) {
  if (!p || typeof p !== 'object') return false;
  if (CONT_PLOT_TEXT_FIELDS.some((f) => String(p[f.key] || '').trim())) return true;
  return (Array.isArray(p.factions) ? p.factions : []).some(contFactionHasContent);
}

/** 角色是否有可展示内容。 */
function contCharProfileHasContent(c) {
  if (!c) return false;
  if (CONT_CHAR_CORE_FIELDS.some((f) => String(c[f.key] || '').trim())) return true;
  return (Array.isArray(c.stages) ? c.stages : []).some((st) =>
    CONT_CHAR_STAGE_FIELDS.some((f) => String(st?.[f.key] || '').trim()),
  );
}

function contCharLatestStage(c) {
  const stages = Array.isArray(c?.stages) ? c.stages : [];
  return stages.length ? stages[stages.length - 1] : makeContCharStage();
}

/**
 * 将「心理：…；心理：…；身体：…」这类分列同类型内容合并，
 * 不同类型各占一行。用于状态 / 装备 / 能力等字段。
 * @param {string} text
 * @param {{ key: string, aliases: string[] }[]} aspects  输出顺序
 * @param {{ maxLen?: number, maxPerAspect?: number }} opts
 */
function normalizeAspectLabeledText(text, aspects, opts = {}) {
  const maxLen = opts.maxLen ?? 1600;
  const maxPerAspect = opts.maxPerAspect ?? 600;
  const raw = String(text || '').trim();
  if (!raw || !Array.isArray(aspects) || !aspects.length) return raw;

  const aliasToKey = new Map();
  for (const a of aspects) {
    for (const al of a.aliases || []) {
      const k = String(al || '').trim();
      if (k) aliasToKey.set(k.toLowerCase(), a.key);
    }
  }
  // 长别名优先匹配
  const aliasList = [...aliasToKey.keys()].sort((a, b) => b.length - a.length);
  const buckets = new Map(aspects.map((a) => [a.key, []]));
  const unlabeled = [];

  const pushUnique = (arr, piece) => {
    const t = String(piece || '').trim();
    if (!t) return;
    const nk = t.replace(/\s+/g, '').toLowerCase();
    if (arr.some((x) => x.replace(/\s+/g, '').toLowerCase() === nk)) return;
    if (arr.some((x) => x.includes(t) || t.includes(x))) {
      // 被更长内容覆盖时替换较短项
      const idx = arr.findIndex((x) => t.includes(x) && t.length > x.length);
      if (idx >= 0) arr[idx] = t;
      return;
    }
    arr.push(t);
  };

  const tryConsumeLabeled = (piece) => {
    const s = String(piece || '').trim();
    if (!s) return true;
    for (const al of aliasList) {
      const re = new RegExp(`^${escapeRegExp(al)}\\s*[:：]\\s*([\\s\\S]+)$`, 'i');
      const m = s.match(re);
      if (m) {
        const key = aliasToKey.get(al);
        pushUnique(buckets.get(key), m[1]);
        return true;
      }
      // 「心理 xxx」无冒号但以别名开头
      const re2 = new RegExp(`^${escapeRegExp(al)}\\s+([\\s\\S]+)$`, 'i');
      const m2 = s.match(re2);
      if (m2 && m2[1].trim().length >= 2) {
        const key = aliasToKey.get(al);
        pushUnique(buckets.get(key), m2[1]);
        return true;
      }
    }
    return false;
  };

  // 先按换行切开，再按中文/英文分号、竖线切开
  const pieces = [];
  for (const line of raw.split(/\n+/)) {
    const lineTrim = line.trim();
    if (!lineTrim) continue;
    // 同行内可能有多个「标签：」——按标签边界再切
    const labelAlt = aliasList.map(escapeRegExp).join('|');
    if (labelAlt && new RegExp(`(?:${labelAlt})\\s*[:：]`, 'i').test(lineTrim)) {
      const parts = lineTrim
        .split(new RegExp(`(?=(?:${labelAlt})\\s*[:：])`, 'i'))
        .map((p) => p.trim())
        .filter(Boolean);
      for (const p of parts) {
        for (const sub of p.split(/[；;|｜]/)) {
          const t = sub.trim();
          if (t) pieces.push(t);
        }
      }
    } else {
      for (const sub of lineTrim.split(/[；;|｜]/)) {
        const t = sub.trim();
        if (t) pieces.push(t);
      }
    }
  }

  for (const piece of pieces) {
    if (!tryConsumeLabeled(piece)) unlabeled.push(piece);
  }

  const lines = [];
  for (const a of aspects) {
    const items = buckets.get(a.key) || [];
    if (!items.length) continue;
    const merged = clipTextHead(items.join('；'), maxPerAspect);
    lines.push(`${a.key}：${merged}`);
  }
  // 无法归类的保留，避免丢信息
  if (unlabeled.length) {
    const rest = clipTextHead(
      unlabeled
        .filter((u) => !lines.some((l) => l.includes(u)))
        .join('；'),
      maxPerAspect,
    );
    if (rest) lines.push(rest);
  }
  return clipTextHead(lines.join('\n'), maxLen);
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CONT_STATUS_ASPECTS = [
  { key: '心理', aliases: ['心理', '心理状态', '心态', '情绪', '精神', '精神状态'] },
  { key: '身体', aliases: ['身体', '身体状态', '伤势', '体能', '健康', '体力'] },
  { key: '外貌', aliases: ['外貌', '外貌状态', '外观', '仪容', '形貌', '相貌'] },
];

const CONT_CLOTHING_ASPECTS = [
  { key: '衣物', aliases: ['衣物', '服装', '衣服', '穿着', '衣着'] },
  { key: '法宝', aliases: ['法宝', '灵器', '宝物'] },
  { key: '道具', aliases: ['道具', '物品', '随身物'] },
  { key: '武器', aliases: ['武器', '兵器', '刀剑'] },
  { key: '防具', aliases: ['防具', '护甲', '铠甲'] },
];

const CONT_ABILITY_ASPECTS = [
  { key: '技能', aliases: ['技能', '招式', '手法'] },
  { key: '功法', aliases: ['功法', '心法', '修炼'] },
  { key: '特长', aliases: ['特长', '天赋', '擅长'] },
  { key: '能力', aliases: ['能力', '异能', '超凡'] },
];

/** 整理单阶段字段：同类合并、异类换行。 */
function finalizeContCharStage(row) {
  const out = row && typeof row === 'object' ? row : {};
  for (const f of CONT_CHAR_STAGE_FIELDS) {
    if (out[f.key] == null) out[f.key] = '';
    else out[f.key] = String(out[f.key]);
  }
  out.status = normalizeAspectLabeledText(out.status, CONT_STATUS_ASPECTS, {
    maxLen: 1200,
    maxPerAspect: 500,
  });
  out.ability = normalizeAspectLabeledText(out.ability, CONT_ABILITY_ASPECTS, {
    maxLen: 1200,
    maxPerAspect: 400,
  });
  out.appearance = String(out.appearance || '').trim();
  return out;
}

/** 阶段字段不得空缺。 */
function fillContCharStageRequired(st) {
  const out = finalizeContCharStage(st || {});
  if (!String(out.label || '').trim()) out.label = '阶段';
  for (const f of CONT_CHAR_STAGE_FIELDS) {
    if (f.key === 'label') continue;
    if (!String(out[f.key] || '').trim()) out[f.key] = CONT_CHAR_EMPTY_PLACEHOLDER;
  }
  return out;
}

/** 从既有阶段综合出「综合现状」块（样例末尾 ## 描述）。 */
function buildCharSummaryStage(profile) {
  const prior = (Array.isArray(profile?.stages) ? profile.stages : []).filter((s) => !isCharSummaryStage(s));
  const vals = (key) =>
    prior
      .map((s) => String(s?.[key] || '').trim())
      .filter((v) => v && v !== CONT_CHAR_EMPTY_PLACEHOLDER);

  const evolving = (key) => {
    const list = vals(key);
    if (!list.length) return CONT_CHAR_EMPTY_PLACEHOLDER;
    if (list.length === 1) return list[0];
    const first = list[0];
    const last = list[list.length - 1];
    if (first === last) return last;
    return `早期：${first}；现状：${last}`;
  };

  const joinAll = (key, sep = '\n') => {
    const list = vals(key);
    if (!list.length) return CONT_CHAR_EMPTY_PLACEHOLDER;
    const seen = new Set();
    const out = [];
    for (const v of list) {
      const k = v.replace(/\s+/g, '');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out.join(sep) || CONT_CHAR_EMPTY_PLACEHOLDER;
  };

  return fillContCharStageRequired(
    makeContCharStage({
      label: CONT_CHAR_SUMMARY_LABEL,
      title: evolving('title'),
      psyche: evolving('psyche'),
      age: evolving('age'),
      lookAge: evolving('lookAge'),
      identity: evolving('identity'),
      personality: evolving('personality'),
      background: evolving('background'),
      appearance: evolving('appearance'),
      ability: evolving('ability'),
      events: joinAll('events', '\n'),
      status: evolving('status'),
      weakness: evolving('weakness'),
      speech: (() => {
        const list = vals('speech');
        return list.length ? list[list.length - 1] : CONT_CHAR_EMPTY_PLACEHOLDER;
      })(),
    }),
  );
}

/**
 * 确保存在「综合现状」阶段；rebuild=true 时按先前阶段重写综合块。
 * 所有阶段字段补全为不得空缺。
 */
function ensureCharSummaryStage(profile, { rebuild = false } = {}) {
  const out = profile && typeof profile === 'object' ? profile : {};
  out.name = String(out.name ?? '');
  out.gender = String(out.gender ?? '') || CONT_CHAR_EMPTY_PLACEHOLDER;
  out.keywords = String(out.keywords ?? '');
  if (!String(out.keywords || '').trim() && String(out.name || '').trim()) {
    out.keywords = String(out.name).trim();
  }
  let stages = Array.isArray(out.stages) ? out.stages.map((s) => makeContCharStage(s)) : [];
  const prior = stages.filter((s) => !isCharSummaryStage(s)).map((s) => fillContCharStageRequired(s));
  if (!prior.length) prior.push(fillContCharStageRequired(makeContCharStage({ label: '阶段1' })));
  const existingSummary = stages.find(isCharSummaryStage);
  const summary =
    rebuild || !existingSummary
      ? buildCharSummaryStage({ ...out, stages: prior })
      : fillContCharStageRequired(makeContCharStage(existingSummary));
  summary.label = CONT_CHAR_SUMMARY_LABEL;
  out.stages = [...prior, summary];
  return out;
}

/** 整理角色档案：规范核心字段 + 各阶段 + 综合现状。 */
function finalizeContCharProfile(row) {
  const out = row && typeof row === 'object' ? row : {};
  out.name = String(out.name ?? '');
  out.gender = String(out.gender ?? '');
  out.keywords = String(out.keywords ?? '');
  // 无关键字时默认用名称，便于同步世界书
  if (!String(out.keywords || '').trim() && String(out.name || '').trim()) {
    out.keywords = String(out.name).trim();
  }
  if (!Array.isArray(out.stages) || !out.stages.length) {
    out.stages = [makeContCharStage({ label: '阶段1' })];
  } else {
    out.stages = out.stages.map((s) => finalizeContCharStage(s));
  }
  return ensureCharSummaryStage(out, { rebuild: false });
}

function migrateLegacyCharString(str) {
  const t = String(str || '').trim();
  if (!t) return [];
  const profiles = [];

  // 新格式：分项多行
  // - 角色名：
  //   身份设定：…
  //   性格气质：…
  const fieldStop =
    '身份设定|人物设定|性格气质|性格|外貌衣着|衣着|装备|能力习惯|能力|技能功法|习惯|当前状态|状态|人物变化|变化|关系与行为';
  const blockRe =
    /^[-*·•]\s*([^:\n：]{1,40})\s*[:：]\s*\n?([\s\S]*?)(?=^[-*·•]\s*[^:\n：]{1,40}\s*[:：]|\n剧情\s*[:：]|$)/gm;
  let bm;
  while ((bm = blockRe.exec(t))) {
    const name = bm[1].trim();
    const body = String(bm[2] || '').trim();
    const pick = (label) => {
      const m = body.match(
        new RegExp(`${label}\\s*[:：]\\s*([^\\n]+(?:\\n(?!\\s*(?:${fieldStop})[:：])[^\\n]+)*)`, 'i'),
      );
      return m ? m[1].trim() : '';
    };
    const setting = pick('身份设定') || pick('人物设定');
    const personality = pick('性格气质') || pick('性格');
    const clothing = pick('装备') || pick('外貌衣着') || pick('衣着');
    const abilityHabit = pick('能力习惯') || pick('技能功法');
    const status = pick('当前状态') || pick('状态');
    const change = pick('人物变化') || pick('变化');
    const relation = pick('关系与行为');
    const ability = abilityHabit || pick('能力');
    const habit = pick('习惯');
    const leftover = body
      .replace(
        new RegExp(
          `(?:${fieldStop})\\s*[:：]\\s*[^\\n]*(?:\\n(?!\\s*(?:${fieldStop})[:：])[^\\n]*)*`,
          'gi',
        ),
        '',
      )
      .trim();
    profiles.push(
      makeContCharProfile({
        name,
        setting: setting || (!personality && !clothing && !status && !change ? body : setting),
        personality,
        clothing,
        ability,
        habit,
        status,
        change,
        extra: [relation, leftover].filter(Boolean).join('\n'),
      }),
    );
  }
  if (profiles.length) return profiles;

  const re = /^[-*·•]\s*(.+?)\s*[:：]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(t))) {
    profiles.push(makeContCharProfile({ name: m[1].trim(), setting: m[2].trim() }));
  }
  if (!profiles.length) {
    // 尝试「姓名：描述」分行（跳过 JSON 脏键）
    const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^\s*[\{\[]/.test(line) || /"characters"\s*:/i.test(line)) continue;
      const hm = line.match(/^([^:：]{1,32})\s*[:：]\s*(.+)$/);
      if (hm && !isJunkAnalyzeCharName(hm[1])) {
        profiles.push(makeContCharProfile({ name: hm[1].trim(), setting: hm[2].trim() }));
      }
    }
  }
  const cleaned = profiles.filter((c) => !isJunkAnalyzeCharName(c.name));
  if (!cleaned.length && t && !/^\s*\{/.test(t) && !/"characters"\s*:/i.test(t)) {
    cleaned.push(makeContCharProfile({ name: '综合', setting: t }));
  }
  return cleaned;
}

function migrateLegacyPlotString(str) {
  const t = String(str || '').trim();
  return makeContPlotProfile(t ? { development: t } : {});
}

/** 规范化续写会话的角色档案/剧情梗概表格；兼容旧版纯文字段。返回是否有变更。 */
function ensureContProfiles(cont) {
  if (!cont) return false;
  let dirty = false;
  if (typeof cont.worldBookName !== 'string') {
    cont.worldBookName = '';
    dirty = true;
  }

  if (!Array.isArray(cont.charProfiles)) {
    cont.charProfiles = migrateLegacyCharString(cont.characters);
    dirty = true;
  } else if (
    !cont.charProfiles.length &&
    String(cont.characters || '').trim()
  ) {
    // 空表格但残留旧字符串 → 迁回表格
    cont.charProfiles = migrateLegacyCharString(cont.characters);
    dirty = true;
  } else {
    cont.charProfiles = cont.charProfiles.map((c) => makeContCharProfile(c));
  }

  const plotEmpty =
    !cont.plotProfile ||
    typeof cont.plotProfile !== 'object' ||
    Array.isArray(cont.plotProfile) ||
    !contPlotProfileHasContent(cont.plotProfile);
  if (plotEmpty && String(cont.plot || '').trim()) {
    cont.plotProfile = migrateLegacyPlotString(cont.plot);
    dirty = true;
  } else if (!cont.plotProfile || typeof cont.plotProfile !== 'object' || Array.isArray(cont.plotProfile)) {
    cont.plotProfile = makeContPlotProfile();
    dirty = true;
  } else {
    cont.plotProfile = makeContPlotProfile(cont.plotProfile);
  }

  // 同步旧字段为表格文本，供兼容读取
  const charText = contCharProfilesText(cont);
  const plotText = contPlotProfileText(cont);
  if (cont.characters !== charText) {
    cont.characters = charText;
    dirty = true;
  }
  if (cont.plot !== plotText) {
    cont.plot = plotText;
    dirty = true;
  }
  return dirty;
}

/** 角色档案 → 提示词/导出文本（与样例一致：阶段块 + --- + 末尾 ## 描述）。 */
function contCharProfilesText(cont) {
  const list = Array.isArray(cont?.charProfiles) ? cont.charProfiles : [];
  const blocks = list
    .map((c, i) => {
      const name = String(c?.name || '').trim() || `角色${i + 1}`;
      const gender = String(c?.gender || '').trim() || CONT_CHAR_EMPTY_PLACEHOLDER;
      const keywords = String(c?.keywords || '').trim() || name;
      const stages = Array.isArray(c?.stages) ? c.stages : [];
      const prior = stages.filter((s) => !isCharSummaryStage(s));
      const summary = stages.find(isCharSummaryStage);
      const formatStage = (st, { asDescription = false } = {}) => {
        const lines = [];
        if (asDescription) lines.push('## 描述');
        lines.push(`**名称**: ${name}`);
        lines.push(`**性别**: ${gender}`);
        if (!asDescription && keywords) lines.push(`**主要关键字**: ${keywords}`);
        for (const key of CONT_CHAR_STAGE_EXPORT_KEYS) {
          const f = CONT_CHAR_STAGE_FIELDS.find((x) => x.key === key);
          if (!f) continue;
          const v = String(st?.[key] || '').trim() || CONT_CHAR_EMPTY_PLACEHOLDER;
          lines.push(`**${f.label}**: ${v}`);
        }
        return lines.join('\n');
      };
      const parts = [];
      prior.forEach((st, si) => {
        const filled = fillContCharStageRequired(st);
        if (!String(filled.label || '').trim() || filled.label === '阶段') {
          filled.label = `阶段${si + 1}`;
        }
        parts.push(formatStage(filled));
      });
      const sum = fillContCharStageRequired(summary || buildCharSummaryStage({ name, gender, stages: prior }));
      parts.push(formatStage(sum, { asDescription: true }));
      return parts.join('\n\n---\n\n');
    })
    .filter(Boolean);
  return blocks.join('\n\n\n');
}

/**
 * 多角色均分预算的精简档案（自然续写无世界书 / 极简轮次用）。
 * 避免 clipTextHead 整表截断只保留第一个角色。
 */
function contCharRosterBrief(cont, maxChars = 900) {
  const list = (Array.isArray(cont?.charProfiles) ? cont.charProfiles : []).filter(contCharProfileHasContent);
  if (!list.length) return '';
  const budget = Math.max(120, maxChars | 0);
  const n = Math.min(list.length, 14);
  const per = Math.max(70, Math.floor(budget / n));
  const keyOrder = ['identity', 'personality', 'appearance', 'ability', 'status'];
  const blocks = list.slice(0, n).map((c, i) => {
    const name = String(c?.name || '').trim() || `角色${i + 1}`;
    const st = contCharLatestStage(c);
    const bits = keyOrder
      .map((k) => {
        const f = CONT_CHAR_STAGE_FIELDS.find((x) => x.key === k);
        const v = String(st?.[k] || '').trim();
        if (!f || !v) return '';
        return `${f.label}：${clipTextHead(v, Math.max(24, Math.floor((per - name.length) / 3)))}`;
      })
      .filter(Boolean);
    return clipTextHead(bits.length ? `【${name}】\n${bits.join('\n')}` : `【${name}】`, per);
  });
  return clipTextHead(blocks.join('\n\n'), budget);
}

/** 剧情梗概表格 → 提示词文本（势力阵营分组织列出）。 */
function contPlotProfileText(cont) {
  const p = cont?.plotProfile && typeof cont.plotProfile === 'object' ? cont.plotProfile : {};
  const parts = [];
  for (const f of CONT_PLOT_TEXT_FIELDS) {
    const v = String(p[f.key] || '').trim();
    if (v) parts.push(`【${f.label}】\n${v}`);
  }
  const factions = Array.isArray(p.factions) ? p.factions.filter(contFactionHasContent) : [];
  if (factions.length) {
    const blocks = factions.map((fa, i) => {
      const title = String(fa.name || '').trim() || `组织${i + 1}`;
      const lines = [`组织${i + 1}：${title}`];
      if (String(fa.members || '').trim()) lines.push(`主要成员：${String(fa.members).trim()}`);
      if (String(fa.goal || '').trim()) lines.push(`目的：${String(fa.goal).trim()}`);
      if (String(fa.morality || '').trim()) lines.push(`道德：${String(fa.morality).trim()}`);
      return lines.join('\n');
    });
    parts.push(`【势力阵营】\n${blocks.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

function normalizeContCharFromObj(obj) {
  if (!obj || typeof obj !== 'object') return makeContCharProfile();
  if (typeof obj === 'string') return makeContCharProfile({ name: obj });
  const seed = { ...obj };
  if (!seed.name && obj.角色名) seed.name = obj.角色名;
  if (!seed.gender && obj.性别) seed.gender = obj.性别;
  if (!seed.keywords && (obj.keywords || obj.keys || obj.主要关键字 || obj.关键字)) {
    const kw = obj.keywords || obj.keys || obj.主要关键字 || obj.关键字;
    seed.keywords = Array.isArray(kw) ? kw.map((x) => String(x).trim()).filter(Boolean).join('、') : String(kw);
  }
  if (!seed.title && (obj.称号 || obj.nickname)) seed.title = obj.称号 || obj.nickname;

  // 已有 stages
  if (Array.isArray(obj.stages) && obj.stages.length) {
    seed.stages = obj.stages.map((s) => normalizeContCharStageFromObj(s));
    return makeContCharProfile(seed);
  }

  // 兼容旧 JSON / 别名 → 单阶段
  const stageSeed = {};
  if (obj.identity || obj.setting || obj.detail || obj.desc || obj.身份) {
    stageSeed.identity = obj.identity || obj.setting || obj.detail || obj.desc || obj.身份;
  }
  if (obj.personality || obj.性格) stageSeed.personality = obj.personality || obj.性格;
  if (obj.background || obj.背景) stageSeed.background = obj.background || obj.背景;
  if (obj.appearance || obj.外貌) stageSeed.appearance = obj.appearance || obj.外貌;
  if (obj.ability || obj.skills || obj.skill || obj.能力 || obj.功法 || obj.特长) {
    stageSeed.ability = obj.ability || obj.skills || obj.skill || obj.能力 || obj.功法 || obj.特长;
  }
  if (obj.events || obj.重要事件 || obj.change || obj.变化) {
    stageSeed.events = obj.events || obj.重要事件 || obj.change || obj.变化;
  }
  if (obj.status || obj.状态 || obj.剧情状况 || obj.currentStatus) {
    stageSeed.status = obj.status || obj.状态 || obj.剧情状况 || obj.currentStatus;
  }
  if (obj.speech || obj.话语示例 || obj.quote) stageSeed.speech = obj.speech || obj.话语示例 || obj.quote;
  if (obj.psyche || obj.人格心理 || obj.mbti || obj.MBTI) {
    stageSeed.psyche = obj.psyche || obj.人格心理 || obj.mbti || obj.MBTI;
  }
  if (obj.age || obj.年龄) stageSeed.age = obj.age || obj.年龄;
  if (obj.lookAge || obj.貌龄) stageSeed.lookAge = obj.lookAge || obj.貌龄;
  if (obj.weakness || obj.弱点) stageSeed.weakness = obj.weakness || obj.弱点;
  if (obj.extra || obj.其他) stageSeed.extra = obj.extra || obj.其他;
  if (obj.clothing || obj.装备) {
    stageSeed.extra = [stageSeed.extra, `装备：${obj.clothing || obj.装备}`].filter(Boolean).join('\n');
  }
  if (Array.isArray(stageSeed.events)) {
    stageSeed.events = stageSeed.events.map((x) => String(x || '').trim()).filter(Boolean).join('\n');
  }
  if (Array.isArray(stageSeed.ability)) {
    stageSeed.ability = stageSeed.ability.map((x) => String(x || '').trim()).filter(Boolean).join('；');
  }
  if (Object.keys(stageSeed).length) seed.stages = [stageSeed];
  return makeContCharProfile(seed);
}

function normalizeContCharStageFromObj(obj) {
  if (!obj || typeof obj !== 'object') return makeContCharStage();
  if (typeof obj === 'string') return makeContCharStage({ events: obj });
  const seed = { ...obj };
  if (!seed.psyche && (obj.人格心理 || obj.mbti || obj.MBTI)) {
    seed.psyche = obj.人格心理 || obj.mbti || obj.MBTI;
  }
  if (!seed.identity && (obj.setting || obj.身份)) seed.identity = obj.setting || obj.身份;
  if (!seed.events && (obj.change || obj.重要事件)) seed.events = obj.change || obj.重要事件;
  if (!seed.background && obj.背景) seed.background = obj.背景;
  if (!seed.appearance && obj.外貌) seed.appearance = obj.外貌;
  if (!seed.speech && obj.话语示例) seed.speech = obj.话语示例;
  if (Array.isArray(seed.events)) {
    seed.events = seed.events.map((x) => String(x || '').trim()).filter(Boolean).join('\n');
  }
  return makeContCharStage(seed);
}

function normalizeContPlotFromObj(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return migrateLegacyPlotString(typeof obj === 'string' ? obj : '');
  }
  const seed = { ...obj };
  if (!seed.development && (obj.plot || obj.summary || obj.剧情发展)) {
    seed.development = obj.plot || obj.summary || obj.剧情发展;
  }
  if (!seed.worldview && (obj.world || obj.世界观)) seed.worldview = obj.world || obj.世界观;
  if (!seed.background && (obj.bg || obj.背景设定 || obj.背景)) {
    seed.background = obj.bg || obj.背景设定 || obj.背景;
  }
  if (Array.isArray(obj.factions)) {
    seed.factions = obj.factions;
  } else if (typeof obj.factions === 'string') {
    seed.factions = obj.factions;
  } else if (Array.isArray(obj.势力阵营)) {
    seed.factions = obj.势力阵营;
  }
  return makeContPlotProfile(seed);
}

/** 解析最终分析：优先 JSON 表格结构，失败再降级旧「角色档案/剧情梗概」文本。 */
function parseFinalContAnalysis(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const looksJson = /^\s*\{/.test(t) || /"characters"\s*:/.test(t) || /"charProfiles"\s*:/.test(t);
  const jsonStr = extractBalancedJson(t) || t;

  const tryParseObj = (raw) => {
    const obj = JSON.parse(raw);
    const charsRaw = Array.isArray(obj.characters)
      ? obj.characters
      : Array.isArray(obj.charProfiles)
        ? obj.charProfiles
        : [];
    const charProfiles = charsRaw
      .map(normalizeContCharFromObj)
      .filter((c) => !isJunkAnalyzeCharName(c.name))
      .filter(contCharProfileHasContent);
    const plotProfile = normalizeContPlotFromObj(obj.plot || obj.plotProfile || {});
    if (charProfiles.length || contPlotProfileHasContent(plotProfile)) {
      return {
        charProfiles: charProfiles.length ? charProfiles : [],
        plotProfile,
        characters: contCharProfilesText({ charProfiles }),
        plot: contPlotProfileText({ plotProfile }),
      };
    }
    return null;
  };

  try {
    const hit = tryParseObj(jsonStr);
    if (hit) return hit;
  } catch (e) {
    /* 纠错 */
  }

  // JSON 纠错：补全括号 / 截断残缺字段（避免把 {"characters" 当角色名）
  if (looksJson) {
    let candidate = String(jsonStr || '').trim();
    for (let k = 0; k < 8 && candidate.length > 2; k++) {
      candidate = candidate.replace(/[\s,\]}]+$/, '');
      for (const suffix of ['}', ']}', '}]}', '"}]}', '"]}]}', '"]}]}']) {
        try {
          const hit = tryParseObj(candidate + suffix);
          if (hit) {
            log.debug('分析 JSON 已纠错解析');
            return hit;
          }
        } catch (e) {
          /* next */
        }
      }
      candidate = candidate.replace(/,\s*("?[^,{}\[\]]*)?$/, '');
    }
    // 像 JSON 但解析失败：宁可空档案，也不把键名当角色
    log.warn('分析 JSON 解析失败，跳过脏文本降级');
    return {
      charProfiles: [],
      plotProfile: makeContPlotProfile(),
      characters: '',
      plot: '',
    };
  }

  const legacy = parseAnalysisResult(t);
  const charProfiles = migrateLegacyCharString(legacy.characters).filter(
    (c) => !isJunkAnalyzeCharName(c.name),
  );
  const plotProfile = migrateLegacyPlotString(legacy.plot);
  return {
    charProfiles,
    plotProfile,
    characters: contCharProfilesText({ charProfiles }),
    plot: contPlotProfileText({ plotProfile }),
  };
}

/** 渲染可编辑角色档案（一人多阶段；末尾综合现状）。 */
function renderContCharProfilesUI(cont) {
  ensureContProfiles(cont);
  const list = cont.charProfiles.length ? cont.charProfiles : [makeContCharProfile()];
  const cards = list
    .map((c, i) => {
      const foldKey = `ct-char-${i}`;
      const coreRows = CONT_CHAR_CORE_FIELDS.map((f) => {
        const tall = f.key === 'keywords';
        const rowsAttr = tall ? 2 : 1;
        return `<tr>
          <th>${esc(f.label)}</th>
          <td><textarea class="ns-profile-input" data-profile="char-core" data-idx="${i}" data-field="${f.key}" rows="${rowsAttr}" placeholder="${esc(f.label)}">${esc(c[f.key] || '')}</textarea></td>
        </tr>`;
      }).join('');
      const stages = Array.isArray(c.stages) && c.stages.length ? c.stages : [makeContCharStage({ label: '阶段1' })];
      const stageHtml = stages
        .map((st, si) => {
          const stageFold = `ct-char-${i}-st-${si}`;
          const isSummary = isCharSummaryStage(st);
          const rows = CONT_CHAR_STAGE_FIELDS.map((f) => {
            if (isSummary && f.key === 'label') {
              return `<tr>
                <th>${esc(f.label)}</th>
                <td><input type="text" class="ns-profile-input" data-profile="char-stage" data-idx="${i}" data-stage="${si}" data-field="label" value="${esc(CONT_CHAR_SUMMARY_LABEL)}" readonly /></td>
              </tr>`;
            }
            const tall = ['psyche', 'background', 'personality', 'appearance', 'ability', 'events', 'status', 'speech'].includes(f.key);
            const rowsAttr = f.short ? 1 : tall ? 4 : 3;
            return `<tr>
              <th>${esc(f.label)}</th>
              <td><textarea class="ns-profile-input" data-profile="char-stage" data-idx="${i}" data-stage="${si}" data-field="${f.key}" rows="${rowsAttr}" placeholder="${esc(f.label)}">${esc(st[f.key] || '')}</textarea></td>
            </tr>`;
          }).join('');
          const stTitle = isSummary
            ? '综合现状（描述）'
            : String(st.label || '').trim() || `阶段 ${si + 1}`;
          return `
            <div class="ns-profile-stage${isSummary ? ' ns-profile-stage--summary' : ''}" data-idx="${i}" data-stage="${si}">
              <div class="ns-profile-stage__head" data-act="ct-stage-toggle" data-fold-key="${stageFold}" title="展开/折叠该阶段">
                <i class="fa-solid fa-chevron-right ns-collapse__icon ${foldIconClass(stageFold)}"></i>
                <strong class="ns-profile-stage__title">${esc(stTitle)}</strong>
                ${
                  isSummary
                    ? ''
                    : `<button type="button" class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-stage-del" data-idx="${i}" data-stage="${si}" title="删除该阶段"><i class="fa-solid fa-trash"></i></button>`
                }
              </div>
              <div class="ns-profile-stage__body"${foldBodyStyle(stageFold)}>
                <table class="ns-table ns-profile-table"><tbody>${rows}</tbody></table>
              </div>
            </div>`;
        })
        .join('');
      const title = c.name ? `角色 ${i + 1} · ${esc(c.name)}` : `角色 ${i + 1}`;
      return `
        <div class="ns-profile-card" data-idx="${i}">
          <div class="ns-profile-card__head" data-act="ct-char-toggle" data-fold-key="${foldKey}" title="展开/折叠该角色">
            <i class="fa-solid fa-chevron-right ns-collapse__icon ${foldIconClass(foldKey)}"></i>
            <strong class="ns-profile-card__title">${title}</strong>
            <button type="button" class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-char-del" data-idx="${i}" title="删除该角色"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="ns-profile-card__body"${foldBodyStyle(foldKey)}>
            <div class="ns-profile-scroll">
              <table class="ns-table ns-profile-table"><tbody>${coreRows}</tbody></table>
              <div class="ns-profile-stages">${stageHtml}</div>
              <div class="ns-row" style="margin-top:8px;">
                <button type="button" class="ns-btn ns-btn--sm" data-act="ct-stage-add" data-idx="${i}" title="在综合现状之前新增阶段"><i class="fa-solid fa-plus"></i> 添加阶段</button>
              </div>
            </div>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div class="ns-profile-block" id="${EXT_ID}-ct-chars">
      <div class="ns-profile-list">
        ${cards || '<p class="ns-muted">暂无角色，请点击标题旁「添加角色」。</p>'}
      </div>
    </div>`;
}

/** 渲染可编辑剧情梗概（文本维度 + 分列势力组织）。 */
function renderContPlotProfileUI(cont) {
  ensureContProfiles(cont);
  const p = cont.plotProfile;
  const rows = CONT_PLOT_TEXT_FIELDS.map(
    (f) => `<tr>
      <th>${esc(f.label)}</th>
      <td><textarea class="ns-profile-input" data-profile="plot" data-field="${f.key}" rows="3" placeholder="${esc(f.label)}…">${esc(p[f.key] || '')}</textarea></td>
    </tr>`,
  ).join('');
  const factions = Array.isArray(p.factions) ? p.factions : [];
  const factionCards = (factions.length ? factions : []).map((fa, i) => {
    const moralOpts = CONT_MORALITY_OPTIONS.map((opt) => {
      const sel = String(fa.morality || '').trim() === opt ? ' selected' : '';
      return `<option value="${esc(opt)}"${sel}>${esc(opt)}</option>`;
    }).join('');
    const customMoral = String(fa.morality || '').trim();
    const customSel = customMoral && !CONT_MORALITY_OPTIONS.includes(customMoral);
    return `
      <div class="ns-profile-faction" data-faction="${i}">
        <div class="ns-profile-faction__head">
          <strong>组织 ${i + 1}${fa.name ? ` · ${esc(fa.name)}` : ''}</strong>
          <button type="button" class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-faction-del" data-faction="${i}" title="删除该组织"><i class="fa-solid fa-trash"></i></button>
        </div>
        <table class="ns-table ns-profile-table"><tbody>
          <tr>
            <th>组织名称</th>
            <td><textarea class="ns-profile-input" data-profile="faction" data-faction="${i}" data-field="name" rows="1" placeholder="组织/势力名称">${esc(fa.name || '')}</textarea></td>
          </tr>
          <tr>
            <th>主要成员</th>
            <td><textarea class="ns-profile-input" data-profile="faction" data-faction="${i}" data-field="members" rows="2" placeholder="甲、乙、丙…">${esc(fa.members || '')}</textarea></td>
          </tr>
          <tr>
            <th>目的</th>
            <td><textarea class="ns-profile-input" data-profile="faction" data-faction="${i}" data-field="goal" rows="2" placeholder="该组织的目标/纲领">${esc(fa.goal || '')}</textarea></td>
          </tr>
          <tr>
            <th>道德</th>
            <td>
              <select class="ns-select ns-profile-input" data-profile="faction" data-faction="${i}" data-field="morality">
                <option value="">（未填）</option>
                ${moralOpts}
                ${customSel ? `<option value="${esc(customMoral)}" selected>${esc(customMoral)}</option>` : ''}
              </select>
            </td>
          </tr>
        </tbody></table>
      </div>`;
  }).join('');
  return `
    <div class="ns-profile-block" id="${EXT_ID}-ct-plot">
      <div class="ns-profile-scroll">
        <table class="ns-table ns-profile-table"><tbody>${rows}</tbody></table>
        <div class="ns-profile-factions" id="${EXT_ID}-ct-factions">
          <div class="ns-row" style="margin:10px 0 6px; align-items:center;">
            <strong>势力阵营</strong>
          </div>
          ${factionCards || '<p class="ns-muted">暂无组织，可点击标题旁「添加组织」或等待分析自动提取。</p>'}
        </div>
      </div>
    </div>`;
}

/** 从 DOM 收集角色档案与剧情梗概表格。 */
function collectContProfilesFromDOM(cont) {
  const $ = globalThis.jQuery;
  if (!$ || !cont) return;
  ensureContProfiles(cont);
  const chars = [];
  $(`#${EXT_ID}-ct-chars .ns-profile-card`).each(function () {
    const idx = Number($(this).attr('data-idx'));
    const seed = { name: '', gender: '', keywords: '', stages: [] };
    $(this)
      .find('.ns-profile-input[data-profile="char-core"]')
      .each(function () {
        const field = String($(this).attr('data-field') || '');
        if (field) seed[field] = String($(this).val() ?? '');
      });
    const stageMap = new Map();
    $(this)
      .find('.ns-profile-input[data-profile="char-stage"]')
      .each(function () {
        const si = Number($(this).attr('data-stage'));
        const field = String($(this).attr('data-field') || '');
        if (!Number.isInteger(si) || !field) return;
        if (!stageMap.has(si)) stageMap.set(si, {});
        stageMap.get(si)[field] = String($(this).val() ?? '');
      });
    const stageIdxs = [...stageMap.keys()].sort((a, b) => a - b);
    seed.stages = stageIdxs.map((si) => stageMap.get(si));
    if (!seed.stages.length) seed.stages = [makeContCharStage({ label: '阶段1' })];
    const row = makeContCharProfile(seed);
    if (contCharProfileHasContent(row) || Number.isInteger(idx)) chars.push(row);
  });
  cont.charProfiles = chars.length ? chars : [makeContCharProfile()];

  const plotSeed = { factions: [] };
  $(`#${EXT_ID}-ct-plot .ns-profile-input[data-profile="plot"]`).each(function () {
    const field = String($(this).attr('data-field') || '');
    if (field) plotSeed[field] = String($(this).val() ?? '');
  });
  const factionMap = new Map();
  $(`#${EXT_ID}-ct-plot .ns-profile-input[data-profile="faction"]`).each(function () {
    const fi = Number($(this).attr('data-faction'));
    const field = String($(this).attr('data-field') || '');
    if (!Number.isInteger(fi) || !field) return;
    if (!factionMap.has(fi)) factionMap.set(fi, {});
    factionMap.get(fi)[field] = String($(this).val() ?? '');
  });
  plotSeed.factions = [...factionMap.keys()]
    .sort((a, b) => a - b)
    .map((fi) => makeContFaction(factionMap.get(fi)))
    .filter(contFactionHasContent);
  cont.plotProfile = makeContPlotProfile(plotSeed);

  cont.characters = contCharProfilesText(cont);
  cont.plot = contPlotProfileText(cont);
}

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
    '你是小说分析助手。精读给定小说片段，提取角色档案与剧情线索。',
    '必须只输出一个合法 JSON 对象，不要代码块标记或多余文字。格式：',
    '{"characters":[{"name":"名称","gender":"性别","keywords":"主名、别称、绰号","stages":[{"label":"阶段名","title":"称号","psyche":"贯彻正义的忠诚信仰人格","age":"年龄","lookAge":"貌龄","identity":"身份","personality":"性格","background":"背景","appearance":"外貌","ability":"技能","events":"重要事件","status":"剧情状况","weakness":"弱点","speech":"话语示例"}]}],"plot":{"worldview":"","background":"","development":"","themes":"","timeline":"","extra":"","factions":[{"name":"组织名","members":"甲、乙","goal":"目的","morality":"善良|中立|邪恶|中立偏善良"}]}',
    '规则：',
    '1. 只写本片段可见信息；不确定写「不详」或「疑似…」，【禁止空字符串】——stages 内除 label 外每个字段都必须有内容。',
    '2. 【同一人物只输出一条】：真名/化名仍是同一人；name 用主名；keywords（主要关键字）用顿号列出可触发检索的名字/称号/别称，至少含主名。',
    '3. 档案必须按「阶段」分割：stages 为数组，每个元素是一个完整阶段块（字段：称号/人格心理/年龄/貌龄/身份/性格/背景/外貌/技能/重要事件/剧情状况/弱点/话语示例）。',
    '4. psyche（人格心理）必须由你根据剧情总结成一句定性短语，禁止输出 MBTI 字母；示例：「贯彻正义的忠诚信仰人格」「彻底堕落绝望的淫乱人格」「喜爱折磨他人的残酷阴暗人格」。人物转变时可写「曾…，现…」。',
    '5. 本片段若人物状态有明显演变，输出多个阶段（按时间先后）；否则 1 个阶段即可。label 写清阶段名（如「童年」「入府后」「改造后」）。',
    '6. 【不要】在单段提取里写「综合现状」；综合现状由系统在合并后生成。',
    '7. ability 对应「技能」（含技能与改造特征）；status 对应「剧情状况」。',
    '8. plot.factions 为数组，每组织含 name/members/goal/morality；不同组织分开。',
    '9. 禁止残缺 JSON 或解释文字。',
  ].join('\n');
  const user = `【片段 ${index + 1}/${totalChunks}】\n${chunkText}\n\n请提取本片段角色与剧情，只输出 JSON:`;
  return { system, user };
}

/** 解析单段分析结果为表格结构（JSON 优先，失败再降级旧文本）。 */
function parseChunkAnalysisResult(text) {
  const parsed = parseFinalContAnalysis(text);
  if (!parsed) {
    return { charProfiles: [], plotProfile: makeContPlotProfile() };
  }
  return {
    charProfiles: Array.isArray(parsed.charProfiles) ? parsed.charProfiles : [],
    plotProfile: parsed.plotProfile || makeContPlotProfile(),
  };
}

async function analyzeChunk(chunkText, index, totalChunks) {
  const { system, user } = buildChunkAnalyzePrompt(chunkText, index, totalChunks);
  const gid = `analyze_${Date.now()}_${index}`;
  analyzeState.genIds.add(gid);
  try {
    const raw = (
      await novelGenerateWithId({ system, user }, gid, () => analyzeState.cancelRequested, {
        minLen: 20,
        maxRetries: 2,
      })
    ).trim();
    return parseChunkAnalysisResult(raw);
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

/** 角色名是否为 JSON/脏解析产物（如 {"characters"）。 */
function isJunkAnalyzeCharName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^[\{\}\[\]",:\\]+$/.test(n)) return true;
  if (/[{}\[\]"]/.test(n)) return true;
  if (
    /^(characters|character|charprofiles|charprofile|plot|plotprofile|name|gender|age|personality|setting|status|change|clothing|ability|habit|extra|worldview|background|development|themes|factions|timeline)$/i.test(
      n,
    )
  ) {
    return true;
  }
  if (/^\{?\s*"?characters"?$/i.test(n)) return true;
  return false;
}

/** 角色名归一化，用于同名合并。 */
function normalizeAnalyzeCharKey(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[《》【】\[\]（）()「」『』"'‘’“”·・\.。]/g, '')
    .toLowerCase();
}

/**
 * 从姓名/设定/其它字段收集可能的别名键（化名、曾用名、括号名、斜杠名等）。
 * @returns {string[]} 已归一化的 key 列表（含本名）
 */
function collectAnalyzeCharAliasKeys(profile) {
  const keys = new Set();
  const add = (raw) => {
    const k = normalizeAnalyzeCharKey(raw);
    if (k && !isJunkAnalyzeCharName(raw) && k.length >= 1) keys.add(k);
  };
  const name = String(profile?.name || '').trim();
  add(name);

  // 主名（化名X）/ 主名(又名X) / 主名/化名
  const paren = [...name.matchAll(/[（(]\s*([^）)]{1,24})\s*[）)]/g)];
  for (const m of paren) {
    const inner = String(m[1] || '')
      .replace(/^(?:化名|假名|曾用名|原名|真名|又名|亦名|号|外号|马甲)\s*[为是:]?\s*/i, '')
      .trim();
    if (inner) add(inner);
  }
  if (/[\/／]/.test(name)) {
    for (const part of name.split(/[\/／]/)) add(part.trim());
  }
  // 去掉括号后的主名
  const core = name.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (core) add(core);

  const blob = [
    profile?.title,
    ...(Array.isArray(profile?.stages) ? profile.stages : []).flatMap((st) => [
      st?.identity,
      st?.background,
      st?.events,
      st?.extra,
      st?.personality,
      st?.status,
    ]),
  ]
    .map((x) => String(x || ''))
    .join('\n');
  const aliasRe =
    /(?:化名|假名|曾用名|原名|真名|又名|亦名|别名|外号|号称|马甲|伪装成|改名[为作]?|自称)\s*[为是:]?\s*[「『"']?([\u4e00-\u9fffA-Za-z0-9·・]{1,16})[」』"']?/gi;
  let m;
  while ((m = aliasRe.exec(blob))) add(m[1]);

  // 「A即B」「A就是B」
  const eqRe =
    /([\u4e00-\u9fffA-Za-z0-9·・]{1,12})\s*(?:即|就是|实为|实则是)\s*[「『"']?([\u4e00-\u9fffA-Za-z0-9·・]{1,12})[」』"']?/g;
  while ((m = eqRe.exec(blob))) {
    add(m[1]);
    add(m[2]);
  }
  return [...keys];
}

/** 档案信息充实度，用于选主档案与主名。 */
function scoreAnalyzeCharProfile(p) {
  if (!p) return 0;
  let score = 0;
  for (const f of CONT_CHAR_CORE_FIELDS) {
    const v = String(p[f.key] || '').trim();
    if (v) score += Math.min(40, v.length) + (f.key === 'name' ? 8 : 6);
  }
  for (const st of Array.isArray(p.stages) ? p.stages : []) {
    for (const f of CONT_CHAR_STAGE_FIELDS) {
      const v = String(st?.[f.key] || '').trim();
      if (!v) continue;
      score += Math.min(60, v.length) + 10;
    }
  }
  return score;
}

/** 合并同人档案时记录更名：写入最新阶段 events/title。 */
function noteAnalyzeCharIdentityMerge(primary, secondary) {
  const a = String(primary?.name || '').trim();
  const b = String(secondary?.name || '').trim();
  const out = makeContCharProfile(
    scoreAnalyzeCharProfile(secondary) > scoreAnalyzeCharProfile(primary) + 20 ? secondary : primary,
  );
  const otherName =
    normalizeAnalyzeCharKey(out.name) === normalizeAnalyzeCharKey(a) ? b : a;
  const outCore = String(out.name || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
  if (
    otherName &&
    normalizeAnalyzeCharKey(otherName) &&
    normalizeAnalyzeCharKey(otherName) !== normalizeAnalyzeCharKey(outCore)
  ) {
    out.name = outCore;
    if (!out.stages?.length) out.stages = [makeContCharStage({ label: '阶段1' })];
    const prior = out.stages.filter((s) => !isCharSummaryStage(s));
    const last = prior[prior.length - 1] || makeContCharStage({ label: '阶段1' });
    last.title = mergeAnalyzeTextField(last.title, `又名${otherName}`, 200);
    last.events = mergeAnalyzeTextField(
      last.events,
      `以「${otherName}」之名出现 → 现用「${outCore}」`,
      1800,
    );
    out.stages = [...prior.slice(0, -1), finalizeContCharStage(last)];
  }
  return out;
}

/**
 * 二次合并：把化名/真名指向同一人的多条档案收成一条。
 * 各阶段保留；更名写入阶段事件。
 */
function mergeAnalyzeCharAliases(profiles) {
  const list = (profiles || [])
    .map((p) => finalizeContCharProfile(makeContCharProfile(p)))
    .filter((p) => !isJunkAnalyzeCharName(p.name));
  if (list.length <= 1) return list;

  const n = list.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    let y = i;
    while (y !== x) {
      const next = parent[y];
      parent[y] = x;
      y = next;
    }
    return x;
  };
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  /** @type {Map<string, number[]>} */
  const keyToIndices = new Map();
  list.forEach((p, idx) => {
    for (const k of collectAnalyzeCharAliasKeys(p)) {
      if (!keyToIndices.has(k)) keyToIndices.set(k, []);
      keyToIndices.get(k).push(idx);
    }
  });
  for (const indices of keyToIndices.values()) {
    for (let i = 1; i < indices.length; i++) union(indices[0], indices[i]);
  }

  /** @type {Map<number, typeof list>} */
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(list[i]);
  }

  const merged = [];
  for (const group of groups.values()) {
    group.sort((a, b) => scoreAnalyzeCharProfile(b) - scoreAnalyzeCharProfile(a));
    let acc = group[0];
    for (let i = 1; i < group.length; i++) {
      const right = group[i];
      const noted = noteAnalyzeCharIdentityMerge(acc, right);
      acc = mergeAnalyzeCharProfile(acc, right);
      if (noted?.name) acc.name = noted.name;
      if (noted?.stages?.length) {
        const nPrior = noted.stages.filter((s) => !isCharSummaryStage(s));
        const nLast = nPrior[nPrior.length - 1];
        const aPrior = (acc.stages || []).filter((s) => !isCharSummaryStage(s));
        const aLast = aPrior[aPrior.length - 1] || makeContCharStage();
        if (nLast) {
          aLast.title = mergeAnalyzeTextField(aLast.title, nLast.title, 200);
          aLast.events = mergeAnalyzeTextField(aLast.events, nLast.events, 1800);
          acc.stages = [...aPrior.slice(0, -1), finalizeContCharStage(aLast)];
        }
      }
    }
    merged.push(ensureCharSummaryStage(acc, { rebuild: true }));
  }
  return merged.length ? merged : list;
}

/** 合并两段文本字段：去包含关系，控制长度。 */
function mergeAnalyzeTextField(a, b, maxLen = 1800) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y) return x;
  if (x === y) return x;
  if (x.includes(y)) return clipTextHead(x, maxLen);
  if (y.includes(x)) return clipTextHead(y, maxLen);
  return clipTextHead(`${x}；${y}`, maxLen);
}

/** 合并人物变化链：拆「→」节点去重后重拼。 */
function mergeAnalyzeChangeField(a, b, maxLen = 1200) {
  const split = (s) =>
    String(s || '')
      .split(/\s*(?:→|->|➔|⇒)\s*/)
      .map((n) => n.trim())
      .filter(Boolean);
  const seen = new Set();
  const nodes = [];
  for (const n of [...split(a), ...split(b)]) {
    const k = n.replace(/\s+/g, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    nodes.push(n);
  }
  return clipTextHead(nodes.join(' → '), maxLen);
}

/** 合并剧情多行字段：按行去重后拼接。 */
function mergeAnalyzePlotLines(a, b, maxLen = 2400) {
  const split = (s) =>
    String(s || '')
      .split(/\n+|；|;/)
      .map((l) => l.trim())
      .filter(Boolean);
  const seen = new Set();
  const lines = [];
  for (const l of [...split(a), ...split(b)]) {
    const k = l.replace(/\s+/g, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(l);
  }
  return clipTextHead(lines.join('\n'), maxLen);
}

function stageFingerprint(st) {
  const parts = ['identity', 'personality', 'status', 'appearance', 'ability', 'label']
    .map((k) => String(st?.[k] || '').replace(/\s+/g, '').toLowerCase())
    .filter(Boolean);
  return parts.join('|').slice(0, 240);
}

function stagesAreSimilar(a, b) {
  const fa = stageFingerprint(a);
  const fb = stageFingerprint(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  if (fa.includes(fb) || fb.includes(fa)) return true;
  // 同 label 且身份相近
  const la = String(a?.label || '').replace(/\s+/g, '');
  const lb = String(b?.label || '').replace(/\s+/g, '');
  if (la && lb && la === lb) {
    const ia = String(a?.identity || '').replace(/\s+/g, '');
    const ib = String(b?.identity || '').replace(/\s+/g, '');
    if (ia && ib && (ia.includes(ib) || ib.includes(ia))) return true;
  }
  return false;
}

function mergeAnalyzeCharStage(base, next) {
  const out = makeContCharStage(base || {});
  const b = makeContCharStage(next || {});
  for (const f of CONT_CHAR_STAGE_FIELDS) {
    const key = f.key;
    if (key === 'label') {
      out.label = out.label || b.label;
      continue;
    }
    if (key === 'age' || key === 'lookAge') {
      if (!String(out[key] || '').trim()) out[key] = b[key] || '';
      else if (String(b[key] || '').trim() && String(b[key]).trim() !== String(out[key]).trim()) {
        out[key] = `${String(out[key]).trim()} → ${String(b[key]).trim()}`;
      }
      continue;
    }
    if (key === 'psyche') {
      out.psyche = mergeAnalyzeTextField(out.psyche, b.psyche, 400);
      continue;
    }
    if (key === 'events' || key === 'speech') {
      out[key] = mergeAnalyzePlotLines(out[key], b[key], key === 'events' ? 3200 : 1600);
      continue;
    }
    if (key === 'status' || key === 'ability') {
      out[key] = mergeAnalyzeTextField(out[key], b[key], 1400);
      continue;
    }
    out[key] = mergeAnalyzeTextField(out[key], b[key], key === 'extra' || key === 'background' ? 2200 : 1600);
  }
  return finalizeContCharStage(out);
}

/** 合并同名角色：核心字段合并，阶段按相似度并入或追加；末尾重建综合现状。 */
function mergeAnalyzeCharProfile(base, next) {
  const out = makeContCharProfile(base || {});
  const b = makeContCharProfile(next || {});
  out.name = out.name || b.name;
  if (!String(out.gender || '').trim()) out.gender = b.gender || '';
  out.keywords = mergeAnalyzeTextField(
    String(out.keywords || '').replace(/[;；]/g, '、'),
    String(b.keywords || '').replace(/[;；]/g, '、'),
    200,
  );
  // 关键字去重规范化
  out.keywords = parseContCharKeywords(out.keywords, out.name).join('、');
  const stages = [...(out.stages || [])].filter((s) => !isCharSummaryStage(s));
  for (const incoming of (b.stages || []).filter((s) => !isCharSummaryStage(s))) {
    let mergedInto = false;
    for (let i = 0; i < stages.length; i++) {
      if (stagesAreSimilar(stages[i], incoming)) {
        stages[i] = mergeAnalyzeCharStage(stages[i], incoming);
        mergedInto = true;
        break;
      }
    }
    if (!mergedInto) {
      const st = makeContCharStage(incoming);
      if (!String(st.label || '').trim() || st.label === '阶段') st.label = `阶段${stages.length + 1}`;
      stages.push(st);
    }
  }
  out.stages = stages.length ? stages : [makeContCharStage({ label: '阶段1' })];
  return ensureCharSummaryStage(out, { rebuild: true });
}

function mergeAnalyzeFaction(base, next) {
  const out = makeContFaction(base || {});
  const b = makeContFaction(next || {});
  out.name = out.name || b.name;
  out.members = mergeAnalyzeTextField(out.members, b.members, 800);
  out.goal = mergeAnalyzeTextField(out.goal, b.goal, 1200);
  if (!String(out.morality || '').trim()) out.morality = normalizeFactionMorality(b.morality);
  else if (String(b.morality || '').trim() && normalizeFactionMorality(b.morality) !== normalizeFactionMorality(out.morality)) {
    // 保留更具体的道德描述
    const bm = normalizeFactionMorality(b.morality);
    if (bm.length >= String(out.morality).trim().length) out.morality = bm;
  } else {
    out.morality = normalizeFactionMorality(out.morality);
  }
  return out;
}

function mergeAnalyzePlotProfile(base, next) {
  const out = makeContPlotProfile(base || {});
  const b = makeContPlotProfile(next || {});
  for (const f of CONT_PLOT_TEXT_FIELDS) {
    const key = f.key;
    if (key === 'development' || key === 'timeline') {
      out[key] = mergeAnalyzePlotLines(out[key], b[key], 3200);
    } else {
      out[key] = mergeAnalyzeTextField(out[key], b[key], 2000);
    }
  }
  const map = new Map();
  const order = [];
  const add = (fa) => {
    const row = makeContFaction(fa);
    if (!contFactionHasContent(row)) return;
    const key = normalizeAnalyzeCharKey(row.name) || `anon_${order.length}`;
    if (!map.has(key)) {
      map.set(key, row);
      order.push(key);
    } else {
      map.set(key, mergeAnalyzeFaction(map.get(key), row));
    }
  };
  for (const fa of out.factions || []) add(fa);
  for (const fa of b.factions || []) add(fa);
  out.factions = order.map((k) => map.get(k)).filter(Boolean);
  return out;
}

/**
 * 本地合并各段结构化结果（无额外 LLM 聚合轮次）。
 * 同名角色合并字段；剧情维度按时间顺序拼接去重。
 */
function mergeChunkAnalysisLocally(partials) {
  const charMap = new Map(); // key -> profile
  const charOrder = [];
  let plotProfile = makeContPlotProfile();

  for (const part of partials || []) {
    if (!part) continue;
    const chars = Array.isArray(part.charProfiles) ? part.charProfiles : [];
    for (const raw of chars) {
      const row = makeContCharProfile(raw);
      if (isJunkAnalyzeCharName(row.name)) continue;
      const key = normalizeAnalyzeCharKey(row.name);
      if (!key) continue;
      if (!charMap.has(key)) {
        charMap.set(key, row);
        charOrder.push(key);
      } else {
        charMap.set(key, mergeAnalyzeCharProfile(charMap.get(key), row));
      }
    }
    if (part.plotProfile) {
      plotProfile = mergeAnalyzePlotProfile(plotProfile, part.plotProfile);
    }
  }

  const charProfiles = charOrder
    .map((k) => ensureCharSummaryStage(charMap.get(k), { rebuild: true }))
    .filter((p) => p && !isJunkAnalyzeCharName(p.name));
  const aliasMerged = mergeAnalyzeCharAliases(charProfiles).map((p) =>
    ensureCharSummaryStage(p, { rebuild: true }),
  );
  const finalChars = aliasMerged.length ? aliasMerged : [makeContCharProfile()];
  return {
    charProfiles: finalChars,
    plotProfile,
    characters: contCharProfilesText({ charProfiles: finalChars }),
    plot: contPlotProfileText({ plotProfile }),
  };
}

/** 聚合：仅本地合并各段 JSON/表格结果，不再做多层 LLM 树状聚合。 */
async function aggregateAnalyses(partials, onProgress) {
  const clean = (partials || []).filter((p) => p && (Array.isArray(p.charProfiles) || p.plotProfile));
  if (clean.length === 0) {
    return {
      charProfiles: [makeContCharProfile()],
      plotProfile: makeContPlotProfile(),
      characters: '',
      plot: '',
    };
  }
  onProgress?.(`本地合并 ${clean.length} 段档案…`);
  // 让出事件循环，便于进度条刷新
  await sleep(0);
  if (analyzeState.cancelRequested) throw new Error('已中止');
  const merged = mergeChunkAnalysisLocally(clean);
  onProgress?.(`合并完成：角色 ${merged.charProfiles.filter((c) => String(c.name || '').trim()).length} 人`);
  return merged;
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
  analyzeState.progressMsg = '';
  analyzeState.progressPct = 0;
  syncMiniBallBusy();
  const t0 = Date.now();
  try {
    onProgress?.(
      `共 ${full.length} 字, 切为 ${chunks.length} 段, 并发 ${concurrency}, 开始提取…`,
      0,
    );
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
          return null;
        }
      },
      (done, total) => onProgress?.(`提取中 ${done}/${total} 段…`, Math.round((done / total) * 90)),
      () => analyzeState.cancelRequested,
    );
    if (analyzeState.cancelRequested) throw new Error('已中止');
    onProgress?.(
      failed ? `提取完成(${failed} 段失败已跳过), 本地合并档案…` : '提取完成, 本地合并档案…',
      92,
    );
    const profiles = await aggregateAnalyses(partials, (m) => onProgress?.(m, 96));
    if (analyzeState.cancelRequested) throw new Error('已中止');

    const result = {
      title: title || analyzeState.uploadedName || '导入的小说',
      charProfiles: profiles.charProfiles,
      plotProfile: profiles.plotProfile,
      characters: profiles.characters,
      plot: profiles.plot,
      totalChars: full.length,
      chunkCount: chunks.length,
      analyzedAt: Date.now(),
    };
    analyzeState.result = result;

    const tailN = getSettings().contextTailChars || 2500;
    const sourceTail = full.slice(Math.max(0, full.length - tailN));
    // 优先写入上传时自动新建的会话；若已删则回退新建
    let cont =
      (analyzeState.pendingContId &&
        getContinuations().find((c) => c.id === analyzeState.pendingContId)) ||
      null;
    if (!cont) {
      cont = createContinuation(result.title);
      analyzeState.pendingContId = cont.id;
    }
    cont.title = result.title;
    cont.charProfiles = profiles.charProfiles.map((c) => makeContCharProfile(c));
    cont.plotProfile = makeContPlotProfile(profiles.plotProfile);
    cont.characters = profiles.characters;
    cont.plot = profiles.plot;
    cont.sourceTail = sourceTail;
    cont.totalChars = full.length;
    cont.analyzedAt = result.analyzedAt;
    getSettings().activeContinuationId = cont.id;
    saveSettings();

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    onProgress?.(`分析完成! 用时 ${secs}s`, 100);
    log.info('分析完成', {
      chars: full.length,
      chunks: chunks.length,
      failed,
      roles: profiles.charProfiles.filter((c) => String(c.name || '').trim()).length,
      secs,
      contId: cont.id,
    });
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
    if (ensureContProfiles(cont)) dirty = true;
    ensureContFreeBatch(cont);
    if (typeof cont.freeTone !== 'string') cont.freeTone = '';
    ensureContFreePlotSpeed(cont);
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
    charProfiles: [makeContCharProfile()],
    plotProfile: makeContPlotProfile(),
    characters: '',
    plot: '',
    worldBookName: '',
    sourceTail: '',
    totalChars: 0,
    analyzedAt: 0,
    mode: 'outline',
    targetChapters: 1,
    targetActs: 1,
    targetSecsPerAct: 1,
    freeTone: '',
    freePlotSpeed: 'medium',
    freeBatchActive: false,
    freeBatchRemain: 0,
    freeBatchSecs: 1,
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

/**
 * 锁定/已写正文之后开新批次时的承接包：剧情链+人物近况 + 最近 1～2 节正文结尾。
 * 强化基调外的「同一连续故事线」约束，避免新批次另起炉灶。
 * @returns {{ hasPrior:boolean, systemRule:string, userBlock:string }}
 */
function buildContFreeContinuityPack(cont, flatIdx, { ultra = false, slim = false, forOutline = false } = {}) {
  if (!hasContPriorBody(cont)) {
    return { hasPrior: false, systemRule: '', userBlock: '' };
  }
  const mem = buildGrandSummaryForWrite(cont, {
    maxChars: ultra ? 720 : slim ? 1100 : forOutline ? 1800 : 2200,
    plotKeep: ultra ? 5 : slim ? 8 : 14,
    chainStepKeep: ultra ? 1 : slim ? 2 : 3,
    skipChapterSummaries: true,
    latestOnly: false,
  });
  const flat = flatSections(cont);
  const end = Math.min(Math.max(0, flatIdx), flat.length);
  const tails = [];
  let found = 0;
  const primaryChars = ultra ? 360 : forOutline ? 560 : 1100;
  const secondaryChars = ultra ? 220 : forOutline ? 320 : 520;
  for (let i = end - 1; i >= 0 && found < 2; i--) {
    const f = flat[i];
    if (!hasValidSectionContent(f?.sec)) continue;
    const body = String(f.sec.content).trim();
    const n = found === 0 ? primaryChars : secondaryChars;
    tails.push(
      `【第${f.actIdx + 1}章第${f.secIdx + 1}节结尾】\n${clipTextTail(body, n)}`,
    );
    found += 1;
  }
  const systemRule = joinPromptBlocks(
    '【承接前文·必须遵守】须与已锁定/已写内容为同一连续故事线：人物处境、装备、关系、未决冲突与时间线须衔接；禁止另起炉灶、换皮重开、无视前文结局状态，也禁止复述已写大段对白。',
    mem
      ? `【已写进度摘要·只读（剧情链/人物链）】\n${mem}\n（新大纲/正文须在此进度上向前推进，勿矛盾、勿重置。）`
      : '',
  );
  const userBlock = tails.length
    ? `【前文结尾（须自然承接，勿复读）】\n${tails.reverse().join('\n\n')}`
    : '';
  return { hasPrior: true, systemRule, userBlock };
}

/**
 * 上一章全部节大纲摘要（整批先写大纲时，下一章第 1 节靠它承接）。
 * @returns {string}
 */
function contPriorActOutlineSummary(cont, actIdx, { perChars = 140, maxSecs = 12 } = {}) {
  if (!cont || actIdx <= 0) return '';
  const prev = cont.acts?.[actIdx - 1];
  if (!prev) return '';
  const secs = Array.isArray(prev.sections) ? prev.sections : [];
  const parts = [];
  const start = Math.max(0, secs.length - Math.max(1, maxSecs));
  for (let i = start; i < secs.length; i++) {
    const ol = String(secs[i]?.outline || '').trim();
    if (!ol) continue;
    parts.push(`第${i + 1}节：${clipTextHead(ol, perChars)}`);
  }
  if (!parts.length) return '';
  const title = String(prev.title || '').trim();
  return `【上一章大纲·第${actIdx}章${title ? `「${title}」` : ''}】\n${parts.join('\n')}`;
}

/**
 * 跨章桥接：上一章末状态 + 大纲摘要 +（若有）章总结。
 * 供自然续写下一章开篇大纲/正文使用，避免回落到原文末尾或复读上一章。
 * @returns {string}
 */
function contCrossChapterBridge(
  cont,
  actIdx,
  flatIdx,
  { ultra = false, forOutline = false } = {},
) {
  if (!cont || actIdx <= 0) return '';
  const prev = cont.acts?.[actIdx - 1];
  if (!prev) return '';
  const blocks = [];
  const title = String(prev.title || '').trim();
  const head = `第${actIdx}章${title ? `「${title}」` : ''}`;

  // 上一章末正文（已写完时）或末节大纲（整批先大纲阶段）
  const bodyTailChars = ultra ? 360 : forOutline ? 520 : 900;
  let endBlock = '';
  const recent = contRecentTail(cont, flatIdx, bodyTailChars);
  if (recent) {
    endBlock = `【上一章结尾正文·${head}】\n${recent}`;
  } else {
    const secs = Array.isArray(prev.sections) ? prev.sections : [];
    for (let i = secs.length - 1; i >= 0; i--) {
      const ol = String(secs[i]?.outline || '').trim();
      if (!ol) continue;
      endBlock = `【上一章末节大纲·${head}第${i + 1}节】\n${clipTextHead(ol, ultra ? 160 : 280)}`;
      break;
    }
  }
  if (endBlock) blocks.push(endBlock);

  const olSum = contPriorActOutlineSummary(cont, actIdx, {
    perChars: ultra ? 80 : forOutline ? 120 : 100,
    maxSecs: ultra ? 6 : 10,
  });
  if (olSum) blocks.push(clipTextHead(olSum, ultra ? 420 : forOutline ? 900 : 700));

  // 有章表总结时附一条紧凑前章总结
  if (!ultra && Array.isArray(cont.summaries) && cont.summaries.length) {
    const prevSum = [...cont.summaries]
      .filter((s) => Number(s?.actNo) === actIdx)
      .sort((a, b) => (a.actNo || 0) - (b.actNo || 0))
      .pop();
    if (prevSum) {
      blocks.push(
        clipTextHead(
          `【前章总结·第${prevSum.actNo}章】\n${summaryToCompact(prevSum)}`,
          forOutline ? 360 : 420,
        ),
      );
    }
  }

  if (!blocks.length) return '';
  const rule = forOutline
    ? '【跨章续写规则】上一章已发生内容禁止复述或换皮重写。本章须承接上一章结尾的未决事件/冲突继续发展或加码；「新进展」指同一线的后续，不是另起全新剧情（除非【剧情速度】为快速且【续写基调】要求开新）。'
    : '【跨章续写规则】上一章已写内容禁止复述或换皮重写；本节须从上一章结尾状态承接，写同一线的后续进展，勿无故另开全新剧情。';
  return `${rule}\n\n${blocks.join('\n\n')}`;
}

/**
 * 本章内、当前节之前已有的节大纲（用于「先写完全章大纲」时承接）。
 * @returns {string}
 */
function contPriorOutlinesInAct(cont, actIdx, secIdx, { maxSecs = 6, perChars = 160 } = {}) {
  const act = cont?.acts?.[actIdx];
  if (!act) return '';
  const parts = [];
  const start = Math.max(0, secIdx - maxSecs);
  for (let i = start; i < secIdx; i++) {
    const ol = String(act.sections?.[i]?.outline || '').trim();
    if (!ol) continue;
    parts.push(`第${i + 1}节：${clipTextHead(ol, perChars)}`);
  }
  return parts.length ? `【本章已有大纲】\n${parts.join('\n')}` : '';
}

/**
 * 解析自然续写「本批」节奏位置（相对 freeBatchStartAct / 章节设定）。
 */
function resolveFreeBatchPace(cont, actIdx, secIdx) {
  ensureContFreeBatch(cont);
  const batchStart = Number.isFinite(Number(cont.freeBatchStartAct))
    ? Math.max(0, Number(cont.freeBatchStartAct))
    : Math.max(0, actIdx | 0);
  const batchActs = Math.max(
    1,
    Number(cont.freeBatchActCount) || Number(cont.targetActs) || 1,
  );
  const secsPerAct = Math.max(
    1,
    Number(cont.freeBatchSecs) ||
      cont.acts?.[actIdx]?.sections?.length ||
      Number(cont.targetSecsPerAct) ||
      1,
  );
  const batchEnd = batchStart + batchActs - 1;
  const inBatch = actIdx >= batchStart && actIdx <= batchEnd;
  const actInBatch = inBatch ? actIdx - batchStart + 1 : Math.min(batchActs, Math.max(1, actIdx - batchStart + 1));
  const secInAct = Math.max(1, (secIdx | 0) + 1);
  const totalSecs = batchActs * secsPerAct;
  const flatInBatch = Math.min(totalSecs, (actInBatch - 1) * secsPerAct + secInAct);
  const progress = totalSecs > 0 ? flatInBatch / totalSecs : 1;
  return {
    batchStart,
    batchActs,
    secsPerAct,
    actInBatch: Math.max(1, Math.min(batchActs, actInBatch)),
    secInAct: Math.min(secsPerAct, secInAct),
    totalSecs,
    flatInBatch,
    progress,
    inBatch,
  };
}

/**
 * 清洗自然续写单节大纲：去掉多节连写（如同时输出第5、第6节）。
 * @returns {string}
 */
function normalizeFreeSectionOutline(raw, secIdx, secsInAct = 0) {
  let t = String(raw || '')
    .replace(/^```[\s\S]*?\n|```$/g, '')
    .replace(/^(本节)?大纲\s*[:：]\s*/m, '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim();
  if (!t) return '';

  const n = Math.max(1, (secIdx | 0) + 1);
  const total = Math.max(0, secsInAct | 0);

  // 若模型用「第N节：… / 第N+1节：…」连写，只保留当前节段落
  const secHeaderRe = /(?:^|\n)\s*(?:【\s*)?(?:第\s*)?(\d+)\s*节\s*(?:】)?\s*[:：\.、\)）]?\s*/gi;
  const headers = [];
  let m;
  while ((m = secHeaderRe.exec(t)) !== null) {
    headers.push({ num: Number(m[1]), index: m.index, end: m.index + m[0].length });
  }
  if (headers.length >= 2) {
    const cur = headers.find((h) => h.num === n) || headers[0];
    const next = headers.find((h) => h.index > cur.index);
    t = t.slice(cur.end, next ? next.index : t.length).trim();
  } else {
    // 单段但带「第N节：」前缀则去掉
    t = t
      .replace(new RegExp(`^\\s*(?:【\\s*)?(?:第\\s*)?${n}\\s*节\\s*(?:】)?\\s*[:：\\.、\\)）]?\\s*`, 'i'), '')
      .trim();
  }

  // 截断明显的「下一节」续写
  const nextN = n + 1;
  const nextCut = t.search(
    new RegExp(
      `(?:^|\\n)\\s*(?:【\\s*)?(?:第\\s*)?${nextN}\\s*节\\b|(?:^|\\n)\\s*${nextN}\\s*[\\.、\\)]\\s*|下[一1]节\\s*[:：]`,
      'i',
    ),
  );
  if (nextCut > 20) t = t.slice(0, nextCut).trim();

  // 去掉「第5/6节」这类误标
  t = t
    .replace(/第\s*\d+\s*\/\s*\d+\s*节/g, '')
    .replace(/^\s*[:：\-—]+\s*/, '')
    .trim();

  if (total > 0) {
    // 再保险：若仍含更高节号标题则截断
    for (let k = n + 1; k <= total + 2; k++) {
      const cut = t.search(new RegExp(`(?:^|\\n)\\s*(?:【\\s*)?(?:第\\s*)?${k}\\s*节\\b`, 'i'));
      if (cut > 20) {
        t = t.slice(0, cut).trim();
        break;
      }
    }
  }

  // 自然续写节大纲目标约 80～100 字，硬截断防越写越长
  const FREE_OUTLINE_MAX = 100;
  if (t.length > FREE_OUTLINE_MAX) {
    let cut = t.slice(0, FREE_OUTLINE_MAX);
    // 尽量在句读处截断，避免半句
    const punct = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('，'),
      cut.lastIndexOf('、'),
    );
    if (punct >= 60) cut = cut.slice(0, punct + 1);
    t = cut.trim();
  }
  return t;
}

/**
 * 自然续写正文提示：与写新小说同结构（预设/全局/记忆 + user 任务），
 * 另附本节大纲、续写基调、剧情速度/本批结构、跨章桥接。
 * 空回强化与写新小说一致（reinforce），仅末轮 ultra 才省略预设/跳过 WI。
 */
function buildContFreeBodyPrompt(cont, actIdx, secIdx, flatIdx, { reinforce = false, slim = false, ultra = false } = {}) {
  ensureContProfiles(cont);
  const act = cont.acts[actIdx];
  const sec = act?.sections?.[secIdx];
  const secOutline = String(sec?.outline || '').trim();
  const crossChapter = actIdx > 0;
  const chapterOpen = crossChapter && secIdx === 0;
  const hasOutline = secOutline.length >= 16;
  const useWi = !!String(cont.worldBookName || '').trim();
  const globalKw = readGlobalKeyword();
  const lenHint = extractLengthHintFromKeyword(globalKw);
  const toneInj = buildContFreeToneInject(cont, actIdx, secIdx, { ultra, slim });
  const continuity = buildContFreeContinuityPack(cont, flatIdx, { ultra, slim, forOutline: false });
  const plotText = contPlotProfileText(cont);
  const charText = contCharProfilesText(cont);
  const needReinforce = !!(reinforce || slim || ultra);
  const hasPrior = continuity.hasPrior;

  const system = buildWorkshopSystemPack({
    roleHint: joinPromptBlocks(
      '你是中文小说续写助手。按章-节结构写作。必须严格遵守【全局提示词】（含字数）。',
      '按本节大纲只输出小说正文，不要标题/解释/再写大纲。',
      '禁止调用搜索/联网/工具；必须直接输出正文，禁止返回空消息。',
      '人物姓名、身份、性格、口吻必须与档案/世界书一致，禁止串角或改名。',
      '只写本节该有的进展。严格遵守【剧情弧·硬性节数】（跨章且跨批次累计）：未满禁止收束开新；新开一批不重置计数。',
      toneInj.roleLine,
      hasPrior
        ? '本节是已有正文之后的续写：必须承接【已写进度摘要】与【前文结尾】的人物状态与未决冲突，禁止写成与前文脱节的新开篇。'
        : '',
      crossChapter
        ? '跨章续写：禁止复述或换皮重写上一章已发生的情节/对白/场面；从上一章结尾状态直接推进新进展。'
        : '',
    ),
    memoryObj: cont,
    worldProj: cont,
    reinforce: needReinforce,
    slim: !!slim || !!ultra,
    compactMemory: true,
    memoryMaxChars: ultra ? 900 : slim ? 1400 : hasPrior ? 2400 : 1800,
    plotKeep: ultra ? 4 : slim ? 5 : hasPrior ? 14 : 8,
    chainStepKeep: ultra ? 1 : slim ? 1 : hasPrior ? 3 : 2,
    memorySkipChapterSummaries: true,
    presetMaxChars: ultra ? 700 : slim ? 1200 : 0,
    globalKwMaxChars: ultra ? 500 : slim ? 900 : 0,
    omitPreset: !!ultra,
    extraRules: [
      toneInj.systemRule,
      continuity.systemRule,
      ...(useWi
        ? ultra
          ? (() => {
              const roster = contCharRosterBrief(cont, 420);
              return roster ? [`【角色要点】\n${roster}`] : [];
            })()
          : []
        : [
            charText ? `【角色档案】\n${clipTextHead(charText, ultra ? 500 : slim ? 1000 : 2800)}` : '',
            !crossChapter && plotText
              ? `【剧情梗概】\n${clipTextHead(plotText, ultra ? 260 : slim ? 560 : 2200)}`
              : '',
          ].filter(Boolean)),
    ].filter(Boolean),
  });

  const recent = contRecentTail(cont, flatIdx, ultra ? 500 : slim ? 800 : 1200);
  const source =
    actIdx === 0 && !recent && !continuity.userBlock && cont.sourceTail
      ? clipTextTail(cont.sourceTail, ultra ? 400 : slim ? 700 : 1200)
      : '';
  const bridge = chapterOpen
    ? contCrossChapterBridge(cont, actIdx, flatIdx, { ultra, forOutline: false })
    : '';
  const paceHint = ultra ? '' : buildFreeBatchPaceHint(cont, actIdx, secIdx, { forOutline: false });
  const lengthLine = globalKw
    ? `字数与文风：严格按【全局提示词】执行${lenHint ? `（识别到字数要求：${lenHint}）` : ''}；本节必须写够篇幅，禁止短节/敷衍占位。`
    : `字数：本节须有实质篇幅，禁止短节占位。`;

  // 基调绝不进 user；承接前文用 continuity / bridge
  const user = joinPromptBlocks(
    paceHint,
    bridge,
    continuity.userBlock && !bridge ? continuity.userBlock : '',
    // 跨章桥接已含上一章结尾时，不再重复短 recent；无桥接且无 continuity 时用 recent/原文
    !bridge && !continuity.userBlock && recent ? `【上一节结尾】\n${recent}` : '',
    !bridge && !continuity.userBlock && !recent && source ? `【原文末尾】\n${source}` : '',
    hasOutline
      ? `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${clipTextHead(secOutline, ultra ? 100 : 120)}`
      : `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n(大纲暂缺，请按前文与基调合理续写一节完整场面)`,
    needReinforce
      ? `请重新完整撰写第${actIdx + 1}章「${act?.title || ''}」第${secIdx + 1}节正文。\n${lengthLine}${
          toneInj.hasTone ? '须符合续写基调。' : ''
        }${hasPrior ? '须承接已写进度与前文结尾状态。' : ''}${
          chapterOpen ? '本章开篇须承接上一章结尾的未决线继续写，勿另起全新剧情，勿回顾复读。' : ''
        }\n直接输出正文，禁止空回复。`
      : `请写第${actIdx + 1}章「${act?.title || ''}」第${secIdx + 1}节正文。\n${lengthLine}${
          toneInj.hasTone ? '须符合续写基调。' : ''
        }${hasPrior ? '须承接已写进度与前文结尾状态。' : ''}${
          chapterOpen ? '本章开篇须承接上一章结尾的未决线继续写，勿另起全新剧情，勿回顾复读。' : ''
        }\n直接输出正文，禁止空回复。`,
  );

  const level = ultra ? 'ultra' : slim ? 'slim' : 'full';
  log.info('自然续写提示体积', {
    level,
    actIdx,
    secIdx,
    flatIdx,
    sysLen: system.length,
    userLen: user.length,
    total: system.length + user.length,
    hasOutline,
    useWi,
    chapterOpen,
    hasBridge: !!bridge,
    hasPrior,
    skipWorldInfo: ultra || !useWi,
    toneRawLen: toneInj.rawLen,
    toneHintLen: toneInj.hint?.length || 0,
    toneBudget: toneInj.budget,
    toneTight: toneInj.tight,
    freeToneTight: !!cont?.freeToneTight,
  });
  if (toneInj.systemRule && toneInj.systemRule.length > FREE_TONE_HARD_MAX + 40) {
    log.warn('基调 systemRule 异常偏长，已应被硬裁', { len: toneInj.systemRule.length });
  }
  return { system, user, skipWorldInfo: ultra || !useWi, level };
}

/**
 * 自然续写节大纲提示：与写新小说同链路注入预设/全局提示词/长期记忆，
 * 另附本批结构、剧情速度、续写基调、跨章桥接。
 */
function buildContFreeOutlinePrompt(cont, actIdx, secIdx, flatIdx, { slim = false, ultra = false, reinforce = false } = {}) {
  ensureContProfiles(cont);
  const act = cont.acts[actIdx];
  const useWi = !!String(cont.worldBookName || '').trim();
  const toneInj = buildContFreeToneInject(cont, actIdx, secIdx, { ultra, slim });
  const continuity = buildContFreeContinuityPack(cont, flatIdx, { ultra, slim, forOutline: true });
  const plotText = contPlotProfileText(cont);
  const charText = contCharProfilesText(cont);
  const chapterOpen = actIdx > 0 && secIdx === 0;
  const secsInAct = Math.max(1, (act?.sections || []).length);
  const needReinforce = !!(reinforce || slim || ultra);
  const hasPrior = continuity.hasPrior;

  const system = buildWorkshopSystemPack({
    roleHint: joinPromptBlocks(
      '你是中文小说编剧。只输出「当前这一节」的大纲短文，不要正文、标题、解释或列表编号装饰。须遵守【全局提示词】文风。',
      '禁止调用搜索/联网/工具；必须直接输出大纲短文，禁止返回空消息。',
      '严禁同时输出多节大纲（例如不要写第5节又写第6节）；不要使用「第5/6节」这种写法。',
      '大纲须写清：场景/冲突/人物动作/情绪落点；字数约 80～100 字（不少于 70、不超过 100）；须承接已有大纲/前文。',
      '禁止把多节内容写进本节大纲，禁止越写越长；只写本节这一小步进展。',
      '出场人物姓名与关系必须与档案/世界书一致，禁止串角或改名。',
      '大纲剧情走向服从【剧情速度】硬性节数与【续写基调】：慢速≥20、中等≥10、快速≥5节，须跨章且跨批次累计后才可收束开新；新开一批不得清零计数，未满必须继续同一未决事件。',
      toneInj.roleLine,
      hasPrior
        ? '本节大纲是已有正文之后的续写规划：必须承接【已写进度摘要】与前文结尾状态，禁止写成与前文脱节的新故事开局。'
        : '',
      actIdx > 0
        ? '跨章：禁止复述或换皮重写上一章；须延续上一章未决冲突/事件的后续发展，「新进展」≠「全新剧情」。'
        : '',
    ),
    memoryObj: cont,
    worldProj: cont,
    reinforce: needReinforce,
    reinforceText:
      '重要：上一轮空回复。本次必须输出可读大纲短文，约 80～100 字，禁止空白/省略号/极短占位，也禁止超过 100 字。',
    slim: !!slim || !!ultra,
    compactMemory: true,
    memoryMaxChars: ultra ? 700 : slim ? 1200 : hasPrior ? 2000 : 1600,
    plotKeep: ultra ? 4 : slim ? 5 : hasPrior ? 12 : 6,
    chainStepKeep: ultra ? 1 : slim ? 1 : hasPrior ? 3 : 2,
    memorySkipChapterSummaries: true,
    presetMaxChars: ultra ? 600 : slim ? 1000 : 0,
    globalKwMaxChars: ultra ? 400 : slim ? 700 : 0,
    omitPreset: !!ultra,
    extraRules: [
      toneInj.systemRule,
      continuity.systemRule,
      ...(useWi
        ? ultra
          ? (() => {
              const roster = contCharRosterBrief(cont, 320);
              return roster ? [`【角色要点】\n${roster}`] : [];
            })()
          : []
        : [
            charText ? `【角色档案】\n${clipTextHead(charText, ultra ? 280 : slim ? 600 : 1600)}` : '',
            actIdx === 0 && plotText
              ? `【剧情要点·仅作背景】\n${clipTextHead(plotText, ultra ? 200 : slim ? 320 : 900)}\n（仅背景；本节走向以【剧情速度】与【续写基调】为准，与批次无关。）`
              : '',
          ].filter(Boolean)),
    ].filter(Boolean),
  });

  const recent = contRecentTail(
    cont,
    flatIdx,
    ultra ? 360 : slim ? 520 : chapterOpen ? 800 : actIdx > 0 ? 600 : 800,
  );
  const priorOutlines = contPriorOutlinesInAct(cont, actIdx, secIdx, {
    maxSecs: ultra ? 3 : 5,
    perChars: ultra ? 80 : 100,
  });
  const source =
    actIdx === 0 && !recent && !priorOutlines && !continuity.userBlock && cont.sourceTail
      ? clipTextTail(cont.sourceTail, ultra ? 320 : slim ? 480 : 800)
      : '';
  const bridge = chapterOpen
    ? contCrossChapterBridge(cont, actIdx, flatIdx, { ultra, forOutline: true })
    : '';
  const priorActOl =
    actIdx > 0 && !chapterOpen
      ? contPriorActOutlineSummary(cont, actIdx, {
          perChars: ultra ? 60 : 100,
          maxSecs: ultra ? 4 : 6,
        })
      : '';
  const paceHint = ultra ? '' : buildFreeBatchPaceHint(cont, actIdx, secIdx, { forOutline: true });

  // 基调绝不进 user
  const user = joinPromptBlocks(
    paceHint,
    bridge || priorActOl,
    priorOutlines,
    continuity.userBlock && !bridge ? continuity.userBlock : '',
    bridge || continuity.userBlock
      ? ''
      : recent
        ? `【上一节正文结尾】\n${recent}`
        : source
          ? `【原文末尾】\n${source}`
          : '',
    needReinforce
      ? `请重新只为第 ${actIdx + 1} 章「${act?.title || ''}」的第 ${secIdx + 1} 节拟定大纲（本章共 ${secsInAct} 节；当前只要第 ${secIdx + 1} 节）。只输出这一节的大纲正文，约 80～100 字。${
          toneInj.hasTone ? '须符合续写基调。' : ''
        }${hasPrior ? '须承接已写进度与前文结尾。' : ''}${
          chapterOpen ? '本章开篇须承接上一章未决线继续发展，勿另起全新剧情，勿回顾复读。' : ''
        }`
      : `【任务】只为第 ${actIdx + 1} 章「${act?.title || ''}」的第 ${secIdx + 1} 节拟定大纲（本章共 ${secsInAct} 节；当前只要第 ${secIdx + 1} 节）。只输出这一节的大纲正文（约 80～100 字），不要写其他节。${
          toneInj.hasTone ? '须符合续写基调。' : ''
        }${hasPrior ? '须承接已写进度与前文结尾。' : ''}${
          chapterOpen ? '本章开篇须承接上一章未决线继续发展，勿另起全新剧情，勿回顾复读。' : ''
        }`,
  );

  const level = ultra ? 'ultra' : slim ? 'slim' : 'full';
  log.info('自然续写大纲提示体积', {
    level,
    actIdx,
    secIdx,
    flatIdx,
    sysLen: system.length,
    userLen: user.length,
    total: system.length + user.length,
    useWi,
    chapterOpen,
    hasBridge: !!bridge,
    hasPrior,
    skipWorldInfo: ultra || !useWi,
    toneRawLen: toneInj.rawLen,
    toneHintLen: toneInj.hint?.length || 0,
    toneTight: toneInj.tight,
    freeToneTight: !!cont?.freeToneTight,
  });
  return { system, user, skipWorldInfo: ultra || !useWi, level };
}

/**
 * 构建续写某节的提示词。mode: outline=按大纲 / free=自然续写。
 */
function buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode, { reinforce = false, slim = false, ultra = false } = {}) {
  if (mode === 'free') {
    return buildContFreeBodyPrompt(cont, actIdx, secIdx, flatIdx, {
      reinforce,
      slim: !!slim && !ultra,
      ultra: !!ultra,
    });
  }

  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];
  ensureContProfiles(cont);
  const useWi = !!cont.worldBookName;
  const charText = contCharProfilesText(cont);
  const plotText = contPlotProfileText(cont);
  const globalKw = readGlobalKeyword();
  const lenHint = extractLengthHintFromKeyword(globalKw);

  const system = buildWorkshopSystemPack({
    roleHint:
      '你是中文小说续写助手。按大纲续写：先理解本章总览，再围绕本节大纲展开。必须严格遵守【全局提示词】（含字数）。只输出正文，不要标题/解释。',
    memoryObj: cont,
    reinforce: reinforce || slim,
    slim,
    memoryMaxChars: slim ? 1000 : 0,
    presetMaxChars: slim ? 800 : 0,
    extraRules: useWi
      ? []
      : [
          charText ? `【角色档案】\n${clipTextHead(charText, slim ? 700 : 2800)}` : '',
          plotText ? `【剧情梗概】\n${clipTextHead(plotText, slim ? 500 : 2200)}` : '',
        ].filter(Boolean),
  });

  const recentTail = contRecentTail(cont, flatIdx, slim ? 900 : 1000);
  const lengthLine = globalKw
    ? `字数：严格按全局提示词${lenHint ? `（${lenHint}）` : ''}写足篇幅，禁止短节占位。`
    : `字数：本节须有实质篇幅，禁止短节占位。`;

  const user = joinPromptBlocks(
    !recentTail && cont.sourceTail ? `【原文末尾】\n${clipTextTail(cont.sourceTail, 1200)}` : '',
    recentTail ? `【上一节结尾】\n${recentTail}` : '',
    `【本章总览】第${actIdx + 1}章 ${act.title || ''}\n${clipTextHead(act.overview || '(未填)', slim ? 800 : 2000)}`,
    `【本节大纲】第${actIdx + 1}章第${secIdx + 1}节\n${clipTextHead(sec.outline || '', slim ? 1000 : 2500)}`,
    reinforce || slim
      ? `请重新完整续写第${actIdx + 1}章第${secIdx + 1}节正文。\n${lengthLine}`
      : `请续写第${actIdx + 1}章第${secIdx + 1}节正文。\n${lengthLine}`,
  );

  return { system, user, skipWorldInfo: !!slim, level: slim ? 'slim' : 'full' };
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
  // 立刻清掉节内「生成中」UI，避免卡在「正在中止」（请求可能稍后才真正 abort）
  contState.activeFlatIdx = -1;
  contState.activeActIdx = -1;
  contState.currentGenId = '';
  finishGenUiProgress();
  stopGenUiProgress();
  rejectFreeOutlineConfirmWait('已中止');
  renderContinuationChapters();
  // 勿用 busy=true：会把文案写进节进度条导致残留
  const $ = globalThis.jQuery;
  $?.(`#${EXT_ID}-ct-hint`).text('正在中止…');
  log.info('已请求中止续写');
}

/** skipSummary=true 时跳过触发整章表格总结(单节重新生成时使用) */
/** deferLiveProgress=true：大纲模式不立刻动态大总结，等用户点「确认总结」；自然续写忽略此标志，每节自动追加/替换链条 */
/** skipLiveProgress=true：仅大纲模式可用；自然续写始终自动更新大总结 */
/** ignoreLock=true：自然续写批量写正文时，无正文的锁定节也强制生成 */
async function generateContSection(cont, actIdx, secIdx, flatIdx, mode, onProgress, { skipSummary = false, reinforce = false, deferLiveProgress = false, skipLiveProgress = false, ignoreLock = false } = {}) {
  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];
  if (!ignoreLock && isSectionLocked(sec)) {
    log.warn(`续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节已锁定，跳过生成`);
    return '';
  }
  const isFree = mode === 'free';
  // 自然续写：章表总结仍在章完成后补；大纲模式：开章时补前章
  if (secIdx === 0 && !skipSummary && !isFree) await summarizePendingContActs(cont, actIdx, onProgress);

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
    // 与写新小说对齐：首轮完整提示 + reinforce 重试；仅最后一轮才 ultra
    const maxPasses = isFree ? 3 : 2;
    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        const gap = calcRetryDelayMs(pass - 1, new Error('空回复'));
        onProgress?.(
          `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节空回，${Math.round(gap / 1000)}s 后加强提示重试(${pass + 1}/${maxPasses})…`,
          true,
        );
        setGenSectionStatus(`冷却中（重试前约 ${Math.round(gap / 1000)}s）…`, { phase: 'wait' });
        await waitCancellable(gap, () => contState.cancelRequested);
        resetGenerationChannel('cont', { hard: false });
      }
      const needReinforce = reinforce || pass > 0;
      // pass0 full；pass1 同结构 reinforce；pass2 ultra（省略预设/可跳 WI）
      const useUltra = isFree && pass >= 2;
      const useSlim = false;
      const built = buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode, {
        reinforce: needReinforce,
        slim: useSlim,
        ultra: useUltra,
      });
      const { system, user } = built;
      onProgress?.(
        pass === 0
          ? `正在续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`
          : `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节重试中(${pass + 1}/${maxPasses}${useUltra ? '·极简' : ''})…`,
        true,
      );
      setGenSectionStatus(
        pass === 0 ? `生成中… 第${actIdx + 1}章第${secIdx + 1}节` : `生成中… 加强重试 ${pass + 1}/${maxPasses}`,
        { phase: 'gen' },
      );
      const gid = `cont_${Date.now()}_${flatIdx}_p${pass}_${Math.random().toString(36).slice(2, 6)}`;
      contState.currentGenId = gid;
      try {
        const useWiName = built.skipWorldInfo ? '' : cont.worldBookName || '';
        text = (
          await novelGenerateWithId({ system, user }, gid, () => contState.cancelRequested, {
            minLen: MIN_SECTION_CHARS,
            // 与写新小说相同：用设置里的 genMaxRetries，不额外压成 1
            worldBookName: useWiName,
            wiScanText: `${user}\n${String(system || '').slice(0, 2000)}`,
          })
        ).trim();
      } catch (e) {
        if (contState.cancelRequested || isCancelError(e)) throw new Error('已中止');
        const msg = String(e?.message || e || '');
        const retryable = /空回复/.test(msg) || isRetryableError(e);
        if (pass < maxPasses - 1 && retryable) {
          log.warn(`续写失败可重试，准备第 ${pass + 2} 轮:`, msg, {
            sysLen: system.length,
            userLen: user.length,
            level: built.level,
          });
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
    delete sec.pendingLiveSummary;

    // 大纲：可 defer 等「确认总结」；自然续写批量写正文时 skipLiveProgress，章末再整章总结
    const shouldSkipLive = !!skipLiveProgress;
    const shouldDefer = !isFree && !!deferLiveProgress && !shouldSkipLive;
    if (shouldDefer) {
      markPendingLiveSummary(cont, actIdx, secIdx, { exclusive: true });
    }
    saveContinuation();
    onProgress?.(
      shouldDefer
        ? `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}，请点击「确认总结」`
        : `续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节完成 · 用时 ${formatGenElapsed(elapsedMs)}`,
      false,
    );

    if (shouldSkipLive || shouldDefer) {
      await sleep(shouldDefer ? 350 : 200);
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
        // 自然续写：大总结后短歇，其余交给全局节流
        await sleep(isFree ? 400 : 300);
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

/**
 * 自然续写：为单节生成「节大纲」并写入 sec.outline（显示在节大纲栏）。
 * 调用方式对齐写新小说：完整提示 + reinforce；末轮才 ultra。
 */
async function generateContFreeSectionOutline(cont, actIdx, secIdx, flatIdx, onProgress) {
  const act = cont?.acts?.[actIdx];
  const sec = act?.sections?.[secIdx];
  if (!sec) return '';
  if (isSectionLocked(sec)) {
    log.warn(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节已锁定，跳过大纲`);
    return String(sec.outline || '');
  }

  ensureContProfiles(cont);
  const useWi = !!String(cont.worldBookName || '').trim();
  const secsInAct = Math.max(1, (act.sections || []).length);
  const maxPasses = 3;
  let lastErr = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    if (contState.cancelRequested) throw new Error('已中止');
    const ultra = pass >= 2;
    const slim = false;
    if (pass > 0) {
      const gap = calcRetryDelayMs(pass - 1, lastErr || new Error('空回复'));
      onProgress?.(
        `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲空回，${Math.round(gap / 1000)}s 后加强重试(${pass + 1}/${maxPasses})…`,
        true,
      );
      setGenSectionStatus(`冷却中（大纲重试约 ${Math.round(gap / 1000)}s）…`, { phase: 'wait' });
      await waitCancellable(gap, () => contState.cancelRequested);
      resetGenerationChannel('cont', { hard: false });
    }

    const built = buildContFreeOutlinePrompt(cont, actIdx, secIdx, flatIdx, {
      slim,
      ultra,
      reinforce: pass > 0,
    });
    const { system, user } = built;
    const skipWi = !!built.skipWorldInfo;

    onProgress?.(
      pass === 0
        ? `正在拟定第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲…`
        : `正在重试拟定大纲(${pass + 1}/${maxPasses}${ultra ? '·极简' : ''})…`,
      true,
    );
    setGenSectionStatus(
      pass === 0
        ? `生成中… 拟定第${actIdx + 1}章第${secIdx + 1}节大纲`
        : `生成中… 大纲加强重试 ${pass + 1}/${maxPasses}`,
      { phase: 'gen' },
    );

    const gid = `cont_ol_${Date.now()}_${actIdx}_${secIdx}_p${pass}`;
    contState.currentGenId = gid;
    try {
      const raw = (
        await novelGenerateWithId({ system, user }, gid, () => contState.cancelRequested, {
          minLen: 16,
          worldBookName: skipWi ? '' : cont.worldBookName || '',
          wiScanText: `${user}\n${String(system || '').slice(0, 2000)}`,
        })
      ).trim();
      const outline = normalizeFreeSectionOutline(raw, secIdx, secsInAct);
      if (isEmptyReply(outline, 16)) {
        if (contState.cancelRequested) throw new Error('已中止');
        lastErr = new Error('空回复');
        continue;
      }
      sec.outline = outline;
      maybeAdvanceFreePlotArcAfterOutline(cont, flatIdx, outline);
      saveContinuation();
      return outline;
    } catch (e) {
      if (contState.cancelRequested || isCancelError(e)) throw new Error('已中止');
      lastErr = e;
      if (/已中止/.test(String(e?.message || ''))) throw e;
      const retryable = /空回复/.test(String(e?.message || '')) || isRetryableError(e);
      if (pass < maxPasses - 1 && retryable) {
        log.warn(`大纲生成失败可重试:`, e?.message || e, {
          sysLen: system.length,
          userLen: user.length,
          level: built.level,
          useWi,
          skipWi,
        });
        continue;
      }
      throw e;
    } finally {
      contState.currentGenId = '';
    }
  }
  throw lastErr || new Error(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲为空`);
}

/** 自然续写：全章大纲齐 → 开始写正文的间隔（毫秒）。主要依赖全局节流。 */
function freeOutlineToBodyGapMs(actIdx) {
  const minGap = Math.max(3000, Number(getSettings()?.genMinIntervalMs) || 5000);
  return Math.max(minGap, actIdx > 0 ? 4000 : 3500);
}

/** 自然续写节与节之间的冷却（交给 waitGenThrottle，此处仅短歇）。 */
function freeInterSectionGapMs(flatIdx) {
  const minGap = Math.max(3000, Number(getSettings()?.genMinIntervalMs) || 5000);
  return minGap;
}

/**
 * 自然续写单节：① 大纲（可复用）→ 冷却 → ② 正文。
 * 批量章生成请用 runContFree（本批全部大纲确认一次后再写正文）。
 */
async function runFreeSectionTwoStep(
  cont,
  actIdx,
  secIdx,
  flatIdx,
  onProgress,
  {
    reuseOutline = false,
    skipSummary = true,
    skipLiveProgress = false,
    deferLiveProgress = false,
    reinforce = false,
  } = {},
) {
  const sec = cont.acts?.[actIdx]?.sections?.[secIdx];
  if (!sec) throw new Error('节不存在');
  if (isSectionLocked(sec)) {
    log.warn(`续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节已锁定，跳过`);
    return '';
  }

  const hasOutline = String(sec.outline || '').trim().length >= 16;
  const skipOl = reuseOutline && hasOutline;

  if (!skipOl) {
    contState.activeFlatIdx = flatIdx;
    contState.activeActIdx = actIdx;
    startGenUiProgress('cont', {
      flatIdx,
      phase: 'gen',
      status: `生成中… 拟定第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲…`,
    });
    renderContinuationChapters();
    paintGenUiProgress();

    try {
      await generateContFreeSectionOutline(cont, actIdx, secIdx, flatIdx, onProgress);
      saveContinuation();
      renderContinuationChapters();
      paintGenUiProgress();

      const gap = freeOutlineToBodyGapMs(actIdx);
      onProgress?.(
        `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲已写入，${Math.round(gap / 1000)}s 后生成正文…`,
        true,
      );
      setGenSectionStatus(`冷却中（大纲→正文约 ${Math.round(gap / 1000)}s）…`, { phase: 'wait' });
      await prepareGenerationChannel('cont', { hadPriorContent: false });
      await waitCancellable(gap, () => contState.cancelRequested);
    } catch (e) {
      finishGenUiProgress();
      stopGenUiProgress();
      contState.activeFlatIdx = -1;
      renderContinuationChapters();
      throw e;
    }
  } else {
    onProgress?.(
      `使用已有大纲生成第 ${actIdx + 1} 章 第 ${secIdx + 1} 节正文…`,
      true,
    );
    await prepareGenerationChannel('cont', { hadPriorContent: false });
    await sleep(200);
  }

  return generateContSection(cont, actIdx, secIdx, flatIdx, 'free', onProgress, {
    skipSummary,
    skipLiveProgress,
    deferLiveProgress,
    reinforce,
  });
}

/**
 * 自然续写：根据本章已写正文拟定章标题。
 * 放在正文生成之后调用，避免「跨章先标题再正文」连打接口导致空回。
 */
async function generateContFreeActTitle(cont, actIdx, onProgress) {
  const act = cont?.acts?.[actIdx];
  if (!act) return;
  onProgress?.(`正在拟定第 ${actIdx + 1} 章标题…`, true);
  const body = (act.sections || [])
    .filter((s) => hasValidSectionContent(s))
    .map((s, i) => `【第${i + 1}节】\n${clipTextHead(s.content, 500)}`)
    .join('\n\n');
  ensureContProfiles(cont);
  const system = [
    '你是小说编辑。请根据本章已写正文，起一个简短有吸引力的中文章标题。',
    '要求：4~16 字；只输出标题本身；不要书名号、引号、第x章前缀或任何解释。',
  ].join('\n');
  const user = joinPromptBlocks(
    contPlotProfileText(cont) ? `【剧情梗概摘要】\n${clipTextHead(contPlotProfileText(cont), 400)}` : '',
    body ? `【本章正文】\n${clipTextHead(body, 1800)}` : '',
    `请为续写第 ${actIdx + 1} 章起标题:`,
  );
  try {
    await prepareGenerationChannel('cont', { hadPriorContent: false });
    await sleep(400);
    const gid = `cont_title_${Date.now()}_${actIdx}`;
    contState.currentGenId = gid;
    // 标题为短任务：不注入世界书，降低空回
    const raw = (
      await novelGenerateWithId({ system, user }, gid, () => contState.cancelRequested, {
        minLen: 2,
      })
    ).trim();
    let title = String(raw || '')
      .split('\n')[0]
      .replace(/^["「『【\s]+|["」』】\s]+$/g, '')
      .replace(/^第\s*\d+\s*章\s*[:：\-]?\s*/, '')
      .trim()
      .slice(0, 24);
    if (!title || isEmptyReply(title, 2)) title = `第 ${actIdx + 1} 章`;
    act.title = title;
  } catch (e) {
    if (/已中止/.test(String(e?.message || ''))) throw e;
    log.warn('自然续写章标题生成失败:', e?.message || e);
    if (!String(act.title || '').trim()) act.title = `第 ${actIdx + 1} 章`;
  } finally {
    contState.currentGenId = '';
  }
}

/** 自然续写：等待用户确认「本批」全部大纲后再写正文。 */
let freeOutlineConfirmWait = null;

function rejectFreeOutlineConfirmWait(reason = '已中止') {
  if (!freeOutlineConfirmWait) return;
  const w = freeOutlineConfirmWait;
  freeOutlineConfirmWait = null;
  try {
    w.reject(new Error(reason));
  } catch (_) {
    /* ignore */
  }
}

function resolveFreeOutlineConfirmWait(action = 'confirm') {
  if (!freeOutlineConfirmWait) return false;
  const w = freeOutlineConfirmWait;
  freeOutlineConfirmWait = null;
  const a = action === 'regen' ? 'regen' : action === 'append' ? 'append' : 'confirm';
  w.resolve(a);
  return true;
}

/** 等待用户确认大纲 / 重生 / 再拟一批。返回 'confirm' | 'regen' | 'append'。 */
function waitFreeOutlineConfirm() {
  return new Promise((resolve, reject) => {
    if (contState.cancelRequested) {
      reject(new Error('已中止'));
      return;
    }
    let timer = null;
    const clear = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    freeOutlineConfirmWait = {
      resolve: (action) => {
        clear();
        const a = action === 'regen' ? 'regen' : action === 'append' ? 'append' : 'confirm';
        resolve(a);
      },
      reject: (err) => {
        clear();
        reject(err instanceof Error ? err : new Error(String(err || '已中止')));
      },
    };
    timer = setInterval(() => {
      if (contState.cancelRequested) rejectFreeOutlineConfirmWait('已中止');
    }, 250);
  });
}

/** 清空本批未锁定的节大纲（锁定大纲保留）。 */
function clearUnlockedFreeOutlines(cont, actIndices) {
  for (const actIdx of actIndices || []) {
    const act = cont?.acts?.[actIdx];
    if (!act) continue;
    for (const sec of act.sections || []) {
      if (!sec || shouldSkipFreeOutlineRegen(sec)) continue;
      sec.outline = '';
      delete sec.outlineSkipped;
    }
  }
}

/** 自然续写失败断点（持久化，供「断点继续」）。 */
function setFreeBreakpoint(cont, bp = {}) {
  if (!cont) return;
  const prev = cont.freeBreakpoint && typeof cont.freeBreakpoint === 'object' ? cont.freeBreakpoint : {};
  const batchActIndices = Array.isArray(bp.batchActIndices)
    ? bp.batchActIndices.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0)
    : Array.isArray(prev.batchActIndices)
      ? prev.batchActIndices
      : [];
  cont.freeBreakpoint = {
    phase: String(bp.phase || prev.phase || 'body'),
    actIdx: Number.isInteger(bp.actIdx) ? bp.actIdx : Number(prev.actIdx) || 0,
    secIdx: Number.isInteger(bp.secIdx) ? bp.secIdx : Number(prev.secIdx) || 0,
    batchActIndices,
    batchStartAct:
      Number.isInteger(bp.batchStartAct)
        ? bp.batchStartAct
        : Number.isInteger(Number(cont.freeBatchStartAct))
          ? Number(cont.freeBatchStartAct)
          : Number(prev.batchStartAct) || 0,
    batchActCount:
      Number.isInteger(bp.batchActCount)
        ? bp.batchActCount
        : Number(cont.freeBatchActCount) || Number(prev.batchActCount) || batchActIndices.length || 1,
    label: String(bp.label || prev.label || formatContFreeBatchLabel(cont) || ''),
    reason: String(bp.reason || prev.reason || '').slice(0, 240),
    updatedAt: Date.now(),
  };
  if (Number.isInteger(cont.freeBreakpoint.batchStartAct)) {
    cont.freeBatchStartAct = cont.freeBreakpoint.batchStartAct;
  }
  if (cont.freeBreakpoint.batchActCount) {
    cont.freeBatchActCount = cont.freeBreakpoint.batchActCount;
  }
  cont.freeBatchActive = true;
  saveContinuation();
}

function clearFreeBreakpoint(cont) {
  if (!cont) return;
  delete cont.freeBreakpoint;
}

function isFreeBreakpointError(e) {
  return !!(e && (e.isFreeBreakpoint || /^FREE_BREAKPOINT:/.test(String(e?.message || ''))));
}

function throwFreeBreakpoint(cont, bp) {
  setFreeBreakpoint(cont, bp);
  const phase = String(bp.phase || 'body');
  const actIdx = Number(bp.actIdx) || 0;
  const secIdx = Number(bp.secIdx) || 0;
  const reason = String(bp.reason || '生成失败').slice(0, 160);
  const where =
    phase === 'outline'
      ? `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲`
      : phase === 'body'
        ? `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节正文`
        : phase === 'title'
          ? `第 ${actIdx + 1} 章标题`
          : phase === 'live'
            ? `第 ${actIdx + 1} 章大总结`
            : phase === 'summary'
              ? `第 ${actIdx + 1} 章表格总结`
              : `第 ${actIdx + 1} 章`;
  const err = new Error(`FREE_BREAKPOINT:${phase}:${actIdx}:${secIdx}:${reason}`);
  err.isFreeBreakpoint = true;
  err.freeBreakpoint = cont.freeBreakpoint;
  err.userMessage = `${where}失败，已暂停。可点「断点继续」重试，或「跳过并删除此断点」从下一节继续。${reason ? `（${reason}）` : ''}`;
  throw err;
}

function formatFreeBreakpointHint(bp) {
  if (!bp) return '';
  const phase = String(bp.phase || '');
  const actIdx = Number(bp.actIdx) || 0;
  const secIdx = Number(bp.secIdx) || 0;
  const map = {
    outline: `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大纲`,
    body: `第 ${actIdx + 1} 章 第 ${secIdx + 1} 节正文`,
    title: `第 ${actIdx + 1} 章标题`,
    live: `第 ${actIdx + 1} 章大总结`,
    summary: `第 ${actIdx + 1} 章表格总结`,
  };
  const where = map[phase] || `第 ${actIdx + 1} 章`;
  return `断点：${where}${bp.reason ? ` · ${String(bp.reason).slice(0, 80)}` : ''}。「断点继续」重试；「跳过并删除此断点」从下一节/下一阶段继续。`;
}

/** 从断点解析本批章下标。 */
function resolveFreeBpBatchIndices(cont, bp) {
  let actIndices = Array.isArray(bp?.batchActIndices)
    ? bp.batchActIndices.filter((n) => Number.isInteger(n) && cont?.acts?.[n])
    : [];
  if (!actIndices.length && Number.isInteger(Number(bp?.batchStartAct)) && Number(bp?.batchActCount) > 0) {
    const start = Number(bp.batchStartAct);
    const count = Number(bp.batchActCount);
    actIndices = [];
    for (let i = 0; i < count; i++) {
      if (cont?.acts?.[start + i]) actIndices.push(start + i);
    }
  }
  return actIndices;
}

/** 标记断点处已跳过（大纲留占位，正文保持空）。 */
function markFreeBreakpointSkipped(cont, bp) {
  const phase = String(bp?.phase || '');
  const actIdx = Number(bp?.actIdx) || 0;
  const secIdx = Number(bp?.secIdx) || 0;
  const sec = cont?.acts?.[actIdx]?.sections?.[secIdx];
  if (!sec) return;
  if (phase === 'outline') {
    sec.outlineSkipped = true;
    if (!String(sec.outline || '').trim()) {
      sec.outline = '（已跳过生成，可稍后手动补写）';
    }
  } else if (phase === 'body') {
    sec.bodySkipped = true;
    sec.content = '';
    sec.done = false;
  }
}

/**
 * 计算跳过当前断点后的下一续写位置。
 * @returns {{ kind: string, phase?: string, actIdx?: number, secIdx?: number, actIndices?: number[] }}
 */
function computeNextFreeResumeAfterSkip(cont, bp) {
  const phase = String(bp?.phase || 'body');
  const actIdx = Number(bp?.actIdx) || 0;
  const secIdx = Number(bp?.secIdx) || 0;
  const actIndices = resolveFreeBpBatchIndices(cont, bp);
  if (!actIndices.length) return { kind: 'lost' };

  const pos = actIndices.indexOf(actIdx);
  const batchPos = pos >= 0 ? pos : 0;
  const secsLen = cont.acts?.[actIdx]?.sections?.length || 0;

  if (phase === 'outline') {
    if (secIdx + 1 < secsLen) {
      return { kind: 'resume', phase: 'outline', actIdx, secIdx: secIdx + 1, actIndices };
    }
    if (batchPos + 1 < actIndices.length) {
      return { kind: 'resume', phase: 'outline', actIdx: actIndices[batchPos + 1], secIdx: 0, actIndices };
    }
    return { kind: 'outlines_ready', actIndices };
  }

  if (phase === 'body') {
    if (secIdx + 1 < secsLen) {
      return { kind: 'resume', phase: 'body', actIdx, secIdx: secIdx + 1, actIndices };
    }
    return { kind: 'resume', phase: 'title', actIdx, secIdx: 0, actIndices };
  }

  if (phase === 'title') {
    return { kind: 'resume', phase: 'live', actIdx, secIdx: 0, actIndices };
  }
  if (phase === 'live') {
    return { kind: 'resume', phase: 'summary', actIdx, secIdx: 0, actIndices };
  }
  if (phase === 'summary') {
    if (batchPos + 1 < actIndices.length) {
      return { kind: 'resume', phase: 'body', actIdx: actIndices[batchPos + 1], secIdx: 0, actIndices };
    }
    return { kind: 'batch_done', actIndices };
  }

  return { kind: 'lost' };
}

/** 创建本批空章（每章 nSecs 节），返回章下标数组。 */
function createFreeBatchActs(cont, nActs, nSecs) {
  const indices = [];
  const acts = Math.max(1, nActs | 0);
  const secs = Math.max(1, nSecs | 0);
  for (let i = 0; i < acts; i++) {
    const actIdx = cont.acts.length;
    const act = makeAct(`第 ${actIdx + 1} 章`, '');
    for (let s = 0; s < secs; s++) act.sections.push(makeSection(''));
    act._folded = false;
    cont.acts.push(act);
    indices.push(actIdx);
  }
  return indices;
}

/** 节大纲 textarea 按内容行数紧贴高度（不多留空行）。 */
function fitContSecOutlineTextareas(rootSel = `#${EXT_ID}-analyze`) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`${rootSel} .ns-ct-sec-outline`).each(function () {
    const el = this;
    const val = String(el.value || '');
    if (!val.trim()) {
      el.rows = 1;
      el.style.height = '';
      el.classList.remove('ns-ct-sec-outline--expanded');
      return;
    }
    el.classList.add('ns-ct-sec-outline--block', 'ns-ct-sec-outline--expanded');
    // 先压到 1 行再量 scrollHeight，避免 rows 偏大撑出空白
    el.rows = 1;
    el.style.height = '0px';
    el.style.overflow = 'hidden';
    const h = Math.min(Math.max(el.scrollHeight, 22), 360);
    el.style.height = `${h}px`;
    el.style.overflow = h >= 360 ? 'auto' : 'hidden';
  });
}

/**
 * 自然续写：为本批各章生成节大纲（跳过已锁定大纲）。
 * 失败时抛出断点错误，不再跳过继续。
 * @param {{ fromActIdx?: number, fromSecIdx?: number }} [resume]
 * @returns {{ failedOutlines: number, outlineCount: number }}
 */
async function generateFreeOutlinesForActs(cont, actIndices, onProgress, resume = {}) {
  return withAutoSectionRpm(async () => {
    const outlineCount = (actIndices || []).reduce(
      (n, ai) => n + (cont.acts?.[ai]?.sections?.length || 0),
      0,
    );
    const fromActIdx = Number.isInteger(resume.fromActIdx) ? resume.fromActIdx : null;
    const fromSecIdx = Number.isInteger(resume.fromSecIdx) ? resume.fromSecIdx : 0;
    let reached = fromActIdx == null;

    for (let ai = 0; ai < (actIndices || []).length; ai++) {
      const actIdx = actIndices[ai];
      const act = cont.acts?.[actIdx];
      if (!act) continue;
      const secs = (act.sections || []).length;

      if (!reached && actIdx < fromActIdx) continue;

      if (ai > 0 || (reached && actIdx > (actIndices[0] ?? 0))) {
        const openGap = Math.max(3500, Number(getSettings()?.genMinIntervalMs) || 5000);
        onProgress?.(
          `跨章冷却约 ${Math.round(openGap / 1000)}s，随后继续拟定第 ${actIdx + 1} 章大纲…`,
          true,
        );
        setGenSectionStatus(`冷却中（跨章约 ${Math.round(openGap / 1000)}s）…`, { phase: 'wait' });
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await waitCancellable(openGap, () => contState.cancelRequested);
      }

      onProgress?.(`第 ${actIdx + 1} 章：拟定 ${secs} 节大纲…`, true);

      for (let s = 0; s < secs; s++) {
        if (contState.cancelRequested) throw new Error('已中止');
        if (!reached) {
          if (actIdx === fromActIdx && s === fromSecIdx) reached = true;
          else continue;
        }
        const sec = act.sections?.[s];
        if (shouldSkipFreeOutlineRegen(sec)) {
          onProgress?.(`第 ${actIdx + 1} 章 第 ${s + 1} 节大纲已锁定，跳过重新生成…`, true);
          continue;
        }
        // 断点续跑时：失败点之前已有合格大纲的节跳过；失败点本身重试
        if (
          fromActIdx != null &&
          !(actIdx === fromActIdx && s === fromSecIdx) &&
          String(sec?.outline || '').trim().length >= 16
        ) {
          continue;
        }
        if (s > 0) {
          const flatNow = flatSections(cont);
          const curFlat = flatNow.find((x) => x.actIdx === actIdx && x.secIdx === s)?.flatIdx ?? s;
          const gap = freeInterSectionGapMs(curFlat);
          onProgress?.(`大纲节间冷却约 ${Math.round(gap / 1000)}s…`, true);
          setGenSectionStatus(`冷却中（大纲节间约 ${Math.round(gap / 1000)}s）…`, { phase: 'wait' });
          await prepareGenerationChannel('cont', { hadPriorContent: false });
          await waitCancellable(gap, () => contState.cancelRequested);
        }
        const flat = flatSections(cont);
        const f = flat.find((x) => x.actIdx === actIdx && x.secIdx === s);
        if (!f) {
          throwFreeBreakpoint(cont, {
            phase: 'outline',
            actIdx,
            secIdx: s,
            batchActIndices: actIndices,
            reason: '节索引缺失',
          });
        }

        contState.activeFlatIdx = f.flatIdx;
        contState.activeActIdx = actIdx;
        startGenUiProgress('cont', {
          flatIdx: f.flatIdx,
          phase: 'gen',
          status: `生成中… 拟定第 ${actIdx + 1} 章 第 ${s + 1}/${secs} 节大纲…`,
        });
        renderContinuationChapters();
        paintGenUiProgress();

        try {
          await generateContFreeSectionOutline(cont, actIdx, s, f.flatIdx, onProgress);
          saveContinuation();
          finishGenUiProgress();
          stopGenUiProgress();
          contState.activeFlatIdx = -1;
          renderContinuationChapters();
          fitContSecOutlineTextareas();
          onProgress?.(
            `第 ${actIdx + 1} 章大纲进度 ${s + 1}/${secs}：第 ${s + 1} 节大纲已写入`,
            true,
          );
        } catch (e) {
          if (/已中止/.test(String(e?.message || ''))) throw e;
          finishGenUiProgress();
          stopGenUiProgress();
          contState.activeFlatIdx = -1;
          renderContinuationChapters();
          throwFreeBreakpoint(cont, {
            phase: 'outline',
            actIdx,
            secIdx: s,
            batchActIndices: actIndices,
            reason: e?.message || e,
          });
        }
        readContFreeBatchFromDOM(cont);
        renderContinuationChapters();
        fitContSecOutlineTextareas();
      }
    }

    if (contState.cancelRequested) throw new Error('已中止');
    return { failedOutlines: 0, outlineCount };
  });
}

/**
 * 自然续写：按已有大纲写单章正文并章末总结（不创建章、不等待大纲确认）。
 * 失败时抛出断点错误，不再跳过继续。
 * @param {{ fromSecIdx?: number, startPhase?: 'body'|'title'|'live'|'summary', batchActIndices?: number[] }} [opts]
 * @returns {number} actIdx
 */
async function writeFreeChapterBodies(cont, actIdx, onProgress, opts = {}) {
  return withAutoSectionRpm(async () => {
    collectContActsFromDOM(cont);
    const act = cont.acts?.[actIdx];
    if (!act) return actIdx;
    const secs = (act.sections || []).length;
    const batchActIndices = Array.isArray(opts.batchActIndices) ? opts.batchActIndices : null;
    let phase = opts.startPhase || 'body';
    const fromSecIdx = Math.max(0, Number(opts.fromSecIdx) || 0);
    const bpBase = { actIdx, batchActIndices };

    if (phase === 'body') {
      onProgress?.(`第 ${actIdx + 1} 章：按大纲生成全部正文…`, true);
      for (let s = fromSecIdx; s < secs; s++) {
        if (contState.cancelRequested) throw new Error('已中止');
        const sec = cont.acts[actIdx]?.sections?.[s];
        if (!sec) {
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'body',
            secIdx: s,
            reason: '节不存在',
          });
        }
        // 续跑时：失败点之后已写好的节跳过；失败点本身重试
        if (s > fromSecIdx && hasValidSectionContent(sec)) continue;
        // 「跳过并删除此断点」标记的节：不再生成
        if (sec.outlineSkipped || sec.bodySkipped) {
          onProgress?.(
            `第 ${actIdx + 1} 章 第 ${s + 1} 节已跳过，继续下一节…`,
            true,
          );
          continue;
        }

        const hasOl = String(sec.outline || '').trim().length >= 16;
        if (!hasOl) {
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'body',
            secIdx: s,
            reason: '无大纲',
          });
        }
        if (s > 0) {
          const flatNow = flatSections(cont);
          const curFlat = flatNow.find((x) => x.actIdx === actIdx && x.secIdx === s)?.flatIdx ?? s;
          const gap = freeInterSectionGapMs(curFlat);
          onProgress?.(`正文节间冷却约 ${Math.round(gap / 1000)}s…`, true);
          setGenSectionStatus(`冷却中（正文节间约 ${Math.round(gap / 1000)}s）…`, { phase: 'wait' });
          await prepareGenerationChannel('cont', { hadPriorContent: false });
          await waitCancellable(gap, () => contState.cancelRequested);
        }
        const flat = flatSections(cont);
        const f = flat.find((x) => x.actIdx === actIdx && x.secIdx === s);
        if (!f) {
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'body',
            secIdx: s,
            reason: '节索引缺失',
          });
        }
        onProgress?.(
          `自然续写：第 ${actIdx + 1} 章 第 ${s + 1}/${secs} 节正文（按大纲）…`,
          true,
        );
        try {
          await generateContSection(cont, actIdx, s, f.flatIdx, 'free', onProgress, {
            skipSummary: true,
            skipLiveProgress: true,
            deferLiveProgress: false,
            ignoreLock: true, // 批量写正文：锁定但无正文也写
          });
        } catch (e) {
          if (/已中止/.test(String(e?.message || ''))) throw e;
          cont.acts[actIdx].sections[s].content = '';
          cont.acts[actIdx].sections[s].done = false;
          saveContinuation();
          finishGenUiProgress();
          stopGenUiProgress();
          contState.activeFlatIdx = -1;
          renderContinuationChapters();
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'body',
            secIdx: s,
            reason: e?.message || e,
          });
        }
        readContFreeBatchFromDOM(cont);
        renderContinuationChapters();
      }
      if (contState.cancelRequested) throw new Error('已中止');
      phase = 'title';
    }

    if (phase === 'title') {
      if (
        !String(cont.acts[actIdx]?.title || '').trim() ||
        /^第\s*\d+\s*章$/.test(String(cont.acts[actIdx]?.title || '').trim())
      ) {
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await sleep(1200);
        try {
          await generateContFreeActTitle(cont, actIdx, onProgress);
        } catch (e) {
          if (/已中止/.test(String(e?.message || ''))) throw e;
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'title',
            secIdx: 0,
            reason: e?.message || e,
          });
        }
        saveContinuation();
        renderContinuationChapters();
      }
      phase = 'live';
    }

    if (phase === 'live') {
      const hasAnyBody = (cont.acts[actIdx]?.sections || []).some((sec) => hasValidSectionContent(sec));
      if (hasAnyBody) {
        onProgress?.(`第 ${actIdx + 1} 章正文已写完，正在更新大总结（剧情链/人物链）…`, true);
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await sleep(1500);
        try {
          await updateLiveProgressForAct(cont, actIdx, onProgress, {
            saveFn: () => saveContinuation(),
            isCancelled: () => contState.cancelRequested,
            hardFail: true,
          });
          refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
        } catch (e) {
          if (/已中止/.test(String(e?.message || ''))) throw e;
          throwFreeBreakpoint(cont, {
            ...bpBase,
            phase: 'live',
            secIdx: 0,
            reason: e?.message || e,
          });
        }
      }
      phase = 'summary';
    }

    if (phase === 'summary') {
      onProgress?.(`第 ${actIdx + 1} 章正文已齐，正在生成整章表格总结…`, true);
      setGenSectionStatus(`总结中… 第${actIdx + 1}章表格总结`, { phase: 'summary' });
      try {
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await sleep(1200);
        const actNow = cont.acts[actIdx];
        const needForce = !isActComplete(actNow) && isFreeActReadyForTableSummary(actNow);
        await maybeSummarizeContAct(cont, actIdx, onProgress, {
          force: needForce,
          hardFail: true,
        });
        if (!cont.summaries?.some((s) => s.actNo === actIdx + 1)) {
          throw new Error('表格总结未写入');
        }
        if (cont.freeBreakpoint?.phase === 'summary' && Number(cont.freeBreakpoint?.actIdx) === actIdx) {
          clearFreeBreakpoint(cont);
          saveContinuation();
        }
      } catch (e) {
        if (/已中止/.test(String(e?.message || ''))) throw e;
        throwFreeBreakpoint(cont, {
          ...bpBase,
          phase: 'summary',
          secIdx: 0,
          reason: e?.message || e,
        });
      }
    }

    return actIdx;
  });
}
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
      status:
        mode === 'free'
          ? `生成中… 正在为第${actIdx + 1}章更新剧情链/人物链…`
          : `生成中… 正在更新剧情链/人物链(第${actIdx + 1}章 第${secIdx + 1}节)…`,
    });
    renderContinuationChapters();
    paintGenUiProgress();
    try {
      // 自然续写已改为每节自动总结；此处仅处理旧数据残留的「待确认」或大纲模式
      await prepareGenerationChannel('cont', { hadPriorContent: false });
      await sleep(400);
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

    if (mode === 'free') {
      setContHint(`第 ${actIdx + 1} 章 第 ${secIdx + 1} 节大总结已补写。自然续写无需再确认，可继续自然续写。`);
      return;
    }

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

/** 续写: 生成整章表格总结并存档。force=true 时允许章未写完强制重总结。 */
async function maybeSummarizeContAct(cont, actIdx, onProgress, { force = false, hardFail = false } = {}) {
  const actNo = actIdx + 1;
  const act = cont.acts[actIdx];
  if (!act) {
    if (hardFail) throw new Error(`第 ${actNo} 章不存在`);
    return;
  }
  if (force) {
    if (!actHasGeneratedContent(act)) {
      if (hardFail) throw new Error(`第 ${actNo} 章无正文可总结`);
      return;
    }
    cont.summaries = (cont.summaries || []).filter((s) => s.actNo !== actNo);
  } else {
    const ready = isActComplete(act) || isFreeActReadyForTableSummary(act);
    if (!ready) {
      if (hardFail) throw new Error(`第 ${actNo} 章尚未写完，无法生成表格总结`);
      return;
    }
    if (cont.summaries.some((s) => s.actNo === actNo)) return;
  }
  try {
    const partial = !isActComplete(act);
    log.info(`开始生成续写第 ${actNo} 章整章表格总结${partial ? '(未完成章·强制)' : ''}…`);
    onProgress?.(
      partial ? `正在强制总结续写第 ${actNo} 章(尚未写完，仅已有正文)…` : `第 ${actNo} 章已写完，正在生成整章表格总结…`,
      true,
    );
    setGenSectionStatus(`总结中… 第${actNo}章表格总结`, { phase: 'summary' });
    const { system, user } = buildActSummaryPrompt(cont, actIdx);
    const raw = (
      await novelGenerateWithId({ system, user }, `cont_sum_${Date.now()}_${actIdx}`, () => contState.cancelRequested, {
        minLen: 40,
      })
    ).trim();
    log.debug(`续写第 ${actNo} 章总结原始返回:`, raw.slice(0, 200));
    const parsed = parseSummary(raw);
    if (!parsed.characters.length && !parsed.plot.length) {
      log.warn(`续写第 ${actNo} 章总结解析为空, 原始文本:`, raw.slice(0, 400));
      throw new Error(`第 ${actNo} 章表格总结解析为空`);
    }
    cont.summaries = (cont.summaries || []).filter((s) => s.actNo !== actNo);
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
    log.info(`已生成续写第 ${actNo} 章表格总结`, {
      characters: parsed.characters.length,
      plot: parsed.plot.length,
      partial,
    });
    onProgress?.(`第 ${actNo} 章表格总结已存档${partial ? '(未完成章)' : ''}`, true);
  } catch (e) {
    log.warn('续写整章总结失败:', e);
    if (hardFail) throw e;
    if (/已中止/.test(String(e?.message || '')) || isCancelError(e)) throw e;
    onProgress?.(`第 ${actNo} 章表格总结失败: ${e?.message || e}`, true);
  }
}

/**
 * 自然续写：若本章已齐且尚无表格总结，则自动总结；失败抛断点。
 */
async function ensureFreeActTableSummaryOrBreakpoint(cont, actIdx, onProgress, batchActIndices = null) {
  const act = cont?.acts?.[actIdx];
  if (!act) return false;
  const actNo = actIdx + 1;
  if (cont.summaries?.some((s) => s.actNo === actNo)) return false;
  if (!isActComplete(act) && !isFreeActReadyForTableSummary(act)) return false;

  const indices =
    Array.isArray(batchActIndices) && batchActIndices.length
      ? batchActIndices
      : Number.isInteger(Number(cont.freeBatchStartAct)) && Number(cont.freeBatchActCount) > 0
        ? Array.from({ length: Number(cont.freeBatchActCount) }, (_, i) => Number(cont.freeBatchStartAct) + i).filter(
            (i) => cont.acts?.[i],
          )
        : [actIdx];

  try {
    await prepareGenerationChannel('cont', { hadPriorContent: false });
    await sleep(800);
    await maybeSummarizeContAct(cont, actIdx, onProgress, {
      force: !isActComplete(act),
      hardFail: true,
    });
    if (!cont.summaries?.some((s) => s.actNo === actNo)) {
      throw new Error('表格总结未写入');
    }
    return true;
  } catch (e) {
    if (/已中止/.test(String(e?.message || '')) || isCancelError(e)) throw e;
    throwFreeBreakpoint(cont, {
      phase: 'summary',
      actIdx,
      secIdx: 0,
      batchActIndices: indices,
      reason: e?.message || e,
    });
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
    if (/已中止/.test(String(e?.message || '')) || isCancelError(e)) {
      setContHint('已中止。');
      log.info('续写已中止');
    } else if (isFreeBreakpointError(e)) {
      const cont = getContinuation();
      const msg = e.userMessage || formatFreeBreakpointHint(cont?.freeBreakpoint) || '已在失败处暂停，可点「断点继续」。';
      setContHint(msg);
      toast('生成失败，已暂停在断点处');
      log.warn('自然续写断点暂停:', cont?.freeBreakpoint);
    } else {
      log.error('续写异常:', e);
      const took = genUiProgress.lastElapsedMs ? ` · 已耗时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '';
      setContHint(`续写失败: ${e.message}${took}`);
      toast(`续写失败: ${e.message}`);
    }
  } finally {
    const hintEl = globalThis.jQuery?.(`#${EXT_ID}-ct-hint`);
    const hintBefore = String(hintEl?.text() || '');
    const wasCancel =
      !!contState.cancelRequested || /已中止|正在中止/.test(hintBefore);
    contState.generating = false;
    contState.cancelRequested = false;
    contState.currentGenId = '';
    contState.activeActIdx = -1;
    contState.activeFlatIdx = -1;
    finishGenUiProgress();
    stopGenUiProgress();
    rejectFreeOutlineConfirmWait('已中止');
    $?.(`#${EXT_ID}-analyze [data-act="ct-stop"]`).prop('disabled', true);
    syncMiniBallBusy();
    if (wasCancel && (!hintBefore || /正在中止/.test(hintBefore))) {
      setContHint('已中止。');
    }
    const cont = getContinuation();
    if (cont) {
      // 有断点时保留批次元数据，便于「断点继续」
      if (cont.freeBreakpoint) {
        delete cont.pendingFreeOutlineBatch;
        if (cont.acts) {
          for (const a of cont.acts) delete a.pendingOutlineConfirm;
        }
        if (cont.freeBreakpoint && !/断点/.test(hintBefore || '')) {
          setContHint(formatFreeBreakpointHint(cont.freeBreakpoint));
        }
      } else {
        delete cont.pendingFreeOutlineBatch;
        delete cont.freeBatchStartAct;
        delete cont.freeBatchActCount;
        if (cont.acts) {
          for (const a of cont.acts) delete a.pendingOutlineConfirm;
        }
      }
      saveContinuation();
    }
    renderContinuationChapters();
    renderAnalyzeUI();
  }
}

/** 清空自然续写批次元数据与断点（不碰档案/基调/原文末尾）。 */
function clearContFreeBatchMeta(cont) {
  if (!cont) return;
  cont.freeBatchActive = false;
  cont.freeBatchRemain = 0;
  delete cont.freeBatchStartAct;
  delete cont.freeBatchActCount;
  delete cont.pendingFreeOutlineBatch;
  delete cont.freeOutlinePendingIndices;
  delete cont.freeToneTight;
  clearFreeBreakpoint(cont);
}

/**
 * 清空自然续写已生成内容：章节、总结、剧情链/人物链。
 * 保留：角色档案、剧情梗概、续写基调、速度、原文末尾、世界书绑定。
 */
function resetContFreeGenerated(cont) {
  if (!cont) return;
  cont.acts = [];
  cont.summaries = [];
  cont.plotChain = [];
  cont.liveProgress = null;
  clearPendingLiveSummary(cont);
  clearContFreeBatchMeta(cont);
  resetFreePlotArcState(cont);
  contState.activeActIdx = -1;
  contState.activeFlatIdx = -1;
}

/** 清空续写已生成正文；大纲模式保留总结；自然续写一并清总结/链条，避免重开仍接着旧剧情。 */
function resetContSections(cont) {
  if ((cont.mode || 'outline') === 'free') {
    resetContFreeGenerated(cont);
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
    clearPendingLiveSummary(cont);
    clearFreeBreakpoint(cont);
    contState.activeActIdx = -1;
    contState.activeFlatIdx = -1;
  }
  saveContinuation();
}

async function runContOutlineManual(cont) {
  if (contState.generating) return;
  collectContProfilesFromDOM(cont);
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
  collectContProfilesFromDOM(cont);
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

/**
 * 全书第一个尚无有效正文的节（忽略锁定；已标记跳过正文的除外）。
 * @returns {{ actIdx:number, secIdx:number, flatIdx:number } | null}
 */
function findFirstSectionWithoutBody(cont) {
  const flat = flatSections(cont);
  for (const f of flat) {
    if (f.sec?.bodySkipped) continue;
    if (!hasValidSectionContent(f.sec)) {
      return { actIdx: f.actIdx, secIdx: f.secIdx, flatIdx: f.flatIdx };
    }
  }
  return null;
}

/**
 * 从 startActIdx 起，收集仍有「无正文」节的章索引（用于确认大纲后写完全书待写正文）。
 * @returns {number[]}
 */
function collectActsNeedingFreeBodies(cont, startActIdx = 0) {
  const start = Math.max(0, Number(startActIdx) || 0);
  const out = [];
  for (let ai = start; ai < (cont.acts || []).length; ai++) {
    const secs = cont.acts[ai]?.sections || [];
    if (secs.some((s) => !s?.bodySkipped && !hasValidSectionContent(s))) out.push(ai);
  }
  return out;
}

/**
 * 自然续写流水线：大纲（可续跑）→ 确认 → 正文/总结（可续跑）。
 * 确认大纲后：从全书第一个无正文的节开始写（无视锁定），不限本批章节。
 */
async function runContFreePipeline(cont, {
  actIndices,
  label,
  resumeOutline = null, // { fromActIdx, fromSecIdx } | null
  skipOutlinePhase = false,
  resumeBody = null, // { actIdx, secIdx, startPhase } | null
} = {}) {
  const indices = (actIndices || []).filter((n) => Number.isInteger(n) && cont.acts?.[n]);
  if (!indices.length) throw new Error('本批章节不存在，无法继续');
  // 断点续跑 / 跳过大纲确认写正文：上下文更肥，强制紧凑基调
  const toneTightPrev = cont.freeToneTight;
  if (resumeOutline || resumeBody || skipOutlinePhase) cont.freeToneTight = true;
  try {
  const batchMeta = {
    batchActIndices: indices,
    batchStartAct: Number(cont.freeBatchStartAct) || indices[0],
    batchActCount: Number(cont.freeBatchActCount) || indices.length,
    label: label || formatContFreeBatchLabel(cont),
  };

  if (!skipOutlinePhase) {
    let pendingIndices = [...indices];
    let genIndices = [...indices];
    let outlineMode = 'initial'; // initial | regen | append

    while (true) {
      if (outlineMode === 'regen') {
        clearUnlockedFreeOutlines(cont, pendingIndices);
        saveContinuation();
        renderContinuationChapters();
        fitContSecOutlineTextareas();
        setContHint(`待确认大纲共 ${pendingIndices.length} 章：重新生成未锁定大纲…`, true);
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await sleep(800);
        genIndices = [...pendingIndices];
        resumeOutline = null;
      } else if (outlineMode === 'append') {
        setContHint(
          `追加大纲：新拟 ${genIndices.length} 章（累计待确认 ${pendingIndices.length} 章）…`,
          true,
        );
        resumeOutline = null;
      } else if (!resumeOutline) {
        setContHint(`本批 ${batchMeta.label}：先拟定全部大纲…`, true);
      } else {
        setContHint(
          `断点继续：从第 ${resumeOutline.fromActIdx + 1} 章 第 ${resumeOutline.fromSecIdx + 1} 节大纲重试…`,
          true,
        );
      }

      await generateFreeOutlinesForActs(
        cont,
        genIndices,
        setContHint,
        outlineMode === 'initial' ? resumeOutline || {} : {},
      );
      // 大纲阶段成功则清掉大纲断点（若有）
      if (cont.freeBreakpoint?.phase === 'outline') clearFreeBreakpoint(cont);
      if (contState.cancelRequested) {
        setContHint('已中止。');
        return;
      }

      for (const ai of pendingIndices) {
        if (cont.acts[ai]) cont.acts[ai]._folded = false;
      }
      cont.pendingFreeOutlineBatch = true;
      cont.freeOutlinePendingIndices = pendingIndices.slice();
      cont.freeBatchStartAct = pendingIndices[0];
      cont.freeBatchActCount = pendingIndices.length;
      batchMeta.batchActIndices = pendingIndices.slice();
      batchMeta.batchStartAct = pendingIndices[0];
      batchMeta.batchActCount = pendingIndices.length;
      saveContinuation();
      finishGenUiProgress();
      stopGenUiProgress();
      contState.activeFlatIdx = -1;
      renderContinuationChapters();
      fitContSecOutlineTextareas();

      setContHint(
        `已累计 ${pendingIndices.length} 章大纲。可再拟一批，或确认后写全部正文。`,
      );
      toast(`已累计 ${pendingIndices.length} 章大纲待确认`);

      let action = 'confirm';
      try {
        action = await waitFreeOutlineConfirm();
      } catch (e) {
        cont.pendingFreeOutlineBatch = false;
        delete cont.freeOutlinePendingIndices;
        saveContinuation();
        renderContinuationChapters();
        throw e;
      }
      if (contState.cancelRequested) {
        setContHint('已中止。');
        return;
      }
      if (action === 'regen') {
        outlineMode = 'regen';
        continue;
      }
      if (action === 'append') {
        collectContProfilesFromDOM(cont);
        readContFreeBatchFromDOM(cont);
        ensureContFreeBatch(cont);
        const addActs = Math.max(1, Number(cont.targetActs) || 1);
        const addSecs = Math.max(1, Number(cont.targetSecsPerAct) || 1);
        cont.freeBatchSecs = addSecs;
        const startAct = cont.acts.length;
        const newIndices = createFreeBatchActs(cont, addActs, addSecs);
        if (!newIndices.length) {
          toast('未能追加新章');
          outlineMode = 'append';
          genIndices = [];
          continue;
        }
        pendingIndices = pendingIndices.concat(newIndices);
        genIndices = newIndices;
        outlineMode = 'append';
        batchMeta.label = `${pendingIndices.length}章/${addSecs}节`;
        setContHint(
          `将追加 ${addActs} 章×${addSecs} 节大纲（自第 ${startAct + 1} 章起）…`,
          true,
        );
        saveContinuation();
        renderContinuationChapters();
        await prepareGenerationChannel('cont', { hadPriorContent: false });
        await sleep(600);
        continue;
      }
      // confirm：写完全部待确认章的正文
      indices.splice(0, indices.length, ...pendingIndices);
      break;
    }

    cont.pendingFreeOutlineBatch = false;
    delete cont.freeOutlinePendingIndices;
    saveContinuation();
    renderContinuationChapters();

    // 确认后：从全书第一个无正文处起写，不限本批章
    const gapAfterConfirm = findFirstSectionWithoutBody(cont);
    if (!gapAfterConfirm) {
      setContHint('已确认大纲，但没有待写正文的节。');
      return;
    }
    if (!resumeBody) {
      resumeBody = {
        actIdx: gapAfterConfirm.actIdx,
        secIdx: gapAfterConfirm.secIdx,
        startPhase: 'body',
      };
    }
    const expanded = collectActsNeedingFreeBodies(cont, gapAfterConfirm.actIdx);
    if (expanded.length) indices.splice(0, indices.length, ...expanded);

    const phaseGap = freeOutlineToBodyGapMs(indices[0] ?? 0);
    setContHint(
      `已确认大纲，将自第 ${gapAfterConfirm.actIdx + 1} 章 第 ${gapAfterConfirm.secIdx + 1} 节起写正文（共 ${indices.length} 章，含锁定无正文节）… ${Math.round(phaseGap / 1000)}s 后开始`,
      true,
    );
    setGenSectionStatus(`冷却中（确认后写正文约 ${Math.round(phaseGap / 1000)}s）…`, { phase: 'wait' });
    await prepareGenerationChannel('cont', { hadPriorContent: false });
    await waitCancellable(phaseGap, () => contState.cancelRequested);
  }

  // 正文阶段：始终从全书第一个无正文节对齐（断点续跑保留 resumeBody）
  if (!resumeBody) {
    const gap = findFirstSectionWithoutBody(cont);
    if (!gap) {
      setContHint('没有待写正文的节。');
      return;
    }
    resumeBody = { actIdx: gap.actIdx, secIdx: gap.secIdx, startPhase: 'body' };
  }
  {
    const expanded = collectActsNeedingFreeBodies(cont, resumeBody.actIdx);
    if (expanded.length) indices.splice(0, indices.length, ...expanded);
    else {
      setContHint('没有待写正文的节。');
      return;
    }
  }
  batchMeta.batchActIndices = indices.slice();
  batchMeta.batchStartAct = indices[0];
  batchMeta.batchActCount = indices.length;

  let startBodyAt = 0;
  let firstOpts = { batchActIndices: indices };
  {
    const bi = indices.indexOf(resumeBody.actIdx);
    startBodyAt = bi >= 0 ? bi : 0;
    firstOpts = {
      batchActIndices: indices,
      fromSecIdx: resumeBody.secIdx || 0,
      startPhase: resumeBody.startPhase || 'body',
    };
  }

  let written = 0;
  for (let i = startBodyAt; i < indices.length; i++) {
    if (contState.cancelRequested) {
      setContHint('已中止。');
      return;
    }
    const actIdx = indices[i];
    if (i > startBodyAt) {
      const betweenGap = Math.max(3500, Number(getSettings()?.genMinIntervalMs) || 5000);
      setContHint(
        `第 ${actIdx + 1} 章前跨章冷却约 ${Math.round(betweenGap / 1000)}s（正文 ${i - startBodyAt + 1}/${indices.length - startBodyAt}）…`,
        true,
      );
      setGenSectionStatus(`冷却中（跨章约 ${Math.round(betweenGap / 1000)}s）…`, { phase: 'wait' });
      await prepareGenerationChannel('cont', { hadPriorContent: false });
      await waitCancellable(betweenGap, () => contState.cancelRequested);
    }
    setContHint(
      `自然续写中：正在写第 ${actIdx + 1} 章正文（${i - startBodyAt + 1}/${indices.length - startBodyAt}）…`,
      true,
    );
    const opts = i === startBodyAt ? firstOpts : { batchActIndices: indices };
    await writeFreeChapterBodies(cont, actIdx, setContHint, opts);
    written += 1;
  }

  cont.freeBatchActive = false;
  cont.freeBatchRemain = 0;
  delete cont.freeBatchStartAct;
  delete cont.freeBatchActCount;
  delete cont.pendingFreeOutlineBatch;
  clearFreeBreakpoint(cont);
  saveContinuation();
  setContHint(
    `自然续写完成：已写完 ${written} 章正文。可再按 ${formatContFreeBatchLabel(cont)} 追加下一批大纲。`,
  );
  } finally {
    if (toneTightPrev) cont.freeToneTight = toneTightPrev;
    else delete cont.freeToneTight;
  }
}

/**
 * 自然续写：按当前「本批续写 x章/x节」开一批。
 * 可多批只拟大纲 → 确认全部大纲 → 再写全部正文。
 * 任一步失败则停在断点，可点「断点继续」。
 */
async function runContFree(cont) {
  if (contState.generating) return;
  collectContProfilesFromDOM(cont);
  readContFreeBatchFromDOM(cont);
  ensureContFreeBatch(cont);
  clearPendingLiveSummary(cont);
  clearFreeBreakpoint(cont);
  delete cont.freeToneTight;

  // 无章节却残留总结/链条时清掉，避免「清除后重开」仍接着旧剧情
  if (!(cont.acts || []).length) {
    if (
      (cont.summaries || []).length ||
      (cont.plotChain || []).length ||
      cont.liveProgress ||
      cont.pendingFreeOutlineBatch ||
      cont.freeBatchActive
    ) {
      log.info('自然续写重开：清理无章节残留的总结/剧情链');
      cont.summaries = [];
      cont.plotChain = [];
      cont.liveProgress = null;
      clearContFreeBatchMeta(cont);
    }
  }

  const batchActs = Math.max(1, Number(cont.targetActs) || 1);
  const nSecs = Math.max(1, Number(cont.targetSecsPerAct) || 1);
  cont.freeBatchSecs = nSecs;
  saveContinuation();

  const label = `${batchActs}章/${nSecs}节`;
  log.info('自然续写开批', {
    label,
    batchActs,
    nSecs,
    tone: readContFreeTone(cont).slice(0, 40),
    plotArcStart: cont.freePlotArcStartFlatIdx,
    plotArcMin: getFreePlotArcMinSecs(cont),
  });

  await withContGenerating(async () => {
    try {
      setUiOpen('ct-summaries', true);
      setUiOpen('ct-grand', true);
      renderAnalyzeUI();

      const startAct = cont.acts.length;
      const actIndices = createFreeBatchActs(cont, batchActs, nSecs);
      cont.freeBatchActive = true;
      cont.freeBatchRemain = 0;
      cont.freeBatchStartAct = startAct;
      cont.freeBatchActCount = batchActs;
      cont.pendingFreeOutlineBatch = false;
      saveContinuation();
      renderContinuationChapters();

      await runContFreePipeline(cont, { actIndices, label });
    } catch (e) {
      if (/已中止/.test(String(e?.message || ''))) {
        setContHint('已中止。');
        return;
      }
      throw e;
    }
  });
  renderAnalyzeUI();
  log.debug('自然续写批次结束', { label, remain: cont.freeBatchRemain });
}

/** 从失败断点继续自然续写。 */
async function resumeContFree(cont) {
  if (contState.generating) return;
  const bp = cont?.freeBreakpoint;
  if (!bp || !bp.phase) {
    toast('当前没有可继续的断点');
    return;
  }
  collectContProfilesFromDOM(cont);
  readContFreeBatchFromDOM(cont);
  ensureContFreeBatch(cont);

  const actIndices = resolveFreeBpBatchIndices(cont, bp);
  if (!actIndices.length) {
    toast('断点批次章节已丢失，请重新开始自然续写');
    clearFreeBreakpoint(cont);
    saveContinuation();
    renderAnalyzeUI();
    return;
  }

  cont.freeBatchStartAct = Number.isInteger(Number(bp.batchStartAct))
    ? Number(bp.batchStartAct)
    : actIndices[0];
  cont.freeBatchActCount = Number(bp.batchActCount) || actIndices.length;
  cont.freeBatchActive = true;
  const label = bp.label || formatContFreeBatchLabel(cont);
  const phase = String(bp.phase || 'body');
  const actIdx = Number(bp.actIdx) || 0;
  const secIdx = Number(bp.secIdx) || 0;

  log.info('自然续写断点继续', { phase, actIdx, secIdx, actIndices, label });

  await withContGenerating(async () => {
    try {
      setUiOpen('ct-summaries', true);
      setUiOpen('ct-grand', true);
      renderAnalyzeUI();

      if (phase === 'outline') {
        clearFreeBreakpoint(cont);
        saveContinuation();
        await runContFreePipeline(cont, {
          actIndices,
          label,
          resumeOutline: { fromActIdx: actIdx, fromSecIdx: secIdx },
        });
        return;
      }

      // 正文/标题/总结：跳过大纲确认，从断点章继续
      clearFreeBreakpoint(cont);
      saveContinuation();
      await runContFreePipeline(cont, {
        actIndices,
        label,
        skipOutlinePhase: true,
        resumeBody: {
          actIdx,
          secIdx: phase === 'body' ? secIdx : 0,
          startPhase: phase === 'body' ? 'body' : phase,
        },
      });
    } catch (e) {
      if (/已中止/.test(String(e?.message || ''))) {
        setContHint('已中止。');
        return;
      }
      throw e;
    }
  });
  renderAnalyzeUI();
}

/**
 * 跳过并删除当前断点，从断点下一节（或下一阶段）继续本批。
 * 大纲/正文失败：跳过该节；标题→大总结→表格总结→下一章正文。
 */
async function skipFreeBreakpointAndResume(cont) {
  if (contState.generating) return;
  const bp = cont?.freeBreakpoint;
  if (!bp || !bp.phase) {
    toast('当前没有可跳过的断点');
    return;
  }
  if (
    !globalThis.confirm?.(
      `${formatFreeBreakpointHint(bp)}\n\n将删除此断点并跳过失败处，从下一节（或下一阶段）继续。确定？`,
    )
  ) {
    return;
  }

  collectContProfilesFromDOM(cont);
  readContFreeBatchFromDOM(cont);
  ensureContFreeBatch(cont);
  collectContActsFromDOM(cont);

  const next = computeNextFreeResumeAfterSkip(cont, bp);
  if (next.kind === 'lost') {
    toast('断点批次章节已丢失，已清除断点');
    clearFreeBreakpoint(cont);
    saveContinuation();
    renderAnalyzeUI();
    return;
  }

  const label = bp.label || formatContFreeBatchLabel(cont);
  const actIndices = next.actIndices || [];
  markFreeBreakpointSkipped(cont, bp);

  cont.freeBatchStartAct = Number.isInteger(Number(bp.batchStartAct))
    ? Number(bp.batchStartAct)
    : actIndices[0];
  cont.freeBatchActCount = Number(bp.batchActCount) || actIndices.length;
  cont.freeBatchActive = true;
  clearFreeBreakpoint(cont);
  saveContinuation();
  renderContinuationChapters();

  log.info('自然续写跳过断点', { from: bp, next });

  if (next.kind === 'outlines_ready') {
    for (const ai of actIndices) {
      if (cont.acts[ai]) cont.acts[ai]._folded = false;
    }
    cont.pendingFreeOutlineBatch = true;
    saveContinuation();
    renderAnalyzeUI();
    setContHint(`已跳过断点。本批 ${label} 大纲已齐，请确认全部大纲或重新生成未锁定大纲。`);
    toast('已跳过断点，请确认大纲');
    return;
  }

  if (next.kind === 'batch_done') {
    delete cont.pendingFreeOutlineBatch;
    cont.freeBatchRemain = 0;
    saveContinuation();
    renderAnalyzeUI();
    setContHint(
      `已跳过末章断点。本批 ${label} 已结束。可再按 ${formatContFreeBatchLabel(cont)} 追加下一批。`,
    );
    toast('已跳过断点，本批结束');
    return;
  }

  const whereHint =
    next.phase === 'outline' || next.phase === 'body'
      ? `第 ${next.actIdx + 1} 章 第 ${next.secIdx + 1} 节`
      : next.phase === 'title'
        ? `第 ${next.actIdx + 1} 章标题`
        : next.phase === 'live'
          ? `第 ${next.actIdx + 1} 章大总结`
          : next.phase === 'summary'
            ? `第 ${next.actIdx + 1} 章表格总结`
            : `第 ${next.actIdx + 1} 章`;
  toast(`已跳过断点，从${whereHint}继续`);

  await withContGenerating(async () => {
    try {
      setUiOpen('ct-summaries', true);
      setUiOpen('ct-grand', true);
      renderAnalyzeUI();

      if (next.phase === 'outline') {
        await runContFreePipeline(cont, {
          actIndices,
          label,
          resumeOutline: { fromActIdx: next.actIdx, fromSecIdx: next.secIdx },
        });
        return;
      }

      await runContFreePipeline(cont, {
        actIndices,
        label,
        skipOutlinePhase: true,
        resumeBody: {
          actIdx: next.actIdx,
          secIdx: next.phase === 'body' ? next.secIdx : 0,
          startPhase: next.phase === 'body' ? 'body' : next.phase,
        },
      });
    } catch (e) {
      if (/已中止/.test(String(e?.message || ''))) {
        setContHint('已中止。');
        return;
      }
      throw e;
    }
  });
  renderAnalyzeUI();
}

/* ================================================================== */
/* 名词库复制板（主面板右侧）                                           */
/* ================================================================== */

const NOUN_BOARD_SOURCES = [
  { key: 'contChars', label: '人物', kind: '人物', tone: 'cont' },
  { key: 'contFactions', label: '组织', kind: '组织', tone: 'cont' },
  { key: 'novelChars', label: '人物', kind: '人物', tone: 'novel', wdKey: 'chars' },
  { key: 'novelItems', label: '道具', kind: '道具', tone: 'novel', wdKey: 'items' },
  { key: 'novelPlaces', label: '地理', kind: '地理', tone: 'novel', wdKey: 'places' },
  { key: 'novelOthers', label: '其他', kind: '其他', tone: 'novel', wdKey: 'others' },
];

/** 名词库主模式：cont | novel */
function ensureNounBoardMode(s = getSettings()) {
  if (s.nounBoardMode !== 'cont' && s.nounBoardMode !== 'novel') s.nounBoardMode = 'cont';
  return s.nounBoardMode;
}

/** 确保名词库次级开关对象完整。 */
function ensureNounBoardSources(s = getSettings()) {
  const def = DEFAULT_SETTINGS.nounBoardSources;
  if (!s.nounBoardSources || typeof s.nounBoardSources !== 'object') {
    s.nounBoardSources = { ...def };
  }
  for (const k of Object.keys(def)) {
    if (typeof s.nounBoardSources[k] !== 'boolean') s.nounBoardSources[k] = def[k];
  }
  return s.nounBoardSources;
}

/** 从设定行提取短名词（名称）。 */
function extractNounLabel(text, fallback = '') {
  const t = String(text || '').trim();
  if (!t) return fallback || '';
  const m = t.match(/^([^\n:：\-—–]{1,40})\s*[:：\-—–]/);
  if (m?.[1]) return m[1].trim();
  const head = t.split(/[\n,，、]/)[0].trim();
  return (head || t).slice(0, 28);
}

function formatContFactionDetail(fa, i = 0) {
  const title = String(fa?.name || '').trim() || `组织${i + 1}`;
  const lines = [`组织：${title}`];
  if (String(fa?.members || '').trim()) lines.push(`主要成员：${String(fa.members).trim()}`);
  if (String(fa?.goal || '').trim()) lines.push(`目的：${String(fa.goal).trim()}`);
  if (String(fa?.morality || '').trim()) lines.push(`道德：${String(fa.morality).trim()}`);
  return lines.join('\n');
}

/** 收集当前主模式 + 次级筛选下的名词条目。 */
function gatherNounBoardItems() {
  const mode = ensureNounBoardMode();
  const src = ensureNounBoardSources();
  const items = [];

  if (mode === 'cont') {
    if (!src.contChars && !src.contFactions) return items;
    const cont = getContinuation();
    if (!cont) return items;
    try {
      ensureContProfiles(cont);
      collectContProfilesFromDOM(cont);
    } catch (_) {
      /* DOM 可能尚未就绪 */
    }
    if (src.contChars) {
      (cont.charProfiles || []).forEach((c, i) => {
        const name = String(c?.name || '').trim();
        if (!name && !contCharProfileHasContent(c)) return;
        const label = name || `角色${i + 1}`;
        items.push({
          id: `cc:${cont.id}:${i}`,
          source: 'contChars',
          kind: '人物',
          label,
          copyText: label,
          detail: contCharProfilesText({ charProfiles: [c] }) || label,
        });
      });
    }
    if (src.contFactions) {
      const factions = Array.isArray(cont.plotProfile?.factions) ? cont.plotProfile.factions : [];
      factions.forEach((fa, i) => {
        if (!contFactionHasContent(fa)) return;
        const label = String(fa.name || '').trim() || `组织${i + 1}`;
        items.push({
          id: `cf:${cont.id}:${i}`,
          source: 'contFactions',
          kind: '组织',
          label,
          copyText: label,
          detail: formatContFactionDetail(fa, i),
        });
      });
    }
    return items;
  }

  // novel
  const novelKeys = NOUN_BOARD_SOURCES.filter((x) => x.tone === 'novel' && src[x.key]);
  if (!novelKeys.length) return items;
  const proj = getActiveProject();
  if (!proj) return items;
  try {
    ensureWorldDefs(proj);
    // 仅当工作区 DOM 属于当前项目时才从 DOM 回写，避免切换瞬间串设定
    if (String(novelState.renderedProjectId || '') === String(proj.id || '')) {
      syncNovelSettingsFromDOM(proj);
    }
  } catch (_) {
    /* ignore */
  }
  const wd = proj.worldDefs || {};
  for (const meta of novelKeys) {
    const list = Array.isArray(wd[meta.wdKey]) ? wd[meta.wdKey] : [];
    let entryIdx = 0;
    list.forEach((raw, i) => {
      const pieces = splitWorldDefNounEntries(raw);
      pieces.forEach((text, pi) => {
        if (!String(text || '').trim()) return;
        const label = extractNounLabel(text, `${meta.kind}${entryIdx + 1}`);
        items.push({
          id: `nv:${proj.id}:${meta.wdKey}:${i}:${pi}`,
          source: meta.key,
          kind: meta.kind,
          label,
          copyText: label,
          detail: text,
        });
        entryIdx++;
      });
    });
  }
  return items;
}

function bindNounBoardEvents($overlay) {
  if (panelUiState._nounBound) return;
  panelUiState._nounBound = true;
  const $ = globalThis.jQuery;

  $overlay.on('click', '[data-act="noun-refresh"]', (e) => {
    e.preventDefault();
    renderNounBoard();
    toast('名词库已刷新');
  });

  $overlay.on('click', '[data-act="noun-mode"]', function (e) {
    e.preventDefault();
    const mode = String($(this).data('mode') || '');
    if (mode !== 'cont' && mode !== 'novel') return;
    getSettings().nounBoardMode = mode;
    saveSettings();
    panelUiState.nounExpandedId = '';
    renderNounBoard();
  });

  $overlay.on('click', '[data-act="noun-src"]', function (e) {
    e.preventDefault();
    const key = String($(this).data('src') || '');
    if (!key) return;
    const src = ensureNounBoardSources();
    src[key] = !src[key];
    saveSettings();
    panelUiState.nounExpandedId = '';
    renderNounBoard();
  });

  $overlay.on('click', '.ns-noun-tag', function (e) {
    e.preventDefault();
    const copyText = String($(this).attr('data-copy') || $(this).text() || '');
    if (panelUiState._nounClickTimer) clearTimeout(panelUiState._nounClickTimer);
    panelUiState._nounClickTimer = setTimeout(() => {
      panelUiState._nounClickTimer = null;
      copyToClipboard(copyText);
    }, 280);
  });

  $overlay.on('dblclick', '.ns-noun-tag', function (e) {
    e.preventDefault();
    if (panelUiState._nounClickTimer) {
      clearTimeout(panelUiState._nounClickTimer);
      panelUiState._nounClickTimer = null;
    }
    const id = String($(this).data('id') || '');
    panelUiState.nounExpandedId = panelUiState.nounExpandedId === id ? '' : id;
    renderNounBoard();
  });

  $overlay.on('click', '[data-act="noun-copy-detail"]', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const id = String($(this).data('id') || '');
    const item = gatherNounBoardItems().find((x) => x.id === id);
    copyToClipboard(item?.detail || '');
  });

  $overlay.on('click', '[data-act="noun-close-detail"]', function (e) {
    e.preventDefault();
    panelUiState.nounExpandedId = '';
    renderNounBoard();
  });
}

function renderNounBoard() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $board = $(`#${EXT_ID}-noun-board`);
  if (!$board.length) return;

  const mode = ensureNounBoardMode();
  const src = ensureNounBoardSources();

  const modesHtml = `
    <button type="button" class="ns-noun-mode ${mode === 'cont' ? 'ns-noun-mode--on' : ''}" data-act="noun-mode" data-mode="cont">续写小说</button>
    <button type="button" class="ns-noun-mode ${mode === 'novel' ? 'ns-noun-mode--on' : ''}" data-act="noun-mode" data-mode="novel">新小说</button>`;
  $(`#${EXT_ID}-noun-modes`).html(modesHtml);

  const subSources = NOUN_BOARD_SOURCES.filter((x) => x.tone === mode);
  const togglesHtml = subSources
    .map((meta) => {
      const on = !!src[meta.key];
      return `<button type="button" class="ns-noun-toggle ${on ? 'ns-noun-toggle--on' : ''}" data-act="noun-src" data-src="${meta.key}" title="${esc(meta.label)}">${esc(meta.label)}</button>`;
    })
    .join('');
  $(`#${EXT_ID}-noun-toggles`).html(togglesHtml);

  const items = gatherNounBoardItems();
  const emptyHint =
    mode === 'cont'
      ? '暂无名词。打开人物/组织，并确保续写档案已填写。'
      : '暂无名词。打开次级筛选，并确保写小说设定已填写。';
  const tagsHtml = items.length
    ? items
        .map((it) => {
          const active = panelUiState.nounExpandedId === it.id ? ' ns-noun-tag--active' : '';
          return `<button type="button" class="ns-noun-tag ns-noun-tag--${esc(it.source)}${active}" data-id="${esc(it.id)}" data-copy="${esc(it.copyText)}" title="${esc(it.kind)} · 单击复制 / 双击详情"><span class="ns-noun-tag__kind">${esc(it.kind)}</span><span class="ns-noun-tag__label">${esc(it.label)}</span></button>`;
        })
        .join('')
    : `<p class="ns-muted">${emptyHint}</p>`;
  $(`#${EXT_ID}-noun-tags`).html(tagsHtml);

  const $detail = $(`#${EXT_ID}-noun-detail`);
  const expanded = items.find((it) => it.id === panelUiState.nounExpandedId);
  if (expanded) {
    const detailEsc = esc(expanded.detail).replace(/\n/g, '<br>');
    $detail
      .html(
        `<div class="ns-noun-detail__bar">
          <strong>${esc(expanded.kind)} · ${esc(expanded.label)}</strong>
          <div class="ns-row" style="gap:4px;">
            <button type="button" class="ns-btn ns-btn--sm" data-act="noun-copy-detail" data-id="${esc(expanded.id)}">复制详情</button>
            <button type="button" class="ns-btn ns-btn--icon ns-btn--sm" data-act="noun-close-detail" title="收起"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
        <div class="ns-noun-detail__body">${detailEsc}</div>`,
      )
      .show();
  } else {
    $detail.hide().empty();
    panelUiState.nounExpandedId = '';
  }
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
  nounExpandedId: '',
  _nounClickTimer: null,
  _nounBound: false,
  _opsBound: false,
  /** 左侧章节树展开状态：key=`${mode}:${projId}:${actIdx}`，缺省为折叠 */
  opsTreeOpen: Object.create(null),
  /** 左侧项目节点展开状态：key=`${mode}:${projId}`，缺省为折叠 */
  opsProjOpen: Object.create(null),
};

function opsTreeActKey(mode, projId, actIdx) {
  return `${mode}:${projId}:${actIdx}`;
}
function isOpsTreeActOpen(mode, projId, actIdx) {
  return !!panelUiState.opsTreeOpen[opsTreeActKey(mode, projId, actIdx)];
}
function setOpsTreeActOpen(mode, projId, actIdx, open) {
  const k = opsTreeActKey(mode, projId, actIdx);
  if (open) panelUiState.opsTreeOpen[k] = true;
  else delete panelUiState.opsTreeOpen[k];
}

function opsProjKey(mode, projId) {
  return `${mode}:${projId}`;
}
function isOpsProjOpen(mode, projId) {
  return !!panelUiState.opsProjOpen[opsProjKey(mode, projId)];
}
function setOpsProjOpen(mode, projId, open) {
  const id = String(projId || '');
  if (!id) return;
  const prefix = `${mode}:`;
  if (open) {
    // 同一功能下只展开当前操作的项目，其余自动折叠
    for (const key of Object.keys(panelUiState.opsProjOpen)) {
      if (key.startsWith(prefix)) delete panelUiState.opsProjOpen[key];
    }
    panelUiState.opsProjOpen[opsProjKey(mode, id)] = true;
  } else {
    delete panelUiState.opsProjOpen[opsProjKey(mode, id)];
  }
}

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

/* ---------------------------- 左侧操作栏 / 视图切换 ---------------------------- */

function applyStudioView(view) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const v = view === 'cont' || view === 'novel' || view === 'keyword' || view === 'idea' ? view : '';
  $(`#${EXT_ID}-home`).css('display', v ? 'none' : 'flex');
  $(`#${EXT_ID}-view-cont`).css('display', v === 'cont' ? '' : 'none');
  $(`#${EXT_ID}-view-novel`).css('display', v === 'novel' ? '' : 'none');
  $(`#${EXT_ID}-view-keyword`).css('display', v === 'keyword' ? '' : 'none');
  $(`#${EXT_ID}-view-idea`).css('display', v === 'idea' ? '' : 'none');
}

function setStudioActiveView(view, { persist = true, syncNoun = true } = {}) {
  const next = view === 'cont' || view === 'novel' || view === 'keyword' || view === 'idea' ? view : '';
  if (persist) {
    getSettings().studioActiveView = next;
    saveSettings();
  }
  applyStudioView(next);
  if (next === 'keyword') fillKeywordForm();
  if (next === 'idea') {
    try {
      ideaState.open = true;
    } catch (_) {
      /* ignore */
    }
    renderIdeaUI();
  }
  if (syncNoun && (next === 'cont' || next === 'novel')) {
    getSettings().nounBoardMode = next === 'cont' ? 'cont' : 'novel';
    saveSettings();
    renderNounBoard();
  }
  renderOpsNav();
  renderOpsTree();
}

function renderOpsNav() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $nav = $(`#${EXT_ID}-ops-nav`);
  if (!$nav.length) return;
  const cur = getStudioActiveView();
  $nav.html(
    STUDIO_VIEWS.map((v) => {
      const on = cur === v.key ? ' ns-ops__btn--on' : '';
      return `<button type="button" class="ns-ops__btn${on}" data-act="ops-view" data-view="${v.key}" title="${esc(v.label)}">
        <i class="fa-solid ${v.icon}"></i><span>${esc(v.label)}</span>
      </button>`;
    }).join(''),
  );
  renderOpsProjBar();
}

/** 功能按钮与项目列表之间：新建 / 删除 */
function renderOpsProjBar() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $bar = $(`#${EXT_ID}-ops-proj-bar`);
  if (!$bar.length) return;
  const view = getStudioActiveView();
  if (view !== 'cont' && view !== 'novel') {
    $bar.hide().empty();
    return;
  }
  const hasActive = view === 'cont' ? !!getContinuation() : !!getActiveProject();
  $bar
    .html(
      `<button type="button" class="ns-btn ns-btn--sm ns-ops__proj-new" data-act="ops-proj-new" title="新建项目">
        <i class="fa-solid fa-plus"></i> 新建项目
      </button>
      <button type="button" class="ns-btn ns-btn--sm ns-btn--danger ns-ops__proj-del" data-act="ops-proj-del" ${hasActive ? '' : 'disabled'} title="双击删除当前项目">
        <i class="fa-solid fa-trash"></i> 删除项目
      </button>`,
    )
    .show();
}

/** 渲染某项目的章节树 HTML（默认各章折叠）；末尾附已生成正文字数。 */
function renderOpsChapterTreeHtml(mode, obj) {
  const projId = String(obj?.id || '');
  const acts = Array.isArray(obj?.acts) ? obj.acts : [];
  const chars = generatedContentCharCount(obj);
  const statsHtml = `<div class="ns-ops__proj-stats" title="各节已生成正文合计">已生成正文 ${chars.toLocaleString('zh-CN')} 字</div>`;
  if (!acts.length) {
    return `<p class="ns-muted ns-ops__tree-empty" style="padding:4px 8px;">暂无章节</p>${statsHtml}`;
  }
  const treeHtml = acts
    .map((act, ai) => {
      const actTitle = String(act.title || '').trim() || `第 ${ai + 1} 章`;
      const open = isOpsTreeActOpen(mode, projId, ai);
      const secs = Array.isArray(act.sections) ? act.sections : [];
      const secHtml = secs
        .map((sec, si) => {
          const done = hasValidSectionContent(sec);
          const label = String(sec.outline || '').trim().slice(0, 28) || `第 ${si + 1} 节`;
          return `<button type="button" class="ns-ops__sec${done ? ' ns-ops__sec--done' : ''}" data-act="ops-jump" data-mode="${mode}" data-pid="${esc(projId)}" data-a="${ai}" data-s="${si}" title="${esc(label)}">
            <span class="ns-ops__sec-no">${si + 1}</span>
            <span class="ns-ops__sec-label">${esc(label)}</span>
          </button>`;
        })
        .join('');
      return `<div class="ns-ops__act${open ? '' : ' ns-ops__act--folded'}" data-mode="${mode}" data-pid="${esc(projId)}" data-a="${ai}">
        <div class="ns-ops__act-row">
          <button type="button" class="ns-ops__fold" data-act="ops-tree-fold" data-mode="${mode}" data-pid="${esc(projId)}" data-a="${ai}" title="${open ? '折叠' : '展开'}">
            <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i>
          </button>
          <button type="button" class="ns-ops__act-btn" data-act="ops-jump" data-mode="${mode}" data-pid="${esc(projId)}" data-a="${ai}" data-s="-1" title="${esc(actTitle)}">
            <span>第 ${ai + 1} 章 · ${esc(actTitle)}</span>
            <span class="ns-ops__act-count">${secs.length}</span>
          </button>
        </div>
        <div class="ns-ops__secs"${open ? '' : ' style="display:none;"'}>${secHtml || '<p class="ns-muted" style="padding:2px 8px;font-size:0.75rem;">无节</p>'}</div>
      </div>`;
    })
    .join('');
  return `${treeHtml}${statsHtml}`;
}

function renderOpsTree() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $tree = $(`#${EXT_ID}-ops-tree`);
  const $wrap = $(`#${EXT_ID}-ops-tree-wrap`);
  if (!$tree.length) return;
  renderOpsProjBar();
  const view = getStudioActiveView();
  if (view !== 'cont' && view !== 'novel') {
    $wrap.addClass('ns-ops__tree-wrap--idle');
    $tree.html('<p class="ns-muted ns-ops__tree-empty">选择「续写小说」或「写新小说」后管理项目</p>');
    return;
  }
  $wrap.removeClass('ns-ops__tree-wrap--idle');
  const mode = view;
  const list = mode === 'cont' ? getContinuations() : getProjects();
  const activeId =
    mode === 'cont' ? String(getSettings().activeContinuationId || getContinuation()?.id || '') : String(getSettings().activeProjectId || getActiveProject()?.id || '');

  if (!list.length) {
    $tree.html(`<p class="ns-muted ns-ops__tree-empty">${mode === 'cont' ? '暂无续写项目，点击上方「新建项目」' : '暂无小说项目，点击上方「新建项目」'}</p>`);
    return;
  }

  const html = list
    .map((obj) => {
      const id = String(obj.id || '');
      const title = String(obj.title || '').trim() || (mode === 'cont' ? '续写项目' : '小说项目');
      const open = isOpsProjOpen(mode, id);
      const active = id && id === activeId;
      const actN = Array.isArray(obj.acts) ? obj.acts.length : 0;
      return `<div class="ns-ops__proj${open ? '' : ' ns-ops__proj--folded'}${active ? ' ns-ops__proj--active' : ''}" data-mode="${mode}" data-pid="${esc(id)}">
        <div class="ns-ops__proj-row">
          <button type="button" class="ns-ops__fold" data-act="ops-proj-fold" data-mode="${mode}" data-pid="${esc(id)}" title="${open ? '折叠章节' : '展开章节'}">
            <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i>
          </button>
          <button type="button" class="ns-ops__proj-btn" data-act="ops-proj-select" data-mode="${mode}" data-pid="${esc(id)}" title="${esc(title)}">
            <span class="ns-ops__proj-title">${esc(title)}</span>
            <span class="ns-ops__act-count">${actN}章</span>
          </button>
        </div>
        <div class="ns-ops__proj-body"${open ? '' : ' style="display:none;"'}>${renderOpsChapterTreeHtml(mode, obj)}</div>
      </div>`;
    })
    .join('');
  $tree.html(html);
}

/** 切换当前续写/写小说项目并刷新工作区。 */
function selectOpsProject(mode, projId, { expand = true } = {}) {
  const id = String(projId || '');
  if (!id) return;
  if (mode === 'cont') {
    const hit = getContinuations().find((c) => c.id === id);
    if (!hit) return void toast('未找到该续写项目');
    getSettings().activeContinuationId = id;
    saveSettings();
    contState.activeActIdx = -1;
    analyzeState.result = null;
    if (expand) setOpsProjOpen(mode, id, true);
    renderAnalyzeUI();
  } else if (mode === 'novel') {
    const hit = getProjects().find((p) => p.id === id);
    if (!hit) return void toast('未找到该小说项目');
    getSettings().activeProjectId = id;
    saveSettings();
    novelState.activeActIdx = -1;
    if (expand) setOpsProjOpen(mode, id, true);
    renderNovelUI();
  } else return;
  renderOpsTree();
}

function opsCreateProject() {
  const view = getStudioActiveView();
  if (view === 'cont') {
    if (analyzeState.running || contState.generating) return void toast('请先等待或中止当前生成');
    const title = globalThis.prompt?.('续写项目标题', '新的续写会话');
    if (title === null) return;
    const cont = createContinuation(title || '');
    contState.activeActIdx = -1;
    analyzeState.result = null;
    setOpsProjOpen('cont', cont.id, true);
    renderAnalyzeUI();
    renderOpsTree();
    toast(`已新建续写项目《${cont.title}》`);
  } else if (view === 'novel') {
    if (novelState.generating) return void toast('请先等待或中止当前生成');
    const title = globalThis.prompt?.('小说标题', '我的新小说');
    if (title === null) return;
    const proj = createProject(title || '');
    novelState.activeActIdx = -1;
    setOpsProjOpen('novel', proj.id, true);
    renderNovelUI();
    renderOpsTree();
    toast(`已新建小说《${proj.title}》`);
  }
}

function opsDeleteProject() {
  const view = getStudioActiveView();
  if (view === 'cont') {
    if (analyzeState.running || contState.generating) return void toast('请先等待或中止当前生成');
    const c0 = getContinuation();
    if (!c0) return void toast('当前没有可删除的续写项目');
    if (!globalThis.confirm?.(`确定删除续写项目《${c0.title}》？此操作不可撤销。`)) return;
    if (analyzeState.pendingContId === c0.id) analyzeState.pendingContId = '';
    delete panelUiState.opsProjOpen[opsProjKey('cont', c0.id)];
    deleteContinuation(c0.id);
    contState.activeActIdx = -1;
    analyzeState.result = null;
    renderAnalyzeUI();
    renderOpsTree();
    toast('已删除续写项目');
  } else if (view === 'novel') {
    if (novelState.generating) return void toast('请先等待或中止当前生成');
    const proj = getActiveProject();
    if (!proj) return void toast('当前没有可删除的小说项目');
    if (!globalThis.confirm?.(`确定删除《${proj.title}》？此操作不可撤销。`)) return;
    delete panelUiState.opsProjOpen[opsProjKey('novel', proj.id)];
    deleteProject(proj.id);
    novelState.activeActIdx = -1;
    renderNovelUI();
    renderOpsTree();
    toast('已删除小说项目');
  }
}

/** 跳转到中间工作区对应章节/节并展开。 */
function jumpToWorkspaceChapter(mode, actIdx, secIdx = -1, projId = '') {
  const $ = globalThis.jQuery;
  if (!$) return;
  const ai = Number(actIdx);
  const si = Number(secIdx);
  if (!Number.isInteger(ai) || ai < 0) return;
  setStudioActiveView(mode, { syncNoun: true });
  const pid = String(projId || '');
  if (pid) {
    if (mode === 'cont' && getSettings().activeContinuationId !== pid) {
      getSettings().activeContinuationId = pid;
      saveSettings();
      renderAnalyzeUI();
    } else if (mode === 'novel' && getSettings().activeProjectId !== pid) {
      getSettings().activeProjectId = pid;
      saveSettings();
      renderNovelUI();
    }
  }
  const obj = mode === 'cont' ? getContinuation() : getActiveProject();
  if (!obj?.acts?.[ai]) return void toast('未找到对应章节');
  const oid = String(obj.id || pid || '');
  obj.acts[ai]._folded = false;
  setOpsProjOpen(mode, oid, true);
  setOpsTreeActOpen(mode, oid, ai, true);
  renderOpsTree();
  if (mode === 'cont') {
    contState.activeActIdx = ai;
    if (Number.isInteger(si) && si >= 0) contState.activeFlatIdx = flatSections(obj).find((f) => f.actIdx === ai && f.secIdx === si)?.flatIdx ?? -1;
    renderContinuationChapters();
  } else {
    novelState.activeActIdx = ai;
    if (Number.isInteger(si) && si >= 0) novelState.activeFlatIdx = flatSections(obj).find((f) => f.actIdx === ai && f.secIdx === si)?.flatIdx ?? -1;
    renderNovelChapters();
  }
  const rootSel = mode === 'cont' ? `#${EXT_ID}-analyze` : `#${EXT_ID}-novel`;
  setTimeout(() => {
    const $act = $(`${rootSel} .ns-act[data-a="${ai}"]`);
    if (!$act.length) return;
    let $target = $act;
    if (Number.isInteger(si) && si >= 0) {
      const $sec = $act.find(`.ns-section[data-s="${si}"]`);
      if ($sec.length) $target = $sec;
    }
    $(`${rootSel} .ns-jump-flash`).removeClass('ns-jump-flash');
    $target.addClass('ns-jump-flash');
    const body = $(`${rootSel} .ns-card__scroll`).get(0) || $(`#${PANEL_ID} .ns-panel__body`).get(0);
    const el = $target.get(0);
    if (body && el) {
      const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 20;
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    setTimeout(() => $target.removeClass('ns-jump-flash'), 1400);
  }, 60);
}

function bindOpsSidebarEvents($overlay) {
  if (panelUiState._opsBound) return;
  panelUiState._opsBound = true;
  const $ = globalThis.jQuery;

  $overlay.on('click', '[data-act="ops-view"]', function (e) {
    e.preventDefault();
    const view = String($(this).data('view') || '');
    const cur = getStudioActiveView();
    // 再次点击同一项 → 回到首页
    setStudioActiveView(cur === view ? '' : view);
  });

  $overlay.on('click', '[data-act="ops-proj-new"]', function (e) {
    e.preventDefault();
    opsCreateProject();
  });

  $overlay.on('click', '[data-act="ops-proj-del"]', function (e) {
    e.preventDefault();
    // 单击不删除，需双击
  });

  $overlay.on('dblclick', '[data-act="ops-proj-del"]', function (e) {
    e.preventDefault();
    opsDeleteProject();
  });

  $overlay.on('click', '[data-act="ops-proj-fold"]', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const mode = String($(this).data('mode') || '');
    const pid = String($(this).data('pid') || '');
    if ((mode !== 'cont' && mode !== 'novel') || !pid) return;
    setOpsProjOpen(mode, pid, !isOpsProjOpen(mode, pid));
    renderOpsTree();
  });

  $overlay.on('click', '[data-act="ops-proj-select"]', function (e) {
    e.preventDefault();
    const mode = String($(this).data('mode') || '');
    const pid = String($(this).data('pid') || '');
    if ((mode !== 'cont' && mode !== 'novel') || !pid) return;
    // 点击项目名：切换为当前项目并展开章节树
    selectOpsProject(mode, pid, { expand: true });
  });

  $overlay.on('click', '[data-act="ops-tree-fold"]', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const mode = String($(this).data('mode') || '');
    const pid = String($(this).data('pid') || '');
    const ai = Number($(this).data('a'));
    if ((mode !== 'cont' && mode !== 'novel') || !pid || !Number.isInteger(ai) || ai < 0) return;
    setOpsTreeActOpen(mode, pid, ai, !isOpsTreeActOpen(mode, pid, ai));
    renderOpsTree();
  });

  $overlay.on('click', '[data-act="ops-jump"]', function (e) {
    e.preventDefault();
    const mode = String($(this).data('mode') || '');
    const pid = String($(this).data('pid') || '');
    const ai = Number($(this).data('a'));
    const si = Number($(this).data('s'));
    if (mode !== 'cont' && mode !== 'novel') return;
    jumpToWorkspaceChapter(mode, ai, Number.isInteger(si) ? si : -1, pid);
  });
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
      <div class="ns-workspace">
      <aside id="${EXT_ID}-ops" class="ns-ops" aria-label="操作栏">
        <div class="ns-ops__nav" id="${EXT_ID}-ops-nav"></div>
        <div class="ns-ops__proj-bar" id="${EXT_ID}-ops-proj-bar" style="display:none;"></div>
        <div class="ns-ops__tree-wrap" id="${EXT_ID}-ops-tree-wrap">
          <div class="ns-ops__tree-head"><i class="fa-solid fa-folder-tree" style="margin-right:6px;"></i>项目管理</div>
          <div class="ns-ops__tree" id="${EXT_ID}-ops-tree"></div>
        </div>
      </aside>
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
          <div id="${EXT_ID}-home" class="ns-home">
            <div class="ns-home__mark"><i class="fa-solid fa-feather-pointed"></i></div>
            <div class="ns-home__title">Novel Studio</div>
            <p class="ns-home__sub ns-muted">从左侧选择功能开始创作</p>
          </div>
          <div id="${EXT_ID}-view-cont" class="ns-view" style="display:none;">
            <div class="ns-card" id="${EXT_ID}-analyze"></div>
          </div>
          <div id="${EXT_ID}-view-novel" class="ns-view" style="display:none;">
            <div class="ns-card" id="${EXT_ID}-novel"></div>
          </div>
          <div id="${EXT_ID}-view-keyword" class="ns-view" style="display:none;">
            <div class="ns-card" id="${EXT_ID}-keyword">
              <div class="ns-card__head">
                <h4>全局提示词</h4>
                <label class="ns-switch" title="启用后作为系统引导词注入每次生成">
                  <input type="checkbox" id="${EXT_ID}-kw-enabled" /><span>启用注入</span>
                </label>
              </div>
              <p class="ns-muted">作为所有 AI 生成内容的引导词, 以系统角色注入每次生成。</p>
              <textarea id="${EXT_ID}-kw-text" class="ns-textarea" rows="8" placeholder="例如: 保持第三人称叙述, 文风冷峻…"></textarea>
              <div class="ns-row"><button class="ns-btn" id="${EXT_ID}-kw-save">保存</button><span class="ns-muted" id="${EXT_ID}-kw-hint"></span></div>
            </div>
          </div>
          <div id="${EXT_ID}-view-idea" class="ns-view" style="display:none;">
            <div class="ns-card" id="${EXT_ID}-idea"></div>
          </div>
        </div>
        <div class="ns-panel__footer"><span class="ns-muted">${EXT_NAME}</span></div>
      </div>
      <aside id="${EXT_ID}-noun-board" class="ns-noun-board" aria-label="名词库复制板">
        <div class="ns-noun-board__head">
          <strong><i class="fa-solid fa-tags" style="margin-right:6px;"></i>名词库</strong>
          <button type="button" class="ns-btn ns-btn--icon ns-btn--sm" data-act="noun-refresh" title="刷新"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <p class="ns-muted ns-noun-board__hint">单击复制 · 双击展开详情</p>
        <div class="ns-noun-board__modes" id="${EXT_ID}-noun-modes"></div>
        <div class="ns-noun-board__toggles" id="${EXT_ID}-noun-toggles"></div>
        <div class="ns-noun-board__tags" id="${EXT_ID}-noun-tags"></div>
        <div class="ns-noun-board__detail" id="${EXT_ID}-noun-detail" style="display:none;"></div>
      </aside>
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
    toast('全局提示词已保存');
  });
  $(`#${EXT_ID}-kw-enabled`).on('change', () => {
    getSettings().keywordEnabled = $(`#${EXT_ID}-kw-enabled`).is(':checked');
    saveSettings();
    refreshGlobalKeyword();
  });

  bindOpsSidebarEvents($overlay);
  bindNounBoardEvents($overlay);

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

/** 兼容旧调用：改为应用左侧操作栏视图。 */
function applyModuleFoldState() {
  applyStudioView(getStudioActiveView());
  renderOpsNav();
  renderOpsTree();
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
  applyStudioView(getStudioActiveView());
  renderOpsNav();
  renderOpsTree();
  renderNounBoard();
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

/** 章节全文查看弹窗；未锁定可编辑，底部固定「编辑 / 保存」，有改动时显示「撤销」。 */
function showSectionTextViewer({
  title,
  content = '',
  locked = false,
  onSave = null,
} = {}) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const ID = `${EXT_ID}-viewer`;
  $(`#${ID}`).remove();

  let baseline = String(content || '');
  let draft = baseline;
  let editing = false;

  const $v = $(`
    <div id="${ID}" class="ns-viewer">
      <div class="ns-viewer__box">
        <div class="ns-viewer__head">
          <strong class="ns-viewer__title">${esc(title)}</strong>
          <span class="ns-muted ns-viewer__meta" data-role="meta">共 ${baseline.length} 字${locked ? ' · 已锁定只读' : ''}</span>
          <button type="button" class="ns-btn ns-btn--icon" data-close="1" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ns-viewer__body" data-role="body"></div>
        <div class="ns-viewer__foot">
          <button type="button" class="ns-btn ns-btn--sm" data-role="edit" ${locked ? 'disabled' : ''} title="${locked ? '已锁定，不可编辑' : '编辑正文'}">编辑</button>
          <button type="button" class="ns-btn ns-btn--sm" data-role="save" ${locked ? 'disabled' : ''} title="${locked ? '已锁定，不可保存' : '保存修改'}">保存</button>
          <button type="button" class="ns-btn ns-btn--sm ns-btn--ghost" data-role="undo" style="display:none;" title="撤销未保存的修改">撤销</button>
          ${locked ? '<span class="ns-muted">已锁定节仅可查看</span>' : '<span class="ns-muted ns-viewer__hint">编辑后可保存；有未保存改动时显示撤销</span>'}
        </div>
      </div>
    </div>`);

  const $body = $v.find('[data-role="body"]');
  const $meta = $v.find('[data-role="meta"]');
  const $undo = $v.find('[data-role="undo"]');
  const $edit = $v.find('[data-role="edit"]');
  const $save = $v.find('[data-role="save"]');

  function readDraft() {
    if (editing) {
      const v = $body.find('textarea').val();
      if (v != null) draft = String(v);
    }
    return draft;
  }

  function isDirty() {
    return readDraft() !== baseline;
  }

  function paintMeta(text) {
    $meta.text(`共 ${String(text || '').length} 字${locked ? ' · 已锁定只读' : ''}`);
  }

  function syncUndo() {
    if (locked) {
      $undo.hide();
      return;
    }
    if (isDirty()) $undo.show();
    else $undo.hide();
  }

  function renderView() {
    editing = false;
    draft = baseline;
    $body.html(`<div class="ns-viewer__readonly">${esc(baseline).replace(/\n/g, '<br>')}</div>`);
    $edit.prop('disabled', !!locked);
    paintMeta(baseline);
    syncUndo();
  }

  function renderEdit() {
    if (locked) return;
    readDraft();
    editing = true;
    $body.html(
      `<textarea class="ns-viewer__textarea" spellcheck="false"></textarea>`,
    );
    const $ta = $body.find('textarea');
    $ta.val(draft);
    $ta.on('input', () => {
      draft = String($ta.val() ?? '');
      paintMeta(draft);
      syncUndo();
    });
    $ta.trigger('focus');
    paintMeta(draft);
    syncUndo();
  }

  $edit.on('click', (e) => {
    e.stopPropagation();
    if (locked) return void toast('已锁定，不可编辑');
    renderEdit();
  });

  $save.on('click', async (e) => {
    e.stopPropagation();
    if (locked) return void toast('已锁定，不可保存');
    if (!editing) renderEdit();
    const text = readDraft();
    if (text === baseline) {
      toast('内容未变化');
      return;
    }
    try {
      if (typeof onSave === 'function') await onSave(text);
      baseline = text;
      draft = text;
      toast('已保存');
      renderView();
    } catch (err) {
      toast(`保存失败: ${err?.message || err}`);
    }
  });

  $undo.on('click', (e) => {
    e.stopPropagation();
    if (locked) return;
    if (!isDirty()) return;
    if (!globalThis.confirm?.('撤销未保存的修改，恢复为上次保存的内容？')) return;
    draft = baseline;
    if (editing) {
      $body.find('textarea').val(baseline);
      paintMeta(baseline);
      syncUndo();
    } else {
      renderView();
    }
    toast('已撤销');
  });

  $v.on('click', (e) => {
    if (e.target.id === ID || $(e.target).closest('[data-close]').length) {
      if (!locked && isDirty()) {
        if (!globalThis.confirm?.('有未保存的修改，确定关闭？')) return;
      }
      $v.remove();
    }
  });

  $('body').append($v);
  renderView();
}

/** @deprecated 简单只读查看；节正文请用 showSectionTextViewer */
function showViewer(title, content) {
  showSectionTextViewer({ title, content, locked: true });
}

function showSectionViewer(ai, si, content, opts = {}) {
  showSectionTextViewer({
    title: `第 ${ai + 1} 章 第 ${si + 1} 节 全文`,
    content,
    locked: !!opts.locked,
    onSave: opts.onSave,
  });
}

/* ---------------------------- 续写: 上传分析 UI ---------------------------- */

function renderAnalyzeUI() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $root = $(`#${EXT_ID}-analyze`);
  if (!$root.length) return;
  const s = getSettings();
  const cont = getContinuation();
  const dockHtml = buildContWorkspaceDockHtml(cont);
  // 分析进行中保持上传区展开，便于看进度
  if (analyzeState.running) setUiOpen('ct-upload', true);

  $root.addClass('ns-card--docked').html(`
    <div class="ns-card__scroll">
      <div class="ns-work-section ns-work-section--upload">
        <div class="ns-collapse ns-collapse--edit">
          <div class="ns-collapse__head" data-act="az-toggle" data-fold-key="ct-upload" title="展开/折叠上传分析">
            <i class="fa-solid fa-chevron-right ${foldIconClass('ct-upload')}"></i>
            <strong class="ns-collapse__title">上传分析</strong>
            <span class="ns-collapse__sep" aria-hidden="true"></span>
            <span class="ns-muted ns-work-section__hint">上传 txt · 分段分析</span>
          </div>
          <div class="ns-collapse__body ns-collapse__body--edit"${foldBodyStyle('ct-upload')}>
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
            <div class="ns-field" id="${EXT_ID}-az-progress-wrap" style="${
              analyzeState.running || analyzeState.progressMsg ? '' : 'display:none;'
            }">
              <div class="ns-progress"><div class="ns-progress__bar" id="${EXT_ID}-az-bar" style="width:${Math.max(0, Math.min(100, Number(analyzeState.progressPct) || 0))}%"></div></div>
              <div class="ns-muted" id="${EXT_ID}-az-hint">${esc(analyzeState.progressMsg || '')}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="ns-field" id="${EXT_ID}-az-result">${renderAnalyzeResult()}</div>
    </div>
    <div class="ns-workspace-dock" id="${EXT_ID}-cont-dock">${dockHtml}</div>
  `);
  _contDragAttach?.(); // 整块重绘后重新绑定拖拽
  renderNounBoard();
  renderOpsTree();
}

function renderAnalyzeResult() {
  const cont = getContinuation();
  if (!cont && !analyzeState.result) return '';
  // 以当前会话为编辑源；刚分析完时把结构化结果写入会话（runAnalysis 已写入）
  const r = cont || analyzeState.result;
  if (cont) ensureContProfiles(cont);
  else if (analyzeState.result) {
    // 无会话时仅展示（极少见）
    analyzeState.result.charProfiles = Array.isArray(analyzeState.result.charProfiles)
      ? analyzeState.result.charProfiles.map((c) => makeContCharProfile(c))
      : migrateLegacyCharString(analyzeState.result.characters);
    analyzeState.result.plotProfile = analyzeState.result.plotProfile
      ? makeContPlotProfile(analyzeState.result.plotProfile)
      : migrateLegacyPlotString(analyzeState.result.plot);
  }
  const profileSrc = cont || analyzeState.result;
  const when = r.analyzedAt ? new Date(r.analyzedAt).toLocaleString() : '';
  const wiName = cont?.worldBookName || '';
  return `
    <div class="ns-result">
      <div class="ns-result__meta ns-muted">分析结果 · ${esc(r.title || '')} · ${r.totalChars || 0} 字${when ? ` · ${esc(when)}` : ''}</div>
      <div class="ns-collapse ns-collapse--profile">
        <div class="ns-collapse__head" data-act="az-toggle" data-fold-key="ct-chars">
          <i class="fa-solid fa-chevron-right ${foldIconClass('ct-chars')}"></i>
          <strong class="ns-collapse__title">角色档案（分阶段）</strong>
          <span class="ns-collapse__sep" aria-hidden="true"></span>
          <button type="button" class="ns-btn ns-btn--sm ns-collapse__action" data-act="ct-char-add" title="新增一名角色档案"><i class="fa-solid fa-plus"></i> 添加角色</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--profile"${foldBodyStyle('ct-chars')}>
          ${renderContCharProfilesUI(profileSrc)}
        </div>
      </div>
      <div class="ns-collapse ns-collapse--profile">
        <div class="ns-collapse__head" data-act="az-toggle" data-fold-key="ct-plot">
          <i class="fa-solid fa-chevron-right ${foldIconClass('ct-plot')}"></i>
          <strong class="ns-collapse__title">剧情梗概（表格）</strong>
          <span class="ns-collapse__sep" aria-hidden="true"></span>
          <button type="button" class="ns-btn ns-btn--sm ns-collapse__action" data-act="ct-faction-add" title="新增一个势力组织"><i class="fa-solid fa-plus"></i> 添加组织</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--profile"${foldBodyStyle('ct-plot')}>
          ${renderContPlotProfileUI(profileSrc)}
        </div>
      </div>
      <div class="ns-row" style="margin-top:6px; flex-wrap:wrap; gap:6px; align-items:center;">
        <button type="button" class="ns-btn ns-btn--sm" data-act="ct-save-profile" title="保存角色档案与剧情梗概表格">保存档案</button>
        <button type="button" class="ns-btn ns-btn--sm" data-act="ct-sync-wi" title="将角色档案与剧情梗概同步为酒馆世界书">
          <i class="fa-solid fa-book"></i> 同步至世界书
        </button>
        ${wiName
          ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-del-wi" title="删除本续写绑定的世界书"><i class="fa-solid fa-trash"></i> 删除世界书</button>`
          : ''}
        <button type="button" class="ns-btn ns-btn--sm" data-act="ct-import-wi" title="从酒馆世界书导入角色档案与剧情/势力">
          <i class="fa-solid fa-file-import"></i> 从世界书导入
        </button>
      </div>
      <p class="ns-muted" style="margin-top:4px;">
        ${wiName
          ? `已绑定世界书：${esc(wiName)}（按大纲/自然续写生成时会扫描注入；自然续写极简重试轮次除外）`
          : '同步后将创建/覆盖一本专用世界书；续写生成时会按酒馆接口扫描并注入。'}
      </p>
    </div>
    ${renderContinuationUI()}
  `;
}

/** 续写章-节列表 HTML(仅按大纲模式可编辑章节结构; 自然模式只读)。 */
function contChapterListHtml(cont) {
  const mode = cont.mode || 'outline';
  const flat = flatSections(cont);
  const flatByAS = {};
  flat.forEach((f) => (flatByAS[`${f.actIdx}_${f.secIdx}`] = f.flatIdx));
  const genThisSet = new Set(resolveGenThisTargets(cont, 2).map((f) => f.flatIdx));
  const batchPending = mode === 'free' && !!cont.pendingFreeOutlineBatch;
  const batchStart = Math.max(0, Number(cont.freeBatchStartAct) || 0);
  const batchCount = Math.max(0, Number(cont.freeBatchActCount) || 0);
  const bp = mode === 'free' && cont.freeBreakpoint ? cont.freeBreakpoint : null;

  const actsHtml = (cont.acts || [])
    .map((act, ai) => {
      const pendingOl =
        batchPending && ai >= batchStart && ai < batchStart + batchCount;
      const isBpAct =
        !!bp &&
        ['title', 'live', 'summary'].includes(String(bp.phase || '')) &&
        Number(bp.actIdx) === ai;
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const working = isSectionWorking('cont', flatIdx);
          const summarizing = working && genUiProgress.phase === 'summary';
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = working ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          // 自然续写不再挂起确认总结；仅大纲模式显示「待确认」
          const pendingSum = mode === 'outline' && !!sec.pendingLiveSummary && valid;
          const outlining = working && /大纲/.test(genUiProgress.statusMsg || '');
          const hasOutlineText = String(sec.outline || '').trim();
          const locked = mode === 'free' ? isFreeSectionLocked(sec) : isSectionLocked(sec);
          const olLocked = mode === 'free' ? locked : isOutlineLocked(sec);
          // 已生成节之后连续最多 2 个空节显示「生成本节」
          const showGenThis =
            genThisSet.has(flatIdx) &&
            !pendingSum &&
            !locked &&
            !(contState.generating && !working);
          const isBpSec =
            !!bp &&
            (bp.phase === 'outline' || bp.phase === 'body') &&
            Number(bp.actIdx) === ai &&
            Number(bp.secIdx) === si;
          const tag = working
            ? `<span class="ns-tag ns-tag--gen">${summarizing ? '总结中' : outlining ? '大纲中' : '生成中'}</span>`
            : isBpSec
              ? `<span class="ns-tag ns-tag--breakpoint">断点·待继续</span>`
              : pendingSum
                ? `<span class="ns-tag ns-tag--pending">待确认总结</span>`
                : valid
                  ? `<span class="ns-tag ns-tag--done">已生成</span>`
                  : locked && mode === 'free' && hasOutlineText
                    ? `<span class="ns-tag ns-tag--pending">已锁定</span>`
                    : hasOutlineText
                      ? `<span class="ns-tag ns-tag--pending">有大纲</span>`
                      : sec.done
                        ? `<span class="ns-tag">空回·待重生</span>`
                        : `<span class="ns-tag">未生成</span>`;
          const olRows = 1;
          const outlineField = `<textarea class="ns-ct-sec-outline ${
            mode === 'free' || hasOutlineText ? 'ns-ct-sec-outline--block' : ''
          } ${hasOutlineText ? 'ns-ct-sec-outline--expanded' : ''} ${olLocked ? 'ns-ct-sec-outline--locked' : ''}" data-a="${ai}" data-s="${si}" rows="${olRows}" ${
            olLocked ? 'readonly' : ''
          } placeholder="${
            mode === 'free' ? '本节大纲（自然续写先生成此处）…' : '本节大纲…'
          }">${esc(sec.outline || '')}</textarea>`;
          const dragHandle = mode === 'outline' && !locked ? `<span class="ns-drag-handle" title="拖拽排序"><i class="fa-solid fa-grip-lines"></i></span>` : (locked ? '<span class="ns-lock-icon" title="已锁定"><i class="fa-solid fa-lock"></i></span>' : '');
          const lockBtn =
            mode === 'free'
              ? `<button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${
                  locked ? 'ct-free-unlock' : 'ct-free-lock'
                }" data-a="${ai}" data-s="${si}" title="${
                  locked ? '解锁本节及之后（大纲+正文）' : '锁定本节及之前（大纲+正文）'
                }"><i class="fa-solid fa-${locked ? 'lock' : 'lock-open'}"></i></button>`
              : `<button class="ns-btn ns-btn--icon ns-btn--sm ${locked ? 'ns-btn--ghost' : ''}" data-act="${
                  locked ? 'ct-sec-unlock' : 'ct-sec-lock'
                }" data-a="${ai}" data-s="${si}" title="${
                  locked ? '解锁本节及之后所有节' : '锁定本节及之前所有节'
                }"><i class="fa-solid fa-${locked ? 'lock-open' : 'lock'}"></i></button>`;
          const bpBtn =
            isBpSec && !contState.generating
              ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--breakpoint" data-act="ct-free-resume" title="从该失败点继续生成本批">断点继续</button>
                 <button type="button" class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-free-skip-bp" title="删除断点并跳过本节，从下一节继续">跳过并删除此断点</button>`
              : '';
          return `
            <div class="ns-section ${working ? 'ns-chapter--gen' : ''} ${pendingSum ? 'ns-section--pending-sum' : ''} ${locked ? 'ns-sec-locked' : ''} ${olLocked ? 'ns-sec-ol-locked' : ''} ${isBpSec ? 'ns-sec-breakpoint' : ''}" data-a="${ai}" data-s="${si}">
              <div class="ns-chapter__head">
                ${dragHandle}
                <strong>第 ${si + 1} 节</strong>${tag}
              </div>
              ${outlineField}
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${bpBtn}
                ${pendingSum ? `<button class="ns-btn ns-btn--sm ns-btn--confirm-sum" data-act="ct-confirm-live-sum" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''} title="确认后更新动态大总结，并自动续写下一节">确认总结</button>` : ''}
                ${!locked && valid && !showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''} title="${mode === 'free' ? '只重新生成正文，大纲不变' : '重新生成本节'}">重新生成</button>` : ''}
                ${!locked && showGenThis ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>生成本节</button>` : ''}
                ${working ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-stop" title="中止当前大纲/正文/总结">${summarizing ? '中止总结' : outlining ? '中止大纲' : '中止'}</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  ${lockBtn}
                  ${!locked && sec.content ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--ghost" data-act="ct-sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文"><i class="fa-solid fa-broom"></i></button>` : ''}
                  ${!locked ? `<button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-sec-del" data-a="${ai}" data-s="${si}" title="删除本节"><i class="fa-solid fa-trash"></i></button>` : ''}
                </span>
              </div>
            </div>`;
        })
        .join('');

      const actEditable = `<input type="text" class="ns-ct-act-title" data-a="${ai}" value="${esc(act.title || '')}" placeholder="章标题" />
             <button class="ns-btn ns-btn--icon ns-btn--sm" data-act="ct-act-del" data-a="${ai}" title="删除本章"><i class="fa-solid fa-trash"></i></button>`;
      const overviewField =
        mode === 'outline'
          ? `<textarea class="ns-textarea ns-ct-act-overview" data-a="${ai}" rows="2" placeholder="章总览：本章走向（生成节时预读）">${esc(act.overview || '')}</textarea>`
          : act.overview
            ? `<div class="ns-muted">章总览：${esc(act.overview)}</div>`
            : '';
      const addSecBtn = mode === 'outline' ? `<div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="ct-sec-add" data-a="${ai}"><i class="fa-solid fa-plus"></i> 添加节</button></div>` : '';
      const folded = isActFolded(act);
      const bpActBtn =
        isBpAct && !contState.generating
          ? `<div class="ns-free-ol-confirm ns-row" style="flex-wrap:wrap;gap:8px;align-items:center;">
              <button type="button" class="ns-btn ns-btn--breakpoint" data-act="ct-free-resume" title="从该失败点继续">断点继续（${
                bp.phase === 'title' ? '章标题' : bp.phase === 'live' ? '大总结' : '表格总结'
              }）</button>
              <button type="button" class="ns-btn ns-btn--ghost" data-act="ct-free-skip-bp" title="删除断点并跳过，进入下一阶段">跳过并删除此断点</button>
              <span class="ns-muted">${esc(formatFreeBreakpointHint(bp))}</span>
            </div>`
          : '';
      return `
        <div class="ns-act ${folded ? 'ns-act--folded' : ''} ${pendingOl ? 'ns-act--pending-ol' : ''} ${isBpAct ? 'ns-act--breakpoint' : ''}" data-a="${ai}">
          <div class="ns-act__head">
            <button class="ns-btn ns-btn--icon ns-btn--sm ns-act-fold" data-act="ct-act-fold" data-a="${ai}" title="折叠/展开本章"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'} ns-act-fold__icon"></i></button>
            <strong>第 ${ai + 1} 章</strong>${actEditable}
            <span class="ns-tag ${isActComplete(act) ? 'ns-tag--done' : pendingOl ? 'ns-tag--pending' : isBpAct ? 'ns-tag--breakpoint' : ''}">${
              pendingOl
                ? '待确认大纲'
                : isBpAct
                  ? '断点·待继续'
                  : `${(act.sections || []).filter((s) => hasValidSectionContent(s)).length}/${(act.sections || []).length} 节`
            }</span>
          </div>
          <div class="ns-act__body" ${folded ? 'style="display:none;"' : ''}>
            ${overviewField}
            <div class="ns-sections">${secHtml || '<p class="ns-muted">本章暂无节。</p>'}</div>
            ${bpActBtn}
            ${addSecBtn}
          </div>
        </div>`;
    })
    .join('');

  const freeBatchConfirm = batchPending
    ? `<div class="ns-free-ol-confirm ns-row" style="flex-wrap:wrap;gap:8px;align-items:center;">
        <button type="button" class="ns-btn" data-act="ct-confirm-free-outlines" title="确认大纲后，从全书第一个无正文的节开始写（含锁定无正文节，不限本批）">确认全部大纲并写正文</button>
        <button type="button" class="ns-btn ns-btn--ghost" data-act="ct-append-free-outlines" title="按当前「章/节」设定再追加一批大纲，确认前不写正文">再拟一批大纲</button>
        <button type="button" class="ns-btn ns-btn--ghost" data-act="ct-regen-free-outlines" title="重新生成未锁定的大纲（已锁定的保留）">重新生成未锁定大纲</button>
        <span class="ns-muted">可多批只拟大纲；满意后点确认，再一次性写全部正文。可用锁图标锁定满意的节。</span>
      </div>`
    : '';

  const freeBpBar =
    !batchPending && bp && !contState.generating
      ? `<div class="ns-free-breakpoint-bar ns-row" style="flex-wrap:wrap;gap:8px;align-items:center;">
          <button type="button" class="ns-btn ns-btn--breakpoint" data-act="ct-free-resume">断点继续</button>
          <button type="button" class="ns-btn ns-btn--ghost" data-act="ct-free-skip-bp" title="删除断点并跳过失败处，从下一节继续">跳过并删除此断点</button>
          <span class="ns-muted">${esc(formatFreeBreakpointHint(bp))}</span>
        </div>`
      : '';

  return actsHtml + freeBatchConfirm + freeBpBar;
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
    fitContSecOutlineTextareas(`#${EXT_ID}-analyze`);
  }
  const $dock = $(`#${EXT_ID}-cont-dock`);
  if ($dock.length) $dock.html(buildContWorkspaceDockHtml(cont));
  renderOpsTree();
}

/** 从 DOM 收集续写章-节结构：标题始终收；大纲模式另收章总览；节大纲两种模式都收（自然续写两步会写入）。 */
function collectContActsFromDOM(cont) {
  const $ = globalThis.jQuery;
  if (!$ || !cont) return;
  const mode = cont.mode || 'outline';
  $(`#${EXT_ID}-analyze .ns-act`).each(function () {
    const ai = Number($(this).attr('data-a'));
    if (!Number.isInteger(ai) || !cont.acts[ai]) return;
    const act = cont.acts[ai];
    const t = $(this).find('.ns-ct-act-title').first().val();
    if (t != null) act.title = String(t);
    if (mode === 'outline') {
      const ov = $(this).find('.ns-ct-act-overview').first().val();
      if (ov != null) act.overview = String(ov);
    }
    $(this)
      .find('.ns-section')
      .each(function () {
        const si = Number($(this).attr('data-s'));
        const sec = Number.isInteger(si) ? act.sections[si] : null;
        if (!sec) return;
        const o = $(this).find('.ns-ct-sec-outline').first().val();
        if (o != null) {
          const skipOutlineEdit =
            isOutlineLocked(sec) || ((cont.mode || 'outline') === 'free' && isSectionLocked(sec));
          if (!skipOutlineEdit) sec.outline = String(o);
        }
      });
  });
  saveContinuation();
}

function buildContWorkspaceDockHtml(cont) {
  if (!cont) return '';
  const mode = cont.mode || 'outline';
  const doneSec = contDoneCount(cont);
  if (mode === 'outline') {
    return `<div class="ns-row ns-workspace-dock__row">
      <button class="ns-btn ns-btn--sm" data-act="ct-save-acts">保存大纲</button>
      <button class="ns-btn" data-act="ct-outline-manual" ${contState.generating ? 'disabled' : ''} title="逐节续写：写完后需点「确认总结」，再自动续写下一节">手动续写（逐节确认）</button>
      <button class="ns-btn" data-act="ct-outline-auto" ${contState.generating ? 'disabled' : ''}>自动续写（全部）</button>
      ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-outline-regen" ${contState.generating ? 'disabled' : ''}>全部重新生成</button>` : ''}
      ${contState.generating ? `<button type="button" class="ns-btn ns-btn--danger" data-act="ct-stop" title="中止当前生成">中止</button>` : ''}
      <button class="ns-btn ns-btn--danger" data-act="ct-clear" ${doneSec > 0 && !contState.generating ? '' : 'disabled'} title="清除已生成正文（大纲与总结保留）">清除生成内容</button>
      <button class="ns-btn ns-btn--ghost" data-act="ct-export" ${doneSec ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 导出续写(txt)</button>
    </div>`;
  }
  ensureContFreeBatch(cont);
  const hasFreeBp = !!(cont.freeBreakpoint && cont.freeBreakpoint.phase);
  return `<div class="ns-row ns-workspace-dock__row">
    <label class="ns-muted" title="每次点击按此数量追加一批">
      本批续写
      <input type="number" id="${EXT_ID}-ct-free-acts" class="ns-num" value="${cont.targetActs}" min="1" max="200" />章 /
      <input type="number" id="${EXT_ID}-ct-free-secs" class="ns-num" value="${cont.targetSecsPerAct}" min="1" max="50" />节
    </label>
    <button class="ns-btn" data-act="ct-free-start" ${contState.generating ? 'disabled' : ''}>${doneSec > 0 ? '继续自然续写' : '开始自然续写'}</button>
    ${hasFreeBp && !contState.generating ? `<button type="button" class="ns-btn ns-btn--breakpoint" data-act="ct-free-resume" title="${esc(formatFreeBreakpointHint(cont.freeBreakpoint))}">断点继续</button>` : ''}
    ${hasFreeBp && !contState.generating ? `<button type="button" class="ns-btn ns-btn--ghost" data-act="ct-free-skip-bp" title="删除断点并跳过失败处，从下一节继续">跳过并删除此断点</button>` : ''}
    ${doneSec > 0 ? `<button class="ns-btn ns-btn--ghost" data-act="ct-free-regen" ${contState.generating ? 'disabled' : ''}>全部重新生成</button>` : ''}
    ${contState.generating ? `<button type="button" class="ns-btn ns-btn--danger" data-act="ct-stop" title="中止大纲或正文生成">中止</button>` : ''}
    <button class="ns-btn ns-btn--danger" data-act="ct-clear" ${doneSec > 0 && !contState.generating ? '' : 'disabled'} title="清除已生成章节、总结与剧情链（档案/基调保留）">清除生成内容</button>
    <button class="ns-btn ns-btn--ghost" data-act="ct-export" ${doneSec ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 导出续写(txt)</button>
  </div>`;
}

function buildNovelWorkspaceDockHtml(proj) {
  if (!proj) return '';
  const done = doneSectionCount(proj);
  const total = totalSectionCount(proj);
  return `<div class="ns-row ns-workspace-dock__row">
    <button class="ns-btn ns-btn--sm" data-act="save-outline" title="仅保存章-节大纲">保存大纲</button>
    <button class="ns-btn" data-act="mode-manual" title="逐节生成：写完后需点「确认总结」，再自动写下一节">手动模式（逐节确认）</button>
    <button class="ns-btn" data-act="mode-auto" title="一次性生成所有未完成节">自动模式（全部生成）</button>
    <button class="ns-btn ns-btn--danger" data-act="nv-clear" ${done ? '' : 'disabled'} title="清除已生成正文（大纲与总结保留）">清除生成内容</button>
    <button class="ns-btn ns-btn--ghost" data-act="export" ${done ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 一键导出(txt)</button>
    <span class="ns-muted">进度：${done}/${total} 节</span>
    <span class="ns-muted" id="${EXT_ID}-nv-hint"></span>
  </div>`;
}

function renderContinuationUI() {
  const cont = getContinuation();
  if (!cont) return '';
  const mode = cont.mode || 'outline';
  const doneSec = contDoneCount(cont);
  const chapterList = contChapterListHtml(cont);

  ensureContFreeBatch(cont);
  if (typeof cont.freeTone !== 'string') cont.freeTone = '';
  ensureContFreePlotSpeed(cont);
  const plotSpeed = readContFreePlotSpeed(cont);
  const hasFreeBp = !!(cont.freeBreakpoint && cont.freeBreakpoint.phase);
  const freeSettings = mode === 'free'
    ? `
    <div class="ns-field" style="margin:8px 0;">
      <label>续写基调 <span class="ns-muted">（可写剧情走向与氛围；建议 300 字内，过长会保留前段）</span></label>
      <textarea id="${EXT_ID}-ct-free-tone" class="ns-textarea" rows="3" placeholder="例如：压抑冷峻；本批把误会写完再和解；或：感情线只升温、结局留给下一批…">${esc(cont.freeTone || '')}</textarea>
    </div>
    <div class="ns-row ns-free-plot-speed" style="flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px;">
      <span class="ns-muted" title="慢速≥20、中等≥10、快速≥5节；跨章且跨批次累计后才可收束开新">剧情速度</span>
      <div class="ns-seg" role="group" aria-label="剧情速度">
        <button type="button" class="ns-seg__btn ${plotSpeed === 'slow' ? 'ns-seg__btn--active' : ''}" data-act="ct-free-speed" data-speed="slow" ${contState.generating ? 'disabled' : ''} title="细节深化；跨章跨批累计至少20节后才可收束开新">慢速</button>
        <button type="button" class="ns-seg__btn ${plotSpeed === 'medium' ? 'ns-seg__btn--active' : ''}" data-act="ct-free-speed" data-speed="medium" ${contState.generating ? 'disabled' : ''} title="常规节奏；跨章跨批累计至少10节后才可收束开新">中等</button>
        <button type="button" class="ns-seg__btn ${plotSpeed === 'fast' ? 'ns-seg__btn--active' : ''}" data-act="ct-free-speed" data-speed="fast" ${contState.generating ? 'disabled' : ''} title="每节快推；跨章跨批累计至少5节后才可收束开新">快速</button>
      </div>
    </div>
    ${hasFreeBp ? `<p class="ns-muted ns-free-breakpoint-hint">${esc(formatFreeBreakpointHint(cont.freeBreakpoint))}</p>` : ''}
    <p class="ns-muted">「x章/y节」= 每批追加数量。收束开新须跨章且跨批次累计节数：慢速≥20、中等≥10、快速≥5；新开一批不会清零。可先多批只拟大纲；确认后从全书第一个无正文的节起写。</p>`
    : '';

  const summaryList = (cont.summaries || []).length
    ? cont.summaries.map((s) => renderSummaryTable(s, 'ct-sum')).join('')
    : '';
  const showSumPanel =
    doneSec > 0 ||
    !!summaryList ||
    contState.generating ||
    normalizePlotChain(cont.plotChain).length > 0 ||
    !!cont.liveProgress;

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
        <div class="ns-chapters">${chapterList || '<p class="ns-muted">尚无续写内容。按大纲续写请点下方「添加章」。</p>'}</div>
        ${mode === 'outline' ? `<div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="ct-act-add"><i class="fa-solid fa-plus"></i> 添加章</button></div>` : ''}
      </div>
      ${freeSettings}
      ${showSumPanel ? `
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="ct-summaries">
          <i class="fa-solid fa-chevron-right ${foldIconClass('ct-summaries')}"></i>
          <strong>整章表格总结（记忆）</strong>
        </div>
        <div class="ns-row" style="padding:4px 10px 0;flex-wrap:wrap;gap:6px;">
          <button class="ns-btn ns-btn--sm" data-act="ct-resum" ${contState.generating ? 'disabled' : ''} title="重新生成各章表格总结，不动大总结">章节总结</button>
          <button class="ns-btn ns-btn--sm" data-act="ct-redyn" ${contState.generating ? 'disabled' : ''} title="仅按正文分段重建剧情链与人物链，不动章总结">重新动态总结</button>
          ${contState.generating ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-stop" title="中止当前大纲/正文/总结">中止</button>` : ''}
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-clear-sum" ${contState.generating ? 'disabled' : ''} title="清空章节总结与动态大总结">清空总结</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--summary"${foldBodyStyle('ct-summaries')}>
          ${summaryBarHtml('cont')}
          ${grandSummaryHtml(cont, 'ct-grand')}
          <div class="ns-summaries">${summaryList}</div>
        </div>
      </div>` : ''}
    </div>`;
}

function setContHint(msg, busy) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const raw = String(msg || '').trim();
  // 中止类提示只写顶栏，绝不灌进节内进度条（否则会卡在「正在中止」）
  if (/^(已中止|正在中止)/.test(raw)) {
    $(`#${EXT_ID}-ct-hint`).text(raw.endsWith('。') || raw.endsWith('…') ? raw : `${raw}。`);
    return;
  }
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

  // 节大纲输入时按内容紧贴高度
  $root.on('input', '.ns-ct-sec-outline', function () {
    const el = this;
    const val = String(el.value || '');
    if (!val.trim()) {
      el.rows = 1;
      el.style.height = '';
      el.classList.remove('ns-ct-sec-outline--expanded');
      return;
    }
    el.classList.add('ns-ct-sec-outline--block', 'ns-ct-sec-outline--expanded');
    el.rows = 1;
    el.style.height = '0px';
    el.style.overflow = 'hidden';
    const h = Math.min(Math.max(el.scrollHeight, 22), 360);
    el.style.height = `${h}px`;
    el.style.overflow = h >= 360 ? 'auto' : 'hidden';
  });

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
    if (analyzeState.running || contState.generating) {
      toast('请先等待或中止当前生成');
      this.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      analyzeState.uploadedText = content;
      analyzeState.uploadedName = file.name;
      analyzeState.result = null;
      // 按上传文件名作为标题；与当前项目同名则归属当前项目，不新开
      const title = inferUploadedNovelTitle(content, file.name);
      const cur = getContinuation();
      const reuse = cur && titlesMatchProject(cur.title, title);
      const cont = reuse ? cur : createContinuation(title);
      const tailN = getSettings().contextTailChars || 2500;
      if (!reuse) cont.title = title;
      cont.sourceTail = content.slice(Math.max(0, content.length - tailN));
      cont.totalChars = content.length;
      saveContinuation();
      analyzeState.pendingContId = cont.id;
      getSettings().activeContinuationId = cont.id;
      saveSettings();
      contState.activeActIdx = -1;
      if (reuse) {
        log.info('已读取文件并归属当前续写项目:', file.name, content.length, '字', cont.id, cont.title);
        toast(`已上传至当前项目《${cont.title || title}》`);
      } else {
        log.info('已读取文件并新建续写项目:', file.name, content.length, '字', cont.id, title);
        toast(`已上传并新建续写项目《${title}》`);
      }
      renderAnalyzeUI();
      $(`#${EXT_ID}-az-fileinfo`).text(`已上传：${file.name}（${content.length} 字）`);
    };
    reader.onerror = () => toast('文件读取失败');
    reader.readAsText(file, 'utf-8');
    this.value = '';
  });

  $root.on('change', `#${EXT_ID}-az-chunk`, function () {
    getSettings().analyzeChunkSize = Math.max(1000, Number($(this).val()) || 6000);
    saveSettings();
  });
  $root.on('change', `#${EXT_ID}-az-title`, function () {
    const cont = getContinuation();
    if (!cont) return;
    const title = String($(this).val() || '').trim();
    if (!title || cont.title === title) return;
    cont.title = title;
    saveContinuation();
    $(`#${EXT_ID}-cont-select option[value="${cont.id}"]`).text(title);
  });
  $root.on('change', `#${EXT_ID}-az-conc`, function () {
    getSettings().analyzeConcurrency = Math.max(1, Math.min(10, Number($(this).val()) || 1));
    saveSettings();
  });

  $root.on('click', '[data-act]', async function (e) {
    const act = $(this).data('act');
    const idx = Number($(this).data('idx'));

    if (act === 'ct-resum-act') {
      e.preventDefault();
      e.stopPropagation();
    }

    if (act === 'az-stop') return void stopAnalyze();
    if (act === 'az-start') {
      if (analyzeState.running) return;
      const text = String(analyzeState.uploadedText || '').trim();
      const cont0 = getContinuation();
      const title =
        String(cont0?.title || '').trim() ||
        String(analyzeState.uploadedName || '')
          .replace(/\.[^.]+$/i, '')
          .trim() ||
        '导入的小说';
      if (!text) return void toast('请先点击上传 txt 文档');
      setUiOpen('ct-upload', true);
      $(`#${EXT_ID}-analyze [data-fold-key="ct-upload"]`).closest('.ns-collapse').find('.ns-collapse__body').first().show();
      $(`#${EXT_ID}-analyze [data-fold-key="ct-upload"] .ns-collapse__icon`).addClass('ns-collapse__icon--open');
      $(`#${EXT_ID}-analyze [data-act="az-stop"]`).prop('disabled', false);
      try {
        const result = await runAnalysis({ text, title }, setAnalyzeProgress);
        if (result) {
          toast('分析完成');
          renderAnalyzeUI(); // 刷新会话下拉 + 表格档案 UI
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
      if ($(e.target).closest('button').length) return;
      if ($(e.target).closest('button.ns-summary__resum').length) return;
      const $head = $(this);
      const $body = $head.parent().find('.ns-collapse__body').first();
      const isHidden = $body.is(':hidden');
      $body.toggle();
      $head.find('.ns-collapse__icon').toggleClass('ns-collapse__icon--open', isHidden);
      const foldKey = $head.data('fold-key');
      if (foldKey) setUiOpen(String(foldKey), isHidden);
      return;
    }
    if (act === 'cont-new') {
      opsCreateProject();
      return;
    }
    if (act === 'cont-del') {
      opsDeleteProject();
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
            // 同步章总结编号
            cont.summaries = (cont.summaries || [])
              .filter((s) => s.actNo !== ai + 1)
              .map((s) => (s.actNo > ai + 1 ? { ...s, actNo: s.actNo - 1 } : s));
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
          // 自然续写走合并锁；大纲模式仅锁正文
          if ((cont.mode || 'outline') === 'free') {
            lockFreeUpToSection(cont, ai, si);
            toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前（大纲+正文）`);
          } else {
            lockUpToSection(cont, ai, si);
            toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前所有内容`);
          }
          saveContinuation();
          renderContinuationChapters();
        }
        return;
      case 'ct-sec-unlock':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          if ((cont.mode || 'outline') === 'free') {
            unlockFreeFromSection(cont, ai, si);
            toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后（大纲+正文）`);
          } else {
            unlockFromSection(cont, ai, si);
            toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后所有内容`);
          }
          saveContinuation();
          renderContinuationChapters();
        }
        return;
      case 'ct-free-lock':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          collectContActsFromDOM(cont);
          lockFreeUpToSection(cont, ai, si);
          saveContinuation();
          renderContinuationChapters();
          toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前（大纲+正文）`);
        }
        return;
      case 'ct-free-unlock':
        if (cont) {
          const ai = Number($(this).data('a'));
          const si = Number($(this).data('s'));
          unlockFreeFromSection(cont, ai, si);
          saveContinuation();
          renderContinuationChapters();
          toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后（大纲+正文）`);
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
      case 'ct-char-toggle': {
        const $head = $(this);
        const $body = $head.closest('.ns-profile-card').find('.ns-profile-card__body').first();
        const isHidden = $body.is(':hidden');
        $body.toggle();
        $head.find('.ns-collapse__icon').toggleClass('ns-collapse__icon--open', isHidden);
        const foldKey = $head.data('fold-key');
        if (foldKey) setUiOpen(String(foldKey), isHidden);
        return;
      }
      case 'ct-save-profile':
        if (cont) {
          collectContProfilesFromDOM(cont);
          saveContinuation();
          toast('角色档案/剧情梗概已保存');
          setContHint('档案表格已保存。');
          renderAnalyzeUI();
        }
        return;
      case 'ct-char-add':
        if (cont) {
          collectContProfilesFromDOM(cont);
          cont.charProfiles.push(makeContCharProfile());
          cont.characters = contCharProfilesText(cont);
          // 新角色默认展开，方便立刻填写
          setUiOpen(`ct-char-${cont.charProfiles.length - 1}`, true);
          saveContinuation();
          renderAnalyzeUI();
        }
        return;
      case 'ct-char-del': {
        if (cont) {
          collectContProfilesFromDOM(cont);
          const di = Number($(this).attr('data-idx'));
          if (Number.isInteger(di) && cont.charProfiles[di]) {
            cont.charProfiles.splice(di, 1);
            if (!cont.charProfiles.length) cont.charProfiles.push(makeContCharProfile());
            cont.characters = contCharProfilesText(cont);
            saveContinuation();
            renderAnalyzeUI();
          }
        }
        return;
      }
      case 'ct-stage-toggle': {
        const $head = $(this);
        const $body = $head.closest('.ns-profile-stage').find('.ns-profile-stage__body').first();
        const isHidden = $body.is(':hidden');
        $body.toggle();
        $head.find('.ns-collapse__icon').toggleClass('ns-collapse__icon--open', isHidden);
        const foldKey = $head.data('fold-key');
        if (foldKey) setUiOpen(String(foldKey), isHidden);
        return;
      }
      case 'ct-stage-add': {
        if (cont) {
          collectContProfilesFromDOM(cont);
          const ci = Number($(this).attr('data-idx'));
          const ch = cont.charProfiles?.[ci];
          if (ch) {
            if (!Array.isArray(ch.stages)) ch.stages = [];
            const prior = ch.stages.filter((s) => !isCharSummaryStage(s));
            prior.push(makeContCharStage({ label: `阶段${prior.length + 1}` }));
            ch.stages = prior;
            ensureCharSummaryStage(ch, { rebuild: true });
            cont.characters = contCharProfilesText(cont);
            setUiOpen(`ct-char-${ci}`, true);
            setUiOpen(`ct-char-${ci}-st-${prior.length - 1}`, true);
            saveContinuation();
            renderAnalyzeUI();
          }
        }
        return;
      }
      case 'ct-stage-del': {
        if (cont) {
          collectContProfilesFromDOM(cont);
          const ci = Number($(this).attr('data-idx'));
          const si = Number($(this).attr('data-stage'));
          const ch = cont.charProfiles?.[ci];
          if (ch && Array.isArray(ch.stages) && Number.isInteger(si) && ch.stages[si] && !isCharSummaryStage(ch.stages[si])) {
            ch.stages.splice(si, 1);
            ensureCharSummaryStage(ch, { rebuild: true });
            cont.characters = contCharProfilesText(cont);
            saveContinuation();
            renderAnalyzeUI();
          }
        }
        return;
      }
      case 'ct-faction-add': {
        if (cont) {
          collectContProfilesFromDOM(cont);
          ensureContProfiles(cont);
          if (!Array.isArray(cont.plotProfile.factions)) cont.plotProfile.factions = [];
          cont.plotProfile.factions.push(makeContFaction());
          cont.plot = contPlotProfileText(cont);
          saveContinuation();
          renderAnalyzeUI();
        }
        return;
      }
      case 'ct-faction-del': {
        if (cont) {
          collectContProfilesFromDOM(cont);
          const fi = Number($(this).attr('data-faction'));
          if (Number.isInteger(fi) && Array.isArray(cont.plotProfile?.factions) && cont.plotProfile.factions[fi]) {
            cont.plotProfile.factions.splice(fi, 1);
            cont.plot = contPlotProfileText(cont);
            saveContinuation();
            renderAnalyzeUI();
          }
        }
        return;
      }
      case 'ct-sync-wi':
        if (cont) {
          try {
            const r = await syncContinuationToWorldInfo(cont);
            toast(`已同步至世界书（${r.count} 条）`);
            setContHint(`已同步世界书：${r.name}`);
            renderAnalyzeUI();
          } catch (e) {
            log.error('续写同步世界书失败:', e);
            toast(`同步失败: ${e.message}`);
          }
        }
        return;
      case 'ct-del-wi':
        if (cont) {
          if (!cont.worldBookName) return void toast('尚未同步世界书');
          if (!globalThis.confirm?.(`确定删除世界书「${cont.worldBookName}」？`)) return;
          try {
            const name = await deleteProjectWorldInfo(cont, () => saveContinuation());
            toast(`已删除世界书：${name}`);
            setContHint('世界书已删除，续写将改回直接注入档案。');
            renderAnalyzeUI();
          } catch (e) {
            log.error('删除续写世界书失败:', e);
            toast(`删除失败: ${e.message}`);
          }
        }
        return;
      case 'ct-import-wi':
        if (cont) {
          if (analyzeState.running || contState.generating) return void toast('请先等待或中止当前生成');
          try {
            const bookName = await pickWorldBookName(cont.worldBookName || '');
            if (!bookName) return;
            if (
              !globalThis.confirm?.(
                `确定从世界书「${bookName}」导入到当前续写？\n将合并角色档案与剧情/势力（同名覆盖），并绑定该世界书。`,
              )
            ) {
              return;
            }
            const r = await importContinuationFromWorldInfo(cont, bookName);
            toast(`已导入：角色 ${r.chars} · 组织 ${r.factions}（条目 ${r.count}）`);
            setContHint(`已从世界书「${r.name}」导入档案`);
            renderAnalyzeUI();
            renderNounBoard();
          } catch (e) {
            log.error('从世界书导入续写失败:', e);
            toast(`导入失败: ${e.message}`);
          }
        }
        return;
      case 'ct-save-acts':
        if (cont) {
          collectContProfilesFromDOM(cont);
          collectContActsFromDOM(cont);
          if (!contState.generating) resetGenerationChannel('cont', { hard: false });
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
          if (cont.freeBreakpoint?.phase) {
            if (
              !globalThis.confirm?.(
                `${formatFreeBreakpointHint(cont.freeBreakpoint)}\n\n开始新一批将清除该断点，是否继续开新一批？`,
              )
            ) {
              return;
            }
            clearFreeBreakpoint(cont);
          }
          readContFreeBatchFromDOM(cont);
          saveContinuation();
          await runContFree(cont);
        }
        return;
      case 'ct-free-speed': {
        if (!cont) return;
        if ((cont.mode || 'outline') !== 'free') return;
        if (contState.generating) return void toast('生成中，请稍后再切换速度');
        const speed = normalizeFreePlotSpeed($(this).attr('data-speed'));
        cont.freePlotSpeed = speed;
        readContFreeBatchFromDOM(cont);
        saveContinuation();
        renderAnalyzeUI();
        toast(`剧情速度：${freePlotSpeedLabel(speed)}`);
        return;
      }
      case 'ct-free-resume':
        if (cont) {
          await resumeContFree(cont);
        }
        return;
      case 'ct-free-skip-bp':
        if (cont) {
          await skipFreeBreakpointAndResume(cont);
        }
        return;
      case 'ct-free-regen':
        if (cont) {
          if (contState.generating) return;
          if (!globalThis.confirm?.('将删除现有自然续写章节、总结与剧情链，并按当前「章/节」设定重新生成，确定继续？')) return;
          readContFreeBatchFromDOM(cont);
          resetContFreeGenerated(cont);
          saveContinuation();
          renderAnalyzeUI();
          await runContFree(cont);
        }
        return;
      case 'ct-confirm-free-outlines': {
        if (!cont) return;
        if (!cont.pendingFreeOutlineBatch) {
          toast('当前无需确认大纲');
          return;
        }
        if (!freeOutlineConfirmWait) {
          toast('当前不在等待确认大纲');
          return;
        }
        collectContProfilesFromDOM(cont);
        collectContActsFromDOM(cont);
        saveContinuation();
        if (resolveFreeOutlineConfirmWait('confirm')) {
          setContHint('全部大纲已确认，开始生成正文…', true);
          toast('全部大纲已确认，开始写正文');
        }
        return;
      }
      case 'ct-append-free-outlines': {
        if (!cont) return;
        if (!cont.pendingFreeOutlineBatch) {
          toast('当前无需追加大纲');
          return;
        }
        if (!freeOutlineConfirmWait) {
          toast('当前不在等待确认大纲');
          return;
        }
        collectContProfilesFromDOM(cont);
        collectContActsFromDOM(cont);
        readContFreeBatchFromDOM(cont);
        saveContinuation();
        const lab = formatContFreeBatchLabel(cont);
        if (resolveFreeOutlineConfirmWait('append')) {
          setContHint(`将按 ${lab} 再拟一批大纲…`, true);
          toast(`再拟一批大纲（${lab}）`);
        }
        return;
      }
      case 'ct-regen-free-outlines': {
        if (!cont) return;
        if (!cont.pendingFreeOutlineBatch) {
          toast('当前无需重新生成大纲');
          return;
        }
        if (!freeOutlineConfirmWait) {
          toast('当前不在等待确认大纲');
          return;
        }
        if (!globalThis.confirm?.('将重新生成全部待确认章中未锁定的大纲（已锁定的保留），是否继续？')) return;
        collectContProfilesFromDOM(cont);
        collectContActsFromDOM(cont);
        if (resolveFreeOutlineConfirmWait('regen')) {
          setContHint('正在重新生成未锁定大纲…', true);
          toast('开始重新生成未锁定大纲');
        }
        return;
      }
      case 'ct-ol-lock': {
        // 兼容旧按钮：自然续写改为大纲+正文合并锁定
        if (!cont) return;
        const ai = Number($(this).attr('data-a'));
        const si = Number($(this).attr('data-s'));
        collectContActsFromDOM(cont);
        lockFreeUpToSection(cont, ai, si);
        saveContinuation();
        renderContinuationChapters();
        toast(`已锁定第 ${ai + 1} 章 第 ${si + 1} 节及之前（大纲+正文）`);
        return;
      }
      case 'ct-ol-unlock': {
        if (!cont) return;
        const ai = Number($(this).attr('data-a'));
        const si = Number($(this).attr('data-s'));
        unlockFreeFromSection(cont, ai, si);
        saveContinuation();
        renderContinuationChapters();
        toast(`已解锁第 ${ai + 1} 章 第 ${si + 1} 节及之后（大纲+正文）`);
        return;
      }
      case 'ct-stop':
        return void stopContinuation();
      case 'ct-clear':
        if (cont) {
          if (contState.generating) return void toast('请先中止当前生成');
          const isFree = (cont.mode || 'outline') === 'free';
          const ok = isFree
            ? globalThis.confirm?.(
                '确定清除自然续写已生成内容？\n将删除全部章节、章节总结、剧情链/人物链。\n（角色档案、剧情梗概、续写基调、原文末尾保留）',
              )
            : globalThis.confirm?.('确定清除目前所有生成内容？（大纲与总结保留，仅清空已生成正文）');
          if (!ok) return;
          resetContSections(cont);
          await resetRuntimeAfterClearContent('cont');
          setContHint(isFree ? '已清除自然续写章节与总结/剧情链。' : '已清除所有生成内容。');
          renderAnalyzeUI();
          toast(isFree ? '已清除自然续写内容' : '已清除生成内容');
        }
        return;
      case 'ct-gen-sec':
        if (cont && !contState.generating) {
          const ai = Number($(this).attr('data-a'));
          const si = Number($(this).attr('data-s'));
          if (Number.isInteger(ai) && Number.isInteger(si) && cont.acts[ai]?.sections[si]) {
            collectContProfilesFromDOM(cont);
            collectContActsFromDOM(cont);
            const secToRegen = cont.acts[ai].sections[si];
            // 仅以有效正文判断「重新生成」；勿用 done（脏 done 会误走加强/跳总结）
            const isRegen = hasValidSectionContent(secToRegen);
            const isFree = (cont.mode || 'outline') === 'free';
            secToRegen.done = false;
            secToRegen.content = '';
            delete secToRegen.pendingLiveSummary;
            // 自然续写「重新生成」只重写正文，保留已有大纲
            const freeReuseOl = isFree && String(secToRegen.outline || '').trim().length >= 16;
            saveContinuation();
            const flat = flatSections(cont);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            await prepareGenerationChannel('cont', { hadPriorContent: isRegen });
            // 自然续写/空回后再生成：多冷却一会儿，避免 Gemini 继续空 completion
            await sleep(isFree ? 1000 : isRegen ? 200 : 80);
            await withContGenerating(async () => {
              if (isFree) {
                await runFreeSectionTwoStep(cont, ai, si, f ? f.flatIdx : -1, setContHint, {
                  reuseOutline: freeReuseOl,
                  skipSummary: true,
                  skipLiveProgress: false,
                  deferLiveProgress: false,
                  reinforce: isRegen,
                });
                // 本章写齐时自动表格总结；失败则断点
                try {
                  const didSum = await ensureFreeActTableSummaryOrBreakpoint(cont, ai, setContHint);
                  setContHint(
                    `第 ${ai + 1} 章 第 ${si + 1} 节已${isRegen ? '重新' : ''}生成` +
                      (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                      (freeReuseOl ? '（沿用大纲仅重写正文）' : '（大纲→正文）') +
                      (didSum ? '，本章表格总结已存档。' : '，大总结已自动更新。'),
                  );
                } catch (e) {
                  if (isFreeBreakpointError(e)) throw e;
                  throw e;
                }
              } else {
                await generateContSection(cont, ai, si, f ? f.flatIdx : -1, 'outline', setContHint, {
                  skipSummary: isRegen,
                  reinforce: isRegen,
                  deferLiveProgress: true,
                });
                setContHint(
                  `第 ${ai + 1} 章 第 ${si + 1} 节已${isRegen ? '重新' : ''}生成` +
                    (genUiProgress.lastElapsedMs ? ` · 用时 ${formatGenElapsed(genUiProgress.lastElapsedMs)}` : '') +
                    '，请点击「确认总结」。',
                );
              }
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
        const sec = cont?.acts?.[ai]?.sections?.[si];
        if (!cont || !sec) return;
        const mode = cont.mode || 'outline';
        const locked = mode === 'free' ? isFreeSectionLocked(sec) : isSectionLocked(sec);
        showSectionViewer(ai, si, sec.content || '', {
          locked,
          onSave: (text) => {
            collectContActsFromDOM(cont);
            const s = cont.acts?.[ai]?.sections?.[si];
            if (!s) throw new Error('节不存在');
            if ((cont.mode || 'outline') === 'free' ? isFreeSectionLocked(s) : isSectionLocked(s)) {
              throw new Error('已锁定，不可保存');
            }
            s.content = text;
            s.done = !!String(text || '').trim();
            s.updatedAt = Date.now();
            saveContinuation();
            renderContinuationChapters();
            renderAnalyzeUI();
          },
        });
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
            setUiOpen('ct-summaries', true);
            renderAnalyzeUI();
            paintSummaryBarStatus('cont');
            const onSum = makeSummaryBarProgress('cont', (msg, busy) => {
              setContHint(msg, busy);
              refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
            });
            try {
              onSum('正在重新生成各章表格总结…', true);
              await regenAllContSummaries(cont, onSum);
              onSum('各章表格总结已重新生成。', false);
              setContHint('各章表格总结已重新生成。');
            } finally {
              clearSummaryBarStatus('cont');
            }
          });
          renderAnalyzeUI();
        }
        return;
      case 'ct-resum-act': {
        if (!cont) return;
        if (contState.generating) return void toast('请先中止当前生成');
        const actNo = Number($(this).data('act-no')) || 0;
        const actIdx = actNo - 1;
        if (actNo < 1 || !cont.acts?.[actIdx]) return void toast('章节不存在');
        if (!actHasGeneratedContent(cont.acts[actIdx])) return void toast(`第 ${actNo} 章尚无正文，无法总结`);
        if (!globalThis.confirm?.(`将重新生成第 ${actNo} 章表格总结（不影响大总结与其它章）。确定继续？`)) return;
        await withContGenerating(async () => {
          setUiOpen('ct-summaries', true);
          setUiOpen(`ct-sum-${actNo}`, true);
          renderAnalyzeUI();
          paintSummaryBarStatus('cont');
          const onSum = makeSummaryBarProgress('cont', (msg, busy) => {
            setContHint(msg, busy);
            refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
          });
          try {
            onSum(`正在重新总结第 ${actNo} 章…`, true);
            await maybeSummarizeContAct(cont, actIdx, onSum, { force: true, hardFail: true });
            onSum(`第 ${actNo} 章表格总结已更新。`, false);
            setContHint(`第 ${actNo} 章表格总结已更新。`);
            toast(`第 ${actNo} 章已重新总结`);
          } catch (e) {
            if (/已中止/.test(String(e?.message || ''))) {
              setContHint('已中止。');
              return;
            }
            setContHint(`第 ${actNo} 章重新总结失败: ${e?.message || e}`);
            toast(`重新总结失败: ${e?.message || e}`);
          } finally {
            clearSummaryBarStatus('cont');
          }
        });
        renderAnalyzeUI();
        return;
      }
      case 'ct-redyn':
        if (cont) {
          if (contState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将按正文分段重建大总结（剧情链 + 人物链），不重新生成章总结。确定继续？')) return;
          await withContGenerating(async () => {
            setUiOpen('ct-summaries', true);
            setUiOpen('ct-grand', true);
            renderAnalyzeUI();
            paintSummaryBarStatus('cont');
            const onSum = makeSummaryBarProgress('cont', (msg, busy) => {
              setContHint(msg, busy);
              refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
            });
            try {
              onSum('正在重新动态总结（剧情链 + 人物链）…', true);
              await regenDynamicSummaryCont(cont, onSum);
              refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
              onSum('动态大总结已重建。', false);
              setContHint('动态大总结已重建。');
            } finally {
              clearSummaryBarStatus('cont');
            }
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
  if (msg != null) analyzeState.progressMsg = String(msg);
  if (typeof pct === 'number') {
    analyzeState.progressPct = Math.max(0, Math.min(100, pct));
  }
  if (!$) return;
  const $wrap = $(`#${EXT_ID}-az-progress-wrap`);
  if (!$wrap.length) return;
  $wrap.css('display', 'block');
  if (typeof pct === 'number') $(`#${EXT_ID}-az-bar`).css('width', `${analyzeState.progressPct}%`);
  if (msg != null) $(`#${EXT_ID}-az-hint`).text(analyzeState.progressMsg);
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
  let bg = obj.background || '';
  if (!bg && src === 'cont') {
    ensureContProfiles(obj);
    const charText = contCharProfilesText(obj);
    const plotText = contPlotProfileText(obj);
    bg = [charText ? `【角色档案】\n${charText}` : '', plotText ? `【剧情梗概】\n${plotText}` : '']
      .filter(Boolean)
      .join('\n\n');
  } else if (!bg && obj.characters) {
    bg = `【角色档案】\n${obj.characters}\n\n【剧情梗概】\n${obj.plot || ''}`;
  }
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
    </div>`;
}

/** 写新小说：世界书操作按钮（放在「保存背景/设定」旁）。 */
function renderNovelWorldBookActions(proj) {
  const wiName = proj?.worldBookName || '';
  return `
    <button class="ns-btn ns-btn--sm" data-act="wd-sync-wi" title="将当前背景与全部世界设定同步为酒馆世界书，生成时按酒馆接口扫描注入">
      <i class="fa-solid fa-book"></i> 同步至世界书
    </button>
    ${wiName
      ? `<button class="ns-btn ns-btn--sm ns-btn--danger" data-act="wd-del-wi" title="删除本项目绑定的世界书"><i class="fa-solid fa-trash"></i> 删除世界书</button>`
      : ''}
    <button class="ns-btn ns-btn--sm" data-act="wd-import-wi" title="从酒馆世界书导入背景与人物/道具/地理/其他设定">
      <i class="fa-solid fa-file-import"></i> 从世界书导入
    </button>`;
}

function renderNovelWorldBookHint(proj) {
  const wiName = proj?.worldBookName || '';
  return wiName
    ? `已绑定世界书：${esc(wiName)}（每次生成按酒馆世界书扫描注入，不再重复塞设定正文）`
    : '同步后将创建/覆盖一本专用世界书；写作与总结生成时会按酒馆接口扫描并注入。';
}

/** 从 DOM 收集世界设定条目并写入 worldDefs。
 *  forceTab: 强制指定板块；不传时读 proj._worldDefTab。
 *  「全部」只读、或 DOM 中没有该板块输入时，不覆盖内存（避免误清空）。
 */
function collectWorldDefsFromDOM(proj, forceTab) {
  const $ = globalThis.jQuery;
  if (!$) return;
  ensureWorldDefs(proj);
  const wd = proj.worldDefs;
  const activeTab = forceTab || proj._worldDefTab || 'chars';

  const collectTab = (tabKey) => {
    if (!tabKey || tabKey === 'all') return;
    const $inputs = $(`#${EXT_ID}-wd-list .ns-entity-input[data-tab="${tabKey}"]`);
    // 兼容旧 DOM：无 data-tab 时仅在「当前活动板块」用无筛选选择器
    const $nodes =
      $inputs.length > 0
        ? $inputs
        : tabKey === activeTab
          ? $(`#${EXT_ID}-wd-list .ns-entity-input`)
          : $();
    if (!$nodes.length) return; // 关键：无输入则保留内存数据
    const vals = [];
    $nodes.each(function () {
      vals.push(String($(this).val() ?? ''));
    });
    wd[tabKey] = vals;
  };

  if (activeTab === 'all') {
    // 只读汇总视图：尝试按 data-tab 同步任何仍挂在 DOM 上的输入（一般没有）
    for (const t of WORLD_DEF_TABS) collectTab(t.key);
  } else {
    collectTab(activeTab);
  }

  const $cb = $(`#${EXT_ID}-wd-preload`);
  if ($cb.length) wd.preload = $cb.is(':checked');
}

/** 同步写新小说背景 + 当前可见的世界设定（名词库 / 重绘前调用）。 */
function syncNovelSettingsFromDOM(proj) {
  if (!proj) return;
  const $ = globalThis.jQuery;
  if (!$) return;
  ensureWorldDefs(proj);
  const $bg = $(`#${EXT_ID}-nv-bg`);
  if ($bg.length) proj.background = String($bg.val() ?? proj.background ?? '');
  // 按 data-tab 收集所有仍在 DOM 中的分类（通常仅当前活动页）
  for (const t of WORLD_DEF_TABS) {
    const $inputs = $(`#${EXT_ID}-novel .ns-entity-input[data-tab="${t.key}"], #${EXT_ID}-wd-list .ns-entity-input[data-tab="${t.key}"]`);
    if (!$inputs.length) continue;
    const vals = [];
    $inputs.each(function () {
      vals.push(String($(this).val() ?? ''));
    });
    proj.worldDefs[t.key] = vals;
  }
  const $cb = $(`#${EXT_ID}-wd-preload`);
  if ($cb.length) proj.worldDefs.preload = $cb.is(':checked');
  // 兼容旧 entities 残留
  if (Array.isArray(proj.entities) && proj.entities.length) {
    const leftover = proj.entities.map((e) => String(e || '').trim()).filter(Boolean);
    if (leftover.length) {
      const chars = Array.isArray(proj.worldDefs.chars) ? proj.worldDefs.chars : [];
      const have = new Set(chars.map((x) => String(x || '').trim()).filter(Boolean));
      for (const e of leftover) {
        if (!have.has(e)) {
          chars.push(e);
          have.add(e);
        }
      }
      proj.worldDefs.chars = chars;
      proj.entities = [];
    }
  }
}

/**
 * 将一条设定拆成可展示的名词条目（支持多行 / 多条粘贴）。
 * @returns {string[]}
 */
function splitWorldDefNounEntries(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^[-*·•、]+\s*/, '').replace(/^\d+[\.\)、]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return [text];
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
  const genThisSet = new Set(resolveGenThisTargets(proj, 2).map((f) => f.flatIdx));

  return (proj.acts || [])
    .map((act, ai) => {
      const secHtml = (act.sections || [])
        .map((sec, si) => {
          const flatIdx = flatByAS[`${ai}_${si}`];
          const working = isSectionWorking('novel', flatIdx);
          const summarizing = working && genUiProgress.phase === 'summary';
          const preview = sec.content ? esc(sec.content.slice(0, 120)) + (sec.content.length > 120 ? '…' : '') : '';
          const genBlock = working ? genProgressBlockHtml() : '';
          const valid = hasValidSectionContent(sec);
          const pendingSum = !!sec.pendingLiveSummary && valid;
          const locked = isSectionLocked(sec);
          // 已生成节之后连续最多 2 个空节显示「生成本节」
          const showGenThis =
            genThisSet.has(flatIdx) &&
            !pendingSum &&
            !locked &&
            !(novelState.generating && !working);
          const tag = working
            ? `<span class="ns-tag ns-tag--gen">${summarizing ? '总结中' : '生成中'}</span>`
            : pendingSum
              ? `<span class="ns-tag ns-tag--pending">待确认总结</span>`
              : valid
                ? `<span class="ns-tag ns-tag--done">已生成</span>`
                : sec.done
                  ? `<span class="ns-tag">空回·待重生</span>`
                  : `<span class="ns-tag">未生成</span>`;
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
                ${working ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="stop">${summarizing ? '中止总结' : '中止'}</button>` : ''}
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
  const $dock = $(`#${EXT_ID}-novel-dock`);
  if ($dock.length) $dock.html(buildNovelWorkspaceDockHtml(proj));
  renderOpsTree();
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

/** 从 DOM 收集章-节结构(章标题/章总览/节大纲), 保留已生成正文。按 data-a/data-s 对齐，避免 DOM 顺序错位。 */
function collectActsFromDOM(proj) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-novel .ns-act`).each(function () {
    const ai = Number($(this).attr('data-a'));
    if (!Number.isInteger(ai) || !proj.acts[ai]) return;
    const act = proj.acts[ai];
    const $title = $(this).find('.ns-act-title').first();
    const $overview = $(this).find('.ns-act-overview').first();
    if ($title.length) act.title = String($title.val() ?? '');
    if ($overview.length) act.overview = String($overview.val() ?? '');
    $(this)
      .find('.ns-section')
      .each(function () {
        const si = Number($(this).attr('data-s'));
        const sec = Number.isInteger(si) ? act.sections[si] : null;
        if (!sec) return;
        const $outline = $(this).find('.ns-sec-outline').first();
        if ($outline.length) sec.outline = String($outline.val() ?? '');
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

  // 重绘前：把当前 DOM 写回「上次渲染的项目」，而不是新的 activeProject
  // （切换/新建/删除后 active 已变，若写回 active 会把 A 的设定污染到 B）
  {
    const prevId = String(novelState.renderedProjectId || '');
    const prev = prevId ? getProjects().find((p) => p && p.id === prevId) : null;
    if (prev) {
      try {
        syncNovelSettingsFromDOM(prev);
        collectActsFromDOM(prev);
        touchProject(prev);
      } catch (_) {
        /* ignore */
      }
    }
  }

  const proj = getActiveProject();

  let body = '';
  if (!proj) {
    body = `<p class="ns-muted">还没有小说。在左侧「项目管理」点击「新建项目」开始。</p>`;
  } else {
    const done = doneSectionCount(proj);
    const total = totalSectionCount(proj);
    const chapterList = novelChapterListHtml(proj);
    const summaryList = proj.summaries.length
      ? proj.summaries.map((s) => renderSummaryTable(s, 'nv-sum')).join('')
      : `<p class="ns-muted">暂无总结。每写完一整章将自动生成该章表格总结。</p>`;

    body = `
      <div class="ns-work-section ns-work-section--settings">
        <div class="ns-collapse ns-collapse--edit ns-collapse--settings">
          <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="nv-settings" title="展开/折叠设定区">
            <i class="fa-solid fa-chevron-right ${foldIconClass('nv-settings')}"></i>
            <strong class="ns-collapse__title">设定</strong>
            <span class="ns-collapse__sep" aria-hidden="true"></span>
            <span class="ns-muted ns-work-section__hint">背景 · 世界设定 · 世界书</span>
          </div>
          <div class="ns-collapse__body ns-collapse__body--edit ns-work-section__body"${foldBodyStyle('nv-settings')}>
            <div class="ns-field" style="margin-bottom:10px;">
              <label class="ns-label">背景设定</label>
              <textarea id="${EXT_ID}-nv-bg" class="ns-textarea" rows="3" placeholder="世界观、设定、主要人物、写作要求等">${esc(proj.background)}</textarea>
            </div>
            <div class="ns-field" style="margin-bottom:10px;">
              <label class="ns-label">世界设定（人物 / 道具 / 地理 / 其他）</label>
              <div id="${EXT_ID}-wd-body">${renderWorldDefsUI(proj)}</div>
            </div>
            <div class="ns-row" style="flex-wrap:wrap; gap:6px; align-items:center;" id="${EXT_ID}-nv-wi-actions">
              <button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>
              ${renderNovelWorldBookActions(proj)}
            </div>
            <p class="ns-muted" style="margin:6px 0 0;" id="${EXT_ID}-nv-wi-hint">${renderNovelWorldBookHint(proj)}</p>
          </div>
        </div>
      </div>
      <div class="ns-work-section ns-work-section--body">
        <div class="ns-work-section__head">
          <strong>正文</strong>
          <span class="ns-muted ns-work-section__hint">大纲 · 章节总结</span>
        </div>
        <div class="ns-field">
          <div class="ns-card__head">
            <label>大纲（章 - 节层次，共 ${proj.acts.length} 章 / ${total} 节）</label>
          </div>
          <div class="ns-chapters">${chapterList}</div>
          <div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="act-add"><i class="fa-solid fa-plus"></i> 添加章</button></div>
        </div>
        <div class="ns-collapse">
          <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="nv-summaries">
            <i class="fa-solid fa-chevron-right ${foldIconClass('nv-summaries')}"></i>
            <strong>整章表格总结（记忆）</strong>
          </div>
          <div class="ns-row" style="padding:4px 10px 0;flex-wrap:wrap;gap:6px;">
            <button class="ns-btn ns-btn--sm" data-act="nv-resum" ${novelState.generating ? 'disabled' : ''} title="重新生成各章表格总结，不动大总结">章节总结</button>
            <button class="ns-btn ns-btn--sm" data-act="nv-redyn" ${novelState.generating ? 'disabled' : ''} title="仅按正文分段重建剧情链与人物链，不动章总结">重新动态总结</button>
            ${novelState.generating ? `<button type="button" class="ns-btn ns-btn--sm ns-btn--danger" data-act="stop" title="中止当前总结/生成">中止总结</button>` : ''}
            <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="nv-clear-sum" ${novelState.generating ? 'disabled' : ''} title="清空章节总结与动态大总结">清空总结</button>
          </div>
          <div class="ns-collapse__body ns-collapse__body--summary"${foldBodyStyle('nv-summaries')}>
            ${summaryBarHtml('novel')}
            ${grandSummaryHtml(proj, 'nv-grand')}
            <div class="ns-summaries">${summaryList}</div>
          </div>
        </div>
      </div>
    `;
  }

  $root.addClass('ns-card--docked').html(`
    <div class="ns-card__scroll">
      <div class="ns-card__head">
        <h4>写新小说</h4>
      </div>
      ${body}
    </div>
    <div class="ns-workspace-dock" id="${EXT_ID}-novel-dock">${proj ? buildNovelWorkspaceDockHtml(proj) : ''}</div>
  `);
  novelState.renderedProjectId = proj?.id || '';
  _novelDragAttach?.(); // 整块重绘后重新绑定拖拽
  renderNounBoard();
  renderOpsTree();
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
  const title = s.actNo
    ? `第 ${s.actNo} 章总结 ${s.actTitle ? '· ' + esc(s.actTitle) : ''}${s.partial ? '（未完成章）' : ''}`
    : `第 ${s.fromChapter}-${s.toChapter} 章总结`;
  const foldKey = `${foldPrefix}-${s.actNo || `${s.fromChapter}-${s.toChapter}`}`;
  const actNo = Number(s.actNo) || 0;
  const resumAct = String(foldPrefix || '').startsWith('ct')
    ? 'ct-resum-act'
    : String(foldPrefix || '').startsWith('nv')
      ? 'nv-resum-act'
      : '';
  const resumBtn =
    actNo > 0 && resumAct
      ? `<button type="button" class="ns-btn ns-btn--sm ns-summary__resum" data-act="${resumAct}" data-act-no="${actNo}" title="仅重新生成本章表格总结（不动大总结与其它章）">重新总结本章</button>`
      : '';
  return `
    <div class="ns-summary ns-collapse">
      <div class="ns-collapse__head" data-act="summary-toggle" data-fold-key="${foldKey}">
        <i class="fa-solid fa-chevron-right ${foldIconClass(foldKey)}"></i>
        <strong class="ns-summary__title">${title}</strong>
        ${resumBtn}
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

/** 清空写小说所有节的正文/完成状态；保留章节总结与大总结（剧情链/人物链）。 */
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
    await withAutoSectionRpm(async () => {
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

  // 世界设定 / 背景：失焦或改动即写回，避免名词库漏读、重绘丢失
  $root.on('change', '.ns-entity-input', function () {
    const proj = getActiveProject();
    if (!proj) return;
    const tab = String($(this).data('tab') || proj._worldDefTab || 'chars');
    collectWorldDefsFromDOM(proj, tab);
    touchProject(proj);
    renderNounBoard();
  });
  $root.on('change', `#${EXT_ID}-nv-bg`, function () {
    const proj = getActiveProject();
    if (!proj) return;
    proj.background = String($(this).val() ?? '');
    touchProject(proj);
  });

  $root.on('click', '[data-act]', async function (e) {
    const act = $(this).data('act');
    const idx = Number($(this).data('idx'));
    const proj = getActiveProject();

    if (act === 'nv-resum-act') {
      e.preventDefault();
      e.stopPropagation();
    }

    switch (act) {
      case 'summary-toggle': {
        if ($(e.target).closest('button.ns-summary__resum').length) break;
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
        opsCreateProject();
        break;
      }
      case 'del-project':
        opsDeleteProject();
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
            $(`#${EXT_ID}-nv-wi-actions`).html(
              `<button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>${renderNovelWorldBookActions(proj)}`,
            );
            $(`#${EXT_ID}-nv-wi-hint`).html(renderNovelWorldBookHint(proj));
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
            $(`#${EXT_ID}-nv-wi-actions`).html(
              `<button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>${renderNovelWorldBookActions(proj)}`,
            );
            $(`#${EXT_ID}-nv-wi-hint`).html(renderNovelWorldBookHint(proj));
            setNovelHint('已删除绑定世界书。');
            toast('世界书已删除');
          } catch (e) {
            log.error('删除世界书失败:', e);
            toast(`删除世界书失败: ${e.message}`);
            $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
            $(`#${EXT_ID}-nv-wi-actions`).html(
              `<button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>${renderNovelWorldBookActions(proj)}`,
            );
            $(`#${EXT_ID}-nv-wi-hint`).html(renderNovelWorldBookHint(proj));
          }
        }
        break;
      case 'wd-import-wi':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          try {
            const bookName = await pickWorldBookName(proj.worldBookName || '');
            if (!bookName) break;
            if (
              !globalThis.confirm?.(
                `确定从世界书「${bookName}」导入到当前小说设定？\n将合并背景/人物/道具/地理/其他（同文去重），并绑定该世界书。`,
              )
            ) {
              break;
            }
            const r = await importProjectFromWorldInfo(proj, bookName);
            $(`#${EXT_ID}-nv-bg`).val(proj.background || '');
            $(`#${EXT_ID}-wd-body`).html(renderWorldDefsUI(proj));
            $(`#${EXT_ID}-nv-wi-actions`).html(
              `<button class="ns-btn ns-btn--sm" data-act="save-bg" title="仅保存背景设定与世界设定">保存背景/设定</button>${renderNovelWorldBookActions(proj)}`,
            );
            $(`#${EXT_ID}-nv-wi-hint`).html(renderNovelWorldBookHint(proj));
            setNovelHint(`已从世界书「${r.name}」导入（${r.count} 条）`);
            toast(`已从世界书导入：${r.name}（${r.count} 条）`);
            renderNounBoard();
          } catch (e) {
            log.error('从世界书导入设定失败:', e);
            toast(`导入失败: ${e.message}`);
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
          // 仅清本地旗标，绝不 stopAll（避免紧接着生成被 abort 成空回）
          if (!novelState.generating) resetGenerationChannel('novel', { hard: false });
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
          if (!globalThis.confirm?.('确定清除目前所有生成内容？（章-节大纲与总结保留，仅清空已生成正文）')) return;
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
            setUiOpen('nv-summaries', true);
            renderNovelUI();
            const onSum = makeSummaryBarProgress('novel', setNovelHint);
            try {
              onSum('正在重新生成各章表格总结…', true);
              await regenAllSummaries(proj, onSum);
              onSum('各章表格总结已重新生成。', false);
              setNovelHint('各章表格总结已重新生成。');
            } finally {
              clearSummaryBarStatus('novel');
            }
          });
          renderNovelUI();
        }
        break;
      case 'nv-resum-act': {
        if (!proj) break;
        if (novelState.generating) return void toast('请先中止当前生成');
        const actNo = Number($(this).data('act-no')) || 0;
        const actIdx = actNo - 1;
        if (actNo < 1 || !proj.acts?.[actIdx]) return void toast('章节不存在');
        if (!actHasGeneratedContent(proj.acts[actIdx])) return void toast(`第 ${actNo} 章尚无正文，无法总结`);
        if (!globalThis.confirm?.(`将重新生成第 ${actNo} 章表格总结（不影响大总结与其它章）。确定继续？`)) break;
        await withGenerating(async () => {
          setUiOpen('nv-summaries', true);
          setUiOpen(`nv-sum-${actNo}`, true);
          renderNovelUI();
          const onSum = makeSummaryBarProgress('novel', setNovelHint);
          try {
            onSum(`正在重新总结第 ${actNo} 章…`, true);
            await maybeSummarizeAct(proj, actIdx, onSum, { force: true });
            onSum(`第 ${actNo} 章表格总结已更新。`, false);
            setNovelHint(`第 ${actNo} 章表格总结已更新。`);
            toast(`第 ${actNo} 章已重新总结`);
          } catch (e) {
            if (/已中止/.test(String(e?.message || ''))) {
              setNovelHint('已中止。');
              return;
            }
            setNovelHint(`第 ${actNo} 章重新总结失败: ${e?.message || e}`);
            toast(`重新总结失败: ${e?.message || e}`);
          } finally {
            clearSummaryBarStatus('novel');
          }
        });
        renderNovelUI();
        break;
      }
      case 'nv-redyn':
        if (proj) {
          if (novelState.generating) return void toast('请先中止当前生成');
          if (!globalThis.confirm?.('将按正文分段重建大总结（剧情链 + 人物链），不重新生成章总结。确定继续？')) return;
          await withGenerating(async () => {
            setUiOpen('nv-summaries', true);
            setUiOpen('nv-grand', true);
            renderNovelUI();
            const onSum = makeSummaryBarProgress('novel', setNovelHint);
            try {
              onSum('正在重新动态总结（剧情链 + 人物链）…', true);
              await regenDynamicSummaryNovel(proj, onSum);
              refreshGrandSummary(proj, `#${EXT_ID}-novel`);
              onSum('动态大总结已重建。', false);
              setNovelHint('动态大总结已重建。');
            } finally {
              clearSummaryBarStatus('novel');
            }
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
            // 仅以有效正文判断「重新生成」；勿用 done（脏 done 会误走加强/跳总结）
            const isRegen = hasValidSectionContent(secToRegen);
            secToRegen.done = false;
            secToRegen.content = '';
            delete secToRegen.pendingLiveSummary;
            touchProject(proj);
            const flat = flatSections(proj);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            await prepareGenerationChannel('novel', { hadPriorContent: isRegen });
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
        const sec = proj?.acts?.[ai]?.sections?.[si];
        if (!proj || !sec) break;
        const locked = isSectionLocked(sec);
        showSectionViewer(ai, si, sec.content || '', {
          locked,
          onSave: (text) => {
            collectActsFromDOM(proj);
            const s = proj.acts?.[ai]?.sections?.[si];
            if (!s) throw new Error('节不存在');
            if (isSectionLocked(s)) throw new Error('已锁定，不可保存');
            s.content = text;
            s.done = !!String(text || '').trim();
            s.updatedAt = Date.now();
            touchProject(proj);
            renderNovelUI();
          },
        });
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
