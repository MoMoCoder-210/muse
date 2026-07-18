import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../hooks/useToast";
import { importVoiceFile, listWorkspaceVoiceFiles, previewPublicVoice, checkVoicesCached } from "../../services/tauri";
import type { VoiceFileEntry } from "../../services/tauri";
import {
  AGE_GROUPS,
  PUBLIC_VOICES,
  type PublicVoice,
  type VoiceGender,
} from "../../data/public-voices";
import type { VoiceBinding } from "../../types/project";

interface VoiceBindingSectionProps {
  /** 当前绑定 */
  value?: VoiceBinding;
  /** 绑定变化回调（解除传 undefined） */
  onChange: (binding: VoiceBinding | undefined) => void;
  disabled?: boolean;
  /** 当前片段 ID，用于列出项目工作区已导入的音频 */
  clipId: string;
}

type Tab = "public" | "local";

/** 角色资产「绑定声音」区块。 */
export function VoiceBindingSection({ value, onChange, disabled, clipId }: VoiceBindingSectionProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>(value?.source === "local" ? "local" : "public");
  const [genderFilter, setGenderFilter] = useState<VoiceGender>(
    value?.source === "public"
      ? PUBLIC_VOICES.find((v) => v.id === value.voiceId)?.gender ?? "female"
      : "female"
  );
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<VoiceFileEntry[]>([]);
  const [cachedVoiceIds, setCachedVoiceIds] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 批量查询已缓存的公共音色
  const refreshCache = useCallback(async () => {
    try {
      const ids = await checkVoicesCached(PUBLIC_VOICES.map((v) => v.id));
      setCachedVoiceIds(new Set(ids));
    } catch { /* 静默 */ }
  }, []);
  useEffect(() => { refreshCache(); }, [refreshCache]);

  // 加载项目工作区已导入的本地音频
  const loadLocalFiles = useCallback(async () => {
    try {
      const files = await listWorkspaceVoiceFiles(clipId);
      setLocalFiles(files);
    } catch {
      // 静默忽略
    }
  }, [clipId]);

  useEffect(() => {
    if (tab === "local") loadLocalFiles();
  }, [tab, loadLocalFiles]);

  const grouped = useMemo(() => {
    const byGender: Record<VoiceGender, PublicVoice[]> = { male: [], female: [] };
    for (const v of PUBLIC_VOICES) byGender[v.gender].push(v);
    return AGE_GROUPS.map((ag) => ({
      age: ag.value,
      label: ag.label,
      voices: byGender[genderFilter].filter((v) => v.age === ag.value),
    })).filter((a) => a.voices.length > 0);
  }, [genderFilter]);

  const handleBindPublic = (v: PublicVoice) => {
    onChange({ source: "public", voiceId: v.id, label: v.name });
  };

  const handleBindLocal = (entry: VoiceFileEntry) => {
    onChange({ source: "local", filePath: entry.file_path, label: entry.file_name });
  };

  // 停止当前播放
  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  };

  // 试听公共音色（首次试听生成缓存后即时刷新缓存标识）
  const handlePreview = async (voiceId: string) => {
    if (playingId === voiceId) { stopAudio(); return; }
    stopAudio();
    setPreviewLoading(voiceId);
    try {
      const res = await previewPublicVoice(voiceId);
      if (!res.cached) refreshCache();
      const url = convertFileSrc(res.sample_path);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => { setPlayingId(null); toast("试听播放失败", "error"); };
      await audio.play();
      setPlayingId(voiceId);
    } catch (e) {
      toast(`试听失败：${String(e)}`, "error");
    } finally {
      setPreviewLoading(null);
    }
  };

  // 播放本地文件
  const handlePlayLocal = (filePath: string) => {
    if (playingId === filePath) { stopAudio(); return; }
    stopAudio();
    const url = convertFileSrc(filePath);
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => { setPlayingId(null); toast("播放失败", "error"); };
    audio.play().catch((e) => toast(`播放失败：${String(e)}`, "error"));
    setPlayingId(filePath);
  };

  // 本地上传（上传到工作区，但不自动绑定）
  const handleLocalUpload = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "ogg", "flac"] }],
      });
      if (!selected || typeof selected !== "string") return;
      await importVoiceFile(clipId, selected);
      // 上传后刷新列表，不自动绑定
      await loadLocalFiles();
    } catch (e) {
      toast(`上传失败：${String(e)}`, "error");
    }
  };

  const isBoundPublic = (id: string) => value?.source === "public" && value.voiceId === id;
  const isBoundLocal = (path: string) => value?.source === "local" && value.filePath === path;
  const isCached = (id: string) => cachedVoiceIds.has(id);

  const currentBinding = value && (
    <div className="voice-binding-current">
      <span className="voice-binding-badge">
        {value.source === "public" ? "公共声音" : "本地上传"}
      </span>
      <span className="voice-binding-name">{value.label}</span>
      <button
        type="button"
        className="voice-binding-unbind"
        disabled={disabled}
        onClick={() => onChange(undefined)}
      >
        解除绑定
      </button>
    </div>
  );

  return (
    <div className="voice-binding">
      <div className="voice-binding-tabs" role="tablist">
        <button
          type="button" role="tab"
          aria-selected={tab === "public"}
          className={tab === "public" ? "active" : ""}
          onClick={() => setTab("public")}
          disabled={disabled}
        >公共声音</button>
        <button
          type="button" role="tab"
          aria-selected={tab === "local"}
          className={tab === "local" ? "active" : ""}
          onClick={() => setTab("local")}
          disabled={disabled}
        >本地上传</button>
      </div>

      {tab === "local" ? (
        <>
          <button
            type="button"
            className="voice-binding-upload-btn"
            disabled={disabled}
            onClick={handleLocalUpload}
          >
            <span className="voice-upload-icon">＋</span>
            选择本地音频文件
          </button>

          {localFiles.length > 0 && (
            <div className="voice-binding-list">
              {localFiles.map((f) => {
                const bound = isBoundLocal(f.file_path);
                const playing = playingId === f.file_path;
                return (
                  <div
                    key={f.file_path}
                    className={`voice-capsule${bound ? " is-bound" : ""}${playing ? " is-playing" : ""}`}
                  >
                    <button
                      type="button"
                      className="voice-capsule-play"
                      title={playing ? "停止" : "试听"}
                      disabled={disabled}
                      onClick={() => handlePlayLocal(f.file_path)}
                    >{playing ? "⏸" : "▶"}</button>
                    <button
                      type="button"
                      className="voice-capsule-body"
                      title={bound ? "已绑定" : `绑定 ${f.file_name}`}
                      disabled={disabled || bound}
                      onClick={() => handleBindLocal(f)}
                    >{f.file_name}</button>
                  </div>
                );
              })}
            </div>
          )}

          {currentBinding}
        </>
      ) : (
        <>
          <div className="voice-gender-filter" role="group" aria-label="性别筛选">
            <button type="button" className={genderFilter === "female" ? "active" : ""}
              onClick={() => setGenderFilter("female")} aria-pressed={genderFilter === "female"}>女声</button>
            <button type="button" className={genderFilter === "male" ? "active" : ""}
              onClick={() => setGenderFilter("male")} aria-pressed={genderFilter === "male"}>男声</button>
          </div>

          <div className="voice-binding-list">
            {grouped.length === 0 ? (
              <div className="voice-empty">该分类下暂无音色</div>
            ) : (grouped.map((a) => (
              <div key={a.age} className="voice-age-block">
                <div className="voice-age-label">{a.label}</div>
                <div className="voice-capsules">
                  {a.voices.map((v) => {
                    const bound = isBoundPublic(v.id);
                    const cached = isCached(v.id);
                    const loading = previewLoading === v.id;
                    const playing = playingId === v.id;
                    return (
                      <div key={v.id} className={`voice-capsule${bound ? " is-bound" : ""}${cached ? " is-cached" : ""}${playing ? " is-playing" : ""}`}>
                        <button type="button" className="voice-capsule-play" title={playing ? "停止" : "试听"}
                          disabled={disabled || loading} onClick={() => handlePreview(v.id)}
                        >{loading ? "…" : playing ? "⏸" : "▶"}</button>
                        <button type="button" className="voice-capsule-body" title={bound ? "已绑定" : `绑定 ${v.name}`}
                          disabled={disabled || bound} onClick={() => handleBindPublic(v)}
                        >{v.name}</button>
                        {cached && <span className="voice-capsule-cached" title="本地已有缓存"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg></span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )))}
          </div>

          {currentBinding}
        </>
      )}
    </div>
  );
}
