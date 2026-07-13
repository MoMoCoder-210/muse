/**
 * 主题配置 - 设计 Token 中心
 *
 * 所有视觉参数在此定义，分为两层：
 *   1. 原始色板（raw palette）— 不直接使用，仅作为语义 token 的来源
 *   2. 语义 token（semantic tokens）— 在 CSS / Canvas 中实际引用的名称
 *
 * CSS 自定义属性名与 TS 键名的映射规则：
 *   camelCase key → kebab-case CSS var，例如 bgBase → --bg-base
 *
 * 切换主题时，只需在 <html data-theme="light"> 对应的 CSS 块中
 * 重新声明这些变量即可，TS 侧通过 getCssVar() 读取实时值。
 *
 */

// ─────────────────────────────────────────────
// 主题名称
// ─────────────────────────────────────────────
export type ThemeName = "dark";
// 预留：| "light" | "midnight"

// ─────────────────────────────────────────────
// 语义 Token 类型定义
// ─────────────────────────────────────────────
export interface ThemeTokens {
  // 背景
  bgBase: string;          // 应用底层背景
  bgCanvas: string;        // Canvas 动画背景填充色
  bgSurface: string;       // 卡片 / 面板背景（半透明）
  bgSurfaceDeep: string;   // 深色面板背景（列表项、输入框等）
  bgSurfaceModal: string;  // 弹窗背景
  bgInput: string;         // 输入框背景
  bgInputDeep: string;     // 输入框 hover 背景

  // 文字
  textPrimary: string;     // 主文字
  textSecondary: string;   // 次级文字
  textMuted: string;       // 弱化文字
  textAccent: string;      // 强调文字
  textSuccess: string;     // 成功状态文字

  // 主色
  accentPrimary: string;       // 主色（蓝色）
  accentSecondary: string;     // 辅色（青色）
  accentPurple: string;        // 紫色（canvas 光晕）
  accentOrange: string;        // 橙色（canvas 光晕）

  // 边框
  borderBase: string;          // 通用边框
  borderSubtle: string;        // 更淡的边框
  borderFaint: string;         // 极淡边框
  borderAccent: string;        // 聚焦 / 激活边框
  borderAccentSubtle: string;  // 次级聚焦边框

  // 基础语义色
  colorDanger: string;
  colorDangerDark: string;
  colorDangerDarker: string;
  colorDangerLight: string;
  colorDangerLighter: string;
  colorSuccess: string;
  colorWarning: string;
  colorInfo: string;

  // RGB 通道（供 rgba() 组合）
  colorDangerRgb: string;
  colorSuccessRgb: string;
  colorWarningRgb: string;
  colorInfoRgb: string;
  accentPrimaryRgb: string;
  borderAccentRgb: string;

  // 按钮
  btnPrimaryBg: string;           // 主按钮背景渐变起点
  btnPrimaryBgEnd: string;        // 主按钮背景渐变终点
  btnPrimaryBorder: string;       // 主按钮边框
  btnPrimaryShadow: string;       // 主按钮阴影
  btnSecondaryBg: string;         // 次级按钮背景
  btnSecondaryBorder: string;     // 次级按钮边框
  btnSecondaryText: string;       // 次级按钮文字
  btnGhostBg: string;             // 幽灵按钮背景
  btnGhostBorder: string;         // 幽灵按钮边框
  btnGhostText: string;           // 幽灵按钮文字

  // 焦点环
  focusRing: string;              // 输入框 / select 聚焦光圈
  focusBorder: string;            // 聚焦时边框色

  // 阴影
  shadowCard: string;             // 卡片阴影
  shadowModal: string;            // 弹窗阴影
  shadowSelectMenu: string;       // 下拉菜单阴影

  // 遮罩
  overlayModal: string;           // 弹窗蒙层背景

  // 工作流步骤（完成态）
  stepDoneBg: string;             // 已完成步骤渐变起点
  stepDoneBgEnd: string;          // 已完成步骤渐变终点
  stepDoneBorder: string;         // 已完成步骤边框
  stepDoneText: string;           // 已完成步骤文字

  // badge / kicker
  badgeBg: string;                // 标签背景
  badgeText: string;              // 标签文字

  // 杂项 badge（工作区状态徽章）
  chipBg: string;
  chipText: string;

  // 分割线 / select 激活态
  selectActiveBg: string;
  selectActiveText: string;
  selectHoverBg: string;
  selectMenuBorder: string;
  selectMenuBg: string;
  segmentedBg: string;
  segmentedActiveBg: string;
  segmentedActiveBorder: string;

  // Canvas 动画
  canvasParticleColor: string;
  canvasLineColor: string;
  canvasGlow1: string;
  canvasGlow2: string;
  canvasGlow3: string;
  canvasGlow4: string;

  // modal close button 半透明文字色
  modalCloseBtnColor: string;
  // select caret 箭头颜色
  selectCaretColor: string;
  // 项目列表激活项背景
  projectItemActiveBg: string;
  // workflow step 未完成背景（半透明）
  stepPendingBg: string;

