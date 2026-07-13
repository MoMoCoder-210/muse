/**
 * API 客户端工厂
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
      settings.reload();
      text.updateConfig(settings.getTextConfig());
      image.updateConfig(settings.getImageConfig());
      voice.updateConfig(settings.getVoiceConfig());
      asset.updateConfig(settings.getAssetConfig());
      video.updateConfig(settings.getVideoConfig());
    },
  };
}

export { TextClient, ImageClient, VoiceClient, AssetClient, VideoClient };
