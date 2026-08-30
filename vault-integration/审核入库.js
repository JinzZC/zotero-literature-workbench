const page = dv.current();
const file = app.vault.getAbstractFileByPath(page.file.path);
const root = dv.container;
const message = root.createEl("div");
message.style.cssText = "margin:8px 0;color:var(--text-muted)";
const bar = root.createDiv();
bar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
const levels = [
  { key: "quick", label: "快速审核并入库", status: "quick-reviewed" },
  { key: "evidence", label: "证据审核", status: "evidence-reviewed" },
  { key: "deep", label: "深度审核", status: "deep-reviewed" }
];
const buttons = new Map();
const prop = (obj, cn, legacy) => obj?.[cn] ?? obj?.[legacy];
const setProp = (obj, cn, legacy, value) => {
  if (Object.prototype.hasOwnProperty.call(obj, cn) || !Object.prototype.hasOwnProperty.call(obj, legacy)) obj[cn] = value;
  else obj[legacy] = value;
};
for (const level of levels) {
  const button = bar.createEl("button", { text: level.label });
  button.style.cssText = "padding:8px 14px;font-weight:600;cursor:pointer";
  buttons.set(level.key, button);
}
function blockState(content, key) {
  const re = new RegExp(`<!-- REVIEW:${key.toUpperCase()}:BEGIN -->([\\s\\S]*?)<!-- REVIEW:${key.toUpperCase()}:END -->`);
  let block = content.match(re);
  if (!block && key === "evidence") block = content.match(/<!-- REVIEW:BEGIN -->([\s\S]*?)<!-- REVIEW:END -->/);
  if (!block) return { total: 0, done: 0, ready: false };
  const tasks = [...block[1].matchAll(/^(?:>\s*)?- \[([ xX])\]/gm)];
  const done = tasks.filter(x => x[1].toLowerCase() === "x").length;
  return { total: tasks.length, done, ready: tasks.length > 0 && done === tasks.length };
}
async function states() {
  const content = await app.vault.cachedRead(file);
  return Object.fromEntries(levels.map(x => [x.key, blockState(content, x.key)]));
}
function normalizedDoi(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
}
function listValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null || value === "" ? [] : [value];
}
function uniqueValues(...values) {
  return [...new Set(values.flatMap(listValue).map(value => String(value).trim()).filter(Boolean))];
}
function frontmatterOf(target) {
  return app.metadataCache.getFileCache(target)?.frontmatter || {};
}
async function findFormalDuplicate(targetPath) {
  const direct = app.vault.getAbstractFileByPath(targetPath);
  if (direct && direct.path !== file.path) return direct;
  const sourceDoi = normalizedDoi(prop(page, "DOI", "doi"));
  const sourceKey = String(prop(page, "Zotero条目键", "zotero_item_key") || "").trim().toUpperCase();
  return app.vault.getMarkdownFiles().find(candidate => {
    if (!candidate.path.startsWith("20_文献/") || candidate.path === file.path) return false;
    const fm = frontmatterOf(candidate);
    const candidateDoi = normalizedDoi(prop(fm, "DOI", "doi"));
    const candidateKey = String(prop(fm, "Zotero条目键", "zotero_item_key") || "").trim().toUpperCase();
    return Boolean((sourceDoi && candidateDoi === sourceDoi) || (sourceKey && candidateKey === sourceKey));
  }) || null;
}
function replaceHumanBlocks(draftContent, existingContent) {
  const blocks = new Map();
  for (const match of existingContent.matchAll(/<!-- HUMAN:BEGIN ([^\s]+) -->([\s\S]*?)<!-- HUMAN:END \1 -->/g)) {
    if (match[2].trim()) blocks.set(match[1], match[2]);
  }
  return draftContent.replace(/<!-- HUMAN:BEGIN ([^\s]+) -->([\s\S]*?)<!-- HUMAN:END \1 -->/g, (whole, name) => {
    const saved = blocks.get(name);
    return saved == null ? whole : `<!-- HUMAN:BEGIN ${name} -->${saved}<!-- HUMAN:END ${name} -->`;
  });
}
function legacyPersonalContent(existingContent) {
  const saved = existingContent.match(/<!-- HUMAN:BEGIN legacy-note -->([\s\S]*?)<!-- HUMAN:END legacy-note -->/);
  if (saved?.[1]?.trim()) return saved[1].trim();
  const personal = existingContent.match(/^##\s+(?:[一二三四五六七八九十]+、)?个人评述[^\n]*\n([\s\S]*)$/m);
  if (!personal?.[0]?.trim()) return "";
  return personal[0].trim().replace(/^(#{2,5})/gm, "$1#");
}
function legacyRouteContent(existingContent, draftContent) {
  const routes = [...existingContent.matchAll(/```mermaid\s*\n[\s\S]*?```/g)].map(match => match[0].trim());
  return routes.filter(route => !draftContent.includes(route)).join("\n\n");
}
async function mergeIntoFormal(existingFile, today) {
  const existingContent = await app.vault.cachedRead(existingFile);
  const draftContent = await app.vault.cachedRead(file);
  const existingFm = { ...frontmatterOf(existingFile) };
  const draftFm = { ...frontmatterOf(file) };
  let mergedContent = replaceHumanBlocks(draftContent, existingContent);
  const legacy = legacyPersonalContent(existingContent);
  const routes = legacyRouteContent(existingContent, draftContent);
  if ((legacy || routes) && !mergedContent.includes("<!-- HUMAN:BEGIN legacy-note -->")) {
    const preserved = [
      routes ? `### 原有技术路线图\n\n${routes}` : "",
      legacy ? `### 原有个人评述与速查内容\n\n${legacy}` : ""
    ].filter(Boolean).join("\n\n");
    const legacyBlock = `### 6.4 原有阅读笔记中的保留内容\n\n> [!info] 合并说明\n> 以下内容来自入库前已经存在的阅读笔记，保留原有技术路线、个人评述、研究启发、术语和速查信息。\n\n<!-- HUMAN:BEGIN legacy-note -->\n${preserved}\n<!-- HUMAN:END legacy-note -->\n\n`;
    mergedContent = mergedContent.includes("\n## 七、待核验")
      ? mergedContent.replace("\n## 七、待核验", `\n${legacyBlock}## 七、待核验`)
      : `${mergedContent.trim()}\n\n${legacyBlock}`;
  }
  await app.vault.modify(existingFile, mergedContent);
  await app.fileManager.processFrontMatter(existingFile, fm => {
    for (const [cn, legacy] of [["别名","aliases"],["标签","tags"],["关键词","keywords"],["机构","affiliations"]]) setProp(fm, cn, legacy, uniqueValues(prop(draftFm, cn, legacy), prop(existingFm, cn, legacy)));
    for (const key of ["rating", "read_date", "quick_reviewed_date", "evidence_reviewed_date", "deep_reviewed_date"]) {
      if (existingFm[key] != null && existingFm[key] !== "") fm[key] = existingFm[key];
    }
    setProp(fm, "入库目录", "library_folder", prop(existingFm, "入库目录", "library_folder") || prop(draftFm, "入库目录", "library_folder") || "未分类");
    setProp(fm, "状态", "status", "已快速审核");
    setProp(fm, "审核等级", "review_level", "快速审核");
    setProp(fm, "快速审核日期", "quick_reviewed_date", prop(existingFm, "快速审核日期", "quick_reviewed_date") || today);
    setProp(fm, "更新时间", "updated", today);
  });
  await app.vault.trash(file, true);
  return existingFile.path;
}
async function setLevel(level) {
  const state = (await states())[level.key];
  if (!state.ready) { new Notice(`${level.label}清单尚未完成（${state.done}/${state.total}）`); return; }
  const folderName = String(prop(page, "入库目录", "library_folder") || "未分类").trim();
  if (!folderName || folderName.includes("..") || folderName.startsWith("/") || folderName.startsWith("\\")) {
    new Notice("“入库目录”属性无效，请先修正。"); return;
  }
  const today = window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0,10);
  await app.fileManager.processFrontMatter(file, fm => {
    const labels = { quick: "快速审核", evidence: "证据审核", deep: "深度审核" };
    setProp(fm, "状态", "status", labels[level.key]); setProp(fm, "审核等级", "review_level", labels[level.key]); setProp(fm, "更新时间", "updated", today);
    if (level.key === "quick") setProp(fm, "快速审核日期", "quick_reviewed_date", today);
    if (level.key === "evidence") { setProp(fm, "证据审核日期", "evidence_reviewed_date", today); setProp(fm, "来源已核验", "source_verified", true); }
    if (level.key === "deep") { setProp(fm, "深度审核日期", "deep_reviewed_date", today); setProp(fm, "来源已核验", "source_verified", true); }
  });
  if (level.key === "quick" && file.path.startsWith("01_收件箱/AI草稿/")) {
    const targetFolder = `20_文献/${folderName}`;
    const targetPath = `${targetFolder}/${file.name}`;
    const duplicate = await findFormalDuplicate(targetPath);
    if (duplicate) {
      const mergedPath = await mergeIntoFormal(duplicate, today);
      new Notice(`已识别同一文献并合并入库：${mergedPath}`);
      return;
    }
    if (!app.vault.getAbstractFileByPath(targetFolder)) await app.vault.createFolder(targetFolder);
    await app.fileManager.renameFile(file, targetPath);
    new Notice(`已快速审核并入库：${targetPath}`);
  } else new Notice(`已标记为 ${level.status}`);
}
for (const level of levels) buttons.get(level.key).addEventListener("click", () => setLevel(level).catch(e => new Notice(e.message || e)));
const s = await states();
for (const level of levels) buttons.get(level.key).disabled = !s[level.key].ready;
message.textContent = levels.map(x => `${x.label} ${s[x.key].done}/${s[x.key].total}`).join(" · ");