  colorWhite: string;
  shadowPanel: string;
  selectTriggerHoverBorder: string;

  // 高透明度 hover / 卡片背景（供 rgba 组合使用）
  bgHoverSubtle: string;
  bgPanelSubtle: string;
  bgGradientSubtle: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;

  // 文字 RGB 通道（供 rgba 组合使用）
  textMutedRgb: string;
  textPrimaryRgb: string;
  textSecondaryRgb: string;

  // 圆角
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusXl: string;
  radius2xl: string;
  radiusFull: string;

  // 间距
  spacingXs: string;
  spacingSm: string;
  spacingMd: string;
  spacingLg: string;
  spacingXl: string;
  spacing2xl: string;
  spacing3xl: string;

  // ── 字体 ──────────────────────────────────────
  fontFamily: string;

  // 字号刻度（5级，语义命名）
  //   xs      12px — badge、状态标签、辅助说明
  //   sm      13px — 次级标签（home-meta、表单字段标签）
  //   base    15px — 正文、列表项标题
  //   control 14px — 输入框、下拉框、所有按钮（普通按钮统一走这里）
  //   section 30px — 侧边栏/弹窗二级标题
  //   icon    24px — 图标按钮字符（icon-button、modal-close-button）
  //   hero    clamp — 首页大标题
  fontSizeXs: string;
  fontSizeSm: string;
  fontSizeBase: string;
  fontSizeControl: string;
  fontSizeSection: string;
  fontSizeIcon: string;
  fontSizeHero: string;

  // 行高
  lineHeightBase: string;    // 1.5 — 正文
  lineHeightTight: string;   // 0.95 — 超大标题
  lineHeightSection: string; // 1.05 — 二级标题

  // 字重
  fontWeightNormal: string;   // 400
  fontWeightSemibold: string; // 600
}

