// 清理上次超分异常退出残留的孤儿子进程（realesrgan.exe / ffmpeg.exe）。
//
// 超分过程中应用被强制关闭时，ncnn（realesrgan.exe）与 ffmpeg 子进程不会随父进程
// 结束而退出，会残留为孤儿进程并持续占用 upscaler/ffmpeg 目录下的资源文件
// （如 vcomp140.dll），导致下次 `tauri dev` / `tauri build` 的 build script 在读取
// 这些文件时失败（os error 32：另一个程序正在使用此文件）。
//
// 本脚本在编译前执行：仅终止可执行路径位于本项目 upscaler/ 或 ffmpeg/ 目录下的
// 同名进程，避免误杀系统中其他 realesrgan/ffmpeg 实例。
import { execFileSync } from "node:child_process";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", shell: true });
  } catch {
    return "";
  }
}

// 枚举进程（Windows tasklist CSV）
const out = run("tasklist", ["/FO", "CSV", "/NH"]);
if (!out) {
  console.log("[kill-orphan-upscale] tasklist 不可用，跳过清理");
  process.exit(0);
}

let killed = 0;
for (const line of out.split(/\r?\n/)) {
  const fields = line.split(",");
  if (fields.length < 2) continue;
  const name = fields[0]?.replace(/"/g, "").toLowerCase();
  if (name !== "realesrgan.exe" && name !== "ffmpeg.exe") continue;
  const pid = Number.parseInt(fields[1]?.replace(/"/g, ""), 10);
  if (!Number.isFinite(pid) || pid <= 0) continue;

  // 校验可执行路径位于本项目 upscaler/ 或 ffmpeg/ 目录
  const pathInfo = run("wmic", [
    "process",
    "where",
    `ProcessId=${pid}`,
    "get",
    "ExecutablePath",
  ]);
  const exePath = pathInfo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^executablepath$/i.test(l));
  if (!exePath) continue;
  const lower = exePath.toLowerCase();
  if (!lower.includes("\\upscaler\\realesrgan.exe") && !lower.includes("\\ffmpeg\\ffmpeg.exe")) {
    continue;
  }
  run("taskkill", ["/PID", String(pid), "/F"]);
  killed += 1;
  console.log(`[kill-orphan-upscale] 已清理残留孤儿进程: ${exePath} (PID=${pid})`);
}
if (killed === 0) {
  console.log("[kill-orphan-upscale] 无残留孤儿进程");
}
