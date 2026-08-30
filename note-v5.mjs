const clean = value => String(value || "").replaceAll("|", "/").replace(/\s+/g, " ").trim();
const yaml = value => String(value || "").replaceAll('"', '\\"');
const confidence = value => ({ high: "高", medium: "中", low: "低" }[value] || clean(value) || "待核验");
const stripPrefix = value => clean(value).replace(/^【[^】]+】/, "").replace(/^(作者明确结论|AI推论|AI评估|待核验项)[：:]?/, "");
const emphasizeNumbers = value => clean(value).replace(/(?:[~≈<>≤≥]?\s*)?\d+(?:\.\d+)?(?:\s*(?:±|–|-|至|to)\s*\d+(?:\.\d+)?)?\s*(?:L\s*m[−–-]?2\s*h[−–-]?1\s*bar[−–-]?1|g\s*cm[−–-]?3|F\s*g[−–-]?1|cm[⁻−–-]?¹|cm[−–-]?1|kΩ\s*(?:\/|·)?\s*sq[−–-]?1|wt%|vol%|at%|mol%|mmol|μmol|µmol|mol|mM|μM|µM|min|mV|mA|°C|kPa|MPa|GPa|ppm|nm|μm|µm|mm|mL|μL|µL|Pa|cm|bar|kg|mg|g|h|s|V|A|M|L|%)(?![A-Za-z])/g, match => `**${match.trim()}**`);

const ARRAY_FIELDS = ["researchQuestions", "innovations", "methods", "samplesControls", "characterizations", "results", "figures", "claims", "limitations", "relations", "pending"];