// ─────────────────────────────────────────────
// 暗色主题 Token 值
// ─────────────────────────────────────────────
export const darkTheme: ThemeTokens = {
  bgBase:           "#060912",
  bgCanvas:         "#090d14",
  bgSurface:        "rgba(7, 10, 16, 0.84)",
  bgSurfaceDeep:    "rgba(15, 23, 42, 0.82)",
  bgSurfaceModal:   "rgba(7, 10, 16, 0.82)",
  bgInput:          "rgba(8, 12, 18, 0.88)",
  bgInputDeep:      "rgba(12, 18, 30, 0.96)",

  textPrimary:      "#f8fafc",
  textSecondary:    "#cbd5e1",
  textMuted:        "#94a3b8",
  textAccent:       "#bfdbfe",
  textSuccess:      "#86efac",

  accentPrimary:    "#2563eb",
  accentSecondary:  "#0ea5e9",
  accentPurple:     "#a855f7",
  accentOrange:     "#f97316",

  borderBase:       "rgba(148, 163, 184, 0.14)",
  borderSubtle:     "rgba(148, 163, 184, 0.12)",
  borderFaint:      "rgba(148, 163, 184, 0.10)",
  borderAccent:     "rgba(96, 165, 250, 0.80)",
  borderAccentSubtle: "rgba(96, 165, 250, 0.22)",

  // 基础语义色
  colorDanger:        "#e04040",
  colorDangerDark:    "#c62828",
  colorDangerDarker:  "#b71c1c",
  colorDangerLight:   "#ef5350",
  colorDangerLighter: "#d32f2f",
  colorSuccess:       "#50c878",
  colorWarning:       "#ffb432",
  colorInfo:          "#6cb4ff",

  // RGB 通道
  colorDangerRgb:     "224, 64, 64",
  colorSuccessRgb:    "80, 200, 120",
  colorWarningRgb:    "255, 180, 50",
  colorInfoRgb:       "100, 160, 255",
  accentPrimaryRgb:   "37, 99, 235",
  borderAccentRgb:    "96, 165, 250",

  btnPrimaryBg:     "#2563eb",
  btnPrimaryBgEnd:  "#0ea5e9",
  btnPrimaryBorder: "rgba(125, 211, 252, 0.34)",
  btnPrimaryShadow: "rgba(37, 99, 235, 0.28)",
  btnSecondaryBg:   "rgba(37, 99, 235, 0.26)",
  btnSecondaryBorder: "rgba(96, 165, 250, 0.28)",
  btnSecondaryText: "#dbeafe",
  btnGhostBg:       "rgba(15, 23, 42, 0.76)",
  btnGhostBorder:   "rgba(148, 163, 184, 0.18)",
  btnGhostText:     "#e2e8f0",

  focusRing:        "rgba(59, 130, 246, 0.16)",
  focusBorder:      "rgba(96, 165, 250, 0.80)",

  shadowCard:       "0 24px 70px rgba(0, 0, 0, 0.45)",
  shadowModal:      "0 24px 70px rgba(0, 0, 0, 0.42)",
  shadowSelectMenu: "0 18px 40px rgba(0, 0, 0, 0.32)",

  overlayModal:     "rgba(2, 6, 23, 0.72)",

  stepDoneBg:       "rgba(37, 99, 235, 0.28)",
  stepDoneBgEnd:    "rgba(15, 23, 42, 0.68)",
  stepDoneBorder:   "rgba(59, 130, 246, 0.42)",
  stepDoneText:     "#dbeafe",

  badgeBg:          "rgba(59, 130, 246, 0.16)",
  badgeText:        "#bfdbfe",

  chipBg:           "rgba(148, 163, 184, 0.12)",
  chipText:         "#cbd5e1",

  selectActiveBg:   "rgba(37, 99, 235, 0.16)",
  selectActiveText: "#dbeafe",
  selectHoverBg:    "rgba(37, 99, 235, 0.24)",
  selectMenuBorder: "rgba(96, 165, 250, 0.22)",
  selectMenuBg:     "rgba(9, 14, 24, 0.98)",
  segmentedBg:      "rgba(148, 163, 184, 0.12)",
  segmentedActiveBg:     "rgba(59, 130, 246, 0.22)",
  segmentedActiveBorder: "rgba(96, 165, 250, 0.80)",

  canvasParticleColor: "rgba(255, 255, 255, 0.6)",
  canvasLineColor:     "148, 163, 184",   // 供 JS 拼入 rgba(r,g,b,alpha)
  canvasGlow1:         "37, 99, 235",
  canvasGlow2:         "14, 165, 233",
  canvasGlow3:         "168, 85, 247",
  canvasGlow4:         "249, 115, 22",

  // modal close button 半透明文字色
  modalCloseBtnColor:  "rgba(226, 232, 240, 0.82)",
  // select caret 箭头颜色
  selectCaretColor:    "rgba(226, 232, 240, 0.90)",
  // 项目列表激活项背景
  projectItemActiveBg: "rgba(30, 41, 59, 0.92)",
  // workflow step 未完成背景（半透明）
  stepPendingBg:       "rgba(15, 23, 42, 0.72)",

  colorWhite:                   "#ffffff",
  shadowPanel:                  "0 24px 70px rgba(0, 0, 0, 0.35)",
  selectTriggerHoverBorder:     "rgba(96, 165, 250, 0.48)",

  bgHoverSubtle:                "rgba(255, 255, 255, 0.04)",
  bgPanelSubtle:                "rgba(255, 255, 255, 0.02)",
  bgGradientSubtle:             "rgba(255, 255, 255, 0.025)",
  scrollbarThumb:               "rgba(148, 163, 184, 0.18)",
  scrollbarThumbHover:          "rgba(148, 163, 184, 0.32)",

  textMutedRgb:                 "148, 163, 184",
  textPrimaryRgb:               "248, 250, 252",
  textSecondaryRgb:             "203, 213, 225",

  radiusSm:                     "4px",
  radiusMd:                     "8px",
  radiusLg:                     "12px",
  radiusXl:                     "16px",
  radius2xl:                    "20px",
  radiusFull:                   "999px",

  spacingXs:                    "4px",
  spacingSm:                    "8px",
  spacingMd:                    "12px",
  spacingLg:                    "16px",
  spacingXl:                    "20px",
  spacing2xl:                   "24px",
  spacing3xl:                   "32px",

  fontFamily:       '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  fontSizeXs:       "12px",
  fontSizeSm:       "13px",
  fontSizeBase:     "15px",
  fontSizeControl:  "14px",
  fontSizeSection:  "30px",
  fontSizeIcon:     "24px",
  fontSizeHero:     "clamp(48px, 8vw, 78px)",
  lineHeightBase:   "1.5",
  lineHeightTight:  "0.95",
  lineHeightSection:"1.05",
  fontWeightNormal: "400",
  fontWeightSemibold: "600",
};

// ─────────────────────────────────────────────
// 主题注册表
// ─────────────────────────────────────────────
export const themes: Record<ThemeName, ThemeTokens> = {
  dark: darkTheme,
};

export const defaultTheme: ThemeName = "dark";

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 将 camelCase token key 转为 CSS 变量名。
 */
function tokenToCssVar(key: string): string {
  return "--" + key.replace(/([A-Z])/g, (c) => "-" + c.toLowerCase());
}

/**
 * 将一个主题的 token 对象注入到 document.documentElement 的 CSS 变量中。
 *
 */
export function applyTheme(name: ThemeName = defaultTheme): void {
  const tokens = themes[name];
  const root = document.documentElement;
  root.setAttribute("data-theme", name);
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(tokenToCssVar(key), value);
  }
}

/**
 * 从当前 document 中读取某个 CSS 变量的计算值。
 *
 */
export function getCssVar(key: keyof ThemeTokens): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(tokenToCssVar(key))
    .trim();
}
