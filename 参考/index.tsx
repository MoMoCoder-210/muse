import Mention from '@tiptap/extension-mention';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import AssetPreviewModal, { type AssetPreviewState } from '@/pages/ShortDrama/components/Flow/components/AssetPreviewModal';
import { getAssetStatusLabel, getAssetStatusState } from '@/pages/ShortDrama/components/Flow/utils/assets';

import { SuggestionList } from './SuggestionList';
import { EDITOR_STYLE } from './style';
import type {
  AssetKind,
  InvalidMentionSelection,
  MentionAsset,
  PromptViewerHandle,
  PromptViewerProps,
  SuggestionListHandle,
} from './types';
import {
  buildAssetList,
  collectPromptMentions,
  getMentionFallbackText,
  getMentionIconSpec,
  getMentionNodeContent,
  mentionDataAttr,
  serializePromptDoc,
  syncMentionAttrsWithAssets,
  textToPromptDoc,
} from './utils';

// ---- 公开 API re-export ----
// ponytail: 拆分后保留原 PromptViewer.tsx 的对外导出面以零改动调用方；资产状态相关
// getAssetStatusState/Label/AssetStatusState 已下沉到 Flow/utils/assets.ts，不再从这里导出。

export {
  buildAssetList,
  collectPromptMentions,
  findMatchingAssetMention,
  getMediaKind,
  getMentionFallbackText,
  getMentionIconSpec,
  getMentionNodeContent,
  getPromptMediaLabel,
  getPromptMediaMentionId,
  getPromptScriptAssetMentionId,
  isKnownAssetMention,
  mentionDataAttr,
  parseMediaList,
  serializePromptDoc,
  syncMentionAttrsWithAssets,
  textToPromptDoc,
} from './utils';

export type {
  MentionAsset,
  PromptMediaItem,
  PromptViewerBlockedMention,
  PromptViewerHandle,
  PromptViewerMentionSnapshot,
  PromptViewerProps,
  PromptViewerResolvedMention,
  PromptViewerSubmitOptions,
  PromptViewerSubmitResult,
  PromptViewerUnresolvedMention,
} from './types';

// ---- 组件 ----

