/**
 * PromptViewer 编辑器内联样式。
 * 组件渲染时通过 <style>{EDITOR_STYLE}</style> 注入，集中在此便于维护。
 */
export const EDITOR_STYLE = `
  .shot-pv { min-height: 220px; }
  .shot-pv {
    font-size: 13px;
  }
  .shot-prompt-shell {
    display: flex;
    flex-direction: column;
    min-height: 190px;
    overflow: hidden;
    border: 1px solid var(--border-default);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.015));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
  }
  .shot-prompt-shell:hover {
    border-color: var(--border-hover);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.018));
  }
  .shot-prompt-shell:focus-within {
    border-color: color-mix(in srgb, var(--color-primary) 72%, white 8%);
    box-shadow:
      0 0 0 2px rgba(219, 39, 119, 0.16),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  .shot-prompt-editor-body {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px;
    cursor: text;
  }
  .shot-prompt-footer {
    flex: 0 0 auto;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.12);
    padding: 8px 10px;
  }
  .shot-pv .ProseMirror {
    min-height: 164px;
    font-size: 13px;
    outline: none;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.75;
    color: var(--text-primary);
    caret-color: var(--color-primary);
  }
  .shot-pv .ProseMirror p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    color: var(--text-tertiary);
    pointer-events: none;
  }
  .shot-pv .ProseMirror p { margin: 0; min-height: 1.5em; }
  .mention-tag {
    display: inline-flex; align-items: center; gap: 0.32em;
    min-width: 6.2em;
    max-width: 14.5em;
    flex: 0 0 auto;
    overflow: hidden;
    padding: 0.14em 0.5em 0.14em 0.22em; margin: 0 0.18em; border-radius: 999px;
    font-size: 0.92em; font-weight: 600; white-space: nowrap; vertical-align: middle;
    word-break: keep-all; overflow-wrap: normal; line-height: 1.35;
    cursor: zoom-in;
    background: rgba(219, 39, 119, 0.13); color: #f9a8d4;
    border: 1px solid rgba(219, 39, 119, 0.28);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transition: filter 0.16s ease, border-color 0.16s ease;
  }
  .mention-tag:hover {
    filter: brightness(1.12);
  }
  .mention-tag[data-invalid='true'] {
    background: rgba(239, 68, 68, 0.1);
    color: #fca5a5;
    border-color: rgba(239, 68, 68, 0.42);
  }
  .mention-tag[data-invalid='true'] [data-mention-status] {
    color: rgba(252, 165, 165, 0.74);
  }
  .mention-tag[data-kind='character'] { background: rgba(249, 115, 22, 0.12); color: #fdba74; border-color: rgba(249, 115, 22, 0.28); }
  .mention-tag[data-kind='scene'] { background: rgba(34, 197, 94, 0.12); color: #86efac; border-color: rgba(34, 197, 94, 0.28); }
  .mention-tag[data-kind='item'] { background: rgba(59, 130, 246, 0.12); color: #93c5fd; border-color: rgba(59, 130, 246, 0.28); }
  .mention-tag[data-kind='audio'] { background: rgba(168, 85, 247, 0.13); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.28); }
  .mention-tag[data-kind='video'] { background: rgba(20, 184, 166, 0.13); color: #5eead4; border-color: rgba(20, 184, 166, 0.28); }
  .mention-tag[data-invalid='true'] [data-mention-label],
  .mention-tag[data-asset-state='unsubmitted'] [data-mention-label],
  .mention-tag[data-asset-state='processing'] [data-mention-label],
  .mention-tag[data-asset-state='failed'] [data-mention-label] {
    text-decoration: line-through;
    text-decoration-thickness: 1px;
    text-decoration-color: #ef4444;
  }
  .mention-tag[data-asset-state='unsubmitted'] {
    background: rgba(113, 113, 122, 0.14);
    color: #d4d4d8;
    border-color: rgba(212, 212, 216, 0.28);
  }
  .mention-tag[data-asset-state='unsubmitted'] [data-mention-status] {
    color: rgba(212, 212, 216, 0.74);
  }
  .mention-tag[data-asset-state='processing'] {
    background: rgba(99, 102, 241, 0.14);
    color: #c7d2fe;
    border-color: rgba(129, 140, 248, 0.38);
  }
  .mention-tag[data-asset-state='processing'] [data-mention-status] {
    color: rgba(199, 210, 254, 0.82);
  }
  .mention-tag[data-asset-state='failed'] {
    background: rgba(239, 68, 68, 0.1);
    color: #fca5a5;
    border-color: rgba(239, 68, 68, 0.42);
  }
  .mention-tag[data-asset-state='failed'] [data-mention-status] {
    color: rgba(252, 165, 165, 0.78);
  }
  .mention-tag [data-mention-thumb] {
    width: 1.55em; height: 1.55em; aspect-ratio: 1 / 1; flex: 0 0 auto;
    border-radius: 999px; object-fit: cover; border: 1px solid rgba(255, 255, 255, 0.18);
  }
  .mention-tag [data-mention-icon] {
    display: inline-grid; place-items: center; width: 1.55em; height: 1.55em; flex: 0 0 auto;
    border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(0, 0, 0, 0.16);
  }
  .mention-tag:has([data-mention-thumb]) [data-mention-icon] {
    display: none;
  }
  .mention-tag [data-mention-icon] svg {
    width: 0.86em;
    height: 0.86em;
    stroke-width: 2;
  }
  .mention-tag [data-mention-label] {
    display: block;
    flex: 1 1 auto;
    min-width: 1em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    word-break: keep-all;
    overflow-wrap: normal;
    vertical-align: middle;
  }
  .mention-tag [data-mention-status] {
    flex: 0 0 auto;
    max-width: 6.6em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
    font-weight: 500;
    line-height: 1;
  }
  .mention-tag [data-mention-status]::before {
    content: attr(data-status-label);
  }
  /* 真人确认中：@标签转圈边框光环（与资产详情步骤一致的观感） */
  @property --sd-mention-halo-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  .mention-tag[data-asset-state='processing'] {
    position: relative;
    border-color: transparent;
  }
  .mention-tag[data-asset-state='processing']::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1.5px;
    background: conic-gradient(
      from var(--sd-mention-halo-angle),
      rgba(178, 92, 255, 0) 0deg,
      rgba(178, 92, 255, 0) 250deg,
      rgba(178, 92, 255, 0.12) 286deg,
      rgba(178, 92, 255, 0.38) 315deg,
      rgba(206, 140, 255, 0.9) 342deg,
      #f2ddff 358deg,
      rgba(178, 92, 255, 0) 360deg
    );
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    pointer-events: none;
    animation: sd-mention-halo-spin 1.6s linear infinite;
  }
  @keyframes sd-mention-halo-spin {
    to { --sd-mention-halo-angle: 360deg; }
  }
  @media (max-width: 1280px) {
    .shot-pv {
      font-size: 13px;
    }
    .shot-pv .ProseMirror {
      font-size: 13px;
      line-height: 1.68;
    }
    .mention-tag {
      min-width: 6em;
      max-width: 12.5em;
      font-size: 0.94em;
    }
  }
  @media (max-width: 960px) {
    .shot-prompt-shell {
      min-height: 172px;
    }
    .shot-pv .ProseMirror {
      min-height: 148px;
      font-size: 12px;
      line-height: 1.62;
    }
    .mention-tag {
      min-width: 5.8em;
      max-width: 11em;
    }
  }
`;
