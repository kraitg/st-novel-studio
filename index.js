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
  // 续写/分析模块
  analyzeChunkSize: 6000,
  analyzeConcurrency: 2,
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
 * 读取当前激活的预设 System Prompt 文字内容。
 * 来源: context.powerUserSettings.sysprompt (CC/TC 通用)。
 * 未启用或读取失败时返回空串。
 */
function readSysPrompt() {
  const ctx = getST();
  if (!ctx) return '';
  try {
    const sp = ctx.powerUserSettings?.sysprompt;
    if (sp && sp.enabled !== false && sp.content) return String(sp.content).trim();
  } catch (e) {
    log.warn('读取预设 System Prompt 失败:', e);
  }
  return '';
}

/**
 * 读取当前全局提示词（globalKeyword）文字内容。
 * 已通过 setExtensionPrompt 走 ST 机制注入，但也显式放入 system 确保双重生效。
 */
function readGlobalKeyword() {
  const s = getSettings();
  if (!s.keywordEnabled) return '';
  return (s.globalKeyword || '').trim();
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
  return store[MODULE_NAME];
}

function saveSettings() {
  const ctx = getST();
  if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function refreshGlobalKeyword() {
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

/* ---------------------------- 项目 CRUD ---------------------------- */

function getProjects() {
  const s = getSettings();
  if (!Array.isArray(s.projects)) s.projects = [];
  return s.projects;
}

function getActiveProject() {
  const s = getSettings();
  const proj = getProjects().find((p) => p.id === s.activeProjectId) || null;
  if (proj) ensureActs(proj);
  return proj;
}

function makeProject(title, source = 'manual') {
  const now = Date.now();
  return {
    id: genId(),
    title: title || `未命名小说 ${new Date(now).toLocaleString()}`,
    background: '',
    entities: [], // 人物/道具设定
    acts: [], // 章-节层次结构 Act[]
    summaries: [], // 每大章一条表格总结
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
  return { id: genId(), title: String(title || ''), overview: String(overview || ''), sections: [] };
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
function doneSectionCount(obj) {
  return flatSections(obj).filter((f) => f.sec.done).length;
}
/** 全部节数。 */
function totalSectionCount(obj) {
  return flatSections(obj).length;
}
/** 判断某大章是否所有节都已完成(且至少有一个节)。 */
function isActComplete(act) {
  const secs = act.sections || [];
  return secs.length > 0 && secs.every((s) => s.done);
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
async function novelGenerateWithId({ system, user }, gid) {
  const th = getTavernHelper();
  if (th && typeof th.generateRaw === 'function') {
    const result = await th.generateRaw({
      ordered_prompts: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      should_stream: false,
      should_silence: true,
      generation_id: gid,
    });
    return typeof result === 'string' ? result : (result?.content ?? String(result ?? ''));
  }
  const ctx = getST();
  if (ctx && typeof ctx.generateRaw === 'function') {
    const result = await ctx.generateRaw({ prompt: user, systemPrompt: system, prefill: '' });
    return typeof result === 'string' ? result : String(result ?? '');
  }
  throw new Error('无可用生成接口(TavernHelper.generateRaw / 原生 generateRaw 均不可用)');
}

async function novelGenerate({ system, user }) {
  const gid = `novel_${Date.now()}`;
  novelState.currentGenId = gid;
  return novelGenerateWithId({ system, user }, gid);
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

/** 取某节之前若干节正文作为前文上下文(按展平顺序)。 */
function recentSectionContext(obj, flatIdx, count = 2) {
  const flat = flatSections(obj);
  const parts = [];
  const start = Math.max(0, flatIdx - count);
  for (let i = start; i < flatIdx; i++) {
    const f = flat[i];
    if (f && f.sec.content) parts.push(`【第${f.actIdx + 1}章 第${f.secIdx + 1}节 正文】\n${f.sec.content}`);
  }
  return parts.join('\n\n');
}

/** 最新一条总结(表格)作为长期记忆。 */
function latestSummaryText(obj) {
  if (!obj.summaries || obj.summaries.length === 0) return '';
  const s = obj.summaries[obj.summaries.length - 1];
  return `【已发生剧情总结(第${s.actNo}章)】\n${summaryToTable(s)}`;
}

/** 取最新已生成节正文末尾若干字(反映当前最新进度)。 */
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

/**
 * 大总结: 汇总全部已归档章节表格总结 + 动态附上最新生成节节选。
 * 作为长期记忆注入生成; 也用于创意灵感。纯拼接, 不额外调用 AI。
 */
function buildGrandSummary(obj) {
  const parts = [];
  const sums = Array.isArray(obj.summaries) ? obj.summaries : [];
  if (sums.length) {
    const body = sums
      .map((s) => `● 第${s.actNo}章${s.actTitle ? '「' + s.actTitle + '」' : ''}总结\n${summaryToTable(s)}`)
      .join('\n\n');
    parts.push(`【全书章节总结汇总】\n${body}`);
  }
  const excerpt = latestSectionExcerpt(obj);
  if (excerpt) parts.push(excerpt);
  return parts.join('\n\n');
}

/** 把 summary 渲染成 Markdown 表格文本(供注入 prompt 与展示)。 */
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

/** 人物/道具设定文本块。 */
function entitiesText(proj) {
  const list = Array.isArray(proj.entities) ? proj.entities.filter((e) => e && e.trim()) : [];
  if (!list.length) return '';
  return `【人物与道具设定】\n${list.map((e) => `- ${e.trim()}`).join('\n')}`;
}

/** 构建"写某一节"的提示词: 先预读所属章总览, 再写本节。 */
function buildSectionPrompt(proj, actIdx, secIdx, flatIdx) {
  const act = proj.acts[actIdx];
  const sec = act.sections[secIdx];

  // ── System: 预设 → 全局提示词 → 写作助手说明 ──
  const presetSys = readSysPrompt();
  const globalKw = readGlobalKeyword();
  const system = [
    presetSys || null,   // 1. 预设 System Prompt（最高优先级）
    globalKw || null,    // 2. 全局提示词
    '你是专业的中文小说写作助手。本作品按"章-节"结构编写。', // 3. 插件写作说明
    '请先理解【本章总览】把握本章走向，再根据【背景设定】【人物与道具设定】【长期记忆】【前文】和【本节大纲】续写本节正文。',
    '要求：只输出本节正文，不要输出标题/大纲/解释/多余标记；严格遵守人物与道具设定；与前文及本章走向连贯；文笔流畅。',
  ].filter(Boolean).join('\n\n');

  // ── User: 背景/设定 → 记忆(大总结) → 前文 → 章总览 → 节大纲 → 指令 ──
  const user = [
    proj.background ? `【背景设定】\n${proj.background}` : '',    // 背景设定
    entitiesText(proj),                                            // 人物/道具设定
    buildGrandSummary(proj),                                       // 记忆（大总结）
    recentSectionContext(proj, flatIdx, 2),                        // 前文（最近2节）
    `【本章总览】(第${actIdx + 1}章 ${act.title || ''})\n${act.overview || '(未填写章总览)'}`,  // 章总览
    `【本节大纲】(第${actIdx + 1}章 第${secIdx + 1}节)\n${sec.outline || ''}`,                 // 节大纲
    `请开始写第${actIdx + 1}章 第${secIdx + 1}节正文:`,
  ]
    .filter(Boolean)
    .join('\n\n');

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
async function generateSection(proj, actIdx, secIdx, flatIdx, onProgress) {
  const act = proj.acts[actIdx];
  const sec = act.sections[secIdx];
  // 开始写"某章第一节"时, 先对之前所有已完成但未总结的章做整章总结
  if (secIdx === 0) await summarizePendingActs(proj, actIdx, onProgress);
  const { system, user } = buildSectionPrompt(proj, actIdx, secIdx, flatIdx);
  onProgress?.(`正在生成第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`, true);
  novelState.activeFlatIdx = flatIdx;
  novelState.activeActIdx = actIdx; // 记住当前操作章, 该章不自动折叠
  renderNovelChapters();
  try {
    const text = (await novelGenerate({ system, user })).trim();
    sec.content = text;
    sec.done = true;
    sec.updatedAt = Date.now();
    touchProject(proj);
    novelState.activeFlatIdx = -1;
    // 每节生成后刷新大总结（latestSectionExcerpt 有了新内容）
    refreshGrandSummary(proj, `#${EXT_ID}-novel`);
    return text;
  } finally {
    novelState.activeFlatIdx = -1;
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

/** 该大章已有表格总结则跳过, 否则生成并存档。 */
async function maybeSummarizeAct(proj, actIdx, onProgress) {
  const actNo = actIdx + 1;
  const act = proj.acts[actIdx];
  if (!act || !isActComplete(act)) {
    log.debug(`第 ${actNo} 章未完成或不存在, 跳过总结`);
    return;
  }
  if (proj.summaries.some((s) => s.actNo === actNo)) {
    log.debug(`第 ${actNo} 章已有总结, 跳过`);
    return;
  }
  try {
    log.info(`开始生成第 ${actNo} 章整章表格总结…`);
    onProgress?.(`第 ${actNo} 章已写完, 正在生成整章表格总结…`, true);
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
    });
    touchProject(proj);
    renderNovelSummaries(); // 实时刷新总结区
    log.info(`已生成第 ${actNo} 章表格总结`, { characters: parsed.characters.length, plot: parsed.plot.length });
    onProgress?.(`第 ${actNo} 章表格总结已存档`, true);
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
    return (await novelGenerateWithId({ system, user }, gid)).trim();
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
    return (await novelGenerateWithId({ system, user }, gid)).trim();
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
  const concurrency = settings.analyzeConcurrency || 2;
  const full = String(text || '').trim();
  if (!full) throw new Error('文本为空');
  const chunks = splitTextIntoChunks(full, chunkSize);
  if (chunks.length === 0) throw new Error('分段失败');

  analyzeState.running = true;
  analyzeState.cancelRequested = false;
  analyzeState.genIds.clear();
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
  }
}

/* ================================================================== */
/* 续写: 生成                                                          */
/* ================================================================== */

const contState = { generating: false, cancelRequested: false, currentGenId: '', activeFlatIdx: -1, activeActIdx: -1 };

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

/** 构建续写某节的提示词。mode: outline=按大纲(读章总览+节大纲) / free=自然续写。 */
function buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode) {
  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];

  // ── System: 预设 → 全局提示词 → 续写助手说明 ──
  const presetSys = readSysPrompt();
  const globalKw = readGlobalKeyword();
  const sysLines = [
    presetSys || null,   // 1. 预设 System Prompt
    globalKw || null,    // 2. 全局提示词
    '你是专业的中文小说续写助手。请在保持原作人物、设定、文风、剧情逻辑连贯的前提下续写。', // 3. 插件说明
    '要求：只输出续写正文，不要输出标题/解释/大纲/多余标记；与前文自然衔接。',
  ].filter(Boolean);
  if (mode === 'free') sysLines.push('本次为自然续写：请根据原文走向与人物剧情，自主推进剧情，写出承接前文的下一节。');
  else sysLines.push('本次为按大纲续写：本作品按"章-节"结构，请先理解【本章总览】再严格围绕【本节大纲】展开本节正文。');

  // ── User: 角色档案/背景 → 记忆(大总结) → 前文 → 章总览 → 节大纲 → 指令 ──
  const recentTail = contRecentTail(cont, flatIdx, 1200);
  const parts = [
    cont.characters ? `【角色档案】\n${cont.characters}` : '',                            // 角色档案
    cont.plot ? `【剧情梗概】\n${cont.plot}` : '',                                        // 剧情梗概
    buildGrandSummary(cont),                                                              // 记忆（大总结）
    !recentTail && cont.sourceTail ? `【原文末尾(承接点)】\n${cont.sourceTail}` : '',      // 原文末尾
    recentTail ? `【上一节结尾】\n${recentTail}` : '',                                    // 前文
    mode === 'outline' ? `【本章总览】(第${actIdx + 1}章 ${act.title || ''})\n${act.overview || '(未填写)'}` : '', // 章总览
    mode === 'outline' ? `【本节大纲】(第${actIdx + 1}章 第${secIdx + 1}节)\n${sec.outline || ''}` : '',          // 节大纲
    `请续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节正文:`,
  ].filter(Boolean);
  return { system: sysLines.join('\n\n'), user: parts.join('\n\n') };
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

/** 生成续写某一节。 */
async function generateContSection(cont, actIdx, secIdx, flatIdx, mode, onProgress) {
  const act = cont.acts[actIdx];
  const sec = act.sections[secIdx];
  // 开始写"某章第一节"时, 先对之前已完成但未总结的章做整章总结
  if (secIdx === 0) await summarizePendingContActs(cont, actIdx, onProgress);
  const { system, user } = buildContSectionPrompt(cont, actIdx, secIdx, flatIdx, mode);
  onProgress?.(`正在续写第 ${actIdx + 1} 章 第 ${secIdx + 1} 节…`, true);
  const gid = `cont_${Date.now()}_${flatIdx}`;
  contState.currentGenId = gid;
  contState.activeFlatIdx = flatIdx;
  contState.activeActIdx = actIdx; // 记住当前操作章, 该章不自动折叠
  renderContinuationChapters();
  try {
    const text = (await novelGenerateWithId({ system, user }, gid)).trim();
    sec.content = text;
    sec.done = true;
    sec.updatedAt = Date.now();
    saveContinuation();
    contState.activeFlatIdx = -1;
    // 每节生成后刷新大总结
    refreshGrandSummary(getContinuation(), `#${EXT_ID}-analyze`);
    return text;
  } finally {
    contState.activeFlatIdx = -1;
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
async function maybeSummarizeContAct(cont, actIdx, onProgress) {
  const actNo = actIdx + 1;
  const act = cont.acts[actIdx];
  if (!act || !isActComplete(act)) return;
  if (cont.summaries.some((s) => s.actNo === actNo)) return;
  try {
    log.info(`开始生成续写第 ${actNo} 章整章表格总结…`);
    onProgress?.(`正在为续写第 ${actNo} 章生成整章表格总结…`, true);
    const { system, user } = buildActSummaryPrompt(cont, actIdx);
    const raw = (await novelGenerateWithId({ system, user }, `cont_sum_${Date.now()}`)).trim();
    log.debug(`续写第 ${actNo} 章总结原始返回:`, raw.slice(0, 200));
    const parsed = parseSummary(raw);
    if (!parsed.characters.length && !parsed.plot.length) {
      log.warn(`续写第 ${actNo} 章总结解析为空, 原始文本:`, raw.slice(0, 400));
    }
    cont.summaries.push({ actNo, actTitle: cont.acts[actIdx].title || '', characters: parsed.characters, plot: parsed.plot, createdAt: Date.now() });
    saveContinuation();
    renderContSummaries();
    log.info(`已生成续写第 ${actNo} 章表格总结`, { characters: parsed.characters.length, plot: parsed.plot.length });
    onProgress?.(`第 ${actNo} 章表格总结已存档`, true);
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
  if ($box.length) $box.html((cont.summaries || []).map((s) => renderSummaryTable(s)).join(''));
  // 同步刷新大总结（保留折叠状态）
  refreshGrandSummary(cont, `#${EXT_ID}-analyze`);
}

async function withContGenerating(fn) {
  contState.generating = true;
  contState.cancelRequested = false;
  const $ = globalThis.jQuery;
  $?.(`#${EXT_ID}-analyze [data-act="ct-stop"]`).prop('disabled', false);
  try {
    await fn();
  } catch (e) {
    log.error('续写异常:', e);
    setContHint(`续写失败: ${e.message}`);
    toast(`续写失败: ${e.message}`);
  } finally {
    contState.generating = false;
    contState.cancelRequested = false;
    contState.currentGenId = '';
    $?.(`#${EXT_ID}-analyze [data-act="ct-stop"]`).prop('disabled', true);
  }
}

/** 清空续写所有节的正文与完成状态、清空总结, 用于从头重新生成。
 *  自然续写(free)模式下章由生成自动创建, 直接清空 acts。 */
function resetContSections(cont) {
  if ((cont.mode || 'outline') === 'free') {
    cont.acts = [];
  } else {
    for (const act of cont.acts || []) {
      for (const sec of act.sections || []) {
        sec.content = '';
        sec.done = false;
        sec.updatedAt = 0;
      }
      delete act._folded;
    }
  }
  cont.summaries = [];
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
  let target = flat.find((f) => !f.sec.done);
  if (!target) {
    // 全部完成: 询问是否从头重新生成
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetContSections(cont);
    renderAnalyzeUI();
    flat = flatSections(cont);
    target = flat.find((f) => !f.sec.done);
    if (!target) return;
  }
  await withContGenerating(async () => {
    await generateContSection(cont, target.actIdx, target.secIdx, target.flatIdx, 'outline', setContHint);
    setContHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已续写，请确认或重新生成。`);
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
  if (!flatSections(cont).some((f) => !f.sec.done)) {
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
      const target = flat.find((f) => !f.sec.done);
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
        <div class="ns-panel__footer"><span class="ns-muted">${EXT_NAME} v1.9</span></div>
      </div>
    </div>`;
  $('body').append(html);
  const $overlay = $(`#${OVERLAY_ID}`);

  $overlay.on('click', (e) => {
    if (e.target && e.target.id === OVERLAY_ID) closePanel();
  });
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
  $(document).on('keydown.novelstudio', (e) => {
    if (e.key === 'Escape' && $overlay.is(':visible')) closePanel();
  });

  // 主模块折叠/展开（委托绑定到 overlay）
  $overlay.on('click', '[data-act="module-fold"]', function () {
    const targetId = $(this).data('target');
    const $body = $(`#${targetId}`);
    const $icon = $(this).find('.ns-module-icon');
    const isHidden = $body.is(':hidden');
    $body.toggle();
    $icon.toggleClass('ns-module-icon--open', isHidden);
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

/** 每次打开面板时，把两个主模块重置为折叠状态。 */
function collapseAllModules() {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-analyze-body, #${EXT_ID}-novel-body`).css('display', 'none');
  $('[data-act="module-fold"] .ns-module-icon').removeClass('ns-module-icon--open');
}

function openPanel() {
  const $overlay = ensurePanel();
  if (!$overlay) return;
  refreshStatus();
  fillKeywordForm();
  bindAnalyzeEvents();
  renderAnalyzeUI();
  bindNovelEvents();
  renderNovelUI();
  bindIdeaEvents();
  renderIdeaUI();
  collapseAllModules(); // 每次打开默认折叠所有模块
  $overlay.css('display', 'flex');
  log.info('面板已打开');
}

function closePanel() {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${OVERLAY_ID}`).css('display', 'none');
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
        <label class="ns-muted">并发<input type="number" id="${EXT_ID}-az-conc" class="ns-num" value="${s.analyzeConcurrency || 2}" min="1" max="10" /></label>
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
        <div class="ns-collapse__head" data-act="az-toggle"><i class="fa-solid fa-chevron-right ns-collapse__icon"></i><strong>角色档案</strong></div>
        <div class="ns-collapse__body" style="display:none;">${esc(r.characters).replace(/\n/g, '<br>') || '（空）'}</div>
      </div>
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="az-toggle"><i class="fa-solid fa-chevron-right ns-collapse__icon"></i><strong>剧情梗概</strong></div>
        <div class="ns-collapse__body" style="display:none;">${esc(r.plot).replace(/\n/g, '<br>') || '（空）'}</div>
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
          const genBlock = generating
            ? `<div class="ns-chapter__gen"><span class="ns-gen-label"><i class="fa-solid fa-spinner fa-spin"></i> 生成中…</span>
                 <div class="ns-progress"><div class="ns-progress__bar ns-progress__bar--indef"></div></div></div>`
            : '';
          const tag = generating
            ? `<span class="ns-tag ns-tag--gen">生成中</span>`
            : `<span class="ns-tag ${sec.done ? 'ns-tag--done' : ''}">${sec.done ? '已生成' : '未生成'}</span>`;
          const outlineField =
            mode === 'outline'
              ? `<input type="text" class="ns-ct-sec-outline" data-a="${ai}" data-s="${si}" value="${esc(sec.outline || '')}" placeholder="本节大纲…" />`
              : `<span class="ns-chapter__outline">${esc(sec.outline || '')}</span>`;
          return `
            <div class="ns-section ${generating ? 'ns-chapter--gen' : ''}">
              <div class="ns-chapter__head">
                <strong>第 ${si + 1} 节</strong>${tag}${outlineField}
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${sec.content ? `<button class="ns-btn ns-btn--sm" data-act="ct-gen-sec" data-a="${ai}" data-s="${si}" ${contState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="ct-sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文">清空</button>` : ''}
                  <button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="ct-sec-del" data-a="${ai}" data-s="${si}" title="删除本节"><i class="fa-solid fa-trash"></i></button>
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
      const isActiveAct = contState.activeActIdx === ai || (act.sections || []).some((s, si) => contState.activeFlatIdx === flatByAS[`${ai}_${si}`]);
      const folded = isActiveAct ? false : typeof act._folded === 'boolean' ? act._folded : isActComplete(act);
      return `
        <div class="ns-act ${folded ? 'ns-act--folded' : ''}" data-a="${ai}">
          <div class="ns-act__head">
            <button class="ns-btn ns-btn--icon ns-btn--sm ns-act-fold" data-act="ct-act-fold" data-a="${ai}" title="折叠/展开本章"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'} ns-act-fold__icon"></i></button>
            <strong>第 ${ai + 1} 章</strong>${actEditable}
            <span class="ns-tag ${isActComplete(act) ? 'ns-tag--done' : ''}">${(act.sections || []).filter((s) => s.done).length}/${(act.sections || []).length} 节</span>
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
  if ($list.length) $list.html(contChapterListHtml(cont));
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
    ? cont.summaries.map((s) => renderSummaryTable(s)).join('')
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
        <div class="ns-collapse__head" data-act="summary-toggle">
          <i class="fa-solid fa-chevron-right ns-collapse__icon"></i>
          <strong>整章表格总结（记忆）</strong>
        </div>
        <div class="ns-row" style="padding:4px 10px 0;">
          <button class="ns-btn ns-btn--sm" data-act="ct-resum" ${contState.generating ? 'disabled' : ''} title="对所有已完成章重新生成总结">全部重新总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="ct-clear-sum" title="清空所有章节总结">清空总结</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--summary" style="display:none;">
          ${grandSummaryHtml(cont)}
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
    getSettings().analyzeConcurrency = Math.max(1, Math.min(10, Number($(this).val()) || 2));
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
            const flat = flatSections(cont);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            await withContGenerating(async () => {
              await generateContSection(cont, ai, si, f ? f.flatIdx : -1, cont.mode || 'outline', setContHint);
              setContHint(`第 ${ai + 1} 章 第 ${si + 1} 节已生成。`);
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
          if (!globalThis.confirm?.('将清空并重新生成所有已完成章的表格总结，确定继续？')) return;
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

function renderEntityRows(entities) {
  const list = Array.isArray(entities) && entities.length ? entities : [''];
  return list
    .map(
      (item, i) => `
      <div class="ns-outline-row">
        <span class="ns-outline-no"><i class="fa-solid fa-user-pen"></i></span>
        <input type="text" class="ns-entity-input" value="${esc(item)}" placeholder="如：林川-主角，冷静果断，持有断罪之剑" />
        <button class="ns-btn ns-btn--icon ns-btn--sm" data-act="entity-del" data-idx="${i}" title="删除本行"><i class="fa-solid fa-trash"></i></button>
      </div>`,
    )
    .join('');
}

function collectEntitiesFromDOM() {
  const $ = globalThis.jQuery;
  if (!$) return [];
  const vals = [];
  $(`#${EXT_ID}-novel .ns-entity-input`).each(function () {
    vals.push(String($(this).val() ?? ''));
  });
  return vals;
}

function refreshEntityList(entities) {
  const $ = globalThis.jQuery;
  if (!$) return;
  $(`#${EXT_ID}-novel .ns-entity-list`).html(renderEntityRows(entities));
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
          const genBlock = generating
            ? `<div class="ns-chapter__gen"><span class="ns-gen-label"><i class="fa-solid fa-spinner fa-spin"></i> 生成中…</span>
                 <div class="ns-progress"><div class="ns-progress__bar ns-progress__bar--indef"></div></div></div>`
            : '';
          const tag = generating
            ? `<span class="ns-tag ns-tag--gen">生成中</span>`
            : `<span class="ns-tag ${sec.done ? 'ns-tag--done' : ''}">${sec.done ? '已生成' : '未生成'}</span>`;
          return `
            <div class="ns-section ${generating ? 'ns-chapter--gen' : ''}">
              <div class="ns-chapter__head">
                <strong>第 ${si + 1} 节</strong>
                ${tag}
                <input type="text" class="ns-sec-outline" data-a="${ai}" data-s="${si}" value="${esc(sec.outline || '')}" placeholder="本节大纲…" />
              </div>
              ${genBlock}
              ${sec.content ? `<div class="ns-chapter__body">${preview}<span class="ns-wordcount">${sec.content.length} 字</span></div>` : ''}
              <div class="ns-chapter__actions">
                ${sec.content ? `<button class="ns-btn ns-btn--sm" data-act="gen-sec" data-a="${ai}" data-s="${si}" ${novelState.generating ? 'disabled' : ''}>重新生成</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="view-sec" data-a="${ai}" data-s="${si}">查看全文</button>` : ''}
                ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="copy-sec" data-a="${ai}" data-s="${si}"><i class="fa-solid fa-copy"></i> 复制</button>` : ''}
                <span class="ns-chapter__actions-right">
                  ${sec.content ? `<button class="ns-btn ns-btn--sm ns-btn--ghost" data-act="sec-clear" data-a="${ai}" data-s="${si}" title="清空本节正文">清空</button>` : ''}
                  <button class="ns-btn ns-btn--icon ns-btn--sm ns-btn--danger" data-act="sec-del" data-a="${ai}" data-s="${si}" title="删除本节"><i class="fa-solid fa-trash"></i></button>
                </span>
              </div>
            </div>`;
        })
        .join('');

      // 折叠状态: 活动章强制展开; 否则沿用用户手动设置(act._folded), 未设置则整章完成默认折叠
      const isActiveAct = novelState.activeActIdx === ai || (act.sections || []).some((s, si) => novelState.activeFlatIdx === flatByAS[`${ai}_${si}`]);
      const folded = isActiveAct ? false : typeof act._folded === 'boolean' ? act._folded : isActComplete(act);
      return `
        <div class="ns-act ${folded ? 'ns-act--folded' : ''}" data-a="${ai}">
          <div class="ns-act__head">
            <button class="ns-btn ns-btn--icon ns-btn--sm ns-act-fold" data-act="act-fold" data-a="${ai}" title="折叠/展开本章"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'} ns-act-fold__icon"></i></button>
            <strong>第 ${ai + 1} 章</strong>
            <input type="text" class="ns-act-title" data-a="${ai}" value="${esc(act.title || '')}" placeholder="章标题" />
            <span class="ns-tag ${isActComplete(act) ? 'ns-tag--done' : ''}">${(act.sections || []).filter((s) => s.done).length}/${(act.sections || []).length} 节</span>
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
  if ($list.length) $list.html(novelChapterListHtml(proj));
}

/** 只刷新写小说总结区。 */
function renderNovelSummaries() {
  const $ = globalThis.jQuery;
  if (!$) return;
  const proj = getActiveProject();
  if (!proj) return;
  // 刷新章节总结列表
  const html = proj.summaries.length
    ? proj.summaries.map((s) => renderSummaryTable(s)).join('')
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
  const ents = (proj.entities || []).filter(Boolean);
  if (ents.length) {
    lines.push('【人物与道具设定】');
    ents.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }
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
      ? proj.summaries.map((s) => renderSummaryTable(s)).join('')
      : `<p class="ns-muted">暂无总结。每写完一整章将自动生成该章表格总结。</p>`;

    body = `
      <div class="ns-collapse ns-collapse--edit">
        <div class="ns-collapse__head" data-act="summary-toggle"><i class="fa-solid fa-chevron-right ns-collapse__icon"></i><strong>背景设定</strong></div>
        <div class="ns-collapse__body ns-collapse__body--edit" style="display:none;">
          <textarea id="${EXT_ID}-nv-bg" class="ns-textarea" rows="3" placeholder="世界观、设定、主要人物、写作要求等">${esc(proj.background)}</textarea>
        </div>
      </div>
      <div class="ns-collapse ns-collapse--edit">
        <div class="ns-collapse__head" data-act="summary-toggle"><i class="fa-solid fa-chevron-right ns-collapse__icon"></i><strong>主要人物角色 / 道具设定</strong></div>
        <div class="ns-collapse__body ns-collapse__body--edit" style="display:none;">
          <p class="ns-muted">逐行添加，每节生成都会读取。</p>
          <div class="ns-entity-list">${renderEntityRows(proj.entities)}</div>
          <div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="entity-add"><i class="fa-solid fa-plus"></i> 添加设定</button></div>
        </div>
      </div>
      <div class="ns-field">
        <div class="ns-card__head">
          <label>大纲（章 - 节层次，共 ${proj.acts.length} 章 / ${total} 节）</label>
          <button class="ns-btn ns-btn--sm" data-act="save-meta">保存背景/设定/大纲</button>
        </div>
        <div class="ns-chapters">${chapterList}</div>
        <div class="ns-row"><button class="ns-btn ns-btn--sm" data-act="act-add"><i class="fa-solid fa-plus"></i> 添加章</button></div>
      </div>
      <div class="ns-field">
        <div class="ns-card__head"><label>生成</label><span class="ns-muted" id="${EXT_ID}-nv-hint"></span></div>
        <div class="ns-row">
          <button class="ns-btn" data-act="mode-manual" title="逐节生成，每节需确认或重新生成">手动模式（逐节确认）</button>
          <button class="ns-btn" data-act="mode-auto" title="一次性生成所有未完成节">自动模式（全部生成）</button>
          <button class="ns-btn ns-btn--danger" data-act="stop" ${novelState.generating ? '' : 'disabled'}>中止</button>
          <button class="ns-btn ns-btn--danger" data-act="nv-clear" ${done ? '' : 'disabled'} title="清除目前所有生成内容">清除生成内容</button>
          <button class="ns-btn ns-btn--ghost" data-act="export" ${done ? '' : 'disabled'}><i class="fa-solid fa-download"></i> 一键导出(txt)</button>
          <span class="ns-muted">进度：${done}/${total} 节</span>
        </div>
      </div>
      <div class="ns-collapse">
        <div class="ns-collapse__head" data-act="summary-toggle">
          <i class="fa-solid fa-chevron-right ns-collapse__icon"></i>
          <strong>整章表格总结（记忆）</strong>
        </div>
        <div class="ns-row" style="padding:4px 10px 0;">
          <button class="ns-btn ns-btn--sm" data-act="nv-resum" ${novelState.generating ? 'disabled' : ''} title="对所有已完成章重新生成总结">全部重新总结</button>
          <button class="ns-btn ns-btn--sm ns-btn--danger" data-act="nv-clear-sum" title="清空所有章节总结">清空总结</button>
        </div>
        <div class="ns-collapse__body ns-collapse__body--summary" style="display:none;">
          ${grandSummaryHtml(proj)}
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
}

/** 渲染大总结折叠块(默认折叠)。 */
function grandSummaryHtml(obj) {
  const text = buildGrandSummary(obj);
  const body = text ? esc(text).replace(/\n/g, '<br>') : '（暂无内容，生成节后自动汇总）';
  return `
    <div class="ns-collapse ns-grand-summary" style="margin-bottom:4px;">
      <div class="ns-collapse__head" data-act="summary-toggle">
        <i class="fa-solid fa-chevron-right ns-collapse__icon"></i>
        <strong><i class="fa-solid fa-layer-group" style="margin-right:4px;"></i>大总结（全书汇总 + 最新进度）</strong>
      </div>
      <div class="ns-collapse__body ns-grand-summary__body" style="display:none;">${body}</div>
    </div>`;
}

/** 只更新大总结文本内容（不重建折叠结构，保留展开/折叠状态）。 */
function refreshGrandSummary(obj, containerSel) {
  const $ = globalThis.jQuery;
  if (!$) return;
  const $body = $(`${containerSel} .ns-grand-summary__body`);
  if (!$body.length) return;
  const text = buildGrandSummary(obj);
  $body.html(text ? esc(text).replace(/\n/g, '<br>') : '（暂无内容，生成节后自动汇总）');
}

/** 渲染一条整章总结为表格（可折叠，默认折叠）。 */
function renderSummaryTable(s) {
  const chars = Array.isArray(s.characters) ? s.characters : [];
  const plots = Array.isArray(s.plot) ? s.plot : [];
  const charRows = chars.length
    ? chars.map((c) => `<tr><td>${esc(c.name || '')}</td><td>${esc(c.detail || '')}</td></tr>`).join('')
    : `<tr><td colspan="2" class="ns-muted">（无）</td></tr>`;
  const plotRows = plots.length
    ? plots.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="ns-muted">（无）</td></tr>`;
  const title = s.actNo ? `第 ${s.actNo} 章总结 ${s.actTitle ? '· ' + esc(s.actTitle) : ''}` : `第 ${s.fromChapter}-${s.toChapter} 章总结`;
  return `
    <div class="ns-summary ns-collapse">
      <div class="ns-collapse__head" data-act="summary-toggle">
        <i class="fa-solid fa-chevron-right ns-collapse__icon"></i>
        <strong>${title}</strong>
      </div>
      <div class="ns-collapse__body" style="display:none;">
        <table class="ns-table"><thead><tr><th>人物</th><th>状态/关系/目标</th></tr></thead><tbody>${charRows}</tbody></table>
        <table class="ns-table"><thead><tr><th>序</th><th>关键剧情</th></tr></thead><tbody>${plotRows}</tbody></table>
      </div>
    </div>`;
}

/** 写小说: 清空总结并对所有已完成章重新生成整章表格总结。 */
async function regenAllSummaries(proj, onProgress) {
  proj.summaries = [];
  touchProject(proj);
  for (let i = 0; i < (proj.acts || []).length; i++) {
    if (proj.acts[i] && isActComplete(proj.acts[i])) {
      await maybeSummarizeAct(proj, i, onProgress);
      renderNovelSummaries();
    }
  }
}

/** 续写: 清空总结并对所有已完成章重新生成整章表格总结。 */
async function regenAllContSummaries(cont, onProgress) {
  cont.summaries = [];
  saveContinuation();
  for (let i = 0; i < (cont.acts || []).length; i++) {
    if (cont.acts[i] && isActComplete(cont.acts[i])) {
      await maybeSummarizeContAct(cont, i, onProgress);
      renderContSummaries();
    }
  }
}

/** 清空写小说所有节的正文/完成状态与总结, 用于从头重新生成。 */
function resetProjSections(proj) {
  for (const act of proj.acts || []) {
    for (const sec of act.sections || []) {
      sec.content = '';
      sec.done = false;
      sec.updatedAt = 0;
    }
    delete act._folded;
  }
  proj.summaries = [];
  novelState.activeActIdx = -1;
  touchProject(proj);
}

/** 手动模式: 生成下一个未完成节。 */
async function runManualStep(proj) {
  if (novelState.generating) return;
  collectActsFromDOM(proj);
  if (!totalSectionCount(proj)) return void setNovelHint('请先添加章与节。');
  let flat = flatSections(proj);
  let target = flat.find((f) => !f.sec.done);
  if (!target) {
    if (!globalThis.confirm?.('当前生成已完成，是否全部重新生成？')) return;
    resetProjSections(proj);
    renderNovelUI();
    flat = flatSections(proj);
    target = flat.find((f) => !f.sec.done);
    if (!target) return;
  }
  await withGenerating(async () => {
    await generateSection(proj, target.actIdx, target.secIdx, target.flatIdx, setNovelHint);
    setNovelHint(`第 ${target.actIdx + 1} 章 第 ${target.secIdx + 1} 节已生成，请确认或重新生成。`);
  });
  renderNovelUI();
}

/** 自动模式: 依次生成所有未完成节。 */
async function runAutoAll(proj) {
  if (novelState.generating) return;
  collectActsFromDOM(proj);
  if (!totalSectionCount(proj)) return void setNovelHint('请先添加章与节。');
  // 全部完成: 询问是否从头重新生成
  if (!flatSections(proj).some((f) => !f.sec.done)) {
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
      const target = flat.find((f) => !f.sec.done);
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
  const $ = globalThis.jQuery;
  $?.(`#${EXT_ID}-novel [data-act="stop"]`).prop('disabled', false);
  try {
    await fn();
  } catch (e) {
    log.error('生成流程异常:', e);
    setNovelHint(`生成失败: ${e.message}`);
    toast(`生成失败: ${e.message}`);
  } finally {
    novelState.generating = false;
    novelState.cancelRequested = false;
    novelState.currentGenId = '';
    $?.(`#${EXT_ID}-novel [data-act="stop"]`).prop('disabled', true);
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
    novelState.activeActIdx = -1; // 切换项目后不保留展开章
    saveSettings();
    renderNovelUI();
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
      case 'entity-add':
        if (proj) {
          const cur = collectEntitiesFromDOM();
          cur.push('');
          refreshEntityList(cur);
          $(`#${EXT_ID}-novel .ns-entity-input`).last().focus();
        }
        break;
      case 'entity-del':
        if (proj && Number.isInteger(idx)) {
          const cur = collectEntitiesFromDOM();
          cur.splice(idx, 1);
          refreshEntityList(cur);
        }
        break;
      case 'save-meta':
        if (proj) {
          proj.background = String($(`#${EXT_ID}-nv-bg`).val() ?? '');
          proj.entities = collectEntitiesFromDOM().map((e) => e.trim()).filter(Boolean);
          collectActsFromDOM(proj);
          touchProject(proj);
          setNovelHint('已保存背景、人物设定与章-节大纲。');
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
          if (!globalThis.confirm?.('将清空并重新生成所有已完成章的表格总结，确定继续？')) return;
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
            const flat = flatSections(proj);
            const f = flat.find((x) => x.actIdx === ai && x.secIdx === si);
            await withGenerating(async () => {
              await generateSection(proj, ai, si, f ? f.flatIdx : -1, setNovelHint);
              setNovelHint(`第 ${ai + 1} 章 第 ${si + 1} 节已生成。`);
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
  const FLOAT_ID = `${EXT_ID}-float-button`;
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

export { openPanel, closePanel };
