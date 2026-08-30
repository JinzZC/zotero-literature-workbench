import assert from "node:assert/strict";
import { buildPaperRecord, renderLiteratureNoteV5, validateLiteratureNoteV5 } from "./note-v5.mjs";

const confidence = "high";
const source = "Fig. 2, PDF p.4";
const outputs = {
  fulltext_analysis: {
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
console.log("V5 renderer and quality gate: OK");
