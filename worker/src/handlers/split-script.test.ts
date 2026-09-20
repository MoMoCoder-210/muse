import assert from "node:assert/strict";
import test from "node:test";

import { ruleSplit } from "./split-script.js";
import { formatNumberedScript, materializeBoundaryClips, parseModelBoundaries } from "./split-boundaries.js";

const body = "这是用于验证本地规则拆分的剧情正文，包含足够多的文字以满足每集至少五十字的质量门槛。主角继续推进事件，配角给出回应，冲突和转折都在这一段持续发展。";

test("识别 Markdown 中文分集标题并保留正文格式", () => {
  const text = [
    "## 第1集：穿越成乞丐",
    "",
    "**场景**：现代办公室 → 明朝街头",
    "",
    "**详细剧情**：",
    body,
    "",
    "------",
    "",
    "### **第２集：小学算术打脸账房**",
    "",
    "**场景**：米铺门口",
    "",
    "**详细剧情**：",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((clip) => clip.title), ["穿越成乞丐", "小学算术打脸账房"]);
  assert.match(clips[0].sourceText, /\*\*场景\*\*/);
  assert.match(clips[0].sourceText, /\*\*详细剧情\*\*/);
  assert.match(clips[0].sourceText, /------/);
});

test("默认剔除首个有效分集标题之前的前言和设定", () => {
  const preamble = "人物介绍：主角来自现代，拥有一套尚未完全理解的能力系统。这段前言只用于导入说明，不应写入任一分集正文。";
  const text = [
    preamble,
    "",
    "## 第1集：故事开始",
    body,
    "",
    "## 第2集：继续前进",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.equal(clips.length, 2);
  assert.doesNotMatch(clips[0].sourceText, /人物介绍|能力系统/);
});

test("场景编号不会作为分集标志", () => {
  const text = [
    "场景1：街头",
    body,
    "",
    "场景2：米铺",
    body,
  ].join("\n");

  assert.equal(ruleSplit(text), null);
});

test("明确分集标题内的场景编号保留在正文", () => {
  const text = [
    "## 第1集：街头冲突",
    body,
    "",
    "场景1：街头",
    body,
    "",
    "## 第2集：新的线索",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.equal(clips.length, 2);
  assert.match(clips[0].sourceText, /场景1：街头/);
});

test("覆盖常见中文分集标志", () => {
  const text = [
    "第1话：开端",
    body,
    "第2部：远行",
    body,
    "第3卷：风云",
    body,
    "第4篇：重逢",
    body,
    "第5幕：决战",
    body,
    "第6回：归来",
    body,
    "第7节：尾声",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.deepEqual(clips.map((clip) => clip.title), ["开端", "远行", "风云", "重逢", "决战", "归来", "尾声"]);
});

test("覆盖季集、英文缩写、罗马数字和 Markdown 编号标题", () => {
  const text = [
    "## 第1季·第2集：季集标题",
    body,
    "",
    "## S01E03: Season Code",
    body,
    "",
    "## Chap. IV: Roman Chapter",
    body,
    "",
    "## Vol. 2: Second Volume",
    body,
    "",
    "## 5、Markdown Number",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.deepEqual(clips.map((clip) => clip.title), [
    "季集标题",
    "Season Code",
    "Roman Chapter",
    "Second Volume",
    "Markdown Number",
  ]);
});

test("纯编号标题会生成干净默认标题，正文中的第X集描述不会误拆", () => {
  const text = [
    "## 第1集 ##",
    body,
    "第1集的故事仍在继续，这一行是正文而不是新的标题。",
    "",
    "## 第2集：新的开始 ##",
    body,
  ].join("\n");

  const clips = ruleSplit(text);

  assert.ok(clips);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].title, "第1集");
  assert.equal(clips[1].title, "新的开始");
  assert.match(clips[0].sourceText, /第1集的故事仍在继续/);
});

test("模型边界只切本地原文，并完整保留空行和 Unicode 字符", () => {
  const text = "第一行😀\n\n第三行\n第四行";
  const numbered = formatNumberedScript(text);
  assert.match(numbered, /\[L000002\] /);

  const ends = parseModelBoundaries('{"boundaries":[{"endLine":2},{"endLine":4}]}', 4);
  const clips = materializeBoundaryClips(text, ends);

  assert.deepEqual(clips.map((clip) => clip.sourceText), ["第一行😀\n\n", "第三行\n第四行"]);
  assert.equal(clips.map((clip) => clip.sourceText).join(""), text);
});

test("拒绝缺尾、倒序或越界的模型边界", () => {
  assert.throws(() => parseModelBoundaries('{"boundaries":[{"endLine":1}]}', 2), /未覆盖完整原文/);
  assert.throws(() => parseModelBoundaries('{"boundaries":[{"endLine":2},{"endLine":2}]}', 2), /不递增/);
  assert.throws(() => parseModelBoundaries('{"boundaries":[{"endLine":3}]}', 2), /越界/);
});