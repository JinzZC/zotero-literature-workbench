import assert from "node:assert/strict";
import { buildPaperRecord, inferDocumentType, renderLiteratureNoteV5, validateLiteratureNoteV5 } from "./note-v5.mjs";

const confidence = "high";
const source = "Fig. 2, PDF p.4";
const outputs = {
  fulltext_analysis: {
    documentType: "research_article",
    noteTitle: "测试材料的界面增强",
    libraryFolder: "界面工程",
    summary: "通过受控界面构筑提高复合材料性能。",
    findings: [], warnings: [],
    record: {
      researchQuestions: ["如何在不牺牲本体性能的情况下增强界面"],
      innovations: [1,2,3].map(i => ({ title:`创新 ${i}`, detail:`提出策略 ${i}`, evidence:"原文证据", source, confidence })),
      methods: [1,2,3,4,5,6,7,8].map(i => ({ step:`步骤 ${i}`, materials:"材料 A", parameters:i === 1 ? "5.0 mmol，1 min" : `${i * 10} °C，${i} h`, purpose:"控制变量", source, confidence })),
      samplesControls: [{ sample:"实验组", role:"实验", composition:"材料 A" ,source,confidence},{sample:"对照组",role:"对照",composition:"不处理",source,confidence}],
      characterizations: [{method:"FTIR",sample:"实验组",signal:"1720 cm−1",assignment:"C=O",source,confidence}],
      results: [1,2,3,4,5,6].map(i => ({topic:`结果 ${i}`,metric:"强度",sample:"实验组",value:`${100+i} MPa`,baseline:"90 MPa",change:"提高 12%",condition:"25 °C",interpretation:"支持界面增强",source,confidence,figureRefs:[`Fig. ${i}A`]})),
      figures: [1,2,3].map(i => ({figureId:`Fig. ${i}A–D`,purpose:`结果 ${i}`,finding:"对应结果",source:`PDF p.${i+2}`})),
      claims: [1,2,3].map(i => ({claim:`主张 ${i}`,evidence:`${100+i} MPa`,source,strength:"高",alternative:"测试误差"})),
      limitations: ["样本规模有限"], relations: ["界面工程"], pending: []
    }
  }
};
const item = { title:"Interface test", creators:["Zhang San"], year:"2026", journal:"Test", doi:"10.1/test" };
const attachments = { pdf:[{key:"PDFKEY"}], mineru:[{key:"MINERU"}], supplementary:[] };
const figures = [1,2,3].map(i => ({path:`90_附件/文献/TEST/fig-${i}.png`,label:`Fig. ${i}`,caption:`结果 ${i}`,page:i+2}));
const note = renderLiteratureNoteV5(item, "TESTKEY", attachments, outputs, {libraryFolder:"未分类"}, figures);
assert.match(note, /架构版本: 文献笔记-v5/);
assert.equal((note.match(/^## /gm) || []).length, 6);
assert.equal((note.match(/!\[\[90_附件\/文献\//g) || []).length, 3);
assert.ok(note.indexOf("fig-1.png") < note.indexOf("- **定量结果**"));
assert.doesNotMatch(note, /## 处理配置/);
assert.match(note, /\*\*5\.0 mmol\*\*，\*\*1 min\*\*/);
assert.doesNotMatch(note, /\*\*1 m\*\*in|\*\*5\.0 mm\*\*ol/);
assert.match(note, /> \[!note\]- 完整实验条件与来源/);
assert.doesNotMatch(note, /\| 环节 \| 材料与关键参数/);
assert.doesNotMatch(note, /\| 核心主张 \| 直接证据/);
const inferredNote = renderLiteratureNoteV5(item, "TESTKEY", attachments, outputs, {libraryFolder:"未分类"}, figures.map(figure => ({ ...figure, label:"", caption:"" })));
assert.equal((inferredNote.match(/!\[\[90_附件\/文献\//g) || []).length, 0);
assert.match(inferredNote, /图表证据尚未与提取图片可靠对应/);
const validation = validateLiteratureNoteV5(note, true, 3, "standard");
assert.equal(validation.ok, true, JSON.stringify(validation.issues));
const missingFigureMap = validateLiteratureNoteV5(inferredNote, true, 0, "standard");
assert.equal(missingFigureMap.ok, false);
assert.ok(missingFigureMap.issues.some(issue => issue.includes("禁止按页序猜测配图")));
const legacyRecord = buildPaperRecord({ fulltext_analysis: { findings: [
  { category:"overview", claim:"分层结构协同实现增强", evidence:"总体设计", source, confidence },
  { category:"method", claim:"采用表面改性", evidence:"改善分散", source, confidence },
  { category:"method", claim:"采用正交层压", evidence:"构筑层状结构", source, confidence },
  { category:"evidence", claim:"屏蔽性能提高", evidence:"达到 90%", source, confidence }
] } });
assert.ok(legacyRecord.innovations.length >= 3);

const reviewItem = {
  title: "Recent advances in carbon fiber surface modification: A review",
  abstract: "This review summarizes surface modification routes, evidence, limitations, and future opportunities.",
  creators: ["Li Ming"], year: "2025", journal: "Progress in Materials Science", doi: "10.1/review"
};
const reviewOutputs = {
  note_synthesis: {
    documentType: "review",
    noteTitle: "碳纤维表面改性研究进展",
    libraryFolder: "碳纤维界面工程",
    summary: "综述比较了碳纤维表面改性路线的作用机制、证据边界与未来方向。",
    findings: [], warnings: [],
    record: {
      researchQuestions: ["不同表面改性路线如何影响界面结构与性能", "现有证据有哪些共识与争议"],
      innovations: [
        { title:"统一分类框架", detail:"按化学、物理和复合策略组织现有工作", evidence:"覆盖主要技术路线", source:"全文综述框架", confidence },
        { title:"证据边界比较", detail:"比较表征证据、性能指标及适用边界", evidence:"跨研究对照", source:"讨论部分", confidence }
      ],
      methods: [
        { step:"文献范围", materials:"碳纤维表面改性研究", parameters:"覆盖化学、物理及复合改性", purpose:"界定综述边界", source:"引言与方法说明", confidence },
        { step:"分类与比较", materials:"不同处理路线", parameters:"按机理、界面表征和性能维度比较", purpose:"形成统一证据框架", source:"正文组织结构", confidence }
      ],
      samplesControls: [
        { sample:"化学改性路线", role:"覆盖类别", composition:"氧化、接枝与涂层", source:"综述正文", confidence },
        { sample:"物理改性路线", role:"覆盖类别", composition:"等离子体与辐照", source:"综述正文", confidence }
      ],
      characterizations: [],
      results: [1,2,3,4,5,6].map(i => ({ topic:`综合结论 ${i}`, metric:"", sample:"", value:`第 ${i} 类证据形成稳定趋势`, baseline:"", change:"", condition:"", interpretation:"同时指出适用条件与证据局限", source:`第 ${i + 1} 节`, confidence, figureRefs:[] })),
      figures: [],
      claims: [1,2,3,4,5,6].map(i => ({ claim:`综述主张 ${i}`, evidence:"由多篇研究的共同趋势支持", source:`第 ${i + 1} 节`, strength:"中", alternative:"研究间测试口径不同" })),
      limitations: ["纳入研究的测试口径不完全一致", "部分机制仍缺少原位证据"],
      relations: ["碳纤维界面工程"], pending: []
    }
  }
};
assert.equal(inferDocumentType(reviewItem, {}), "review");
assert.equal(inferDocumentType({ title:"Generic surface modification", journal:"Example Reviews" }, {}), "review");
const reviewNote = renderLiteratureNoteV5(reviewItem, "REVIEW1", attachments, reviewOutputs, { libraryFolder:"未分类" }, []);
assert.match(reviewNote, /文献类型: 叙述性综述/);
assert.match(reviewNote, /## 二、检索范围与分类框架/);
assert.match(reviewNote, /## 三、核心观点与证据脉络/);
assert.doesNotMatch(reviewNote, /## 二、实验设计与关键条件/);
assert.match(reviewNote, /\*\*综合证据\*\*/);
const reviewValidation = validateLiteratureNoteV5(reviewNote, true, 0, "library");
assert.equal(reviewValidation.ok, true, JSON.stringify(reviewValidation.issues));
assert.equal(reviewValidation.documentType, "review");
// A review is not exempt from synthesis or reliable-image checks.
const shortReview = reviewNote.replace(/结果=\d+/, "结果=2").replace(/观点=\d+/, "观点=2");
assert.ok(validateLiteratureNoteV5(shortReview, true, 0, "library").issues.some(issue => issue.includes("核心综合结论不足")));
assert.ok(validateLiteratureNoteV5(reviewNote, true, 2, "library").issues.some(issue => issue.includes("原文图片不足")));
assert.equal(validateLiteratureNoteV5(reviewNote + "\n综述一般性讨论 FTIR 方法。", true, 0, "library").ok, true);
assert.ok(validateLiteratureNoteV5(note.replaceAll("1720 cm−1", "存在信号"), true, 3, "standard").issues.some(issue => issue.includes("红外表征")));
assert.equal(inferDocumentType(reviewItem, { note_synthesis:{documentType:"research_article"} }), "research_article");
for (const type of ["systematic_review", "meta_analysis", "perspective"]) {
  const fixture = structuredClone(reviewOutputs);
  fixture.note_synthesis.documentType = type;
  const rendered = renderLiteratureNoteV5(reviewItem, "REVIEW1", attachments, fixture, {}, []);
  assert.equal(validateLiteratureNoteV5(rendered, true, 0, "library").documentType, type);
  assert.equal(validateLiteratureNoteV5(rendered, true, 0, "library").ok, true);
}
const localNaming = renderLiteratureNoteV5(item, "TESTKEY", attachments, outputs, {
  noteOverrides: { TESTKEY: { title:"合成测试题名", folder:"合成测试分类" } }
}, figures);
assert.match(localNaming, /标题: "合成测试题名"/);
assert.match(localNaming, /入库目录: 合成测试分类/);
console.log("V5 renderer and quality gate: OK");