const PromptViewer = forwardRef<PromptViewerHandle, PromptViewerProps>(
  (
    {
      prompt,
      promptDoc,
      resetKey,
      characters = [],
      scenes = [],
      items = [],
      media,
      headerExtra,
      footer,
      referenceTextsById,
      placeholder = '请输入提示词，输入 @ 引用角色、场景或视频',
      onChange,
      onMentionsChange,
    },
    ref,
  ) => {
    const assets = useMemo(
      () => buildAssetList(characters, scenes, items, media, referenceTextsById),
      [characters, scenes, items, media, referenceTextsById],
    );
    const assetsKey = useMemo(
      () =>
        assets
          .map(
            (asset) =>
              `${asset.id}:${asset.kind}:${asset.label}:${asset.assetStatus || ''}:${asset.previewUrl || ''}:${asset.sourceUrl || ''}:${(
                asset.referenceTexts || []
              ).join(',')}`,
          )
          .join('|'),
      [assets],
    );
    // 用 ref 打破 useEditor 闭包：items 函数始终读取最新资产列表
    const assetsRef = useRef(assets);
    assetsRef.current = assets;
    const hasUserEditedRef = useRef(false);
    const internalMentionSyncRef = useRef(false);
    const appliedExternalKeyRef = useRef('');
    const lastPromptRef = useRef(prompt ?? '');
    const lastResetKeyRef = useRef(resetKey);
    const replacementListRef = useRef<SuggestionListHandle | null>(null);
    const replacementPopupRef = useRef<HTMLDivElement | null>(null);
    const [previewAsset, setPreviewAsset] = useState<AssetPreviewState | null>(null);
    const [invalidMentionSelection, setInvalidMentionSelection] = useState<InvalidMentionSelection | null>(null);
    // 文档版本号：内容变化（含粘贴）时自增，用于触发 mention 有效性重校验
    const [docVersion, setDocVersion] = useState(0);

    const waitForHydration = useCallback(
      () =>
        new Promise<void>((resolve) => {
          const schedule =
            typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
              ? window.requestAnimationFrame.bind(window)
              : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 0);

          schedule(() => {
            schedule(() => resolve());
          });
        }),
      [],
    );

    // Suggestion render: 使用 @tiptap/react 的 ReactRenderer + mount() 自动定位
    const suggestionRender = useCallback(() => {
      let renderer: ReactRenderer<SuggestionListHandle, { items: MentionAsset[]; command: (item: MentionAsset) => void }> | null = null;
      let unmountPopup: (() => void) | null = null;

      const destroy = () => {
        unmountPopup?.();
        unmountPopup = null;
        renderer?.destroy();
        renderer = null;
      };

      return {
        onStart: (props: SuggestionProps<MentionAsset, MentionAsset>) => {
          renderer = new ReactRenderer(SuggestionList, {
            editor: props.editor,
            props: {
              items: props.items,
              command: props.command,
            },
          });
          // mount() 自动追加到 body、锚定光标、处理滚动/尺寸变化
          unmountPopup = props.mount(renderer.element);
        },
        onUpdate: (props: SuggestionProps<MentionAsset, MentionAsset>) => {
          renderer?.updateProps({
            items: props.items,
            command: props.command,
          });
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === 'Escape') {
            destroy();
            return true;
          }
          return renderer?.ref?.onKeyDown(props) ?? false;
        },
        onExit: () => {
          destroy();
        },
      };
    }, []);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: false,
          bold: false,
          italic: false,
          strike: false,
          code: false,
          bulletList: false,
          orderedList: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          dropcursor: false,
          gapcursor: false,
        }),
        Placeholder.configure({
          placeholder,
        }),
        Mention.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              kind: mentionDataAttr('kind'),
              assetStatus: mentionDataAttr('assetStatus'),
              previewUrl: mentionDataAttr('previewUrl'),
              sourceUrl: mentionDataAttr('sourceUrl'),
              invalid: mentionDataAttr('invalid'),
            };
          },
          renderText({ node }: any) {
            return `@${node.attrs.label ?? node.attrs.id}`;
          },
          renderHTML({ node, HTMLAttributes }: any) {
            const label = `@${node.attrs.label ?? node.attrs.id}`;
            const kind = node.attrs.kind as AssetKind | null;
            const assetStatus = node.attrs.assetStatus as string | null;
            const assetState = getAssetStatusState(assetStatus);
            const assetStatusLabel = getAssetStatusLabel(assetStatus);
            const previewUrl = node.attrs.previewUrl as string | null;
            const invalid = node.attrs.invalid === 'true';
            const statusLabel = invalid ? '已失效' : assetStatusLabel;
            const iconKind = !previewUrl && (kind === 'audio' || kind === 'video') ? kind : null;
            const className = Array.from(new Set(['mention-tag', HTMLAttributes.class].filter(Boolean))).join(' ');
            const children = [
              ...(previewUrl ? [['img', { 'data-mention-thumb': 'true', src: previewUrl, alt: node.attrs.label ?? '' }] as const] : []),
              ...(iconKind ? ([['span', { 'data-mention-icon': iconKind }, getMentionIconSpec(iconKind)]] as const) : []),
              ['span', { 'data-mention-label': 'true' }, label] as const,
              ...(statusLabel ? ([['span', { 'data-mention-status': 'true', 'data-status-label': statusLabel }]] as const) : []),
            ];

            return [
              'span',
              {
                ...HTMLAttributes,
                class: className,
                'data-type': 'mention',
                'data-label': node.attrs.label ?? node.attrs.id,
                title: invalid
                  ? `${label}（该资产已从当前分镜移除，点击替换）`
                  : statusLabel
                  ? `${label}（${statusLabel}，点击替换）`
                  : label,
                ...(kind ? { 'data-kind': kind } : {}),
                ...(assetState && !invalid ? { 'data-asset-state': assetState } : {}),
                ...(invalid ? { 'data-invalid': 'true' } : {}),
              },
              ...children,
            ];
          },
        }).configure({
          HTMLAttributes: { class: 'mention-tag' },
          deleteTriggerWithBackspace: true,
          suggestion: {
            char: '@',
            allowSpaces: true,
            allowedPrefixes: null,
            items: ({ query }: { query: string }) => {
              const list = assetsRef.current;
              if (!query) return list;
              const q = query.toLowerCase();
              return list.filter((asset) => asset.label.toLowerCase().includes(q));
            },
            render: suggestionRender,
          },
        }),
      ],
      content: promptDoc || textToPromptDoc(prompt ?? '', assets),
      editable: true,
      onUpdate: ({ editor: ed }) => {
        if (internalMentionSyncRef.current) {
          internalMentionSyncRef.current = false;
          return;
        }
        hasUserEditedRef.current = true;
        onChange?.(ed.getText({ blockSeparator: '\n' }));
        onMentionsChange?.(collectPromptMentions(ed.getJSON()));
        // 内容变化后触发 mention 重校验：粘贴进来的、当前分镜不存在的资产标签会被标记为失效
        setDocVersion((version) => version + 1);
      },
    });

    const getSubmitResult = useCallback(
      (options?: import('./types').PromptViewerSubmitOptions): import('./types').PromptViewerSubmitResult => {
        if (!editor || editor.isDestroyed) {
          return { text: prompt ?? '', mentions: [], blockedMentions: [], unresolvedMentions: [] };
        }

        const mentionTextById = options?.mentionTextById || {};
        const mentions: import('./types').PromptViewerResolvedMention[] = [];
        const blockedMentions: import('./types').PromptViewerBlockedMention[] = [];
        const unresolvedMentions: import('./types').PromptViewerUnresolvedMention[] = [];
        const text = serializePromptDoc(editor.getJSON(), (attrs) => {
          const id = String(attrs.id || '');
          const label = String(attrs.label || '');
          const kind = attrs.kind as AssetKind | undefined;
          const mappedText = id ? mentionTextById[id] : undefined;
          const invalid = attrs.invalid === 'true';
          const assetStatus = typeof attrs.assetStatus === 'string' ? attrs.assetStatus : undefined;
          const assetStatusLabel = getAssetStatusLabel(assetStatus);

          if (!mappedText) {
            unresolvedMentions.push({ id, label, kind });
            blockedMentions.push({ id, label, kind, reason: invalid ? '已失效' : '未绑定' });
          } else {
            mentions.push({ id, label, kind, text: mappedText });
            if (invalid || assetStatusLabel) {
              blockedMentions.push({ id, label, kind, reason: invalid ? '已失效' : assetStatusLabel });
            }
          }

          return mappedText || getMentionFallbackText(attrs);
        });

        return { text, mentions, blockedMentions, unresolvedMentions };
      },
      [editor, prompt],
    );

    const handleEditorShellClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const mention = target?.closest('[data-type="mention"]') as HTMLElement | null;

        if (mention) {
          event.preventDefault();
          event.stopPropagation();

          const kind = mention.dataset.kind as AssetKind | undefined;
          // 节点 title 已写入 "@label"（见 renderHTML），直接取用即可
          const label = mention.dataset.label || mention.textContent || '@资产';
          const url = mention.dataset.sourceUrl || mention.dataset.previewUrl;

          if ((mention.dataset.invalid === 'true' || mention.dataset.assetState) && kind && editor) {
            try {
              const from = editor.view.posAtDOM(mention, 0);
              const node = editor.state.doc.nodeAt(from);

              if (node?.type.name === 'mention') {
                setInvalidMentionSelection({
                  from,
                  id: String(node.attrs.id || ''),
                  to: from + node.nodeSize,
                  kind,
                  label: String(node.attrs.label || label).replace(/^@/, ''),
                  rect: mention.getBoundingClientRect(),
                });
                return;
              }
            } catch (error) {
              console.warn('定位失效引用失败:', error);
            }
          }

          if (kind) {
            setPreviewAsset({ kind, label, url });
          }
          return;
        }

        editor?.commands.focus();
      },
      [editor],
    );

    const replaceInvalidMention = useCallback(
      (asset: MentionAsset) => {
        if (!editor || !invalidMentionSelection) return;

        const targetId = invalidMentionSelection.id;
        const targetKind = invalidMentionSelection.kind;
        const targetLabel = invalidMentionSelection.label;
        const ranges: Array<{ from: number; to: number }> = [];

        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'mention') return undefined;

          const nodeId = String(node.attrs.id || '');
          const nodeKind = node.attrs.kind as AssetKind | undefined;
          const nodeLabel = String(node.attrs.label || '');
          const sameMention = targetId
            ? nodeId === targetId
            : nodeKind === targetKind && nodeLabel.replace(/^@/, '') === targetLabel.replace(/^@/, '');

          if (sameMention) {
            ranges.push({ from: pos, to: pos + node.nodeSize });
          }
          return undefined;
        });

        const targets = (ranges.length > 0 ? ranges : [{ from: invalidMentionSelection.from, to: invalidMentionSelection.to }]).sort(
          (a, b) => b.from - a.from,
        );
        let chain = editor.chain().focus();
        targets.forEach((range) => {
          chain = chain.insertContentAt(range, getMentionNodeContent(asset));
        });
        chain.run();
        setInvalidMentionSelection(null);
      },
      [editor, invalidMentionSelection],
    );

    useImperativeHandle(
      ref,
      () => ({
        getSubmitResult,
        getHydratedSubmitResult: async (options) => {
          await waitForHydration();
          return getSubmitResult(options);
        },
        waitForHydration,
        getSubmitText: (options) => {
          if (!editor || editor.isDestroyed) return prompt ?? '';
          const mentionTextById = options?.mentionTextById || {};

          return serializePromptDoc(editor.getJSON(), (attrs) => {
            const id = String(attrs.id || '');
            const mappedText = id ? mentionTextById[id] : undefined;
            return mappedText || getMentionFallbackText(attrs);
          });
        },
        getSnapshot: () => {
          if (!editor || editor.isDestroyed) return undefined;
          const doc = editor.getJSON();
          return {
            doc,
            text: editor.getText({ blockSeparator: '\n' }),
            mentions: collectPromptMentions(doc),
          };
        },
      }),
      [editor, getSubmitResult, prompt, waitForHydration],
    );

    // 外部内容同步：prompt 文本变化时重灌；资产列表变化时只在尚未水合 mention 的情况下重灌。
    // 已存在的 mention 会通过下面的同步逻辑标记为有效/失效，避免删除资产后把失效标签退化为普通文本。
    useLayoutEffect(() => {
      if (!editor || editor.isDestroyed) {
        return;
      }

      const next = prompt ?? '';
      const nextExternalKey = `${next}\n${assetsKey}`;
      const promptChanged = lastPromptRef.current !== next;
      const resetKeyChanged = lastResetKeyRef.current !== resetKey;
      const externalContentChanged = appliedExternalKeyRef.current !== nextExternalKey;
      let hasMention = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'mention') {
          hasMention = true;
          return false;
        }
        return undefined;
      });
      const shouldHydrateAssets = !hasUserEditedRef.current && !hasMention && externalContentChanged;
      const shouldForceReset =
        resetKeyChanged && (externalContentChanged || promptChanged || Boolean(promptDoc) || hasUserEditedRef.current);

      if (shouldForceReset || (!hasUserEditedRef.current && (promptChanged || shouldHydrateAssets))) {
        editor.commands.setContent(promptDoc || textToPromptDoc(next, assetsRef.current), { emitUpdate: false });
        onMentionsChange?.(collectPromptMentions(editor.getJSON()));
        hasUserEditedRef.current = false;
        appliedExternalKeyRef.current = nextExternalKey;
        lastPromptRef.current = next;
        lastResetKeyRef.current = resetKey;
      } else if (resetKeyChanged) {
        hasUserEditedRef.current = false;
        lastPromptRef.current = next;
        lastResetKeyRef.current = resetKey;
      }
    }, [assetsKey, editor, onMentionsChange, prompt, promptDoc, resetKey]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;

      let transaction = editor.state.tr;
      let changed = false;

      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'mention') return undefined;

        const nextAttrs = syncMentionAttrsWithAssets(node.attrs, assetsRef.current);

        const sameAttrs =
          (node.attrs.label || null) === (nextAttrs.label || null) &&
          (node.attrs.invalid || null) === (nextAttrs.invalid || null) &&
          (node.attrs.assetStatus || null) === (nextAttrs.assetStatus || null) &&
          (node.attrs.previewUrl || null) === (nextAttrs.previewUrl || null) &&
          (node.attrs.sourceUrl || null) === (nextAttrs.sourceUrl || null);
        if (sameAttrs) return undefined;

        transaction = transaction.setNodeMarkup(pos, undefined, nextAttrs);
        changed = true;
        return undefined;
      });

      if (changed) {
        internalMentionSyncRef.current = true;
        editor.view.dispatch(transaction);
      }
    }, [assetsKey, docVersion, editor]);

    const replacementAssets = useMemo(() => {
      if (!invalidMentionSelection) return [];
      return assets.filter((asset) => asset.kind === invalidMentionSelection.kind);
    }, [assets, invalidMentionSelection]);

    useEffect(() => {
      if (!invalidMentionSelection) return undefined;

      const handlePointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && replacementPopupRef.current?.contains(target)) return;
        setInvalidMentionSelection(null);
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setInvalidMentionSelection(null);
          return;
        }

        if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab'].includes(event.key)) {
          const handled = replacementListRef.current?.onKeyDown({ event } as SuggestionKeyDownProps);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
      };

      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('keydown', handleKeyDown);

      return () => {
        document.removeEventListener('mousedown', handlePointerDown);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [invalidMentionSelection]);

    const replacementPopup = invalidMentionSelection
      ? createPortal(
          <div
            ref={replacementPopupRef}
            className="fixed z-[1050]"
            style={{
              left: Math.min(invalidMentionSelection.rect.left, Math.max(window.innerWidth - 380, 8)),
              top: Math.min(invalidMentionSelection.rect.bottom + 6, Math.max(window.innerHeight - 360, 8)),
            }}
          >
            <SuggestionList ref={replacementListRef} items={replacementAssets} command={replaceInvalidMention} />
          </div>,
          document.body,
        )
      : null;

    return (
      <>
        <style>{EDITOR_STYLE}</style>
        <div className="shot-pv flex h-full min-h-[220px] flex-col gap-2 p-3 leading-relaxed">
          <div className="flex items-center justify-between px-0.5">
            <span className="font-mono text-[11px] font-semibold tracking-[0.1em] text-foreground-muted">PROMPT</span>
            {headerExtra}
          </div>
          <div className="shot-prompt-shell min-h-[190px] flex-1 rounded-lg">
            <div className="shot-prompt-editor-body" onClick={handleEditorShellClick}>
              <EditorContent editor={editor} />
            </div>
            {footer ? <div className="shot-prompt-footer">{footer}</div> : null}
          </div>
        </div>
        <AssetPreviewModal preview={previewAsset} onClose={() => setPreviewAsset(null)} />
        {replacementPopup}
      </>
    );
  },
);

PromptViewer.displayName = 'PromptViewer';

export default PromptViewer;
