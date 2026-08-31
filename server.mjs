import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { renderLiteratureNoteV5, validateLiteratureNoteV5 } from "./note-v5.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const dataDir = path.resolve(process.env.LITERATURE_WORKBENCH_DATA_DIR || path.join(here, "data"));
const cacheDir = path.join(dataDir, "cache");
const jobsFile = path.join(dataDir, "jobs.json");
const settingsFile = path.join(dataDir, "settings.json");
const credentialsDir = path.join(dataDir, "credentials");
const legacyOpenAIKeyFile = path.join(dataDir, "openai-key.dpapi");
const stageSchemaFile = path.join(here, "config", "stage-output.schema.json");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configuredCodexExe = process.env.CODEX_CLI_PATH || "";
const bundledCodexExe = path.join(codexHome, "plugins", ".plugin-appserver", process.platform === "win32" ? "codex.exe" : "codex");
const codexExe = configuredCodexExe || (fs.existsSync(bundledCodexExe) ? bundledCodexExe : "codex");
const pythonCandidates = [
  process.env.LITERATURE_WORKBENCH_PYTHON,
  process.platform === "win32" ? path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "",
  process.platform === "win32" ? "python" : "python3"
].filter(Boolean);
const pythonExe = pythonCandidates.find(candidate => {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}) || pythonCandidates[0];
const modelConfig = JSON.parse(fs.readFileSync(path.join(here, "config", "models.json"), "utf8"));
const stageOutputSchema = JSON.parse(fs.readFileSync(stageSchemaFile, "utf8"));
const port = Number(process.env.LITERATURE_WORKBENCH_PORT || 8765);
const zoteroBase = process.env.ZOTERO_LOCAL_API || "http://127.0.0.1:23119/api/users/0";
const defaultVaultPath = process.env.OBSIDIAN_VAULT || "";
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(credentialsDir, { recursive: true });

const defaultSettings = {
  vaultPath: defaultVaultPath,
  draftFolder: "01_收件箱/AI草稿",
  libraryFolder: "未分类",
  parallelMode: "smart",
  maxParallelItems: 2,
  singlePaperAgents: true,
  maxParallelStages: 3,
  preset: "library",
  stages: modelConfig.presets.library,
  customProviders: {
    "openai-compatible": { baseUrl: "", model: "" }
  },
  ...modelConfig.presetLimits.library
};
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return structuredClone(fallback); } };
// Optional per-item naming is private runtime data, never bundled in source.
const localNoteOverrides = readJson(path.join(dataDir, "note-overrides.json"), {});
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); };
function normalizeUnifiedConfig(input = {}) {
  const { presets: _legacyPresets, presetLimits: _legacyLimits, ...clean } = input || {};
  const preferredStages = clean.stages || {};
  const stages = Object.fromEntries(modelConfig.stages.map(stage => {
    const recommended = modelConfig.presets.library[stage.id];
    return [stage.id, { ...recommended, ...(preferredStages[stage.id] || {}), enabled: true }];
  }));
  return {
    ...clean,
    preset: "library",
    stages,
    ...modelConfig.presetLimits.library
  };
}
let settings = normalizeUnifiedConfig({ ...defaultSettings, ...readJson(settingsFile, {}) });
writeJson(settingsFile, settings);
let jobs = readJson(jobsFile, []);
let recoveredInterruptedJobs = false;
for (const job of jobs) {
  if (["running", "stopping", "cancelling"].includes(job.status)) {
    job.status = "interrupted"; job.cancelRequested = null;
    job.events ||= []; job.events.push({ at: new Date().toISOString(), stage: "job", state: "interrupted", message: "服务曾意外关闭；已有结果已保留，可继续处理" });
    job.updatedAt = new Date().toISOString(); recoveredInterruptedJobs = true;
  }
}
if (recoveredInterruptedJobs) writeJson(jobsFile, jobs);
let runnerActive = false;
const activeExecutions = new Map();
const jobStageLimiters = new Map();
class CancelledError extends Error {
  constructor(mode = "immediate") { super(mode === "after-stage" ? "已在当前阶段结束后停止" : "任务已立即停止"); this.name = "CancelledError"; this.mode = mode; }
}
const providerEnvKeys = {
  "openai-api": process.env.OPENAI_API_KEY || null,
  "deepseek-api": process.env.DEEPSEEK_API_KEY || null,
  "anthropic-api": process.env.ANTHROPIC_API_KEY || null,
  "openai-compatible": process.env.OPENAI_COMPATIBLE_API_KEY || null
};
const cachedProviderKeys = new Map(Object.entries(providerEnvKeys));
const providerKeyFile = provider => path.join(credentialsDir, `${provider}.dpapi`);

function getProviderKey(provider) {
  if (cachedProviderKeys.get(provider)) return cachedProviderKeys.get(provider);
  if (process.platform !== "win32") return null;
  const encryptedFile = provider === "openai-api" && fs.existsSync(legacyOpenAIKeyFile)
    ? legacyOpenAIKeyFile
    : providerKeyFile(provider);
  if (!fs.existsSync(encryptedFile)) return null;
  const script = "& { param($file) $secure = Get-Content -LiteralPath $file -Raw | ConvertTo-SecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script, encryptedFile], { encoding: "utf8", windowsHide: true });
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (value) cachedProviderKeys.set(provider, value);
  return value || null;
}
function saveProviderKey(provider, key) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("当前系统请通过环境变量配置 API Key；界面加密保存目前仅支持 Windows DPAPI"));
      return;
    }
    const encryptedFile = providerKeyFile(provider);
    const script = "& { param($file) $plain = [Console]::In.ReadToEnd().Trim(); $secure = ConvertTo-SecureString $plain -AsPlainText -Force; $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $file -Encoding ASCII }";
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", script, encryptedFile], { windowsHide: true });
    let error = "";
    ps.stderr.on("data", data => error += data);
    ps.on("exit", code => {
      if (code === 0) { cachedProviderKeys.set(provider, key); resolve(); }
      else reject(new Error(error || `DPAPI 配置失败 (${code})`));
    });
    ps.stdin.end(key);
  });
}
function codexSubscriptionReady() {
  const result = spawnSync(codexExe, ["login", "status"], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
  return !result.error && `${result.stdout || ""}\n${result.stderr || ""}`.includes("Logged in using ChatGPT");
}

function pythonReady() {
  const result = spawnSync(pythonExe, ["--version"], { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function send(res, status, payload, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(payload) : payload);
}
async function body(req) {
  const parts = []; for await (const part of req) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
}
async function zotero(route) {
  const response = await fetch(`${zoteroBase}/${route}`, { headers: { "Zotero-API-Version": "3" } });
  if (!response.ok) throw new Error(`Zotero API ${response.status}: ${route}`);
  return response.json();
}
const plainText = value => String(value || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
const itemView = item => ({
  key: item.key,
  title: plainText(item.data?.title) || "无标题",
  creators: (item.data?.creators || []).map(x => [x.firstName, x.lastName].filter(Boolean).join(" ") || x.name).filter(Boolean),
  year: String(item.data?.date || "").match(/\d{4}/)?.[0] || "",
  itemType: item.data?.itemType,
  doi: item.data?.DOI || "",
  journal: item.data?.publicationTitle || item.data?.proceedingsTitle || "",
  volume: item.data?.volume || "",
  issue: item.data?.issue || "",
  pages: item.data?.pages || "",
  abstract: plainText(item.data?.abstractNote || ""),
  tags: (item.data?.tags || []).map(x => x.tag),
  dateModified: item.data?.dateModified
});
function classify(children) {
  const result = { pdf: [], mineru: [], supplementary: [], other: [] };
  for (const child of children) {
    const title = String(child.data?.title || "");
    const contentType = String(child.data?.contentType || "");
    const entry = { key: child.key, title, contentType, filename: child.data?.filename || "" };
    if (/mineru.*cache/i.test(title) || /\.zip$/i.test(entry.filename)) result.mineru.push(entry);
    else if (/\b(?:supp(?:lementary)?|supporting(?: information)?|si|esi)\b/i.test(title + " " + entry.filename)) result.supplementary.push(entry);
    else if (contentType === "application/pdf" || /\.pdf$/i.test(entry.filename) || title === "PDF") result.pdf.push(entry);
    else result.other.push(entry);
  }
  return result;
}
const pdfInfoCache = new Map();
function inspectPdf(filePath) {
  if (!filePath) return { title: "", pages: 0 };
  if (pdfInfoCache.has(filePath)) return pdfInfoCache.get(filePath);
  const result = spawnSync("pdfinfo", [filePath], { encoding: "utf8", windowsHide: true });
  const text = result.status === 0 ? result.stdout : "";
  const info = {
    title: text.match(/^Title:\s*(.+)$/mi)?.[1]?.trim() || "",
    pages: Number(text.match(/^Pages:\s*(\d+)$/mi)?.[1] || 0)
  };
  pdfInfoCache.set(filePath, info); return info;
}
function extractPdfTextContext(filePath, maxChars = 120_000) {
  if (!filePath || !fs.existsSync(filePath) || !pythonReady()) return "";
  const result = spawnSync(pythonExe, [path.join(here, "scripts", "extract_pdf_text.py"), filePath, String(maxChars)], {
    encoding: "utf8", windowsHide: true, maxBuffer: Math.max(2_000_000, maxChars * 4)
  });
  return result.status === 0 ? result.stdout.trim() : "";
}
const normalizedTitle = value => String(value || "").toLowerCase().replace(/[^a-z0-9\p{Script=Han}]+/gu, "");
async function resolveAttachments(children, itemTitle) {
  const attachments = classify(children);
  const target = normalizedTitle(itemTitle);
  const enriched = await Promise.all(attachments.pdf.map(async entry => {
    const localPath = await filePathFor(entry.key);
    const info = inspectPdf(localPath);
    const text = `${entry.title} ${entry.filename} ${info.title}`;
    let score = 0;
    const pdfTitle = normalizedTitle(info.title);
    if (target && pdfTitle && (target.includes(pdfTitle) || pdfTitle.includes(target))) score += 20;
    if (/supplementary|supporting|\besi\b|esi_gallery|support info|appendix/i.test(text)) score -= 25;
    if (info.pages > 0 && info.pages <= 25) score += 4;
    if (info.pages >= 50) score -= 5;
    return { ...entry, localPath, pdfTitle: info.title, pageCount: info.pages, score };
  }));
  enriched.sort((a, b) => b.score - a.score);
  attachments.pdf = enriched;
  const mainPdf = enriched[0] || null;
  const supportingPdfs = enriched.slice(1).map(entry => ({ ...entry, role: "supporting-pdf" }));
  attachments.supplementary = [...attachments.supplementary, ...supportingPdfs]
    .filter((entry, index, rows) => rows.findIndex(row => row.key === entry.key) === index);
  if (mainPdf) {
    attachments.mineru.sort((a, b) => Number(`${b.title} ${b.filename}`.includes(mainPdf.key)) - Number(`${a.title} ${a.filename}`.includes(mainPdf.key)));
  }
  attachments.mainPdfKey = mainPdf?.key || "";
  attachments.mainMineruKey = attachments.mineru[0]?.key || "";
  attachments.supplementaryMineru = attachments.mineru.slice(1);
  return attachments;
}
async function filePathFor(key) {
  const response = await fetch(`${zoteroBase}/items/${key}/file/view/url`);
  if (!response.ok) return null;
  const value = (await response.text()).trim().replace(/^"|"$/g, "");
  if (!value.startsWith("file:")) return null;
  return fileURLToPath(value);
}
function expandZip(zipPath, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destination, { recursive: true });
    const script = "& { param($zip, $dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }";
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", script, zipPath, destination], { windowsHide: true });
    let error = ""; ps.stderr.on("data", d => error += d);
    ps.on("exit", code => code === 0 ? resolve() : reject(new Error(error || `Expand-Archive exited ${code}`)));
  });
}
function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { path: path.resolve(filePath), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch { return null; }
}
async function expandZipCached(zipPath, destination) {
  const signature = fileSignature(zipPath);
  const markerPath = path.join(destination, ".source-signature.json");
  const cached = readJson(markerPath, null);
  if (signature && cached && cached.path === signature.path && cached.size === signature.size && cached.mtimeMs === signature.mtimeMs && findFile(destination, "full.md")) return;
  await expandZip(zipPath, destination);
  if (signature) writeJson(markerPath, signature);
}
function safeName(value) { return String(value || "文献").replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100); }
async function uploadOpenAIFile(filePath, execution = null) {
  const key = getProviderKey("openai-api");
  if (!key) throw new Error("未配置 OPENAI_API_KEY");
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "application/pdf" }), path.basename(filePath));
  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { "authorization": `Bearer ${key}` },
    body: form,
    signal: execution?.controller.signal
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI Files API ${response.status}`);
  return payload.id;
}
const analysisQualityRequirements = stage => `所有处理模式（包括最简单模式）都必须保留以下核心质量要求：
0. 首先填写 documentType：原创研究为 research_article，叙述性综述为 review，系统综述为 systematic_review，Meta 分析为 meta_analysis，观点/展望为 perspective。不得仅因材料科学论文包含背景综述就误判为综述。
1. 创新点必须拆成互不重复的独立发现，每条使用“短标签：具体贡献”的写法，说明相对既有方法新在哪里，禁止把背景或普通结果冒充创新。
2. 实验方法必须按“配方/材料—样品与对照—设备与环境—工艺步骤—表征/测试”拆分；claim 以不超过 12 个汉字的环节名开头，随后用分号列出浓度、配比、温度、时间、电压、压力、气氛、尺寸、速率等可复现实数值。不得把整段方法压成一条长句。
3. 关键结果必须优先保留绝对值、基线/对照值、变化幅度、误差、样本条件和单位。原文有数值时，禁止只写“出现信号、显著提高、性能优异”等定性结论。
4. 每种关键表征至少单列一条 finding。FT-IR、Raman、XRD、XPS、NMR、DSC、TGA 等必须提取峰位、化学位移、结合能、温度或失重区间及其归属；力学、热学、电化学、渗透和生物测试必须提取测试条件与定量结果。
5. evidence 字段用于写“数据及其证明什么”，source 字段写准确图表、章节或 PDF 页码；claim 不得重复 evidence。
6. 所有任务执行统一入库标准：不得省略核心配方、关键实验参数、表征峰位、主要性能数值、关键对照、图文对应与证据定位。
7. record 是唯一的 V5 笔记中间数据：全文阶段填写 researchQuestions、innovations、limitations；方法阶段填写 methods、samplesControls、characterizations；PDF阶段填写 results、figures、characterizations、claims、pending；关系阶段填写 relations；综合阶段对所有字段去重补全。当前阶段不负责的数组必须返回空数组，不能省略字段。
8. results 中 value、baseline、change、condition 必须分字段填写；原文没有时填写空字符串，禁止用“显著提高”替代数值。figureRefs 只能填写原文明确引用的 Fig/Figure/Scheme 编号。
9. 禁止浏览网络或使用新闻稿、机构网页、搜索摘要等外部来源补充论文内容。只能使用输入中提供的 Zotero 元数据、MinerU Markdown、原始 PDF 分页文本层、图清单和支持材料；视觉图形中无法从文本层可靠读取的数据必须列入 pending。
10. 若 documentType 属于 review、systematic_review、meta_analysis 或 perspective，不得套用原创实验论文逻辑：methods 填写检索/纳入范围、分类框架、比较维度与证据评价方法；samplesControls 填写所覆盖的材料/方法类别及参照维度；results 填写互不重复的核心综合结论、共识、争议、趋势和边界条件；claims 填写综述主张及其引用证据范围。叙述性综述没有原始实验数值时必须如实保留定性证据，禁止虚构配方、样品或定量结果。`;
async function openAI(stage, profile, input, fileId = null, limits = {}, execution = null) {
  const key = getProviderKey("openai-api");
  if (!key) throw new Error("未配置 OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
    signal: execution?.controller.signal,
    body: JSON.stringify({
      model: profile.model,
      reasoning: { effort: profile.effort },
      max_output_tokens: Math.max(1600, Number(limits.maxFindings || 12) * 260),
      prompt_cache_key: `literature-v5-${stage}`,
      instructions: `你是材料科学文献分析助手。当前阶段：${stage}。noteTitle 必须给出准确、简洁、适合作为 Obsidian 文件名的中文学术短标题（不含作者和年份）。libraryFolder 必须依据当前论文主题给出稳定、简洁的中文知识库目录；作者关系或阅读任务背景不能代替内容分类。用户给出的优先级、用途和关注方向属于任务要求，应据此调整分析重点，但不得把它们当作论文事实证据。区分作者结论、AI推论和待核验项；不得虚构页码、数值或支持材料。${analysisQualityRequirements(stage)}`,
      input: fileId ? [{ role: "user", content: [
        { type: "input_text", text: input },
        { type: "input_file", file_id: fileId }
      ] }] : input,
      text: { verbosity: "low", format: { type: "json_schema", name: "literature_stage", strict: true, schema: stageOutputSchema } }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI API ${response.status}`);
  const outputText = payload.output_text || (payload.output || [])
    .flatMap(item => item.content || [])
    .filter(content => content.type === "output_text")
    .map(content => content.text)
    .join("");
  if (!outputText) throw new Error("模型响应中没有可解析的结构化文本");
  return JSON.parse(outputText);
}
const stageInstructions = (stage, limits) => `你是材料科学文献分析助手。当前阶段：${stage}。noteTitle 必须给出准确、简洁、适合作为 Obsidian 文件名的中文学术短标题（不含作者和年份）。libraryFolder 必须依据当前论文主题给出稳定、简洁的中文知识库目录；作者关系或阅读任务背景不能代替内容分类。最多输出 ${limits.maxFindings || 12} 条高价值发现。必须输出 JSON，结构严格符合给定 schema；区分作者结论、AI推论和待核验项，不得虚构页码、数值、图号或支持材料。用户给出的优先级、用途和关注方向属于任务要求，应据此调整分析深度与重点；其中涉及论文内容的陈述仍须依据正文、PDF或支持材料核验，不得强行归并主题、作者身份或研究结论。${analysisQualityRequirements(stage)}`;

