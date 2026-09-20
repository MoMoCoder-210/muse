import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database, { type Database as DatabaseType } from "better-sqlite3";

import { claimPendingTask, transitionEntityStatus } from "../db.js";
import type { ChatMessage, TextCallOptions, TextCallResult } from "../clients/text.js";
import type { TaskContext } from "../types.js";
import {
  generateClipScriptHandler,
  parseAssetsOutput,
  parseStoryboardsOutput,
  resolveReusableAssetId,
  toModelAssetReferences,
  validateStoryboardAssetIds,
  validateStoryboardOutput,
  type AvailableAsset,
  type StoryboardItem,
} from "./generate-clip-script.js";

const assets: AvailableAsset[] = [
  { id: "char-1", type: "character", name: "沈青", description: "主角", prompt: "人物" },
  { id: "scene-1", type: "scene", name: "书房", description: "室内", prompt: "场景" },
  { id: "item-1", type: "item", name: "玉佩", description: "信物", prompt: "道具" },
];

const sourceText = "主角在书房查看玉佩";
const validStoryboard: StoryboardItem = {
  sbid: "1",
  duration: 5,
  description: "主角在书房查看玉佩",
  originalText: sourceText,
  animationPrompt: "c01,5s,[空间:书房中景，主角居中][姿态:沈青站立，手持玉佩] 沈青低头查看玉佩。",
  characterAssetIds: ["char-1"],
  sceneAssetIds: ["scene-1"],
  itemAssetIds: ["item-1"],
};

function storyboard(overrides: Partial<StoryboardItem> = {}): StoryboardItem {
  return { ...validStoryboard, ...overrides };
}

test("阶段 A 无 id 时不按当前分集名称隐式复用", () => {
  assert.equal(
    resolveReusableAssetId({ type: "character", name: "沈青" }, assets),
    undefined,
  );
});

test("阶段 A 无 id 时不按作品素材名称隐式复用", () => {
  const projectAsset: AvailableAsset = { id: "project-scene", type: "scene", name: "城门", description: "", prompt: "" };
  assert.equal(
    resolveReusableAssetId({ type: "scene", name: "城门" }, [projectAsset]),
    undefined,
  );
});

test("阶段 A 可显式复用当前作品中其他分集的素材 ID", () => {
  const projectAsset: AvailableAsset = { id: "project-char", type: "character", name: "沈青", description: "主角", prompt: "人物" };
  assert.equal(
    resolveReusableAssetId({ type: "character", name: "沈青", id: "project-char" }, [projectAsset]),
    "project-char",
  );
});

test("阶段 A 拒绝不属于当前作品的显式素材 ID", () => {
  assert.throws(
    () => resolveReusableAssetId({ type: "character", name: "沈青", id: "other-project-char" }, assets),
    /不属于当前作品/,
  );
});

test("阶段 A 拒绝显式素材 ID 的跨类型引用", () => {
  assert.throws(
    () => resolveReusableAssetId({ type: "scene", name: "书房", id: "char-1" }, assets),
    /类型不匹配/,
  );
});

test("阶段 B 接受当前拆解且类型正确的素材 ID", () => {
  assert.doesNotThrow(() => validateStoryboardAssetIds([validStoryboard], assets));
});

test("阶段 B 拒绝不属于本次拆解的素材 ID，不按名称回退", () => {
  assert.throws(
    () => validateStoryboardAssetIds([storyboard({ characterAssetIds: ["foreign-char"] })], assets),
    /不属于本次拆解/,
  );
});

test("阶段 B 拒绝跨类型素材 ID", () => {
  assert.throws(
    () => validateStoryboardAssetIds([storyboard({
      characterAssetIds: [],
      sceneAssetIds: ["char-1"],
    })], assets),
    /类型不匹配/,
  );
});

test("模型素材快照只包含复用所需的 ID、类型和名称", () => {
  assert.deepEqual(toModelAssetReferences([assets[0]]), [
    { id: "char-1", type: "character", name: "沈青" },
  ]);
});

