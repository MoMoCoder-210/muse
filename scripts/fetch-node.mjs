/**
 * 下载 Node.js 运行时并放置到作品根目录 node/ 下，供 Tauri 打包捆绑。
 *
 * 用法：node scripts/fetch-node.mjs [--arch x64|arm64] [--version v22.15.0]
 *
 * 默认下载 Windows x64 版本（与当前打包目标一致）。
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { get } from "node:https";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_DIR = join(ROOT, "node");

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const NODE_VERSION = getArg("version", "v22.15.0");
const ARCH = getArg("arch", "x64"); // x64 | arm64
const PLATFORM = "win"; // 当前仅支持 Windows 打包

// ---------- 下载逻辑 ----------
const fileName = `node-${NODE_VERSION}-win-${ARCH}.zip`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/${fileName}`;
const zipPath = join(NODE_DIR, fileName);

function download(fileUrl, dest) {
  return new Promise((resolve, reject) => {
    const doRequest = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const ws = createWriteStream(dest);
        res.pipe(ws);
        ws.on("finish", () => { ws.close(); resolve(); });
        ws.on("error", reject);
      }).on("error", reject);
    };
    doRequest(fileUrl);
  });
}

function extractZip(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    // 使用 PowerShell 解压（Windows 内置，无需额外依赖）
    const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipFile}' -DestinationPath '${destDir}' -Force"`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function main() {
  console.log(`[fetch-node] 目标: Node ${NODE_VERSION} (${PLATFORM}-${ARCH})`);
  console.log(`[fetch-node] 输出目录: ${NODE_DIR}`);

  // 检查是否已存在
  const nodeExe = join(NODE_DIR, "node.exe");
  if (existsSync(nodeExe)) {
    console.log("[fetch-node] node.exe 已存在，跳过下载。如需更新请删除 node/ 目录后重试。");
    return;
  }

  // 创建目录
  mkdirSync(NODE_DIR, { recursive: true });

  // 下载
  console.log(`[fetch-node] 下载中: ${url}`);
  await download(url, zipPath);
  console.log("[fetch-node] 下载完成");

  // 解压到临时目录
  const tmpDir = join(NODE_DIR, "_tmp");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  console.log("[fetch-node] 解压中...");
  await extractZip(zipPath, tmpDir);

  // 移动 node.exe 到 node/ 根目录
  const extractedDir = join(tmpDir, `node-${NODE_VERSION}-win-${ARCH}`);
  const srcExe = join(extractedDir, "node.exe");

  if (!existsSync(srcExe)) {
    throw new Error(`解压后未找到 node.exe: ${srcExe}`);
  }

  copyFileSync(srcExe, nodeExe);
  console.log(`[fetch-node] 已放置: ${nodeExe}`);

  // 清理临时文件
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  console.log("[fetch-node] 完成！打包时将自动捆绑 node.exe");
}

main().catch((err) => {
  console.error("[fetch-node] 失败:", err.message);
  process.exit(1);
});
