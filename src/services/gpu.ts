/**
 * GPU 超分支持检测 — 全局单例缓存。
 *
 * 应用启动时调用 initGpuDetect() 探测一次，结果缓存在模块级变量中。
 * 各页面通过 useGpuDetect() hook 获取，不再各自重复探测。
 */
import { useEffect, useState } from "react";
import { detectGpuSupport } from "./tauri";

/** null=未初始化，true=支持，false=不支持 */
let _gpuOk: boolean | null = null;
let _initPromise: Promise<void> | null = null;

/** 应用启动时调用（仅一次）。幂等：重复调用不会重新探测。 */
export function initGpuDetect(): void {
  if (_initPromise) return;
  _initPromise = detectGpuSupport()
    .then((ok) => {
      _gpuOk = ok;
    })
    .catch(() => {
      _gpuOk = false;
    });
}

/**
 * React hook：获取 GPU 超分支持状态。
 *
 * 返回状态渐进变化：null（探测中）→ true/false（探测完成）。
 * 应用启动后 ~1s 内完成，之后再也不会变为 null。
 */
export function useGpuDetect(): boolean | null {
  const [gpuOk, setGpuOk] = useState<boolean | null>(_gpuOk);
  useEffect(() => {
    // 已缓存：直接同步
    if (_gpuOk !== null) {
      setGpuOk(_gpuOk);
      return;
    }
    // 探测中：等待完成后更新
    let disposed = false;
    if (_initPromise) {
      _initPromise.then(() => {
        if (!disposed) setGpuOk(_gpuOk);
      });
    }
    return () => {
      disposed = true;
    };
  }, []);
  return gpuOk;
}