test("阶段 A 复用素材只接受原样的 id/type/name", () => {
  assert.deepEqual(
    parseAssetsOutput('{"assets":[{"id":"char-1","type":"character","name":"沈青"}]}'),
    [{ id: "char-1", type: "character", name: "沈青", description: "", prompt: "" }],
  );
  assert.throws(
    () => parseAssetsOutput('{"assets":[{"id":"char-1","type":"character","name":"沈青","description":"冗余"}]}'),
    /只能原样返回/,
  );
});

test("阶段 A 新增素材不得返回 id 且必须提供描述和提示词", () => {
  assert.deepEqual(
    parseAssetsOutput('{"assets":[{"type":"scene","name":"城门","description":"古城门","prompt":"青砖城门"}]}'),
    [{ type: "scene", name: "城门", description: "古城门", prompt: "青砖城门" }],
  );
  assert.throws(
    () => parseAssetsOutput('{"assets":[{"type":"scene","name":"城门","description":"古城门"}]}'),
    /必须提供 description 和 prompt/,
  );
  assert.throws(
    () => parseAssetsOutput('{"assets":[{"assetId":"legacy","type":"scene","name":"城门"}]}'),
    /废弃字段 assetId/,
  );
});

test("阶段 A 复用素材的名称必须与作品资产表一致", () => {
  assert.throws(
    () => resolveReusableAssetId({ type: "character", name: "主角沈青", id: "char-1" }, assets),
    /名称不匹配/,
  );
});

test("阶段 B 接受合法时长并拒绝非整数、越界和切镜秒数不相等", () => {
  assert.doesNotThrow(() => validateStoryboardOutput([validStoryboard], sourceText));
  assert.throws(() => validateStoryboardOutput([storyboard({ duration: 4 })], sourceText), /5~15 的整数/);
  assert.throws(() => validateStoryboardOutput([storyboard({ duration: 5.5 })], sourceText), /5~15 的整数/);
  assert.throws(() => validateStoryboardOutput([storyboard({ duration: 6 })], sourceText), /秒数之和/);
});

test("阶段 B 强制每镜 cNN 从 c01 连续递增", () => {
  assert.throws(
    () => validateStoryboardOutput([storyboard({
      duration: 10,
      animationPrompt: "c01,5s,[空间:书房中景][姿态:沈青站立] 沈青查看玉佩。\nc03,5s,[空间:书房近景][姿态:沈青低头] 镜头推近玉佩。",
    })], sourceText),
    /c01 连续递增/,
  );
  assert.throws(
    () => validateStoryboardOutput([storyboard({
      animationPrompt: "c1,5s,[空间:书房中景][姿态:沈青站立] 沈青查看玉佩。",
    })], sourceText),
    /格式无效/,
  );
  assert.throws(
    () => validateStoryboardOutput([storyboard({
      animationPrompt: "c01,5s,[空间:   ][姿态:\t] 沈青查看玉佩。",
    })], sourceText),
    /空间和姿态不能为空/,
  );
});

test("阶段 B animationPrompt 最多 600 字符", () => {
  const prefix = "c01,5s,[空间:书房中景][姿态:沈青站立] ";
  const exactly600 = prefix + "动".repeat(600 - prefix.length);
  assert.equal(exactly600.length, 600);
  assert.doesNotThrow(() => validateStoryboardOutput([storyboard({ animationPrompt: exactly600 })], sourceText));
  assert.throws(
    () => validateStoryboardOutput([storyboard({ animationPrompt: `${exactly600}作` })], sourceText),
    /不能超过 600 字符/,
  );
});

test("阶段 B 每镜三个素材数组合计最多 9 个", () => {
  const nineAssets: AvailableAsset[] = Array.from({ length: 9 }, (_, index) => ({
    id: `char-${index + 1}`,
    type: "character" as const,
    name: `人物${index + 1}`,
    description: "人物",
    prompt: "人物",
  }));
  const nineIds = nineAssets.map((asset) => asset.id);
  assert.doesNotThrow(() => validateStoryboardAssetIds([
    storyboard({ characterAssetIds: nineIds, sceneAssetIds: [], itemAssetIds: [] }),
  ], nineAssets));
  assert.throws(
    () => validateStoryboardAssetIds([
      storyboard({ characterAssetIds: [...nineIds, "char-10"], sceneAssetIds: [], itemAssetIds: [] }),
    ], nineAssets),
    /不能超过 9 个/,
  );
});

