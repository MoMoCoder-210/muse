/**
 * PromptEditor — 提示词富文本编辑器。
 *
 * 编辑态只操作 PromptDoc（Tiptap JSON）。资产胶囊是 atom mention 节点，绝不覆盖在
 * 普通文本之上；保存/提交时才将节点序列化为 `资产名(@图片N)`。
 */

import {
  useEffect, useImperativeHandle, useRef, useState, useCallback, forwardRef, type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { mergeAttributes, type JSONContent } from "@tiptap/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AssetMention } from "./MentionDropdown";
import type { MentionAnchor } from "../../types/mention";
import {
  promptDocToPlainText,
  type PromptDoc,
  type PromptMentionAttrs,
} from "../../utils/promptDocument";

export interface PromptEditorChange {
  plainText: string;
  promptDoc: PromptDoc;
}

export interface PromptEditorHandle {
  editor: Editor | null;
  insertMention: (asset: AssetMention, index: number) => void;
  getPlainText: () => string;
  getPromptDoc: () => PromptDoc;
  focus: () => void;
}

interface Props {
  /** 当前分镜已持久化或水合后的主文档。 */
  document: PromptDoc;
  /** 分镜 ID；切换分镜时强制恢复新文档。 */
  resetKey: string;
  onChange: (change: PromptEditorChange) => void;
  onBlur?: () => void;
  placeholder?: string;
  onMentionStart?: (query: string, pos: MentionAnchor) => void;
  onMentionUpdate?: (query: string) => void;
  onMentionClose?: () => void;
  disabled?: boolean;
}

type MentionCallbacks = {
  onStart: (query: string, pos: MentionAnchor) => void;
  onUpdate: (query: string) => void;
  onClose: () => void;
};

function buildMentionExtension(
  callbacks: MutableRefObject<MentionCallbacks>,
  commandRef: MutableRefObject<((attrs: PromptMentionAttrs) => void) | null>,
  rangeRef: MutableRefObject<{ from: number; to: number } | null>,
) {
  return Mention.extend({
    name: "mention",
    atom: true,
    inline: true,
    group: "inline",

    addAttributes() {
      return {
        id: { default: null },
        index: { default: null },
        kind: { default: "图片" },
        label: { default: "" },
        assetId: { default: null },
        assetType: { default: null },
        imagePath: { default: null },
        assetTag: { default: "" },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-mention]" }];
    },

    // 一个 mention 节点只生成一个 .prompt-chip：缩略图、名称和类型色都在同一个 atom 内。
    renderHTML({ node, HTMLAttributes }) {
      const { label, assetType, imagePath, deleted } = node.attrs as PromptMentionAttrs;
      const thumbSrc = imagePath ? convertFileSrc(imagePath) : null;
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-mention": "true",
          "data-type": "mention",
          "data-kind": assetType ?? undefined,
          "data-image-src": thumbSrc ?? "",
          "data-deleted": deleted ? "true" : undefined,
          class: "prompt-chip",
        }),
        thumbSrc
          ? ["img", { "data-mention-thumb": "true", src: thumbSrc, alt: label ?? "" }]
          : ["span", { "data-mention-dot": "true" }],
        ["span", { "data-mention-label": "true" }, label ?? ""],
      ];
    },

    renderText({ node }) {
      const attrs = node.attrs as PromptMentionAttrs;
      return attrs.assetTag || `${attrs.label ?? ""}(@图片${attrs.index})`;
    },
  }).configure({
    HTMLAttributes: {},
    suggestion: {
      char: "@",
      allowSpaces: false,
      startOfLine: false,
      // 允许在文本任意位置（包括中文标点后）触发 @。
      allowedPrefixes: null,
      render: () => ({
        onStart(props) {
          rangeRef.current = props.range;
          commandRef.current = (attrs) => props.command(attrs as Parameters<typeof props.command>[0]);
          const rect = props.clientRect?.();
          if (rect) callbacks.current.onStart(props.query, { top: rect.top, left: rect.left, bottom: rect.bottom });
        },
        onUpdate(props) {
          rangeRef.current = props.range;
          commandRef.current = (attrs) => props.command(attrs as Parameters<typeof props.command>[0]);
          callbacks.current.onUpdate(props.query);
        },
        onExit() {
          rangeRef.current = null;
          commandRef.current = null;
          callbacks.current.onClose();
        },
        onKeyDown({ event }) {
          return ["Escape", "ArrowUp", "ArrowDown", "Enter"].includes(event.key);
        },
      }),
    },
  });
}

