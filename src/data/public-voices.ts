/**
 * 火山方舟 / 豆包语音合成 — 公共音色清单
 *
 */

import raw from "./public-voices.json";

export type VoiceGender = "male" | "female";
export type VoiceAge = "child" | "youth" | "mature" | "senior";
export type VoiceLanguage = "zh" | "en" | "multilingual";

export interface PublicVoice {
  /** 火山方舟 Speaker ID */
  id: string;
  /** 展示名称 */
  name: string;
  gender: VoiceGender;
  age: VoiceAge;
  language: VoiceLanguage;
  /** 风格 / 用途标签 */
  tags: string[];
}

/** 试听样例文本（点击公共声音时由 Rust 端实时合成并落盘缓存） */
export const VOICE_PREVIEW_TEXT =
  "这是一段用于试听的示例语音，希望能帮您挑选到最合适的音色。";

/** 年龄分组展示顺序与中文标签 */
export const AGE_GROUPS: { value: VoiceAge; label: string }[] = [
  { value: "child", label: "儿童" },
  { value: "youth", label: "青年" },
  { value: "mature", label: "成熟" },
  { value: "senior", label: "长辈" },
];

export const GENDER_LABELS: Record<VoiceGender, string> = {
  male: "男声",
  female: "女声",
};

/**
 * 公共音色清单（gender / age / tags 以火山方舟官方文档分类为准）。
 * 数据来源：`docs/音色.md`（整理自官方文档 1257544）。
 */
export const PUBLIC_VOICES: PublicVoice[] = raw as PublicVoice[];