test("阶段 B originalText 保持原文且只允许遗漏空白或纯 Markdown 分隔线", () => {
  const parsed = parseStoryboardsOutput(JSON.stringify({
    storyboards: [{ ...validStoryboard, originalText: ` ${sourceText} ` }],
  }));
  assert.equal(parsed[0].originalText, ` ${sourceText} `);

  const dividedSource = "第一段\n\n---\n\n第二段\n***";
  assert.doesNotThrow(() => validateStoryboardOutput([
    storyboard({ sbid: "1", originalText: "第一段" }),
    storyboard({ sbid: "2", originalText: "第二段" }),
  ], dividedSource));

  assert.throws(() => validateStoryboardOutput([
    storyboard({ sbid: "1", originalText: "第一段" }),
    storyboard({ sbid: "2", originalText: "第二段" }),
  ], "第一段\n遗漏剧情\n第二段"), /遗漏了非空白/);

  assert.throws(
    () => validateStoryboardOutput([storyboard({ originalText: "第一段" })], "第一段\n末尾遗漏"),
    /最后一个镜头之后遗漏/,
  );
});

const integrationInput = {
  projectId: "project-integration",
  clipId: "clip-integration",
  clipScriptId: "clip-script-integration",
  sourceText,
  sourceRevision: 1,
  styleMode: "国漫",
};

const integrationTask = {
  id: "task-integration",
  type: "generate_clip_script",
  clip_id: integrationInput.clipId,
  lock_key: "generate_clip_script:clip-integration",
  input_json: JSON.stringify(integrationInput),
};