export const PromptEditor = forwardRef<PromptEditorHandle, Props>(
  function PromptEditor(
    {
      document, resetKey, onChange, onBlur, placeholder,
      onMentionStart, onMentionUpdate, onMentionClose, disabled,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const commandRef = useRef<((attrs: PromptMentionAttrs) => void) | null>(null);
    const rangeRef = useRef<{ from: number; to: number } | null>(null);
    const appliedResetKey = useRef<string | null>(null);
    const [chipPreview, setChipPreview] = useState<string | null>(null);
    const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previewRoot = useRef<HTMLElement | null>(null);

    const handleChipMouseEnter = useCallback((e: MouseEvent) => {
      const chip = (e.target as HTMLElement).closest?.(".prompt-chip") as HTMLElement | null;
      if (!chip) return;
      const src = chip.getAttribute("data-image-src");
      if (!src) return;
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => {
        setChipPreview(src);
      }, 400);
    }, []);

    const handleChipMouseLeave = useCallback((e: MouseEvent) => {
      const chip = (e.target as HTMLElement).closest?.(".prompt-chip") as HTMLElement | null;
      if (!chip) return;
      if (previewTimer.current) clearTimeout(previewTimer.current);
      setChipPreview(null);
    }, []);

    // 事件委托：监听 prompt-chip 的 hover
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      // 悬浮预览直接挂载到 document.body，避免被工作区滚动容器裁切。
      previewRoot.current = window.document.body;
      el.addEventListener("mouseover", handleChipMouseEnter, { passive: true });
      el.addEventListener("mouseout", handleChipMouseLeave, { passive: true });
      return () => {
        el.removeEventListener("mouseover", handleChipMouseEnter);
        el.removeEventListener("mouseout", handleChipMouseLeave);
        if (previewTimer.current) clearTimeout(previewTimer.current);
      };
    }, [handleChipMouseEnter, handleChipMouseLeave]);

    const callbacks = useRef<MentionCallbacks>({
      onStart: (query, position) => onMentionStart?.(query, position),
      onUpdate: (query) => onMentionUpdate?.(query),
      onClose: () => onMentionClose?.(),
    });

    useEffect(() => {
      callbacks.current = {
        onStart: (query, position) => onMentionStart?.(query, position),
        onUpdate: (query) => onMentionUpdate?.(query),
        onClose: () => onMentionClose?.(),
      };
    }, [onMentionStart, onMentionUpdate, onMentionClose]);

    const mentionExtension = useRef(buildMentionExtension(callbacks, commandRef, rangeRef)).current;
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: false, blockquote: false, bulletList: false, orderedList: false,
          listItem: false, codeBlock: false, horizontalRule: false, bold: false,
          italic: false, strike: false, code: false,
        }),
        mentionExtension,
      ],
      content: document as JSONContent,
      editable: !disabled,
      onUpdate({ editor: instance }) {
        const promptDoc = instance.getJSON() as PromptDoc;
        onChange({ promptDoc, plainText: promptDocToPlainText(promptDoc) });
      },
      onBlur() { onBlur?.(); },
      editorProps: {
        attributes: {
          class: "prompt-editor-content",
          spellcheck: "false",
          autocomplete: "off",
          autocorrect: "off",
          "data-placeholder": placeholder ?? "",
        },
      },
    });

    // 同步分镜切换及异步水合文档；编辑器自身回传的相同 JSON 不会重置光标。
    useEffect(() => {
      if (!editor) return;
      const resetKeyChanged = appliedResetKey.current !== resetKey;
      const documentChanged = JSON.stringify(editor.getJSON()) !== JSON.stringify(document);
      if (!resetKeyChanged && !documentChanged) return;

      editor.commands.setContent(document as JSONContent, { emitUpdate: false });
      appliedResetKey.current = resetKey;
    }, [document, editor, resetKey]);

    useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);

    useImperativeHandle(ref, () => ({
      get editor() { return editor ?? null; },
      insertMention(asset, index) {
        if (!editor) return;
        const attrs: PromptMentionAttrs = {
          id: asset.assetId,
          index,
          kind: "图片",
          label: asset.name,
          assetId: asset.assetId,
          assetType: asset.type,
          imagePath: asset.imagePath,
          assetTag: asset.assetTag,
        };
        const range = rangeRef.current;
        if (range) {
          editor.chain().focus().deleteRange(range).insertContent({ type: "mention", attrs }).run();
        } else if (commandRef.current) {
          commandRef.current(attrs);
        }
      },
      getPlainText() {
        return editor ? promptDocToPlainText(editor.getJSON() as PromptDoc) : promptDocToPlainText(document);
      },
      getPromptDoc() {
        return editor ? editor.getJSON() as PromptDoc : document;
      },
      focus() { editor?.commands.focus(); },
    }), [document, editor]);

    return (
      <div ref={containerRef} className={`prompt-editor${disabled ? " is-disabled" : ""}`}>
        <EditorContent editor={editor} />
        {chipPreview && createPortal(
          <div className="prompt-chip-preview">
            <img src={chipPreview} alt="" />
          </div>,
          previewRoot.current || window.document.body,
        )}
      </div>
    );
  },
);
