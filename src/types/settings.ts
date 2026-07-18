/**
 * 应用设置类型与默认值 — 前端入口
 *
 * 类型定义 → src/types/settings-types.ts（双端共享）
 * 默认值 → 派生自 src/config/default-settings.json（单一真相源）
 */

import defaultSettingsJson from "../config/default-settings.json";

// 所有类型从共享模块重导出
export type {
  ModelEntry,
  ChannelBase,
  TextChannel,
  ImageChannel,
  VoiceChannel,
  AssetChannel,
  VideoChannel,
  TextParams,
  ImageParams,
  VoiceParams,
  AssetParams,
  VideoParams,
  ChannelList,
  GeneralSettings,
  AppSettings,
} from "./settings-types";

// ── 默认值（单一真相源：src/config/default-settings.json） ──
// 前端 / Worker / Rust 三端均从该 JSON 派生，避免三处手写重复与漂移。

const DEFAULTS = defaultSettingsJson as unknown as import("./settings-types").AppSettings;

export const DEFAULT_MODEL_ENTRY: import("./settings-types").ModelEntry = { id: "m1", modelId: "" };
export const DEFAULT_TEXT_CHANNEL = DEFAULTS.text.channels[0];
export const DEFAULT_IMAGE_CHANNEL = DEFAULTS.image.channels[0];
export const DEFAULT_VOICE_CHANNEL = DEFAULTS.voice.channels[0];
export const DEFAULT_ASSET_CHANNEL = DEFAULTS.asset.channels[0];
export const DEFAULT_VIDEO_CHANNEL = DEFAULTS.video.channels[0];

export const DEFAULT_TEXT_PARAMS = DEFAULTS.textParams;
export const DEFAULT_IMAGE_PARAMS = DEFAULTS.imageParams;
export const DEFAULT_VOICE_PARAMS = DEFAULTS.voiceParams;
export const DEFAULT_ASSET_PARAMS = DEFAULTS.assetParams;
export const DEFAULT_VIDEO_PARAMS = DEFAULTS.videoParams;

export const DEFAULT_SETTINGS: import("./settings-types").AppSettings = DEFAULTS;

// ── 工具 ────────────────────────────────────────────────

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 同步点：与 worker/src/config/defaults.ts::getActiveChannel 逻辑保持一致。
export function getActiveChannel<T extends { id: string }>(
  list: import("./settings-types").ChannelList<T>,
): T | undefined {
  return list.channels.find((c) => c.id === list.activeId) ?? list.channels[0];
}