const integrationSchema = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT 'script',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    deleted_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    clip_id TEXT,
    storyboard_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    lock_key TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    error_message TEXT,
    cancel_requested_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE task_locks (
    lock_key TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL
  );
  CREATE TABLE clip_scripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE,
    source_revision INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    script_summary TEXT,
    raw_model_output TEXT,
    assets_raw_model_output TEXT,
    mode TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'model',
    status TEXT NOT NULL DEFAULT 'draft'
  );
  CREATE UNIQUE INDEX idx_assets_project_type_name ON assets(project_id, type, name);
  CREATE TABLE clip_assets (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'generated'
  );
  CREATE UNIQUE INDEX idx_clip_assets_unique ON clip_assets(clip_id, asset_id);
  CREATE TABLE storyboards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    sbid TEXT NOT NULL DEFAULT '',
    seq_num INTEGER NOT NULL,
    source_text TEXT,
    visual_description TEXT NOT NULL DEFAULT '',
    video_prompt TEXT NOT NULL DEFAULT '',
    video_duration REAL,
    video_param_json TEXT,
    selected_video_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE storyboard_assets (
    id TEXT PRIMARY KEY,
    storyboard_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_type TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_sa_unique ON storyboard_assets(storyboard_id, asset_id);
  CREATE TABLE storyboard_videos (
    storyboard_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cover_path TEXT
  );
  CREATE TABLE upscale_jobs (
    storyboard_id TEXT,
    output_path TEXT NOT NULL
  );
`;

interface IntegrationFixture {
  db: DatabaseType;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function createIntegrationFixture(withOldStoryboard = false): Promise<IntegrationFixture> {
  const workspacePath = await mkdtemp(join(tmpdir(), "muse-generate-clip-script-"));
  const db = new Database(":memory:");
  db.exec(integrationSchema);
  db.prepare("INSERT INTO projects (id, workspace_path, current_step) VALUES (?, ?, 'script')")
    .run(integrationInput.projectId, workspacePath);
  db.prepare("INSERT INTO clips (id, project_id, source_revision, status) VALUES (?, ?, 1, 'pending')")
    .run(integrationInput.clipId, integrationInput.projectId);
  db.prepare(`
    INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    integrationTask.id,
    integrationInput.projectId,
    integrationInput.clipId,
    integrationTask.type,
    integrationTask.lock_key,
    integrationTask.input_json,
  );
  db.prepare(`
    INSERT INTO clip_scripts (id, project_id, clip_id, task_id, source_revision, source_text, status)
    VALUES (?, ?, ?, ?, 1, ?, 'pending')
  `).run(
    integrationInput.clipScriptId,
    integrationInput.projectId,
    integrationInput.clipId,
    integrationTask.id,
    sourceText,
  );

  if (withOldStoryboard) {
    db.prepare(`
      INSERT INTO assets (id, project_id, type, name, description, prompt, source, status)
      VALUES ('old-asset', ?, 'character', '旧人物', '旧描述', '旧提示词', 'manual', 'confirmed')
    `).run(integrationInput.projectId);
    db.prepare(`
      INSERT INTO clip_assets (id, clip_id, asset_id, source)
      VALUES ('old-clip-asset', ?, 'old-asset', 'manual')
    `).run(integrationInput.clipId);
    db.prepare(`
      INSERT INTO storyboards (
        id, project_id, clip_id, sbid, seq_num, source_text,
        visual_description, video_prompt, video_duration, video_param_json
      ) VALUES ('old-storyboard', ?, ?, 'old', 1, '旧原文', '旧镜头', '旧提示词', 5, '{}')
    `).run(integrationInput.projectId, integrationInput.clipId);
    db.prepare(`
      INSERT INTO storyboard_assets (id, storyboard_id, asset_id, asset_type)
      VALUES ('old-storyboard-asset', 'old-storyboard', 'old-asset', 'character')
    `).run();
  }

  return {
    db,
    workspacePath,
    cleanup: async () => {
      db.close();
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

interface FakeChatCall {
  messages: ChatMessage[];
  options: TextCallOptions;
}

function createFakeTextClient(
  respond: (messages: ChatMessage[], callIndex: number) => string,
): {
  calls: FakeChatCall[];
  client: { chat: (messages: ChatMessage[], onChunk: (delta: string) => void, options?: TextCallOptions) => Promise<TextCallResult> };
} {
  const calls: FakeChatCall[] = [];
  return {
    calls,
    client: {
      async chat(
        messages: ChatMessage[],
        _onChunk: (delta: string) => void,
        options: TextCallOptions = {},
      ): Promise<TextCallResult> {
        calls.push({ messages, options });
        return {
          content: respond(messages, calls.length - 1),
          inputTokens: 0,
          outputTokens: 0,
          model: "integration-fake",
        };
      },
    },
  };
}

function createHandlerContext(
  fixture: IntegrationFixture,
  textClient: ReturnType<typeof createFakeTextClient>["client"],
): TaskContext {
  return {
    workspacePath: fixture.workspacePath,
    taskId: integrationTask.id,
    taskInput: integrationInput,
    db: fixture.db,
    emit: () => {},
    rateLimiter: {},
    signal: new AbortController().signal,
    clients: { text: textClient },
    ffmpeg: {},
  } as unknown as TaskContext;
}

const generatedAssetsOutput = JSON.stringify({
  assets: [
    { type: "character", name: "沈青", description: "年轻主角", prompt: "青衣青年" },
    { type: "scene", name: "书房", description: "古朴书房", prompt: "木质书房内景" },
    { type: "item", name: "玉佩", description: "白色玉佩", prompt: "温润白玉佩" },
  ],
});

function storyboardsOutputFromModelPayload(messages: ChatMessage[]): string {
  const payload = JSON.parse(messages[1].content) as {
    availableAssets: Array<{ id: string; type: string; name: string }>;
  };
  const byType = new Map(payload.availableAssets.map((asset) => [asset.type, asset]));
  assert.deepEqual(
    payload.availableAssets.map(({ type, name }) => ({ type, name })),
    [
      { type: "character", name: "沈青" },
      { type: "scene", name: "书房" },
      { type: "item", name: "玉佩" },
    ],
  );
  return JSON.stringify({
    storyboards: [{
      ...validStoryboard,
      characterAssetIds: [byType.get("character")?.id],
      sceneAssetIds: [byType.get("scene")?.id],
      itemAssetIds: [byType.get("item")?.id],
    }],
  });
}

test("真实 SQLite：running 拆解任务原子写入新素材、镜头与成功状态", async () => {
  const fixture = await createIntegrationFixture();
  try {
    const pending = fixture.db.prepare("SELECT status FROM tasks WHERE id = ?")
      .get(integrationTask.id) as { status: string };
    assert.equal(pending.status, "pending");
    assert.equal(claimPendingTask(fixture.db, integrationTask, "integration-worker"), true);
    transitionEntityStatus(fixture.db, integrationTask, "running");
    assert.deepEqual(
      fixture.db.prepare(`
        SELECT t.status AS task_status, c.status AS clip_status, cs.status AS script_status
        FROM tasks t
        JOIN clips c ON c.id = t.clip_id
        JOIN clip_scripts cs ON cs.task_id = t.id
        WHERE t.id = ?
      `).get(integrationTask.id),
      { task_status: "running", clip_status: "running", script_status: "running" },
    );

    const fake = createFakeTextClient((messages, callIndex) => {
      if (callIndex === 0) return generatedAssetsOutput;
      if (callIndex === 1) return storyboardsOutputFromModelPayload(messages);
      throw new Error(`unexpected text call ${callIndex + 1}`);
    });
    const ctx = createHandlerContext(fixture, fake.client);
    const output = await generateClipScriptHandler(ctx);

    assert.equal(output, JSON.stringify({ sbidCount: 1, characterCount: 1, sceneCount: 1, itemCount: 1 }));
    assert.equal(fake.calls.length, 2);
    for (const call of fake.calls) {
      assert.equal(call.options.signal, ctx.signal);
      assert.equal(call.options.reasoning_effort, "high");
    }

    const task = fixture.db.prepare(`
      SELECT status, output_json, error_message, finished_at FROM tasks WHERE id = ?
    `).get(integrationTask.id) as {
      status: string;
      output_json: string;
      error_message: string | null;
      finished_at: string | null;
    };
    assert.equal(task.status, "success");
    assert.equal(task.output_json, output);
    assert.equal(task.error_message, null);
    assert.ok(task.finished_at);

    const script = fixture.db.prepare(`
      SELECT status, script_summary, raw_model_output, assets_raw_model_output, mode, error_message
      FROM clip_scripts WHERE id = ?
    `).get(integrationInput.clipScriptId) as Record<string, string | null>;
    assert.deepEqual(script, {
      status: "success",
      script_summary: validStoryboard.description,
      raw_model_output: storyboardsOutputFromModelPayload(fake.calls[1].messages),
      assets_raw_model_output: generatedAssetsOutput,
      mode: "国漫",
      error_message: null,
    });
    assert.deepEqual(
      fixture.db.prepare(`
        SELECT c.status AS clip_status, p.current_step AS project_step
        FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.id = ?
      `).get(integrationInput.clipId),
      { clip_status: "script_ready", project_step: "asset" },
    );

    const persistedAssets = fixture.db.prepare(`
      SELECT id, type, name, description, prompt, source, status
      FROM assets ORDER BY CASE type WHEN 'character' THEN 1 WHEN 'scene' THEN 2 ELSE 3 END
    `).all() as Array<Record<string, string>>;
    assert.equal(persistedAssets.length, 3);
    assert.deepEqual(
      persistedAssets.map(({ type, name, description, prompt, source, status }) => ({
        type, name, description, prompt, source, status,
      })),
      [
        { type: "character", name: "沈青", description: "年轻主角", prompt: "青衣青年", source: "model", status: "draft" },
        { type: "scene", name: "书房", description: "古朴书房", prompt: "木质书房内景", source: "model", status: "draft" },
        { type: "item", name: "玉佩", description: "白色玉佩", prompt: "温润白玉佩", source: "model", status: "draft" },
      ],
    );
    assert.deepEqual(
      fixture.db.prepare(`
        SELECT a.type, a.name, ca.source
        FROM clip_assets ca JOIN assets a ON a.id = ca.asset_id
        WHERE ca.clip_id = ?
        ORDER BY CASE a.type WHEN 'character' THEN 1 WHEN 'scene' THEN 2 ELSE 3 END
      `).all(integrationInput.clipId),
      [
        { type: "character", name: "沈青", source: "generated" },
        { type: "scene", name: "书房", source: "generated" },
        { type: "item", name: "玉佩", source: "generated" },
      ],
    );

    const persistedStoryboard = fixture.db.prepare(`
      SELECT id, sbid, seq_num, source_text, visual_description, video_prompt,
             video_duration, video_param_json
      FROM storyboards WHERE clip_id = ?
    `).get(integrationInput.clipId) as Record<string, string | number>;
    assert.equal(persistedStoryboard.sbid, "1");
    assert.equal(persistedStoryboard.seq_num, 1);
    assert.equal(persistedStoryboard.source_text, sourceText);
    assert.equal(persistedStoryboard.visual_description, validStoryboard.description);
    assert.equal(persistedStoryboard.video_duration, 5);
    assert.match(String(persistedStoryboard.video_prompt), /人物： 沈青。/);
    assert.match(String(persistedStoryboard.video_prompt), /场景： 书房。/);
    assert.match(String(persistedStoryboard.video_prompt), /道具： 玉佩。/);
    assert.match(String(persistedStoryboard.video_prompt), /c01,5s/);
    assert.deepEqual(
      JSON.parse(String(persistedStoryboard.video_param_json)),
      {
        mention_map: persistedAssets.map((asset, index) => ({
          n: index + 1,
          assetId: asset.id,
          name: asset.name,
          type: asset.type,
          assetTag: `${asset.name}(@图片${index + 1})`,
        })),
      },
    );
    assert.deepEqual(
      fixture.db.prepare(`
        SELECT sa.asset_type, a.name
        FROM storyboard_assets sa JOIN assets a ON a.id = sa.asset_id
        WHERE sa.storyboard_id = ?
        ORDER BY CASE sa.asset_type WHEN 'character' THEN 1 WHEN 'scene' THEN 2 ELSE 3 END
      `).all(persistedStoryboard.id),
      [
        { asset_type: "character", name: "沈青" },
        { asset_type: "scene", name: "书房" },
        { asset_type: "item", name: "玉佩" },
      ],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await fixture.cleanup();
  }
});

test("真实 SQLite：阶段 B 最终非法时不写阶段 A 素材且保留旧镜头和 running 状态", async () => {
  const fixture = await createIntegrationFixture(true);
  try {
    assert.equal(claimPendingTask(fixture.db, integrationTask, "integration-worker"), true);
    transitionEntityStatus(fixture.db, integrationTask, "running");
    assert.equal(
      (fixture.db.prepare("SELECT status FROM clip_scripts WHERE id = ?")
        .get(integrationInput.clipScriptId) as { status: string }).status,
      "running",
    );

    const invalidStoryboardsOutput = JSON.stringify({ storyboards: [] });
    const fake = createFakeTextClient((_messages, callIndex) => {
      if (callIndex === 0) return generatedAssetsOutput;
      return invalidStoryboardsOutput;
    });
    await assert.rejects(
      generateClipScriptHandler(createHandlerContext(fixture, fake.client)),
      /镜头返回格式无效/,
    );
    assert.equal(fake.calls.length, 3, "阶段 B 首次失败后应执行一次修复调用");

    assert.deepEqual(
      fixture.db.prepare(`
        SELECT t.status AS task_status, t.output_json, t.finished_at,
               c.status AS clip_status, cs.status AS script_status,
               cs.raw_model_output, cs.assets_raw_model_output
        FROM tasks t
        JOIN clips c ON c.id = t.clip_id
        JOIN clip_scripts cs ON cs.task_id = t.id
        WHERE t.id = ?
      `).get(integrationTask.id),
      {
        task_status: "running",
        output_json: null,
        finished_at: null,
        clip_status: "running",
        script_status: "running",
        raw_model_output: null,
        assets_raw_model_output: null,
      },
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, name FROM assets ORDER BY id").all(),
      [{ id: "old-asset", name: "旧人物" }],
      "阶段 A 分配的新素材不得提前落库",
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, asset_id, source FROM clip_assets ORDER BY id").all(),
      [{ id: "old-clip-asset", asset_id: "old-asset", source: "manual" }],
    );
    assert.deepEqual(
      fixture.db.prepare(`
        SELECT id, sbid, visual_description FROM storyboards WHERE clip_id = ?
      `).all(integrationInput.clipId),
      [{ id: "old-storyboard", sbid: "old", visual_description: "旧镜头" }],
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, storyboard_id, asset_id FROM storyboard_assets").all(),
      [{ id: "old-storyboard-asset", storyboard_id: "old-storyboard", asset_id: "old-asset" }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("真实 SQLite：旧 revision 失败只更新自身拆解记录，不覆盖新 revision 分集状态", async () => {
  const fixture = await createIntegrationFixture();
  try {
    assert.equal(claimPendingTask(fixture.db, integrationTask, "integration-worker"), true);
    transitionEntityStatus(fixture.db, integrationTask, "running");
    fixture.db.prepare(`
      UPDATE clips SET source_revision = 2, status = 'script_ready' WHERE id = ?
    `).run(integrationInput.clipId);

    transitionEntityStatus(fixture.db, integrationTask, "failed", "旧任务失败");

    assert.deepEqual(
      fixture.db.prepare("SELECT source_revision, status FROM clips WHERE id = ?")
        .get(integrationInput.clipId),
      { source_revision: 2, status: "script_ready" },
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT status, error_message FROM clip_scripts WHERE id = ?")
        .get(integrationInput.clipScriptId),
      { status: "failed", error_message: "旧任务失败" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("真实 SQLite：旧镜头有活跃任务时拒绝提交重拆并完整保留旧数据", async () => {
  const fixture = await createIntegrationFixture(true);
  try {
    assert.equal(claimPendingTask(fixture.db, integrationTask, "integration-worker"), true);
    transitionEntityStatus(fixture.db, integrationTask, "running");
    fixture.db.prepare(`
      INSERT INTO tasks (
        id, project_id, clip_id, storyboard_id, type, status, lock_key, input_json
      ) VALUES ('old-video-task', ?, ?, 'old-storyboard', 'generate_video', 'pending',
                'generate_video:old-storyboard', '{}')
    `).run(integrationInput.projectId, integrationInput.clipId);

    const fake = createFakeTextClient((messages, callIndex) => {
      if (callIndex === 0) return generatedAssetsOutput;
      if (callIndex === 1) return storyboardsOutputFromModelPayload(messages);
      throw new Error(`unexpected text call ${callIndex + 1}`);
    });
    await assert.rejects(
      generateClipScriptHandler(createHandlerContext(fixture, fake.client)),
      /旧镜头仍有活跃任务，暂不能提交重拆结果：generate_video\/pending/,
    );
    assert.equal(fake.calls.length, 2);

    assert.deepEqual(
      fixture.db.prepare("SELECT id, name FROM assets ORDER BY id").all(),
      [{ id: "old-asset", name: "旧人物" }],
      "阶段 A 新素材必须随最终事务回滚",
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, asset_id, source FROM clip_assets ORDER BY id").all(),
      [{ id: "old-clip-asset", asset_id: "old-asset", source: "manual" }],
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, sbid, visual_description FROM storyboards WHERE clip_id = ?")
        .all(integrationInput.clipId),
      [{ id: "old-storyboard", sbid: "old", visual_description: "旧镜头" }],
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT id, status FROM tasks ORDER BY id").all(),
      [
        { id: "old-video-task", status: "pending" },
        { id: integrationTask.id, status: "running" },
      ],
    );
    assert.equal(
      (fixture.db.prepare("SELECT status FROM clip_scripts WHERE id = ?")
        .get(integrationInput.clipScriptId) as { status: string }).status,
      "running",
    );
  } finally {
    await fixture.cleanup();
  }
});