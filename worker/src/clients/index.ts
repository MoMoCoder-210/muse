/**
 * API 客户端工厂
 *
 * 启动时通过 createClients(settingsManager) 初始化。
 * 配置更新（设置页保存）后调用 clients.reload() 热更新。
 * 所有渠道均使用活跃渠道 + 活跃模型解析为平面配置送入 client。
 *
 * @author yt @date 20260702
 */

import type { SettingsManager } from "../config/settings.js";
import { TextClient } from "./text.js";
import { ImageClient } from "./image.js";
import { VoiceClient } from "./voice.js";
import { AssetClient } from "./asset.js";
import { VideoClient } from "./video.js";

export { FALLBACK_API_KEY } from "./constants.js";

export interface ApiClients {
  text: TextClient;
  image: ImageClient;
  voice: VoiceClient;
  asset: AssetClient;
  video: VideoClient;
  reload: () => void;
}

export function createClients(settings: SettingsManager): ApiClients {
  const text  = new TextClient(settings.getTextConfig());
  const image = new ImageClient(settings.getImageConfig());
  const voice = new VoiceClient(settings.getVoiceConfig());
  const asset = new AssetClient(settings.getAssetConfig());
  const video = new VideoClient(settings.getVideoConfig());

  return {
    text, image, voice, asset, video,
    reload() {
      const updated = settings.reload();
      // settings.reload() 已重置缓存，以下直接从缓存取
      text.updateConfig(settings.getTextConfig());
      image.updateConfig(settings.getImageConfig());
      voice.updateConfig(settings.getVoiceConfig());
      asset.updateConfig(settings.getAssetConfig());
      video.updateConfig(settings.getVideoConfig());
    },
  };
}

export { TextClient, ImageClient, VoiceClient, AssetClient, VideoClient };
