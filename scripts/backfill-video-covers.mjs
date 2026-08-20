import Database from "better-sqlite3";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes("--apply");
if (!apply) {
  console.error("此脚本会写入数据库；确认目标数据库和 FFmpeg 后，请追加 --apply 执行回填。");
  process.exit(2);
}

const dbPath = resolve(argValue("--db", join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".muse", "app.sqlite")));
const ffmpegPath = resolve(argValue("--ffmpeg", join(process.cwd(), "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")));

if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
if (!existsSync(ffmpegPath)) throw new Error(`FFmpeg 不存在：${ffmpegPath}`);

function previewPathFor(inputPath, kind) {
  const directory = dirname(inputPath);
  const folder = kind === "thumbnail" ? "thumbnails" : "covers";
  return join(directory, folder, `${basename(inputPath)}.jpg`);
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, [
      "-y", "-loglevel", "error", "-i", inputPath,
      "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
      "-frames:v", "1", "-q:v", "4", "-an", "-map_metadata", "-1", outputPath,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`FFmpeg 退出码 ${code}：${stderr.trim() || inputPath}`));
    });
  });
}

async function generatePreview(inputPath, kind) {
  const outputPath = previewPathFor(inputPath, kind);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.preview-backfill-${randomUUID()}.jpg`);
  try {
    await runFfmpeg(inputPath, temporaryPath);
    await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);
    await stat(outputPath);
    return outputPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const requiredColumns = [
  ["asset_images", "thumbnail_path"],
  ["storyboard_videos", "cover_path"],
  ["concat_outputs", "cover_path"],
];
for (const [table, column] of requiredColumns) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    throw new Error(`数据库缺少 ${table}.${column}；请先启动已更新 schema 的应用再执行回填`);
  }
}

const targets = [
  {
    table: "asset_images",
    kind: "thumbnail",
    idColumn: "id",
    rows: db.prepare("SELECT id, image_path AS source_path, thumbnail_path AS preview_path FROM asset_images WHERE TRIM(image_path) <> '' ORDER BY created_at, id").all(),
  },
  {
    table: "storyboard_videos",
    kind: "cover",
    idColumn: "id",
    rows: db.prepare("SELECT id, file_path AS source_path, cover_path AS preview_path FROM storyboard_videos WHERE TRIM(file_path) <> '' ORDER BY created_at, id").all(),
  },
  {
    table: "concat_outputs",
    kind: "cover",
    idColumn: "id",
    rows: db.prepare("SELECT id, output_path AS source_path, cover_path AS preview_path FROM concat_outputs WHERE TRIM(output_path) <> '' ORDER BY created_at, id").all(),
  },
];

const summary = {
  asset_images: { total: 0, generated: 0, skipped: 0, failed: 0 },
  storyboard_videos: { total: 0, generated: 0, skipped: 0, failed: 0 },
  concat_outputs: { total: 0, generated: 0, skipped: 0, failed: 0 },
};

for (const target of targets) {
  const stats = summary[target.table];
  const update = db.prepare(`UPDATE ${target.table} SET ${target.previewColumn} = ? WHERE ${target.idColumn} = ?`);
  for (const row of target.rows) {
    stats.total += 1;
    if (row.preview_path && existsSync(row.preview_path)) {
      stats.skipped += 1;
      continue;
    }
    if (!existsSync(row.source_path)) {
      stats.failed += 1;
      console.error(`[失败] ${target.table} ${row.id}：源文件不存在：${row.source_path}`);
      continue;
    }
    try {
      const previewPath = await generatePreview(row.source_path, target.kind);
      update.run(previewPath, row.id);
      stats.generated += 1;
      console.log(`[完成] ${target.table} ${row.id} -> ${previewPath}`);
    } catch (error) {
      stats.failed += 1;
      console.error(`[失败] ${target.table} ${row.id}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

db.close();
console.log(JSON.stringify({ dbPath, ffmpegPath, ...summary }, null, 2));
if (Object.values(summary).some((stats) => stats.failed > 0)) process.exitCode = 1;