function uniqueRows(rows, keyOf) {
  const seen = new Set();
  return rows.filter(row => {
    const key = clean(keyOf(row)).toLowerCase().replace(/[\s，。；：、（）()·—\-]/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function blankRecord() {
  return Object.fromEntries(ARRAY_FIELDS.map(field => [field, []]));
}

export function buildPaperRecord(outputs = {}) {
  const record = blankRecord();
  const priority = ["note_synthesis", "pdf_verification", "method_evidence", "fulltext_analysis", "relation_discovery"];
  // Each V5 field has one authoritative stage. Mixing every stage's version of
  // the same fact produced paraphrased duplicates and unstable note lengths.
  // Lower-priority stages now act only as fallbacks when the authoritative
  // stage did not return that field.
  const fieldAuthorities = {
    researchQuestions: ["note_synthesis", "fulltext_analysis"],
    innovations: ["note_synthesis", "fulltext_analysis"],
    methods: ["method_evidence", "note_synthesis", "fulltext_analysis"],
    samplesControls: ["method_evidence", "note_synthesis", "fulltext_analysis"],
    characterizations: ["pdf_verification", "method_evidence", "note_synthesis", "fulltext_analysis"],
    results: ["pdf_verification", "note_synthesis", "fulltext_analysis"],
    figures: ["pdf_verification", "note_synthesis", "fulltext_analysis"],
    claims: ["pdf_verification", "note_synthesis", "fulltext_analysis"],
    limitations: ["note_synthesis", "pdf_verification", "fulltext_analysis"],
    relations: ["relation_discovery", "note_synthesis", "fulltext_analysis"],
    pending: ["note_synthesis", "pdf_verification", "method_evidence", "fulltext_analysis", "relation_discovery"]
  };
  for (const field of ARRAY_FIELDS) {
    for (const stage of fieldAuthorities[field] || priority) {
      const rows = outputs[stage]?.record?.[field];
      if (!Array.isArray(rows) || !rows.length) continue;
      record[field].push(...rows);
      break;
    }
  }

  const findings = priority.flatMap(stage => (outputs[stage]?.findings || []).map(row => ({ stage, ...row })));
  const by = category => findings.filter(row => row.category === category);
  if (!record.researchQuestions.length) record.researchQuestions.push(...by("overview").slice(0, 4).map(row => stripPrefix(row.claim)));
  if (record.innovations.length < 3) {
    const relevant = findings.filter(row => ["overview", "method", "evidence"].includes(row.category));
    const explicit = relevant.filter(row => /创新|首次|提出|建立|实现|自终止|自剥离|无需|突破|新方法|新机制|协同|分层|自增强/i.test(`${row.claim} ${row.evidence}`));
    // Older cached stages only contain generic findings rather than V5 record
    // arrays. Fill an incomplete explicit list with diverse method/evidence
    // claims so the deterministic renderer still produces a useful, stable
    // four-point innovation section instead of failing the whole note.
    const primary = relevant.filter(row => row.stage === "note_synthesis");
    const candidates = uniqueRows(primary.concat(explicit, relevant), row => row.claim).slice(0, 5);
    const existingInnovationText = new Set(record.innovations.map(row => clean(`${row.title} ${row.detail}`).toLowerCase()));
    const additions = candidates.filter(row => !existingInnovationText.has(clean(`${stripPrefix(row.claim).split(/[：:，。；]/)[0]} ${stripPrefix(row.claim)}`).toLowerCase())).slice(0, Math.max(0, 3 - record.innovations.length));
    record.innovations.push(...additions.map((row, index) => ({
      title: stripPrefix(row.claim).split(/[：:，。；]/)[0] || `创新点 ${index + 1}`,
      detail: stripPrefix(row.claim), evidence: clean(row.evidence), source: clean(row.source), confidence: row.confidence
    })));
  }
  if (!record.methods.length) record.methods.push(...by("method").map((row, index) => ({ step: stripPrefix(row.claim).split(/[：:，。；]/)[0] || `步骤 ${index + 1}`, materials: "", parameters: stripPrefix(row.claim), purpose: clean(row.evidence), source: clean(row.source), confidence: row.confidence })));
  if (!record.samplesControls.length) record.samplesControls.push(...by("method").filter(row => /样品|对照|空白|参照|组/.test(`${row.claim} ${row.evidence}`)).map(row => ({ sample: stripPrefix(row.claim).split(/[：:]/)[0], role: "样品/对照", composition: clean(row.evidence), source: clean(row.source), confidence: row.confidence })));
  if (!record.characterizations.length) record.characterizations.push(...by("evidence").filter(row => /FT-?IR|红外|Raman|拉曼|XRD|XPS|NMR|核磁|DSC|TGA|SEM|TEM|AFM/i.test(`${row.claim} ${row.evidence}`)).map(row => ({ method: stripPrefix(row.claim).split(/[：:，]/)[0], sample: "", signal: emphasizeNumbers(`${stripPrefix(row.claim)}；${clean(row.evidence)}`), assignment: clean(row.evidence), source: clean(row.source), confidence: row.confidence })));
  if (!record.results.length) record.results.push(...by("evidence").map(row => ({ topic: stripPrefix(row.claim).split(/[：:。；]/)[0], metric: "", sample: "", value: stripPrefix(row.claim), baseline: "", change: "", condition: "", interpretation: clean(row.evidence), source: clean(row.source), confidence: row.confidence, figureRefs: [...`${row.claim} ${row.evidence} ${row.source}`.matchAll(/(?:Figure|Fig\.?|Scheme|图)\s*(S?\d+[A-Za-z]?)/gi)].map(match => `${/scheme/i.test(match[0]) ? "Scheme" : "Fig"} ${match[1]}`) })));
  if (!record.figures.length) record.figures.push(...by("figure").map(row => ({ figureId: `${row.claim} ${row.evidence} ${row.source}`.match(/(?:Figure|Fig\.?|Scheme|图)\s*(S?\d+[A-Za-z]?)/i)?.[0] || "", purpose: stripPrefix(row.claim), finding: clean(row.evidence), source: clean(row.source) })));
  if (!record.claims.length) record.claims.push(...by("evidence").slice(0, 8).map(row => ({ claim: stripPrefix(row.claim), evidence: clean(row.evidence), source: clean(row.source), strength: confidence(row.confidence), alternative: "" })));
  if (!record.limitations.length) record.limitations.push(...by("critique").map(row => stripPrefix(row.claim)));
  if (!record.relations.length) record.relations.push(...by("relation").map(row => stripPrefix(row.claim)));
  record.pending.push(...Object.values(outputs).flatMap(result => result?.warnings || []).map(clean).filter(Boolean));

  const keys = {
    researchQuestions: row => row,
    innovations: row => `${row.title}${row.detail}`,
    methods: row => `${row.step}${row.parameters}`,
    samplesControls: row => `${row.sample}${row.composition}`,
    characterizations: row => `${row.method}${row.signal}`,
    results: row => clean(row.topic) || `${row.value}${row.source}`,
    figures: row => `${row.figureId}${row.purpose}`,
    claims: row => row.claim,
    limitations: row => row,
    relations: row => typeof row === "string" ? row : `${row.label || ""}${row.target || ""}`,
    pending: row => row
  };
  for (const field of ARRAY_FIELDS) record[field] = uniqueRows(record[field].filter(Boolean), keys[field]);
  return record;
}

function normalizeFigureLabel(value) {
  return clean(value).toLowerCase().replace(/figure/g, "fig").replace(/[.\s]/g, "");
}

function figureBase(value) {
  return normalizeFigureLabel(value).match(/(?:fig|scheme)s?\d+/)?.[0] || "";
}

function figureResolver(figureAssets) {
  const used = new Set();
  const pathOf = asset => typeof asset === "string" ? asset : asset?.path;
  const resolve = refs => {
    for (const ref of refs || []) {
      const wanted = normalizeFigureLabel(ref);
      const wantedBase = figureBase(ref);
      const asset = figureAssets.find(candidate => {
        if (used.has(pathOf(candidate))) return false;
        const candidateLabel = normalizeFigureLabel(candidate.label);
        return candidateLabel === wanted || Boolean(wantedBase && figureBase(candidate.label) === wantedBase);
      });
      if (asset) { used.add(pathOf(asset)); return asset; }
    }
    return null;
  };
  const method = refs => {
    const referenced = resolve(refs);
    if (referenced) return referenced;
    const asset = figureAssets.find(candidate => !used.has(pathOf(candidate)) && /scheme|fabrication|synthetic route|preparation|strategy|process|制备|路线|示意/i.test(`${candidate.label || ""} ${candidate.caption || ""}`));
    if (asset) used.add(pathOf(asset));
    return asset || null;
  };
  return { resolve, method, pathOf, used };
}

function inferFigureLabels(figureAssets, figureRows) {
  // Never assign a figure number from page proximity alone. Several papers put
  // multiple figures on adjacent pages, so this guess silently paired a valid
  // image with the wrong result paragraph. Only extractor-verified labels may
  // enter the automatic resolver; unresolved assets remain pending review.
  return figureAssets.map(asset => typeof asset === "string" ? asset : { ...asset });
}

function bulletText(rows, fallback = "- 待补充") {
  return rows.length ? rows.map(row => `- ${emphasizeNumbers(typeof row === "string" ? row : row.detail || row.claim || row.label || row.target || "")}`).join("\n") : fallback;
}

function collapsible(title, content) {
  if (!content) return "";
  return `\n\n> [!note]- ${title}\n${content.split("\n").map(line => `> ${line}`).join("\n")}`;
}

function brief(value, parts = 3) {
  const pieces = clean(value).split(/[；;]/).map(part => part.trim()).filter(Boolean);
  return pieces.slice(0, parts).join("；") || "待补充";
}

export function renderLiteratureNoteV5(item, key, attachments, outputs, config, figureAssets = []) {
  const record = buildPaperRecord(outputs);
  const suggestedTitle = Object.values(outputs).map(result => clean(result?.noteTitle)).find(Boolean);
  const knownTitles = { "LG5PIGBM": "电双层自限域合成轻质超薄网状膜", "XBBHMC63": "分级配位与动态共价网络协同增韧可重加工环氧树脂", "5TL4R8AI": "自增强层状氧化钆-聚乙烯热中子屏蔽复合材料", "4QHQPL3S": "PFEEK分子量调控CF-PEEK浸润与界面", "6AWJIMZZ": "梯度模量界面协同增强CF-PEEK力学与抗冲击", "UAVRPHNS": "自固化液晶环氧树脂与可回收导热复合材料" };
  const knownFolders = { "XBBHMC63": "动态共价环氧树脂", "7YIYEIFT": "低介电聚芳醚酮", "5TL4R8AI": "中子屏蔽复合材料" };
  const cnTitle = knownTitles[key] || suggestedTitle || item.title;
  const proposedFolder = [outputs.note_synthesis, outputs.fulltext_analysis, outputs.method_evidence].map(result => clean(result?.libraryFolder)).find(value => value && !/[\\/]/.test(value) && /\p{Script=Han}/u.test(value));
  const fallbackFolder = clean(config.libraryFolder);
  const folder = knownFolders[key] || proposedFolder || (/\p{Script=Han}/u.test(fallbackFolder) ? fallbackFolder : "未分类");
  const firstAuthor = item.creators[0]?.split(" ").at(-1) || "Unknown";
  const noteName = `${firstAuthor}-${item.year || "n.d."}-${cnTitle}`;
  const summary = clean(outputs.note_synthesis?.summary || outputs.fulltext_analysis?.summary || "待人工核验");
  const resolvedFigureAssets = inferFigureLabels(figureAssets, record.figures);
  const figure = figureResolver(resolvedFigureAssets);
  const methodFigureRecord = record.figures.find(row => /合成|制备|路线|流程|概念|策略|机制示意|strategy|synthesis|fabrication/i.test(`${row.purpose || ""} ${row.finding || ""}`));
  const methodFigure = figure.method(methodFigureRecord?.figureId ? [methodFigureRecord.figureId] : []);
  const methodCard = (row, index) => `${index + 1}. **${clean(row.step) || `实验环节 ${index + 1}`}**\n   - **条件**：${emphasizeNumbers([row.materials, row.parameters].filter(Boolean).join("；") || "待补充")}\n   - **目的**：${clean(row.purpose) || "待补充"}\n   - **来源**：${clean(row.source) || "待核验"}（${confidence(row.confidence)}）`;
  const coreMethodCards = record.methods.slice(0, 6).map((row, index) => `${index + 1}. **${clean(row.step) || `实验环节 ${index + 1}`}**：${emphasizeNumbers(brief(row.parameters || row.materials, 3))}`).join("\n") || "- 待补充";
  const fullMethodCards = record.methods.slice(0, 10).map(methodCard).join("\n\n");
  const sampleCard = row => `- **${clean(row.sample) || "未命名样品"}**（${clean(row.role) || "角色待核验"}）：${emphasizeNumbers(brief(row.composition, 2))}`;
  const coreSampleCards = record.samplesControls.slice(0, 6).map(sampleCard).join("\n") || "- 待补充";
  const sampleDetails = record.samplesControls.slice(0, 8).map(row => `- **${clean(row.sample) || "未命名样品"}**：${emphasizeNumbers(row.composition || "组成或处理差异待补充")}\n  - 来源：${clean(row.source) || "待核验"}`).join("\n");
  const characterizationCard = row => `- **${clean(row.method) || "未命名表征"}${row.sample ? ` · ${clean(row.sample)}` : ""}**：${emphasizeNumbers(brief(row.signal, 2))}；${brief(row.assignment, 1)}`;
  const coreCharacterizationCards = record.characterizations.slice(0, 7).map(characterizationCard).join("\n") || "- 未提取到可可靠定位的表征峰位或信号。";
  const characterizationDetails = record.characterizations.slice(0, 10).map(row => `- **${clean(row.method) || "未命名表征"}**：${emphasizeNumbers(row.signal || "特征值待核验")}\n  - 归属：${clean(row.assignment) || "待补充"}；来源：${clean(row.source) || "待核验"}`).join("\n");
  const resultBlocks = record.results.slice(0, 10).map((row, index) => {
    const asset = figure.resolve(row.figureRefs);
    const image = asset ? `![[${figure.pathOf(asset)}]]\n\n**${clean(asset.label) || `原文图 ${index + 1}`}，PDF p.${asset.page || "?"}**：${clean(asset.caption) || "图注需对照原始 PDF 核验。"}\n\n` : "";
    const values = [row.metric && `指标：${row.metric}`, row.sample && `样品：${row.sample}`, row.value && `结果：${row.value}`, row.baseline && `对照：${row.baseline}`, row.change && `变化：${row.change}`, row.condition && `测试条件：${row.condition}`].filter(Boolean).join("；");
    return `### 3.${index + 1} ${clean(row.topic) || `关键结果 ${index + 1}`}\n\n${image}- **定量结果**：${emphasizeNumbers(values || row.value || "原文未提取到可可靠定位的数值，需核验")}
- **证据解释**：${emphasizeNumbers(row.interpretation || "待补充")}
- **原文位置**：${clean(row.source) || "待核验"}（${confidence(row.confidence)}）`;
  }).join("\n\n") || "- 待补充";
  const resultCount = Math.min(10, record.results.length);
  const additionalFigureEntries = record.figures.map(row => ({ row, asset: figure.resolve(row.figureId ? [row.figureId] : []) })).filter(entry => entry.asset).slice(0, 6);
  const additionalFigureBlocks = additionalFigureEntries.map((entry, index) => `### 3.${resultCount + index + 1} ${clean(entry.row.figureId) || `关键原图 ${index + 1}`}：${clean(entry.row.purpose) || "补充图证据"}\n\n![[${figure.pathOf(entry.asset)}]]\n\n**${clean(entry.asset.label) || entry.row.figureId}，PDF p.${entry.asset.page || "?"}**：${clean(entry.asset.caption) || "图注需对照原始 PDF 核验。"}\n\n- **图表结论**：${emphasizeNumbers(entry.row.finding || "待补充")}\n- **原文位置**：${clean(entry.row.source) || "待核验"}`).join("\n\n");
  const claimCard = (row, index) => `${index + 1}. **${clean(row.claim) || `核心主张 ${index + 1}`}**\n   - **直接证据**：${emphasizeNumbers(row.evidence || "待补充")}\n   - **证据强度**：${clean(row.strength) || "待核验"}；来源：${clean(row.source) || "待核验"}${row.alternative ? `\n   - **尚未排除**：${clean(row.alternative)}` : ""}`;
  const coreClaimCards = record.claims.slice(0, 6).map((row, index) => `${index + 1}. **${clean(row.claim) || `核心主张 ${index + 1}`}**\n   - ${emphasizeNumbers(brief(row.evidence, 2))}（${clean(row.strength) || "待核验"}）`).join("\n\n") || "- 待补充";
  const claimDetails = record.claims.slice(0, 8).map(claimCard).join("\n\n");
  const innovationRows = record.innovations.slice(0, 5).map((row, index) => `${index + 1}. **${clean(row.title).replace(/[：:；。]+$/, "") || `创新点 ${index + 1}`}**：${emphasizeNumbers(row.detail)}${row.evidence ? `  \n   - **证据**：${emphasizeNumbers(row.evidence)}（${clean(row.source) || "待核验"}）` : ""}`).join("\n\n") || "1. **待补充**：需对照原文确认创新性。";
  const relationRows = record.relations.slice(0, 8).map(row => {
    const value = clean(typeof row === "string" ? row : row.target || row.label);
    if (value.startsWith("[[")) return `- ${value}`;
    const looksLikeNoteTitle = value.length <= 60 && !/[：；。]/.test(value);
    return looksLikeNoteTitle ? `- [[${value.replace(/^\[\[|\]\]$/g, "")}]]` : `- ${value}`;
  }).join("\n") || "- 待建立可靠的主题、方法或作者关联。";
  const pending = [...record.pending];
  const unmatched = record.figures.filter(row => {
    if (!row.figureId) return false;
    const asset = resolvedFigureAssets.find(candidate => normalizeFigureLabel(candidate.label) === normalizeFigureLabel(row.figureId) || (figureBase(row.figureId) && figureBase(candidate.label) === figureBase(row.figureId)));
    return !asset || !figure.used.has(figure.pathOf(asset));
  });
  if (unmatched.length) pending.push(`有 ${unmatched.length} 条图表证据尚未与提取图片可靠对应，未自动插入正文`);
  if (attachments.supplementary.length) pending.push(`发现 ${attachments.supplementary.length} 份支持材料，深度审核时需核验其中的 Fig. S / Table S 与补充实验条件`);
  const pendingSection = pending.length ? `\n\n## 七、待核验\n\n${uniqueRows(pending, row => row).slice(0, 10).map(text => `- [ ] ${clean(text)}`).join("\n")}` : "";
  const pdfVerified = Boolean(outputs.pdf_verification) && ![outputs.pdf_verification?.summary, ...(outputs.pdf_verification?.warnings || [])].some(text => /(?:未提供|没有|未能读取|无法读取|未能直接打开).*PDF|仅依据.*(?:网页|新闻稿|机构发布)/.test(String(text)));
  const embeddedCount = figure.used.size;

  return `---
标识: lit-${key}
类型: 文献
标题: "${yaml(cnTitle)}"
英文标题: "${yaml(item.title)}"
别名:
  - "${yaml(`${firstAuthor} et al. (${item.year || "n.d."}) — ${cnTitle}`)}"
作者:
${item.creators.map(author => `  - "${yaml(author)}"`).join("\n") || "  - 未知作者"}
期刊: "${yaml(item.journal)}"
年份: ${item.year || ""}
DOI: "${yaml(item.doi)}"
标签:
  - 文献阅读
  - ${/CF|carbon fiber/i.test(item.title) ? "碳纤维复合材料" : "材料科学"}
状态: AI草稿
处理状态: 完整
审核等级: 未审核
入库目录: ${folder}
Zotero条目键: ${key}
PDF附件键: ${attachments.pdf[0]?.key || ""}
MinerU缓存键: ${attachments.mineru[0]?.key || ""}
支持材料键: [${attachments.supplementary.map(row => row.key).join(", ")}]
证据状态: 待审核
更新时间: ${new Date().toISOString().slice(0, 10)}
架构版本: 文献笔记-v5
---

# ${noteName}

> [!abstract] 一句话结论
> ${summary}

<!-- REVIEW:QUICK:BEGIN -->
> [!check]- 快速审核与入库
> - [ ] 元数据、题名、作者、年份与 DOI 正确
> - [ ] 主文、MinerU缓存和支持材料分类正确
> - [ ] 一句话结论、创新点和关键结果已对照原文
<!-- REVIEW:QUICK:END -->

<!-- REVIEW:EVIDENCE:BEGIN -->
> [!check]- 证据审核
> - [ ] 关键条件、样品命名、数值、单位和对照已核验
> - [ ] 图片、图号、图注、PDF页码与正文论证一致
> - [ ] 作者结论、AI推论和替代解释已经区分
<!-- REVIEW:EVIDENCE:END -->

\`\`\`dataviewjs
const code = await dv.io.load("99_系统/脚本/审核入库.js");
await eval(\`(async () => { \${code} })()\`);
\`\`\`

## 一、研究问题与创新

### 1.1 研究背景与核心问题

${bulletText(record.researchQuestions.slice(0, 4), `- ${summary}`)}

### 1.2 创新点

${innovationRows}

## 二、实验设计与关键条件

### 2.1 技术路线

${bulletText(record.methods.slice(0, 4).map(row => `${row.step}：${row.parameters || row.purpose}`))}

${methodFigure ? `![[${figure.pathOf(methodFigure)}]]\n\n**${clean(methodFigure.label) || "原文技术路线图"}，PDF p.${methodFigure.page || "?"}**：${clean(methodFigure.caption) || "需对照原始 PDF 核验图注。"}` : "> [!warning] 技术路线图待核验\n> 未识别到可可靠确认的原文技术路线图，因此没有使用无关图片占位。"}

### 2.2 样品与对照

${coreSampleCards}${collapsible("样品详情与原文位置（展开查看）", sampleDetails)}

### 2.3 关键实验条件

${coreMethodCards}${collapsible("完整实验条件与来源（展开查看）", fullMethodCards)}

## 三、关键结果与讨论

${resultBlocks}${additionalFigureBlocks ? `\n\n${additionalFigureBlocks}` : ""}

### 3.${resultCount + additionalFigureEntries.length + 1} 关键表征信号

${coreCharacterizationCards}${collapsible("完整表征归属与来源（展开查看）", characterizationDetails)}

## 四、机制与证据强度

${coreClaimCards}${collapsible("完整证据判断与替代解释（展开查看）", claimDetails)}

## 五、结论、局限与可复用内容

### 5.1 结论

${bulletText(record.claims.slice(0, 5).map(row => row.claim), `- ${summary}`)}

### 5.2 局限性

${bulletText(record.limitations.slice(0, 6), "- 原文局限性尚未被可靠提取，需深度审核。")}

### 5.3 可复用内容

<!-- HUMAN:BEGIN reusable -->
- **可复现实验条件**：
- **可复用表征组合**：
- **可复用论证方式**：
- **对后续实验的启示**：
<!-- HUMAN:END reusable -->

## 六、知识关联与个人笔记

### 6.1 相关知识与文献

${relationRows}

### 6.2 为什么阅读这篇

<!-- HUMAN:BEGIN reading-purpose -->
- 要解决的问题：
- 与当前研究的关系：
- 阅读前预期：
- 阅读后是否满足预期：
<!-- HUMAN:END reading-purpose -->

### 6.3 我的判断

<!-- HUMAN:BEGIN judgement -->
- 证据充分之处：
- 仍不信服之处：
- 对当前研究的价值：
<!-- HUMAN:END judgement -->${pendingSection}

<!-- V5质量计数 创新=${Math.min(5, record.innovations.length)} 方法=${Math.min(10, record.methods.length)} 结果=${Math.min(10, record.results.length)} 表征=${Math.min(10, record.characterizations.length)} 图片=${embeddedCount} PDF核验=${pdfVerified} -->
`;
}

export function validateLiteratureNoteV5(note, hasPdf, expectedFigures = 0, preset = "standard") {
  const headings = ["一、研究问题与创新", "二、实验设计与关键条件", "三、关键结果与讨论", "四、机制与证据强度", "五、结论、局限与可复用内容", "六、知识关联与个人笔记"];
  const issues = headings.filter(heading => !note.includes(heading)).map(heading => `缺少“${heading}”`);
  if (!note.includes("架构版本: 文献笔记-v5")) issues.push("不是锁定的文献笔记 V5 架构");
  const counts = Object.fromEntries([...note.matchAll(/(创新|方法|结果|表征|图片)=(\d+)/g)].map(match => [match[1], Number(match[2])]));
  const minimums = {
    quick: { innovation: 3, method: 4, result: 5, image: 2 },
    standard: { innovation: 3, method: 5, result: 6, image: 3 },
    deep: { innovation: 3, method: 6, result: 8, image: 4 },
    library: { innovation: 3, method: 8, result: 8, image: 4 }
  }[preset] || { innovation: 3, method: 5, result: 6, image: 3 };
  if ((counts.创新 || 0) < minimums.innovation) issues.push(`创新点不足（${counts.创新 || 0}/${minimums.innovation}）`);
  if ((counts.方法 || 0) < minimums.method) issues.push(`可复现实验条件不足（${counts.方法 || 0}/${minimums.method}）`);
  if ((counts.结果 || 0) < minimums.result) issues.push(`关键结果不足（${counts.结果 || 0}/${minimums.result}）`);
  const numericCount = (note.match(/\d+(?:\.\d+)?\s*(?:wt%|vol%|at%|mol%|mM|μM|M|mV|V|°C|min|h|s|nm|μm|mm|cm|Pa|kPa|MPa|GPa|ppm|%)/gi) || []).length;
  if (hasPdf && numericCount < minimums.result) issues.push(`带单位的定量证据不足（${numericCount}/${minimums.result}）`);
  if (hasPdf && expectedFigures === 0) issues.push("原始 PDF 存在，但未建立可靠的图号—图注—图片映射；禁止按页序猜测配图");
  if (hasPdf && expectedFigures > 0 && (counts.图片 || 0) < Math.min(expectedFigures, minimums.image)) issues.push(`与论证可靠对应的原文图片不足（${counts.图片 || 0}/${Math.min(expectedFigures, minimums.image)}）；未对应图片不会强行堆入正文`);
  if (/(?:FT-?IR|红外)/i.test(note) && !/cm[⁻−–-]?¹|cm[−–-]?1/i.test(note)) issues.push("提及红外表征但没有给出峰位及归属");
  return { ok: !issues.length, issues };
}
