/**
 * 将 worker 的生产依赖（含传递依赖）从根 node_modules 复制到 worker/dist/node_modules/，
 * 并动态写入 tauri.conf.json 中对应的 resources 显式映射条目。
 * 确保打包后独立运行的 Node 进程能找到这些包。
 *
 * 用法：node scripts/copy-worker-deps.mjs
 * 前提：已执行过 npm install 且 worker:build (tsc) 已完成。
 */

import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORKER_DIST = join(ROOT, "worker", "dist");
const ROOT_NM = join(ROOT, "node_modules");
const DEST_NM = join(WORKER_DIST, "node_modules");
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");

// ── 读取 worker 的生产依赖列表 ──
const workerPkg = JSON.parse(
  readFileSync(join(ROOT, "worker", "package.json"), "utf8")
);
const prodDeps = Object.keys(workerPkg.dependencies || {});

// ── 递归收集所有传递依赖 ──
const require_ = createRequire(join(ROOT_NM, "_"));
const collected = new Set();

function collect(name) {
  if (collected.has(name)) return;
  collected.add(name);

  let pkgJsonPath;
  try {
    pkgJsonPath = require_.resolve(`${name}/package.json`);
  } catch {
    const nested = join(ROOT_NM, name, "package.json");
    if (existsSync(nested)) {
      pkgJsonPath = nested;
    } else {
      console.warn(`  [skip] ${name} (not found)`);
      return;
    }
  }

  let deps;
  try {
    deps = JSON.parse(readFileSync(pkgJsonPath, "utf8")).dependencies || {};
  } catch {
    return;
  }

  for (const dep of Object.keys(deps)) {
    collect(dep);
  }
}

console.log(`Worker 生产依赖: ${prodDeps.join(", ")}`);
for (const dep of prodDeps) {
  collect(dep);
}

// ── 复制到 worker/dist/node_modules/ ──
let copied = 0;
for (const pkg of collected) {
  const src = join(ROOT_NM, pkg);
  const dest = join(DEST_NM, pkg);
  if (existsSync(src)) {
    // 跳过 workspace symlink（如 `muse` 指向根目录），Windows 下 cpSync 会 EPERM
    try {
      if (lstatSync(src).isSymbolicLink()) {
        console.warn(`  [skip] ${pkg} (symlink, workspace)`);
        continue;
      }
    } catch {
      // lstat 失败则忽略，继续尝试复制
    }
    cpSync(src, dest, { recursive: true });
    copied++;
  }
}
console.log(`已复制 ${copied} 个包 → worker/dist/node_modules/`);

// ── 动态写入 tauri.conf.json resources 条目 ──
// Tauri 2.x 的 **/* glob 无法保留子目录结构，必须为每个目录显式映射
const confText = readFileSync(TAURI_CONF, "utf8");
const conf = JSON.parse(confText);

// 移除旧的动态 node_modules 条目（如有）
const resources = conf.bundle.resources;
for (const key of Object.keys(resources)) {
  if (key.includes("node_modules")) delete resources[key];
}

// 递归收集包内所有含文件的子目录（跳过嵌套 node_modules、.cache 等）
function collectLeafDirs(basePath, prefix) {
  const entries = readdirSync(basePath, { withFileTypes: true });
  let hasFiles = false;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 跳过嵌套 node_modules 和构建缓存，避免无限膨胀
      if (entry.name === "node_modules" || entry.name === ".cache") continue;
      const subPath = join(basePath, entry.name);
      const subPrefix = `${prefix}/${entry.name}`;
      const subHasFiles = collectLeafDirs(subPath, subPrefix);
      if (subHasFiles) {
        resources[`../worker/dist/node_modules${subPrefix}/*`] = `worker/dist/node_modules${subPrefix}/`;
      }
    } else if (entry.isFile()) {
      hasFiles = true;
    }
  }
  // 如果包根目录有文件，也需要映射
  if (prefix.split("/").length === 2 && hasFiles) {
    resources[`../worker/dist/node_modules${prefix}/*`] = `worker/dist/node_modules${prefix}/`;
  }
  return hasFiles;
}

// 为每个包生成完整的资源映射
const nmPackages = readdirSync(DEST_NM, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let entryCount = 0;
for (const pkg of nmPackages) {
  const pkgPath = join(DEST_NM, pkg);
  collectLeafDirs(pkgPath, `/${pkg}`);
}

// 统计新增条目数
for (const key of Object.keys(resources)) {
  if (key.includes("node_modules")) entryCount++;
}

writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n", "utf8");
console.log(`已写入 ${entryCount} 条 node_modules 资源映射 → tauri.conf.json`);