async function openAICompatible(stage, profile, input, limits = {}, execution = null) {
  const provider = profile.provider;
  const key = getProviderKey(provider);
  if (!key) throw new Error(`未配置 ${provider} API Key`);
  const custom = settings.customProviders?.[provider] || {};
  const baseUrl = provider === "deepseek-api" ? "https://api.deepseek.com" : String(custom.baseUrl || "").replace(/\/$/, "");
  const model = profile.model === "__custom__" ? custom.model : profile.model;
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw new Error("自定义 API Base URL 无效");
  if (!model) throw new Error("尚未配置自定义模型 ID");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
    signal: execution?.controller.signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${stageInstructions(stage, limits)}\nJSON Schema：${JSON.stringify(stageOutputSchema)}` },
        { role: "user", content: input }
      ],
      response_format: { type: "json_object" },
      max_tokens: Math.max(1600, Number(limits.maxFindings || 12) * 260),
      stream: false
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `${provider} API ${response.status}`);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} 没有返回可解析文本`);
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
}

async function anthropic(stage, profile, input, pdfPath = null, limits = {}, execution = null) {
  const key = getProviderKey("anthropic-api");
  if (!key) throw new Error("未配置 Anthropic API Key");
  const content = [{ type: "text", text: input }];
  if (pdfPath) content.push({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(pdfPath).toString("base64") }
  });
  const maxTokens = Math.max(1600, Number(limits.maxFindings || 12) * 260);
  const payload = {
    model: profile.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: stageInstructions(stage, limits), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: stageOutputSchema } }
  };
  if (profile.effort && profile.effort !== "none") {
    payload.thinking = { type: "adaptive" };
    payload.output_config.effort = profile.effort;
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: execution?.controller.signal
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Anthropic API ${response.status}`);
  const text = (result.content || []).filter(x => x.type === "text").map(x => x.text).join("");
  if (!text) throw new Error("Claude 没有返回可解析文本");
  return JSON.parse(text);
}
function codexModel(stage, profile, input, pdfPath = null, limits = {}, execution = null) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(cacheDir, "codex-output"); fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${Date.now()}-${crypto.randomUUID()}.json`);
    const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-m", profile.model, "-c", `model_reasoning_effort=\"${profile.effort}\"`, "--output-schema", stageSchemaFile, "-o", outputPath, "-"];
    const child = spawn(codexExe, args, { cwd: here, windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
    if (execution) {
      execution.child = child;
      execution.children ||= new Set();
      execution.children.add(child);
    }
    let diagnostics = "";
    let timedOut = false;
    const timeoutMs = Math.max(1, Number(limits.stageTimeoutMinutes || 6)) * 60_000;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stderr.on("data", data => diagnostics = (diagnostics + data).slice(-8000));
    child.on("error", error => { clearTimeout(timer); execution?.children?.delete(child); reject(error); });
    child.on("exit", code => {
      clearTimeout(timer);
      execution?.children?.delete(child);
      if (execution?.child === child) execution.child = null;
      if (execution?.cancelMode === "immediate") return reject(new CancelledError("immediate"));
      if (timedOut) return reject(new Error(`阶段超时：超过 ${limits.stageTimeoutMinutes || 6} 分钟`));
      if (code !== 0) return reject(new Error(`Codex 订阅通道失败 (${code})：${diagnostics.trim()}`));
      try {
        const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        fs.unlinkSync(outputPath); resolve(parsed);
      } catch (error) { reject(new Error(`Codex 输出解析失败：${error.message}`)); }
    });
    const instructions = `你是材料科学文献分析助手。当前阶段：${stage}。noteTitle 必须给出准确、简洁、适合作为 Obsidian 文件名的中文学术短标题（不含作者和年份）。libraryFolder 必须依据当前论文主题给出稳定、简洁的中文知识库目录；作者关系或阅读任务背景不能代替内容分类。最多输出 ${limits.maxFindings || 12} 条高价值发现，每条必须选择 category。综合全文阶段应覆盖 overview、method、evidence、critique；PDF阶段只核验关键数值、图表、公式和解析异常；关系阶段只输出 relation。用户给出的优先级、用途和关注方向属于任务要求，应据此调整分析深度与重点；其中涉及论文内容的陈述仍须依据正文、PDF或支持材料核验。区分作者明确结论、AI推论和待核验项，不得虚构页码、数值、图号或支持材料。禁止浏览网络；原始 PDF 的分页文本层和图清单已直接放入输入，不要尝试启动外部 PDF 程序。只输出符合指定 JSON Schema 的结果。${analysisQualityRequirements(stage)}`;
    child.stdin.end(`${instructions}\n\n${input}${pdfPath ? `\n\n原始 PDF 本地路径（仅用于核验）：${pdfPath}` : ""}`);
  });
}
async function runModel(stage, profile, input, pdfPath = null, limits = {}, execution = null) {
  const provider = profile.provider || "codex-subscription";
  if (provider === "codex-subscription") return codexModel(stage, profile, input, pdfPath, limits, execution);
  if (provider === "openai-api") {
    let fileId = null;
    if (pdfPath) fileId = await uploadOpenAIFile(pdfPath, execution);
    return openAI(stage, profile, input, fileId, limits, execution);
  }
  if (provider === "deepseek-api" || provider === "openai-compatible") {
    if (pdfPath) throw new Error(`${provider} 当前不支持原始 PDF 核验，请选择 Codex、OpenAI 或 Claude`);
    return openAICompatible(stage, profile, input, limits, execution);
  }
  if (provider === "anthropic-api") return anthropic(stage, profile, input, pdfPath, limits, execution);
  throw new Error(`尚未实现的模型提供商：${provider}`);
}
function addEvent(job, stage, state, message) {
  job.events.push({ at: new Date().toISOString(), stage, state, message });
  job.updatedAt = new Date().toISOString(); writeJson(jobsFile, jobs);
}
function setItemProgress(job, itemKey, patch) {
  job.activeItems ||= {};
  job.activeItems[itemKey] = { ...(job.activeItems[itemKey] || {}), itemKey, ...patch, updatedAt: new Date().toISOString() };
  job.currentItemKey = itemKey;
  job.currentItemTitle = job.activeItems[itemKey].title || job.currentItemTitle;
  job.currentStage = job.activeItems[itemKey].stage || job.currentStage;
  writeJson(jobsFile, jobs);
}
function resolvedParallelItems(config) {
  if (config.parallelMode !== "smart") return Math.max(1, Math.min(3, Number(config.maxParallelItems || 2)));
  return ({ quick: 3, standard: 2, deep: 1, library: 2 })[config.preset] || 2;
}
function isConcurrencyPressure(error) {
  return /(?:429|rate.?limit|too many requests|capacity|overloaded|usage.?limit|quota|并发|频率|额度)/i.test(String(error?.message || error));
}
async function runPool(tasks, limit) {
  let cursor = 0;
  const results = new Array(tasks.length);
  const workers = Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(result => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}
function createAsyncLimiter(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift(); active++;
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => { active--; drain(); });
    }
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}
function registerExecution(jobId, execution) {
  const group = activeExecutions.get(jobId) || new Set();
  group.add(execution); activeExecutions.set(jobId, group);
}
function unregisterExecution(jobId, execution) {
  const group = activeExecutions.get(jobId); if (!group) return;
  group.delete(execution); if (!group.size) activeExecutions.delete(jobId);
}
async function runItem(job, itemKey, execution, options = {}) {
  job.config.batchName ||= job.batchName;
  setItemProgress(job, itemKey, { title: null, stage: "metadata", state: "running" });
  const item = await zotero(`items/${itemKey}`);
  const view = itemView(item);
  setItemProgress(job, itemKey, { title: view.title, stage: "metadata" });
  addEvent(job, "metadata", "completed", `读取 ${view.title}`);
  setItemProgress(job, itemKey, { stage: "attachments" });
  const attachments = await resolveAttachments(await zotero(`items/${itemKey}/children`), view.title);
  addEvent(job, "attachments", "completed", `PDF ${attachments.pdf.length} · MinerU ${attachments.mineru.length} · SI ${attachments.supplementary.length}`);
  let markdown = "";
  if (attachments.mineru[0]) {
    const zipPath = await filePathFor(attachments.mineru[0].key);
    const dest = path.join(cacheDir, itemKey);
    if (zipPath) { await expandZipCached(zipPath, dest); const full = findFile(dest, "full.md"); if (full) markdown = fs.readFileSync(full, "utf8"); }
  }
  const supplementaryMarkdownBlocks = [];
  for (const cache of attachments.supplementaryMineru || []) {
    const zipPath = await filePathFor(cache.key);
    const dest = path.join(cacheDir, itemKey, "supplementary", cache.key);
    if (!zipPath) continue;
    await expandZipCached(zipPath, dest);
    const full = findFile(dest, "full.md");
    if (full) supplementaryMarkdownBlocks.push(`【支持材料 MinerU：${cache.key}】\n${fs.readFileSync(full, "utf8")}`);
  }
  const batchContext = String(job.config.batchContext || "").trim().slice(0, 1200);
  const metadataContext = `题目：${view.title}\n作者：${view.creators.join(", ")}\n年份：${view.year}\nDOI：${view.doi}\n摘要：${view.abstract || "未提供"}\n附件：${JSON.stringify(attachments)}${batchContext ? `\n用户提供的阅读任务背景与优先级要求（不作为论文事实证据）：${batchContext}` : ""}`;
  const maxMarkdownChars = Math.max(20_000, Number(job.config.maxMarkdownChars || 120_000));
  const mainMarkdownPart = markdown.slice(0, Math.min(markdown.length, Math.floor(maxMarkdownChars * 0.7)));
  const supplementaryMarkdown = supplementaryMarkdownBlocks.join("\n\n");
  const supplementaryMarkdownPart = supplementaryMarkdown.slice(0, Math.max(0, maxMarkdownChars - mainMarkdownPart.length));
  const markdownContext = `${metadataContext}\n\n【主文 MinerU Markdown】\n${mainMarkdownPart}${supplementaryMarkdownPart ? `\n\n【支持材料 MinerU Markdown】\n${supplementaryMarkdownPart}` : ""}`;
  const outputs = { ...(job.stageResults?.[itemKey] || {}) };
  const sourcePdfPath = attachments.pdf[0]?.localPath || (attachments.pdf[0] ? await filePathFor(attachments.pdf[0].key) : null);
  const supportingPdfPaths = (await Promise.all((attachments.supplementary || []).map(async entry => entry.localPath || await filePathFor(entry.key)))).filter(Boolean);
  const mainPdfAttachmentKey = attachments.pdf[0]?.key || "main";
  const figureAssets = sourcePdfPath ? prepareFigureAssets(sourcePdfPath, itemKey, mainPdfAttachmentKey, job.config) : [];
  const rawPdfBudget = Math.min(maxMarkdownChars, 180_000);
  const mainPdfText = extractPdfTextContext(sourcePdfPath, Math.floor(rawPdfBudget * 0.55));
  let remainingPdfBudget = Math.max(0, rawPdfBudget - mainPdfText.length);
  const supportingPdfTexts = [];
  for (const pdfPath of supportingPdfPaths) {
    if (remainingPdfBudget < 2_000) break;
    const text = extractPdfTextContext(pdfPath, remainingPdfBudget);
    if (text) supportingPdfTexts.push(`【支持材料 PDF：${path.basename(pdfPath)}】\n${text}`);
    remainingPdfBudget -= text.length;
  }
  const figureManifestContext = figureAssets.map(asset => `${asset.label || "未编号图"} | PDF p.${asset.page || "?"} | ${asset.caption || "无可提取图注"}`).join("\n");
  const pdfEvidenceContext = `【主文原始 PDF 分页文本层】\n${mainPdfText || "未提取到文本层"}${supportingPdfTexts.length ? `\n\n【支持材料原始 PDF 分页文本层】\n${supportingPdfTexts.join("\n\n")}` : ""}\n\n【主文原图清单】\n${figureManifestContext || "未提取到图清单"}`;
  let cancellation = null;
  const runStage = async stage => {
    if (job.cancelRequested) throw new CancelledError(job.cancelRequested);
    const profile = job.config.stages[stage.id];
    if (!profile?.enabled) { addEvent(job, stage.id, "skipped", "阶段已关闭"); return; }
    if (outputs[stage.id]) { addEvent(job, stage.id, "skipped", "使用已保存的阶段结果"); return; }
    if (options.rerenderOnly) { addEvent(job, stage.id, "skipped", "历史任务重排：该阶段没有旧结果，不调用模型"); return; }
    if (stage.id === "pdf_verification" && !attachments.pdf.length) { addEvent(job, stage.id, "skipped", "没有主文 PDF"); return; }
    const compactPrior = JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([id, result]) => [id, { documentType: result.documentType, summary: result.summary, findings: result.findings, record: result.record, warnings: result.warnings }])));
    const stageInput = ["fulltext_analysis", "method_evidence"].includes(stage.id)
      ? markdownContext
      : stage.id === "pdf_verification"
        ? `${metadataContext}\n\n${pdfEvidenceContext}\n\n请只依据上述原始 PDF 分页文本层、主文图清单和支持材料独立核验关键图表、数值、公式及 Markdown 疑似解析问题。不要访问网络；纯视觉曲线中无法由文本层确认的数值必须列入 pending。`
        : `${metadataContext}\n\n前序结构化结果：${compactPrior}`;
    const activeStages = new Set(job.activeItems?.[itemKey]?.activeStages || []); activeStages.add(stage.id);
    setItemProgress(job, itemKey, { stage: stage.id, activeStages: [...activeStages] });
    addEvent(job, stage.id, "running", `${profile.provider || "codex-subscription"} · ${profile.model} · ${profile.effort} · 约 ${Math.ceil(stageInput.length / 4).toLocaleString()} 输入 tokens`);
    let pdfPath = null;
    if (stage.id === "pdf_verification") {
      if (!sourcePdfPath) throw new Error("无法读取 Zotero 主文 PDF 的本地路径");
      pdfPath = path.join(cacheDir, itemKey, safeName(path.basename(sourcePdfPath)));
      fs.copyFileSync(sourcePdfPath, pdfPath);
    }
    try {
      const limiter = jobStageLimiters.get(job.id);
      const invoke = () => {
        if (job.cancelRequested) throw new CancelledError(job.cancelRequested);
        return runModel(stage.id, profile, stageInput, pdfPath, job.config, execution);
      };
      outputs[stage.id] = limiter ? await limiter(invoke) : await invoke();
      outputs[stage.id].findings = outputs[stage.id].findings.slice(0, Number(job.config.maxFindings || 12));
      job.stageResults ||= {}; job.stageResults[itemKey] ||= {}; job.stageResults[itemKey][stage.id] = outputs[stage.id]; writeJson(jobsFile, jobs);
      addEvent(job, stage.id, "completed", `${outputs[stage.id].findings.length} 条发现`);
      if (job.cancelRequested === "after-stage") throw new CancelledError("after-stage");
    } catch (error) {
      if (error instanceof CancelledError || job.cancelRequested) throw error instanceof CancelledError ? error : new CancelledError(job.cancelRequested);
      if (isConcurrencyPressure(error)) throw error;
      if (stage.id === "fulltext_analysis") throw error;
      outputs[stage.id] = { summary: `${stage.label}未完成`, findings: [], warnings: [error.message] };
      addEvent(job, stage.id, "failed", `${error.message}；已跳过并继续生成草稿`);
    } finally {
      const remaining = new Set(job.activeItems?.[itemKey]?.activeStages || []); remaining.delete(stage.id);
      setItemProgress(job, itemKey, { activeStages: [...remaining] });
    }
  };
  try {
    const initialIds = new Set(["fulltext_analysis", "method_evidence", "pdf_verification"]);
    const initialStages = modelConfig.stages.filter(stage => initialIds.has(stage.id));
    const laterStages = modelConfig.stages.filter(stage => !initialIds.has(stage.id));
    const useStageAgents = job.config.singlePaperAgents !== false && !options.rerenderOnly;
    if (useStageAgents) {
      const stageLimit = Math.max(1, Math.min(3, Number(job.config.maxParallelStages || 2)));
      job.runtimeParallelStages = stageLimit;
      addEvent(job, "stage_agents", "running", `受控多 Agent：本篇第一波最多 ${stageLimit} 个阶段并行，全批次共享并发上限`);
      try {
        await runPool(initialStages.map(stage => () => runStage(stage)), stageLimit);
      } catch (error) {
        if (!job.cancelRequested && stageLimit > 1 && isConcurrencyPressure(error)) {
          job.runtimeParallelStages = 1;
          addEvent(job, "stage_agents", "running", "模型通道拥堵，单篇阶段已降为单 Agent，并复用已完成阶段");
          for (const stage of initialStages) await runStage(stage);
        } else throw error;
      }
      for (const stage of laterStages) await runStage(stage);
    } else {
      for (const stage of modelConfig.stages) await runStage(stage);
    }
  } catch (error) {
    if (error instanceof CancelledError) cancellation = error;
    else throw error;
  }
  const draftRoot = path.resolve(job.config.vaultPath, job.config.draftFolder, job.batchName);
  if (!draftRoot.startsWith(path.resolve(job.config.vaultPath) + path.sep)) throw new Error("草稿目录越界");
  fs.mkdirSync(draftRoot, { recursive: true });
  const noteOverride = localNoteOverrides[itemKey] || {};
  const generatedTitle = Object.values(outputs).map(result => result?.noteTitle).find(Boolean);
  const noteTitle = noteOverride.title || generatedTitle || view.title.slice(0, 42);
  const filename = `${safeName(view.creators[0]?.split(" ").at(-1) || "Unknown")}-${view.year || "n.d."}-${safeName(noteTitle)}.md`;
  setItemProgress(job, itemKey, { stage: "figure_extraction" });
  let note = renderLiteratureNoteV5(view, itemKey, attachments, outputs, { ...job.config, noteOverrides: localNoteOverrides }, figureAssets);
  if (cancellation) note = note.replace("处理状态: 完整\n", "处理状态: 部分\n").replace(/^(# .+)$/m, `$1\n\n> [!warning] 部分处理结果\n> 任务已停止；本笔记仅包含停止前完成的阶段，可在工作台继续处理后自动完善。`);
  setItemProgress(job, itemKey, { stage: "write_note" });
  const targetPath = path.join(draftRoot, filename);
  const existingPath = fs.readdirSync(draftRoot).filter(name => name.endsWith(".md")).map(name => path.join(draftRoot, name)).find(file => {
    const content = fs.readFileSync(file, "utf8");
    return content.includes(`Zotero条目键: ${itemKey}`) || content.includes(`zotero_item_key: ${itemKey}`);
  });
  if (existingPath && existingPath !== targetPath) fs.renameSync(existingPath, targetPath);
  if (fs.existsSync(targetPath)) note = preserveHumanBlocks(fs.readFileSync(targetPath, "utf8"), note);
  fs.writeFileSync(targetPath, note, "utf8");
  if (cancellation) {
    job.partialItemKeys ||= []; if (!job.partialItemKeys.includes(itemKey)) job.partialItemKeys.push(itemKey);
    addEvent(job, "write_note", "completed", `部分草稿：${filename}`);
    throw cancellation;
  }
  setItemProgress(job, itemKey, { stage: "quality_gate" });
  const quality = validateLiteratureNoteV5(note, Boolean(sourcePdfPath), figureAssets.length, job.config.preset);
  if (!quality.ok) {
    note = note.replace("处理状态: 完整\n", "处理状态: 部分\n").replace(/^(# .+)$/m, `> [!warning] 质量门禁未通过\n> ${quality.issues.join("；")}。本笔记保留在草稿区，不应直接入库。\n\n$1`);
    fs.writeFileSync(targetPath, note, "utf8");
    job.partialItemKeys ||= []; if (!job.partialItemKeys.includes(itemKey)) job.partialItemKeys.push(itemKey);
    job.completedItemKeys = (job.completedItemKeys || []).filter(key => key !== itemKey);
    addEvent(job, "quality_gate", "failed", quality.issues.join("；"));
    throw new Error(`笔记质量门禁未通过：${quality.issues.join("；")}`);
  }
  job.completedItemKeys ||= []; if (!job.completedItemKeys.includes(itemKey)) job.completedItemKeys.push(itemKey);
  job.partialItemKeys = (job.partialItemKeys || []).filter(key => key !== itemKey);
  job.currentStage = "item_complete";
  setItemProgress(job, itemKey, { stage: "item_complete", state: "completed" });
  addEvent(job, "write_note", "completed", filename);

  const auditRoot = path.resolve(job.config.vaultPath, "99_系统", "AI日志");
  if (auditRoot.startsWith(path.resolve(job.config.vaultPath) + path.sep)) {
    writeJson(path.join(auditRoot, `${itemKey}.json`), {
      zoteroItemKey: itemKey,
      noteFile: targetPath,
      batchName: job.batchName,
      preset: job.config.preset,
      stages: job.config.stages,
      limits: { maxMarkdownChars: job.config.maxMarkdownChars, maxFindings: job.config.maxFindings, stageTimeoutMinutes: job.config.stageTimeoutMinutes },
      promptVersion: "literature-note-v5",
      schemaVersion: 5,
      generatedAt: new Date().toISOString()
    });
  }
}
function prepareFigureAssets(pdfPath, itemKey, pdfAttachmentKey, config) {
  try {
    if (!pythonReady()) return [];
    // Keep the main article and every supporting PDF in independent caches.
    // A shared item-level directory previously allowed a 91-page SI extraction
    // to replace the main article's figure manifest, producing unrelated or
    // missing images in the final note.
    const extractionRoot = path.join(cacheDir, itemKey, "pdf-images", safeName(pdfAttachmentKey || "main"));
    const signature = fileSignature(pdfPath);
    const markerPath = path.join(extractionRoot, ".source-signature.json");
    const cached = readJson(markerPath, null);
    const cacheValid = signature && cached?.extractorVersion === 3 && cached.path === signature.path && cached.size === signature.size && cached.mtimeMs === signature.mtimeMs && fs.existsSync(path.join(extractionRoot, "figure-manifest.json"));
    if (!cacheValid) {
      const result = spawnSync(pythonExe, [path.join(here, "scripts", "extract_pdf_images.py"), pdfPath, extractionRoot], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) return [];
      if (signature) writeJson(markerPath, { ...signature, extractorVersion: 3 });
    }
    const figureRoot = fs.existsSync(path.join(extractionRoot, "figures")) ? path.join(extractionRoot, "figures") : path.join(extractionRoot, "embedded");
    const manifest = readJson(path.join(extractionRoot, "figure-manifest.json"), { figures: [] });
    const candidates = manifest.figures.length ? manifest.figures
      .filter(row => fs.existsSync(path.join(figureRoot, row.file)))
      .map(row => ({ ...row, name: row.file, path: path.join(figureRoot, row.file) }))
      .slice(0, 12)
      : [];
    const assetRoot = path.resolve(config.vaultPath, "90_附件", "文献", itemKey);
    if (!assetRoot.startsWith(path.resolve(config.vaultPath) + path.sep)) return [];
    fs.mkdirSync(assetRoot, { recursive: true });
    return candidates.map(entry => {
      const filename = `原文-${entry.name}`;
      fs.copyFileSync(entry.path, path.join(assetRoot, filename));
      return { ...entry, path: `90_附件/文献/${itemKey}/${filename}` };
    });
  } catch { return []; }
}
/** @deprecated 仅用于读取历史代码；活动质量门禁为 validateLiteratureNoteV5。 */
function legacyValidateNoteQualityV4(note, hasPdf, expectedFigures = 0) {
  const required = ["文献信息卡片", "研究背景与核心问题", "创新点", "实验方法", "标准化实验条件卡", "关键结果", "核心主张—证据表", "结论", "局限性", "速查卡", "待核验"];
  const issues = required.filter(heading => !note.includes(heading)).map(heading => `缺少“${heading}”`);
  if (hasPdf && !/!\[\[90_附件\/文献\//.test(note)) issues.push("原始 PDF 存在但笔记没有原文图片");
  const imageCount = (note.match(/!\[\[90_附件\/文献\//g) || []).length;
  if (expectedFigures >= 3 && imageCount < 3) issues.push(`已提取 ${expectedFigures} 张候选原图，但笔记只嵌入 ${imageCount} 张`);
  const innovationSection = note.match(/## 二、创新点[\s\S]*?(?=\n## )/)?.[0] || "";
  const innovationCount = (innovationSection.match(/^\d+\.\s+\*\*/gm) || []).length;
  if (innovationCount < 3) issues.push(`创新点未拆成清晰的独立条目（当前 ${innovationCount} 条）`);
  const methodSection = note.match(/### 3\.2 关键实验条件[\s\S]*?(?=\n### |\n## )/)?.[0] || "";
  const methodCount = (methodSection.match(/^- \*\*/gm) || []).length;
  if (methodCount < 3) issues.push(`关键实验条件不够清晰或缺少可复现参数（当前 ${methodCount} 条）`);
  const numericEvidenceCount = (note.match(/\d+(?:\.\d+)?\s*(?:wt%|vol%|at%|mol%|mM|μM|M|mV|V|°C|min|h|s|nm|μm|mm|cm|Pa|kPa|MPa|GPa|ppm|%)/gi) || []).length;
  if (hasPdf && numericEvidenceCount < 8) issues.push(`定量实验与结果不足（当前识别 ${numericEvidenceCount} 处带单位数据）`);
  if (/(?:FT-?IR|红外)/i.test(note) && !/cm[⁻−–-]?¹|cm[−–-]?1/i.test(note)) issues.push("提及红外表征但没有给出峰位及归属");
  return { ok: !issues.length, issues };
}

function distinctFindings(outputs) {
  const priority = ["note_synthesis", "pdf_verification", "method_evidence", "fulltext_analysis", "relation_discovery"];
  const rows = priority.flatMap(stage => (outputs[stage]?.findings || []).map(row => ({ stage, ...row })));
  const tokens = value => new Set(String(value || "").replace(/^【[^】]+】/, "").replace(/[\s，。；：、（）()·—\-]/g, "").toLowerCase().match(/[\p{Script=Han}]|[a-z0-9.%]+/gu) || []);
  const kept = [];
  for (const row of rows) {
    const current = tokens(row.claim);
    const duplicate = kept.some(old => {
      if (old.category !== row.category) return false;
      const previous = tokens(old.claim);
      const overlap = [...current].filter(token => previous.has(token)).length;
      return overlap / Math.max(1, Math.min(current.size, previous.size)) >= 0.72;
    });
    if (!duplicate) kept.push(row);
  }
  return kept;
}

/** @deprecated 仅保留历史迁移参考；活动渲染器位于 note-v5.mjs。 */
function legacyRenderLibraryNoteV4(item, key, attachments, outputs, config, figureAssets = []) {
  const clean = value => String(value || "").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  const yaml = value => String(value || "").replaceAll('"', '\\"');
  const rows = distinctFindings(outputs);
  const take = (category, count) => rows.filter(row => row.category === category).slice(0, count);
  const overview = take("overview", 4), methods = take("method", 8), evidence = take("evidence", 7);
  const figures = take("figure", 6), critique = take("critique", 5), relations = take("relation", 5);
  const warnings = [...new Set(Object.values(outputs).flatMap(result => result?.warnings || []).map(clean).filter(Boolean))].slice(0, 6);
  const suggestedTitle = Object.values(outputs).map(result => clean(result?.noteTitle)).find(Boolean);
  const noteOverride = config.noteOverrides?.[key] || {};
  const cnTitle = noteOverride.title || suggestedTitle || item.title;
  const proposedFolder = [outputs.note_synthesis, outputs.fulltext_analysis, outputs.method_evidence].map(result => clean(result?.libraryFolder)).find(value => value && !/[\\/]/.test(value) && /\p{Script=Han}/u.test(value));
  const fallbackFolder = clean(config.libraryFolder);
  const folder = noteOverride.folder || proposedFolder || (/\p{Script=Han}/u.test(fallbackFolder) ? fallbackFolder : "未分类");
  const firstAuthor = item.creators[0]?.split(" ").at(-1) || "Unknown";
  const displayTitle = `${firstAuthor} et al. (${item.year || "n.d."}) — ${cnTitle}`;
  const models = Object.entries(config.stages).filter(([, value]) => value.enabled).map(([stage, value]) => `${stage}:${value.provider || "codex-subscription"}/${value.model}/${value.effort}`).join("; ");
  const pdfResult = outputs.pdf_verification;
  const pdfVerified = Boolean(pdfResult) && ![pdfResult.summary, ...(pdfResult.warnings || [])].some(text => /未能|无法|未直接|未完成.*PDF/.test(String(text)));
  const emphasizeNumbers = value => clean(value).replace(/(?:[~≈<>≤≥]?\s*)?\d+(?:\.\d+)?(?:\s*(?:±|–|-|至|to)\s*\d+(?:\.\d+)?)?\s*(?:wt%|vol%|at%|mol%|mM|μM|M|mV|V|mA|A|°C|min|h|s|nm|μm|mm|cm|mL|μL|L|Pa|kPa|MPa|GPa|g\s*cm[−–-]?3|g\/cm³|cm[−–-]?1|ppm|kΩ\/sq|F\s*g[−–-]?1|L\s*m[−–-]?2\s*h[−–-]?1\s*bar[−–-]?1|%)/gi, match => `**${match.trim()}**`);
  const methodName = (row, index) => {
    const claim = clean(row.claim.replace(/^【[^】]+】/, ""));
    const explicit = claim.match(/^([^：:；;]{2,14})[：:]/)?.[1];
    if (explicit) return explicit;
    const rules = [[/配方|浓度|单体|溶液/, "配方与反应液"], [/电极|电压|电位|电化学/, "电化学体系"], [/温度|时间|聚合|成膜/, "成膜工艺"], [/对照|参照|空白/, "对照设计"], [/表征|FT-?IR|XPS|NMR|SEM|TEM|AFM/, "表征方法"], [/渗透|过滤/, "渗透测试"], [/力学|拉伸|压缩|鼓泡/, "力学测试"], [/碳化|热处理/, "后处理"]];
    return rules.find(([pattern]) => pattern.test(claim))?.[1] || `步骤 ${index + 1}`;
  };
  const methodDetails = row => {
    const claim = clean(row.claim.replace(/^【[^】]+】/, ""));
    return claim.replace(/^([^：:；;]{2,14})[：:]\s*/, "");
  };
  const methodTable = methods.map((row, index) => `| **${methodName(row, index)}** | ${emphasizeNumbers(methodDetails(row))} | ${clean(row.source)} | ${row.confidence} |`).join("\n") || "| 待补充 |  |  |  |";
  const evidenceTable = evidence.concat(critique.slice(0, 2)).map(row => `| ${clean(row.claim)} | ${clean(row.evidence)} | ${clean(row.source)} | ${row.confidence} |`).join("\n") || "| 待补充 |  |  |  |";
  const shortHeading = row => {
    const value = clean(row.claim.replace(/^【[^】]+】/, "")).replace(/^(作者明确结论|AI推论|AI评估|待核验项)[：:]?/, "");
    const clause = value.split(/(?:数据称为|据称(?:依次)?为|据称从|具体数值|分别为)|[。；]|，(?=(?:但|而|且|并|其中|说明|表明|体现))/)[0].trim();
    return clause.length > 52 ? `${clause.slice(0, 52).replace(/[\s，。；：,]$/, "")}…` : clause.replace(/[。；：,，]$/, "");
  };
  const assetPath = asset => typeof asset === "string" ? asset : asset?.path;
  const normalizedFigureLabel = value => String(value || "").toLowerCase().replace(/figure/g, "fig").replace(/[.\s]/g, "");
  const methodFigure = figureAssets.find(asset => /scheme|fabrication|synthetic route|preparation|strategy|process|制备|路线|示意/i.test(`${asset.label || ""} ${asset.caption || ""}`));
  const usedFigures = new Set(methodFigure ? [assetPath(methodFigure)] : []);
  const matchFigure = row => {
    const context = [row.claim, row.evidence, row.source].join(" ");
    const references = [...context.matchAll(/(?:Figure|Fig\.?|Scheme|图)\s*(S?\d+[A-Za-z]?)/gi)];
    for (const reference of references) {
      const requested = normalizedFigureLabel(`${/scheme/i.test(reference[0]) ? "Scheme" : "Fig"} ${reference[1]}`);
      const asset = figureAssets.find(candidate => !usedFigures.has(assetPath(candidate)) && normalizedFigureLabel(candidate.label) === requested);
      if (asset) { usedFigures.add(assetPath(asset)); return asset; }
    }
    return null;
  };
  const resultBlocks = evidence.map((row, index) => {
    const relatedFigure = matchFigure(row);
    return `### 4.${index + 1} ${shortHeading(row)}\n\n${relatedFigure ? `![[${assetPath(relatedFigure)}]]\n\n**${relatedFigure.label}，PDF p.${relatedFigure.page}**：${clean(relatedFigure.caption)}\n\n` : ""}- **核心数据**：${emphasizeNumbers(row.claim)}\n- **数据说明**：${emphasizeNumbers(row.evidence)}\n- **原文位置**：${clean(row.source)}（${row.confidence}）`;
  }).join("\n\n");
  const figureRowsWithAssets = figures.map(row => ({ row, asset: matchFigure(row) })).filter(entry => entry.asset);
  const remainingAssets = figureAssets.filter(asset => !usedFigures.has(assetPath(asset)) && asset.label).slice(0, Math.max(0, 5 - usedFigures.size));
  for (const asset of remainingAssets) usedFigures.add(assetPath(asset));
  const explicitFigureBlocks = figureRowsWithAssets.map((entry, index) => `### 4.${evidence.length + index + 1} ${shortHeading(entry.row)}\n\n![[${assetPath(entry.asset)}]]\n\n**${entry.asset.label}，PDF p.${entry.asset.page}**：${clean(entry.asset.caption)}\n\n- **图表解读**：${clean(entry.row.claim)}\n- **证据**：${clean(entry.row.evidence)}\n- **原文位置**：${clean(entry.row.source)}（${entry.row.confidence}）`).join("\n\n");
  const remainingFigureBlocks = remainingAssets.map((asset, index) => `### 4.${evidence.length + figureRowsWithAssets.length + index + 1} ${asset.label}\n\n![[${assetPath(asset)}]]\n\n**${asset.label}，PDF p.${asset.page}**：${clean(asset.caption) || "图注为栅格内容，需对照原始 PDF 核验。"}\n\n- **读图重点**：核对各子图的样品、坐标、测试条件、绝对值、误差棒及对照组；不得仅凭图注作定性结论。`).join("\n\n");
  const bullets = list => list.map(row => `- ${clean(row.claim.replace(/^【[^】]+】/, ""))}`).join("\n") || "- 待补充";
  const methodBullets = methods.map((row, index) => `- **${methodName(row, index)}**：${emphasizeNumbers(methodDetails(row))}`).join("\n") || "- 待补充";
  const contributionRows = rows.filter(row => ["overview", "evidence"].includes(row.category) && /创新|首次|提出|建立|实现|自终止|自剥离|无需|突破|新方法|新机制/i.test(row.claim)).slice(0, 5);
  const contributionList = (contributionRows.length ? contributionRows : overview.slice(1).concat(evidence.slice(0, 2))).slice(0, 5).map((row, index) => {
    const text = clean(row.claim.replace(/^【[^】]+】/, ""));
    const parts = text.match(/^([^：:。；]{2,16})[：:](.+)$/);
    const lead = parts ? parts[1] : (text.split(/[，。；]/)[0].slice(0, 14) || `创新点 ${index + 1}`);
    const detail = parts ? parts[2] : text;
    return `${index + 1}. **${lead}**：${emphasizeNumbers(detail)}`;
  }).join("\n\n") || "1. **待补充**：需对照原文确认创新性。";
  const summary = clean(outputs.note_synthesis?.summary || outputs.fulltext_analysis?.summary || "待人工检查");
  return `---
id: lit-${key}
type: literature
title: "${yaml(cnTitle)}"
en_title: "${yaml(item.title)}"
aliases:
  - "${yaml(displayTitle)}"
authors:
${item.creators.map(author => `  - "${yaml(author)}"`).join("\n") || "  - 未知作者"}
journal: "${yaml(item.journal)}"
year: ${item.year || ""}
volume: "${yaml(item.volume)}"
issue: "${yaml(item.issue)}"
pages: "${yaml(item.pages)}"
doi: "${yaml(item.doi)}"
tags:
  - 文献阅读
  - ${/CF|carbon fiber/i.test(item.title) ? "碳纤维复合材料" : "材料科学"}
  - ${/PEEK/i.test(item.title) ? "PEEK" : "界面工程"}
cssclasses:
  - literature-note
status: ai-draft
review_level: unreviewed
library_folder: ${folder}
batch_name: "${yaml(config.batchName || "")}"
classification_basis: paper-topic
zotero_item_key: ${key}
zotero_pdf_key: ${attachments.pdf[0]?.key || ""}
mineru_cache_key: ${attachments.mineru[0]?.key || ""}
supplementary_keys: [${attachments.supplementary.map(row => row.key).join(", ")}]
supplementary_status: ${attachments.supplementary.length ? "found" : "not_found"}
source_verified: true
text_verified: true
figures_verified: ${pdfVerified}
tables_verified: ${pdfVerified}
equations_verified: ${pdfVerified}
supplementary_verified: false
evidence_pending: true
processing_models: "${yaml(models)}"
schema_version: 4
prompt_version: literature-library-v2
parser: MinerU
updated: ${new Date().toISOString().slice(0, 10)}
---

# 📖 文献阅读笔记：${displayTitle}

## ✅ 人工审核与入库

### 快速审核
<!-- REVIEW:QUICK:BEGIN -->
- [ ] Zotero 元数据、题名、作者、年份与 DOI 正确
- [ ] 主文、支持材料和 MinerU 缓存分类正确
- [ ] 一句话结论已对照原文摘要或结论
<!-- REVIEW:QUICK:END -->

### 证据审核
<!-- REVIEW:EVIDENCE:BEGIN -->
- [ ] 最佳实验条件、单位和样品命名已核验
- [ ] 关键性能绝对值、基线、增幅和误差已核验
- [ ] 关键图表、图号和 PDF 页码一致
- [ ] 作者结论与 AI 推论已经区分
<!-- REVIEW:EVIDENCE:END -->

### 深度审核
<!-- REVIEW:DEEP:BEGIN -->
- [ ] 支持材料已检查或明确标记缺失
- [ ] 局限性、替代解释和跨文献关系已核验
- [ ] 已补充个人判断、可复用内容和研究关联
<!-- REVIEW:DEEP:END -->

\`\`\`dataviewjs
const code = await dv.io.load("99_系统/脚本/审核入库.js");
await eval(\`(async () => { \${code} })()\`);
\`\`\`

> 🎯 **一句话概括**：${summary}

## 📋 文献信息卡片

| 项目 | 内容 |
|---|---|
| **期刊** | ${item.journal || "待补充"} (${item.year || "未知"}) |
| **DOI** | ${item.doi ? `[${item.doi}](https://doi.org/${item.doi})` : "无"} |
| **Zotero** | Item \`${key}\` · PDF \`${attachments.pdf[0]?.key || "缺失"}\` · MinerU \`${attachments.mineru[0]?.key || "缺失"}\` |
| **附件状态** | ${attachments.supplementary.length ? `发现 ${attachments.supplementary.length} 份支持材料` : "未发现独立支持材料，需人工确认"} |

## 一、研究背景与核心问题

${bullets(overview.slice(0, 3))}

> **核心问题**：${clean(overview.at(-1)?.claim || summary)}

## 二、创新点

${contributionList}

## 三、实验方法

### 3.1 总体技术路线

${bullets(methods.slice(0, 3))}

${methodFigure ? `![[${assetPath(methodFigure)}]]\n\n**${methodFigure.label}，PDF p.${methodFigure.page}**：${clean(methodFigure.caption)}` : "- 原文未识别到可确认的技术路线图；不使用无关图片占位。"}

### 3.2 关键实验条件

${methodBullets}

### 3.3 对照与变量设计

${bullets(methods.slice(3, 7))}

## 四、关键结果与讨论

${[resultBlocks, explicitFigureBlocks, remainingFigureBlocks].filter(Boolean).join("\n\n") || "待补充"}

## 五、标准化实验条件卡

| 环节 | 可复现参数与条件 | 原文位置 | 可信度 |
|---|---|---|---|
${methodTable}

## 六、核心主张—证据表

| 核心主张 | 证据与结果 | 原文位置 | 归属/可信度 |
|---|---|---|---|
${evidenceTable}

## 七、结论

${bullets(evidence.slice(0, 5))}

## 八、个人评述

### 优点 ⭐

${bullets(evidence.slice(0, 2))}

### 局限性

${bullets(critique)}

### 对后续研究的启发 💡

${bullets(relations.slice(0, 4))}

### 我的判断
<!-- HUMAN:BEGIN judgement -->
- 证据充分之处：
- 仍不信服之处：
- 对当前研究的价值：
<!-- HUMAN:END judgement -->

## 九、速查卡

> [!summary] 速查卡
> **🔑 核心方法**：${clean(methods[0]?.claim || "待补充")}
> **⚙️ 关键条件**：${clean(methods[1]?.claim || "待补充")}
> **📊 关键结果**：${clean(evidence[0]?.claim || "待补充")}
> **⚠️ 主要局限**：${clean(critique[0]?.claim || "待补充")}

## 十、关联文献链接

${bullets(relations)}

## 十一、来源与待核验

${warnings.map(text => `- [ ] ${text}`).join("\n") || "- [ ] 对照原始 PDF 抽查关键数值、图号与单位"}

## 为什么阅读这篇

<!-- HUMAN:BEGIN reading-purpose -->
- 要解决的问题：
- 与当前研究的关系：
- 阅读前预期：
- 阅读后是否满足预期：
<!-- HUMAN:END reading-purpose -->

## 处理配置

${Object.entries(config.stages).map(([stage, value]) => `- ${stage}: ${value.enabled ? `${value.provider || "codex-subscription"} / ${value.model} / ${value.effort}` : "关闭"}`).join("\n")}
`;
}
function preserveHumanBlocks(existing, generated) {
  const blocks = [...existing.matchAll(/<!-- HUMAN:BEGIN ([^ ]+) -->[\s\S]*?<!-- HUMAN:END \1 -->/g)];
  for (const match of blocks) {
    const pattern = new RegExp(`<!-- HUMAN:BEGIN ${match[1]} -->[\\s\\S]*?<!-- HUMAN:END ${match[1]} -->`);
    if (pattern.test(generated)) generated = generated.replace(pattern, match[0]);
  }
  return generated;
}
function findFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) { const found = findFile(candidate, name); if (found) return found; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return candidate;
  }
  return null;
}
/** @deprecated 历史 V2 渲染器。 */
function legacyRenderNoteV2(item, key, attachments, outputs, config) {
  const all = Object.entries(outputs);
  const findings = all.flatMap(([stage, result]) => result.findings.map(x => ({ stage, ...x })));
  const warnings = all.flatMap(([, result]) => result.warnings);
  const categoryAliases = { fulltext_analysis:["overview","critique"], method_evidence:["method"], pdf_verification:["figure"], relation_discovery:["relation"], note_synthesis:["evidence"] };
  const rows = (...selectors) => findings.filter(x => selectors.includes(x.stage) || selectors.includes(x.category) || selectors.some(selector => categoryAliases[selector]?.includes(x.category)));
  const clean = value => String(value || "").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  const bulletRows = (...selectors) => rows(...selectors).map(x => `- ${clean(x.claim)}  \n  - **证据**：${clean(x.evidence)}  \n  - **位置**：${clean(x.source)} · ${x.confidence}`).join("\n");
  const tableRows = (...selectors) => rows(...selectors).map(x => `| ${clean(x.claim)} | ${clean(x.evidence)} | ${clean(x.source)} | ${x.confidence} |`).join("\n");
  const authors = item.creators.map(x => `  - "${String(x).replaceAll('"','\\"')}"`).join("\n");
  const models = Object.entries(config.stages).filter(([,v])=>v.enabled).map(([k,v])=>`${k}:${v.provider || 'codex-subscription'}/${v.model}/${v.effort}`).join('; ');
  return `---\nid: lit-${key}\ntype: literature\ntitle: "${item.title.replaceAll('"','\\"')}"\naliases: []\nauthors:\n${authors || '  - 未知作者'}\nstatus: ai-draft\nreview_level: unreviewed\nlibrary_folder: ${config.libraryFolder}\nyear: ${item.year || ""}\ndoi: "${item.doi}"\nzotero_item_key: ${key}\nzotero_pdf_key: ${attachments.pdf[0]?.key || ""}\nsupplementary_keys: [${attachments.supplementary.map(x=>x.key).join(', ')}]\nmineru_cache_keys: [${attachments.mineru.map(x=>x.key).join(', ')}]\nsupplementary_status: ${attachments.supplementary.length ? "found" : "unknown"}\nsource_verified: true\ntext_verified: true\nfigures_verified: ${outputs.pdf_verification ? 'true' : 'false'}\ntables_verified: ${outputs.pdf_verification ? 'true' : 'false'}\nequations_verified: ${outputs.pdf_verification ? 'true' : 'not_applicable'}\nsupplementary_verified: false\nevidence_pending: true\nprocessing_models: "${models}"\nschema_version: 2\nprompt_version: literature-v2\n---\n\n# ${item.title}\n\n## ✅ 人工审核与入库\n\n### 快速审核\n<!-- REVIEW:QUICK:BEGIN -->\n- [ ] Zotero 元数据、题名、作者、年份与 DOI 正确\n- [ ] 主文、支持材料和 MinerU 缓存分类正确\n- [ ] 一句话结论已对照原文摘要或结论\n<!-- REVIEW:QUICK:END -->\n\n### 证据审核\n<!-- REVIEW:EVIDENCE:BEGIN -->\n- [ ] 最佳实验条件、单位和样品命名已核验\n- [ ] 关键性能绝对值、基线、增幅和误差已核验\n- [ ] 关键图表、图号和 PDF 页码一致\n- [ ] 作者结论与 AI 推论已经区分\n<!-- REVIEW:EVIDENCE:END -->\n\n### 深度审核\n<!-- REVIEW:DEEP:BEGIN -->\n- [ ] 支持材料已检查或明确标记缺失\n- [ ] 局限性、替代解释和跨文献关系已核验\n- [ ] 已补充个人判断、可复用内容和研究关联\n<!-- REVIEW:DEEP:END -->\n\n\`\`\`dataviewjs\nconst code = await dv.io.load("99_系统/脚本/审核入库.js");\nawait eval(\`(async () => { \${code} })()\`);\n\`\`\`\n\n> [!abstract] 一句话结论\n> ${outputs.fulltext_analysis?.summary || "待人工检查"}\n\n## 为什么阅读这篇\n\n<!-- HUMAN:BEGIN reading-purpose -->\n- 要解决的问题：\n- 与当前研究的关系：\n- 阅读前预期：\n- 阅读后是否满足预期：\n<!-- HUMAN:END reading-purpose -->\n\n## 文献信息与来源状态\n\n- **英文题名**：${item.title}\n- **作者**：${item.creators.join('、')}\n- **年份**：${item.year || '未知'}\n- **DOI**：${item.doi ? `[${item.doi}](https://doi.org/${item.doi})` : '无'}\n- **Zotero 母条目**：\`${key}\`\n- **主文 PDF**：\`${attachments.pdf[0]?.key || '缺失'}\`\n- **MinerU 缓存**：\`${attachments.mineru[0]?.key || '缺失'}\`\n- **支持材料**：${attachments.supplementary.length ? attachments.supplementary.map(x=>`\`${x.key}\``).join('、') : '未发现'}\n\n## 研究问题、全文总结与论证逻辑\n\n${bulletRows('fulltext_analysis') || '待补充'}\n\n## 实验方法与标准化条件卡\n\n| 方法、条件或主张 | 证据与关键条件 | 原文位置 | 可信度 |\n|---|---|---|---|\n${tableRows('method_evidence') || '| 待补充 |  |  |  |'}\n\n## 图表、公式与原始 PDF 核验\n\n| 核验结论 | PDF 证据 | 原文位置 | 可信度 |\n|---|---|---|---|\n${tableRows('pdf_verification') || '| 未运行 PDF 核验 |  |  |  |'}\n\n## 关系、主题与研究启发\n\n${bulletRows('relation_discovery') || '- [[主题索引]]'}\n\n## 结论分层\n\n### 作者明确结论与综合证据\n<!-- AI:BEGIN author-conclusions -->\n${bulletRows('note_synthesis') || '待补充'}\n<!-- AI:END author-conclusions -->\n\n### 我的判断\n<!-- HUMAN:BEGIN judgement -->\n<!-- HUMAN:END judgement -->\n\n## 可复用内容\n\n<!-- HUMAN:BEGIN reusable -->\n- 可复用实验方法：\n- 可复用表征组合：\n- 可用于论文写作的论证模式：\n- 可用于对照实验的条件：\n- 不建议直接复用的做法：\n<!-- HUMAN:END reusable -->\n\n## 待核验事项\n\n${[...new Set(warnings)].map(x=>`- [ ] ${x}`).join('\n') || '- [ ] 对照原始 PDF 完成人工证据审核'}\n\n## 处理配置\n\n${Object.entries(config.stages).map(([stage,v])=>`- ${stage}: ${v.enabled ? `${v.provider || 'codex-subscription'} / ${v.model} / ${v.effort}` : '关闭'}`).join('\n')}\n`;
}

/** @deprecated 历史 V3 渲染器。 */
function legacyRenderNoteV3(item, key, attachments, outputs, config, figureAssets = []) {
  return legacyRenderLibraryNoteV4(item, key, attachments, outputs, config, figureAssets);
  /* Legacy v3 renderer retained below only for migration reference. */
  const noteOverride = config.noteOverrides?.[key] || {};
  const results = Object.values(outputs).filter(Boolean);
  const findings = Object.entries(outputs).flatMap(([stage, result]) => (result.findings || []).map(row => ({ stage, ...row })));
  const byCategory = category => findings.filter(row => row.category === category);
  const clean = value => String(value || "").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  const yaml = value => String(value || "").replaceAll('"', '\\"');
  const label = row => row.claim.match(/^【([^】]+)】/)?.[1] || (row.category === "critique" ? "AI评估" : "证据");
  const bullet = rows => rows.map(row => `- **${label(row)}**：${clean(row.claim.replace(/^【[^】]+】/, ""))}  \n  - **证据**：${clean(row.evidence)}  \n  - **位置**：${clean(row.source)} · ${row.confidence}`).join("\n");
  const table = rows => rows.map(row => `| ${clean(row.claim)} | ${clean(row.evidence)} | ${clean(row.source)} | ${row.confidence} |`).join("\n");
  const authorConclusions = findings.filter(row => /作者明确/.test(row.claim));
  const aiInferences = findings.filter(row => /AI推论|AI评估/.test(row.claim));
  const pending = findings.filter(row => /待核验|解析异常/.test(row.claim));
  const warnings = [...new Set(results.flatMap(result => result.warnings || []))];
  const suggestedTitle = results.map(result => clean(result.noteTitle)).find(Boolean);
  const suggestedFolder = [outputs.note_synthesis, outputs.fulltext_analysis, outputs.method_evidence, ...results].map(result => clean(result?.libraryFolder)).find(folder => folder && !folder.includes("..") && !/[\\/]/.test(folder));
  const resolvedLibraryFolder = suggestedFolder || config.libraryFolder || "未分类";
  const cnTitle = noteOverride.title || suggestedTitle || item.title;
  const firstAuthor = item.creators[0]?.split(" ").at(-1) || "Unknown";
  const displayTitle = `${firstAuthor} et al. (${item.year || "n.d."}) — ${cnTitle}`;
  const models = Object.entries(config.stages).filter(([, value]) => value.enabled).map(([stage, value]) => `${stage}:${value.provider || "codex-subscription"}/${value.model}/${value.effort}`).join("; ");
  const pdfOutput = outputs.pdf_verification;
  const pdfActuallyVerified = Boolean(pdfOutput) && ![pdfOutput.summary, ...(pdfOutput.warnings || [])].some(text => /未能|无法|未直接|没有完成|未完成.*PDF|路径.*截断/.test(String(text)));
  const methodRows = byCategory("method");
  const evidenceRows = byCategory("evidence");
  const overviewRows = byCategory("overview");
  const critiqueRows = byCategory("critique");
  const figureRows = byCategory("figure").concat((outputs.pdf_verification?.findings || []).filter(row => row.category !== "figure"));
  const relationRows = byCategory("relation");
  const tags = [...new Set(["文献阅读", /CF|carbon fiber/i.test(item.title) ? "碳纤维复合材料" : "材料科学", /PEEK/i.test(item.title) ? "PEEK" : "界面工程", /impact/i.test(item.title) ? "抗冲击" : "界面调控"])];
  return `---
id: lit-${key}
type: literature
title: "${yaml(cnTitle)}"
en_title: "${yaml(item.title)}"
aliases:
  - "${yaml(displayTitle)}"
authors:
${item.creators.map(author => `  - "${yaml(author)}"`).join("\n") || "  - 未知作者"}
journal: "${yaml(item.journal)}"
year: ${item.year || ""}
volume: "${yaml(item.volume)}"
issue: "${yaml(item.issue)}"
pages: "${yaml(item.pages)}"
doi: "${yaml(item.doi)}"
tags:
${tags.map(tag => `  - ${tag}`).join("\n")}
cssclasses:
  - literature-note
status: ai-draft
review_level: unreviewed
library_folder: ${resolvedLibraryFolder}
batch_name: "${yaml(config.batchName || "")}"
classification_basis: paper-topic
zotero_item_key: ${key}
zotero_pdf_key: ${attachments.pdf[0]?.key || ""}
mineru_cache_key: ${attachments.mineru[0]?.key || ""}
supplementary_keys: [${attachments.supplementary.map(row => row.key).join(", ")}]
supplementary_status: ${attachments.supplementary.length ? "found" : "not_found"}
source_verified: true
parse_quality: usable
text_verified: true
figures_verified: ${pdfActuallyVerified}
tables_verified: ${pdfActuallyVerified}
equations_verified: ${pdfActuallyVerified}
supplementary_verified: false
evidence_pending: true
processing_models: "${yaml(models)}"
schema_version: 3
prompt_version: literature-v3
parser: MinerU
updated: ${new Date().toISOString().slice(0, 10)}
---

# 📖 文献阅读笔记：${displayTitle}

## ✅ 人工审核与入库

### 快速审核
<!-- REVIEW:QUICK:BEGIN -->
- [ ] Zotero 元数据、题名、作者、年份与 DOI 正确
- [ ] 主文、支持材料和 MinerU 缓存分类正确
- [ ] 一句话结论已对照原文摘要或结论
<!-- REVIEW:QUICK:END -->

### 证据审核
<!-- REVIEW:EVIDENCE:BEGIN -->
- [ ] 最佳实验条件、单位和样品命名已核验
- [ ] 关键性能绝对值、基线、增幅和误差已核验
- [ ] 关键图表、图号和 PDF 页码一致
- [ ] 作者结论与 AI 推论已经区分
<!-- REVIEW:EVIDENCE:END -->

### 深度审核
<!-- REVIEW:DEEP:BEGIN -->
- [ ] 支持材料已检查或明确标记缺失
- [ ] 局限性、替代解释和跨文献关系已核验
- [ ] 已补充个人判断、可复用内容和研究关联
<!-- REVIEW:DEEP:END -->

\`\`\`dataviewjs
const code = await dv.io.load("99_系统/脚本/审核入库.js");
await eval(\`(async () => { \${code} })()\`);
\`\`\`

> [!abstract] 一句话结论
> ${outputs.note_synthesis?.summary || outputs.fulltext_analysis?.summary || "待人工检查"}

## 📋 文献信息卡片

| 项目 | 内容 |
|---|---|
| **中文短题名** | ${cnTitle} |
| **英文题名** | ${item.title} |
| **作者** | ${item.creators.join("、")} |
| **期刊** | ${item.journal || "待补充"} |
| **年份** | ${item.year || "未知"} |
| **DOI** | ${item.doi ? `[${item.doi}](https://doi.org/${item.doi})` : "无"} |
| **Zotero / PDF / MinerU** | \`${key}\` / \`${attachments.pdf[0]?.key || "缺失"}\` / \`${attachments.mineru[0]?.key || "缺失"}\` |
| **支持材料** | ${attachments.supplementary.length ? attachments.supplementary.map(row => `\`${row.key}\``).join("、") : "未发现，需人工确认"} |

## 一、研究背景与核心问题

${bullet(overviewRows) || `- ${outputs.fulltext_analysis?.summary || "待补充"}`}

## 二、创新点与核心贡献

${bullet(overviewRows.concat(evidenceRows.slice(0, 2))) || "待补充"}

## 三、实验方法与技术路线

### 3.1 总体方法

${bullet(methodRows) || "待补充；建议启用“方法与证据抽取”阶段。"}

### 3.2 标准化实验条件卡

| 环节、变量或方法 | 关键条件与证据 | 原文位置 | 可信度 |
|---|---|---|---|
${table(methodRows) || "| 待补充 |  |  |  |"}

## 四、关键结果与讨论

${bullet(evidenceRows) || "待补充"}

## 五、图表、公式与原始 PDF 核验

> [!${pdfActuallyVerified ? "success" : "warning"}] PDF 核验状态
> ${pdfActuallyVerified ? "已完成原始 PDF 页级核验；仍需人工抽查关键图表。" : "本轮没有完成可靠的原始 PDF 页级核验。下表中的图号、单位和数值仍须回看原始 PDF，不能把“运行了 PDF 阶段”等同于“已核验”。"}

| 核验结论 | PDF/图表证据 | 原文位置 | 可信度 |
|---|---|---|---|
${table(figureRows) || "| 尚无可靠 PDF 核验结果 |  |  |  |"}

### 原文关键图

${figureAssets.length ? figureAssets.map((asset, index) => `![[${asset}]]\n\n**原文图像 ${index + 1}**：自动从主文 PDF 提取。正式入库前需核对图号、图注及其与正文论证位置的对应关系。`).join("\n\n") : "> [!warning] 图片缺失\n> 未能从 MinerU 缓存或原始 PDF 提取可用图片，本笔记不能通过完整入库质量门禁。"}

## 六、核心主张—证据表

| 核心主张 | 证据与结果 | 原文位置 | 归属/可信度 |
|---|---|---|---|
${table(evidenceRows.concat(critiqueRows)) || "| 待补充 |  |  |  |"}

## 七、结论分层

### 7.1 作者明确结论
<!-- AI:BEGIN author-conclusions -->
${bullet(authorConclusions) || "待补充"}
<!-- AI:END author-conclusions -->

### 7.2 AI 综合推论

${bullet(aiInferences) || "- 暂无；不把作者未证明的机制提升为事实。"}

### 7.3 我的判断
<!-- HUMAN:BEGIN judgement -->
- 证据充分之处：
- 仍不信服之处：
- 对当前研究的价值：
<!-- HUMAN:END judgement -->

## 八、局限性与替代解释

${bullet(critiqueRows) || "- 待深度审核后补充。"}

## 九、可复用内容与研究启发

<!-- HUMAN:BEGIN reusable -->
- 可复用实验方法：
- 可复用表征组合：
- 可用于论文写作的论证模式：
- 可用于对照实验的条件：
- 不建议直接复用的做法：
<!-- HUMAN:END reusable -->

${bullet(relationRows) || "- 可在深度模式中启用“关系与主题发现”阶段。"}

## 十、速查卡

> [!summary] 速查卡
> **核心问题**：${clean(overviewRows[0]?.claim || outputs.fulltext_analysis?.summary || "待补充")}
> **核心方法**：${clean(methodRows[0]?.claim || "待补充")}
> **关键结果**：${clean(evidenceRows[0]?.claim || "待补充")}
> **主要局限**：${clean(critiqueRows[0]?.claim || "待补充")}

## 十一、关联主题与文献

- [[主题索引]]
- [[${tags[1]}]]
- [[${tags[2]}]]
${relationRows.map(row => `- ${clean(row.claim)}`).join("\n")}

## 十二、待核验事项

${[...pending.map(row => clean(row.claim)), ...warnings].map(text => `- [ ] ${text}`).join("\n") || "- [ ] 对照原始 PDF 完成人工证据审核"}

## 为什么阅读这篇

<!-- HUMAN:BEGIN reading-purpose -->
- 要解决的问题：
- 与当前研究的关系：
- 阅读前预期：
- 阅读后是否满足预期：
<!-- HUMAN:END reading-purpose -->

## 处理配置

${Object.entries(config.stages).map(([stage, value]) => `- ${stage}: ${value.enabled ? `${value.provider || "codex-subscription"} / ${value.model} / ${value.effort}` : "关闭"}`).join("\n")}
`;
}
async function runQueue() {
  if (runnerActive) return; runnerActive = true;
  try {
    while (true) {
      const job = jobs.find(x => x.status === "queued"); if (!job) break;
      job.config = normalizeUnifiedConfig(job.config);
      job.completedItemKeys ||= []; job.partialItemKeys ||= [];
      job.cancelRequested = null; job.currentItemKey = null; job.currentStage = null; job.activeItems = {};
      const parallelItems = Math.min(resolvedParallelItems(job.config), job.itemKeys.length);
      const sharedStageLimit = job.config.singlePaperAgents === false ? 1 : Math.max(1, Math.min(3, Number(job.config.maxParallelStages || 3)));
      jobStageLimiters.set(job.id, createAsyncLimiter(sharedStageLimit));
      job.resolvedParallelItems = parallelItems;
      job.status = "running"; addEvent(job, "job", "running", `${job.resumeCount ? "继续处理任务" : "任务开始"} · ${parallelItems} 篇并行 · 全批次最多 ${sharedStageLimit} 个阶段 Agent`);
      try {
        const pending = job.itemKeys.filter(key => {
          if (!job.completedItemKeys.includes(key)) return true;
          addEvent(job, "item", "skipped", `保留已完成条目 ${key}`); return false;
        });
        let cursor = 0; let firstError = null; job.runtimeParallelItems = parallelItems;
        const workers = Array.from({ length: Math.min(parallelItems, pending.length) }, async (_, workerIndex) => {
          while (!firstError && cursor < pending.length) {
            if (workerIndex >= job.runtimeParallelItems) return;
            if (job.cancelRequested) throw new CancelledError(job.cancelRequested);
            const key = pending[cursor++];
            const execution = { controller: new AbortController(), child: null, cancelMode: null, itemKey: key };
            registerExecution(job.id, execution);
            try { await runItem(job, key, execution); }
            catch (error) {
              if (!job.cancelRequested && job.runtimeParallelItems > 1 && isConcurrencyPressure(error)) {
                job.runtimeParallelItems = 1;
                addEvent(job, "job", "running", `模型通道拥堵，已自动降为单篇；${key} 将复用缓存后重试`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                try { await runItem(job, key, execution); }
                catch (retryError) { firstError ||= retryError; throw retryError; }
                if (workerIndex > 0) return;
                continue;
              }
              firstError ||= error; throw error;
            }
            finally { unregisterExecution(job.id, execution); }
          }
        });
        const settled = await Promise.allSettled(workers);
        const rejected = settled.find(result => result.status === "rejected");
        if (rejected) throw rejected.reason;
        job.currentItemKey = null; job.currentStage = null;
        job.status = "completed"; addEvent(job, "job", "completed", "全部条目处理完成");
      } catch (error) {
        if (error instanceof CancelledError || job.cancelRequested || error?.name === "AbortError") {
          const mode = error instanceof CancelledError ? error.mode : (job.cancelRequested || "immediate");
          job.status = "cancelled"; job.cancelMode = mode; job.cancelRequested = null;
          addEvent(job, "job", "cancelled", `已停止：完成 ${job.completedItemKeys.length}/${job.itemKeys.length}${job.partialItemKeys.length ? `，保留 ${job.partialItemKeys.length} 篇部分草稿` : ""}`);
        } else {
          job.status = String(error.message).includes("OPENAI_API_KEY") ? "blocked" : "failed";
          addEvent(job, "job", job.status, error.message);
        }
      } finally {
        activeExecutions.delete(job.id);
        jobStageLimiters.delete(job.id);
        job.activeItems = {};
      }
    }
  } finally { runnerActive = false; writeJson(jobsFile, jobs); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") {
      let zoteroOk = false; try { const r = await fetch("http://127.0.0.1:23119/api/"); zoteroOk = r.ok; } catch {}
      const codexReady = codexSubscriptionReady();
      const providerStatus = Object.fromEntries(modelConfig.providers.map(provider => [provider.id, provider.id === "codex-subscription" ? codexReady : Boolean(getProviderKey(provider.id))]));
      const configuredVaultPath = String(settings.vaultPath || "").trim();
      return send(res, 200, { ok: true, zotero: zoteroOk, codexSubscription: codexReady, openaiKeyConfigured: providerStatus["openai-api"], providerStatus, modelProviderConfigured: Object.values(providerStatus).some(Boolean), vaultPath: configuredVaultPath, vaultReady: Boolean(configuredVaultPath && fs.existsSync(configuredVaultPath)), pythonReady: pythonReady() });
    }
    if (url.pathname === "/api/config") return send(res, 200, modelConfig);
    if (url.pathname === "/api/providers" && req.method === "GET") {
      return send(res, 200, {
        providers: modelConfig.providers.map(provider => ({ ...provider, configured: provider.id === "codex-subscription" ? codexSubscriptionReady() : Boolean(getProviderKey(provider.id)) })),
        customProviders: settings.customProviders || {}
      });
    }
    if (url.pathname === "/api/settings" && req.method === "GET") return send(res, 200, settings);
    if (url.pathname === "/api/settings" && req.method === "POST") {
      const input = await body(req);
      if (Object.hasOwn(input, "vaultPath")) {
        const requestedVault = String(input.vaultPath || "").trim();
        if (requestedVault && !path.isAbsolute(requestedVault)) return send(res, 400, { error: "Obsidian 仓库必须使用绝对路径" });
        if (requestedVault && !fs.existsSync(requestedVault)) return send(res, 400, { error: "Obsidian 仓库路径不存在" });
      }
      settings = normalizeUnifiedConfig({ ...settings, ...input }); writeJson(settingsFile, settings); return send(res, 200, settings);
    }
    if (url.pathname === "/api/key" && req.method === "POST") {
      const input = await body(req); const key = String(input.key || "").trim();
      if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return send(res, 400, { error: "API Key 格式不正确" });
      await saveProviderKey("openai-api", key);
      return send(res, 200, { configured: true, encryptedAtRest: true, suffix: key.slice(-4) });
    }
    if (url.pathname === "/api/provider-key" && req.method === "POST") {
      const input = await body(req);
      const provider = String(input.provider || "");
      if (!modelConfig.providers.some(x => x.id === provider && x.credential === "api-key")) return send(res, 400, { error: "不支持的 API 提供商" });
      const key = String(input.key || "").trim();
      if (key.length < 10 || /\s/.test(key)) return send(res, 400, { error: "API Key 格式不正确" });
      if (provider === "openai-compatible") {
        const baseUrl = String(input.baseUrl || "").trim().replace(/\/$/, "");
        const model = String(input.model || "").trim();
        if (!/^https:\/\//i.test(baseUrl)) return send(res, 400, { error: "Base URL 必须使用 https://" });
        if (!model) return send(res, 400, { error: "必须填写模型 ID" });
        settings.customProviders ||= {};
        settings.customProviders[provider] = { baseUrl, model };
        writeJson(settingsFile, settings);
      }
      await saveProviderKey(provider, key);
      return send(res, 200, { provider, configured: true, encryptedAtRest: true, suffix: key.slice(-4) });
    }
    if (url.pathname === "/api/collections") {
      const raw = await zotero("collections?limit=100");
      return send(res, 200, raw.map(x => ({ key:x.key, name:x.data.name, parent:x.data.parentCollection || null, itemCount:x.meta?.numItems || 0 })));
    }
    if (url.pathname === "/api/items") {
      const collection = url.searchParams.get("collection"); const q = url.searchParams.get("q") || "";
      const route = collection ? `collections/${collection}/items/top?limit=100&q=${encodeURIComponent(q)}` : `items/top?limit=100&q=${encodeURIComponent(q)}`;
      const raw = await zotero(route); return send(res, 200, raw.filter(x => !["attachment","note","annotation"].includes(x.data?.itemType)).map(itemView));
    }
    const attachmentMatch = url.pathname.match(/^\/api\/items\/([A-Z0-9]+)\/attachments$/);
    if (attachmentMatch) {
      const parent = itemView(await zotero(`items/${attachmentMatch[1]}`));
      return send(res, 200, await resolveAttachments(await zotero(`items/${attachmentMatch[1]}/children`), parent.title));
    }
    if (url.pathname === "/api/jobs" && req.method === "GET") return send(res, 200, jobs.slice().reverse());
    if (url.pathname === "/api/jobs" && req.method === "POST") {
      const input = await body(req);
      if (!Array.isArray(input.itemKeys) || !input.itemKeys.length) return send(res, 400, { error:"至少选择一篇文献" });
      const requestedVault = String(input.config?.vaultPath || settings.vaultPath || "").trim();
      if (!requestedVault || !fs.existsSync(requestedVault)) return send(res, 400, { error:"请先配置有效的 Obsidian 仓库路径" });
      const job = { id: crypto.randomUUID(), batchName: safeName(input.batchName || `批次-${new Date().toISOString().slice(0,10)}`), itemKeys: input.itemKeys, config: normalizeUnifiedConfig({ ...settings, ...input.config }), status:"queued", createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), events:[] };
      jobs.push(job); writeJson(jobsFile, jobs); setTimeout(runQueue, 10); return send(res, 202, job);
    }
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/cancel$/i);
    if (cancelMatch && req.method === "POST") {
      const job = jobs.find(x => x.id === cancelMatch[1]);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (!["queued", "running", "stopping", "cancelling"].includes(job.status)) return send(res, 409, { error: "当前任务无需停止" });
      const input = await body(req); const mode = input.mode === "after-stage" ? "after-stage" : "immediate";
      if (job.status === "queued") {
        job.status = "cancelled"; job.cancelMode = mode;
        addEvent(job, "job", "cancelled", "已取消排队，尚未调用模型");
      } else {
        job.cancelRequested = mode;
        job.status = mode === "after-stage" ? "stopping" : "cancelling";
        addEvent(job, "job", job.status, mode === "after-stage" ? "将在当前阶段完成并保存结果后停止" : "正在立即停止并保存已有结果");
        const executions = activeExecutions.get(job.id);
        if (mode === "immediate" && executions) {
          for (const execution of executions) {
            execution.cancelMode = "immediate";
            execution.controller.abort();
            execution.child?.kill();
            for (const child of execution.children || []) child.kill();
          }
        }
      }
      return send(res, 202, job);
    }
    const resumeMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/resume$/i);
    if (resumeMatch && req.method === "POST") {
      const job = jobs.find(x => x.id === resumeMatch[1]);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (!["cancelled", "failed", "blocked", "interrupted"].includes(job.status)) return send(res, 409, { error: "只有已停止或失败的任务可以继续" });
      const input = await body(req);
      job.config = normalizeUnifiedConfig(input.config && typeof input.config === "object"
        ? { ...job.config, ...input.config, stages: input.config.stages || job.config.stages }
        : job.config);
      job.cancelRequested = null; job.cancelMode = null; job.currentItemKey = null; job.currentStage = null;
      job.resumeCount = Number(job.resumeCount || 0) + 1; job.status = "queued";
      addEvent(job, "job", "queued", `已加入继续处理队列；保留 ${job.completedItemKeys?.length || 0} 篇完整结果及已完成阶段`);
      setTimeout(runQueue, 10);
      return send(res, 202, job);
    }
    const reprocessMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/reprocess$/i);
    if (reprocessMatch && req.method === "POST") {
      const job = jobs.find(x => x.id === reprocessMatch[1]);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (["queued", "running", "stopping", "cancelling"].includes(job.status)) return send(res, 409, { error: "运行中的任务不能重新解析" });
      const input = await body(req);
      const requested = Array.isArray(input.itemKeys) && input.itemKeys.length ? input.itemKeys : job.itemKeys;
      const itemKeys = requested.filter(key => job.itemKeys.includes(key));
      if (!itemKeys.length) return send(res, 400, { error: "没有可重新解析的文献" });
      job.stageResults ||= {};
      for (const key of itemKeys) delete job.stageResults[key];
      job.completedItemKeys = (job.completedItemKeys || []).filter(key => !itemKeys.includes(key));
      job.partialItemKeys = (job.partialItemKeys || []).filter(key => !itemKeys.includes(key));
      job.cancelRequested = null; job.cancelMode = null; job.currentItemKey = null; job.currentStage = null;
      job.resumeCount = Number(job.resumeCount || 0) + 1; job.status = "queued";
      addEvent(job, "job", "queued", `已清除 ${itemKeys.length} 篇旧阶段缓存，将按当前附件识别规则从头重新解析`);
      setTimeout(runQueue, 10);
      return send(res, 202, { ...job, reprocessingItemKeys: itemKeys });
    }
    const reprocessStagesMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/reprocess-stages$/i);
    if (reprocessStagesMatch && req.method === "POST") {
      const job = jobs.find(x => x.id === reprocessStagesMatch[1]);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (["queued", "running", "stopping", "cancelling"].includes(job.status)) return send(res, 409, { error: "运行中的任务不能重跑阶段" });
      const input = await body(req);
      const requestedItems = Array.isArray(input.itemKeys) && input.itemKeys.length ? input.itemKeys : job.itemKeys;
      const itemKeys = requestedItems.filter(key => job.itemKeys.includes(key));
      const validStages = new Set(modelConfig.stages.map(stage => stage.id));
      const stages = [...new Set((Array.isArray(input.stages) ? input.stages : []).filter(stage => validStages.has(stage)))];
      if (!itemKeys.length || !stages.length) return send(res, 400, { error: "必须指定文献和至少一个有效阶段" });
      if (stages.some(stage => stage !== "note_synthesis") && !stages.includes("note_synthesis")) stages.push("note_synthesis");
      job.stageResults ||= {};
      for (const key of itemKeys) for (const stage of stages) delete job.stageResults?.[key]?.[stage];
      job.completedItemKeys = (job.completedItemKeys || []).filter(key => !itemKeys.includes(key));
      job.partialItemKeys = (job.partialItemKeys || []).filter(key => !itemKeys.includes(key));
      job.cancelRequested = null; job.cancelMode = null; job.currentItemKey = null; job.currentStage = null;
      job.resumeCount = Number(job.resumeCount || 0) + 1; job.status = "queued";
      addEvent(job, "job", "queued", `将重跑 ${itemKeys.length} 篇的阶段：${stages.join("、")}；其余阶段缓存保留`);
      setTimeout(runQueue, 10);
      return send(res, 202, { ...job, reprocessingItemKeys: itemKeys, reprocessingStages: stages });
    }
    const rerenderMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/rerender$/i);
    if (rerenderMatch && req.method === "POST") {
      const job = jobs.find(x => x.id === rerenderMatch[1]);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (["queued", "running", "stopping", "cancelling"].includes(job.status)) return send(res, 409, { error: "运行中的任务不能重排笔记" });
      const input = await body(req);
      const requested = Array.isArray(input.itemKeys) && input.itemKeys.length ? input.itemKeys : (job.completedItemKeys || Object.keys(job.stageResults || {}));
      const itemKeys = requested.filter(key => job.stageResults?.[key]);
      for (const key of itemKeys) await runItem(job, key, { controller: new AbortController(), child: null, cancelMode: null }, { rerenderOnly: true });
      job.currentItemKey = null; job.currentStage = null;
      addEvent(job, "write_note", "completed", `按统一模板重建 ${itemKeys.length} 篇笔记（未调用模型）`);
      return send(res, 200, { rebuilt: itemKeys });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "API not found" });
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.resolve(publicDir, "." + requestPath);
    if (!target.startsWith(publicDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const ext = path.extname(target); const mime = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml"}[ext] || "application/octet-stream";
    return send(res, 200, fs.readFileSync(target), mime);
  } catch (error) { return send(res, 500, { error: error.message, stack: process.env.NODE_ENV === "development" ? error.stack : undefined }); }
});
server.listen(port, "127.0.0.1", () => console.log(`Literature Workbench: http://127.0.0.1:${port}`));
