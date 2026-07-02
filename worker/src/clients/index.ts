/**
 * API 客户端工厂
 *
 * worker 启动时通过 createClients(settingsManager) 初始化。
 * 配置更新（设置页保存）后调用 clients.reload() 热更新客户端。
 *
 * @author yt @date 20260702
 */

import type { SettingsManager } from "../config/settings.js";
import { TextClient } from "./text.js";
import { ImageClient } from "./image.js";
import { VoiceClient } from "./voice.js";

export { FALLBACK_API_KEY } from "./constants.js";

export interface ApiClients {
  text: TextClient;
  image: ImageClient;
  voice: VoiceClient;
  /** 重新加载配置文件并更新所有客户端 */
  reload: () => void;
}

export function createClients(settings: SettingsManager): ApiClients {
  const cfg = settings.get();

  const text  = new TextClient(cfg.text);
  const image = new ImageClient(cfg.image);
  const voice = new VoiceClient(cfg.voice);

  return {
    text,
    image,
    voice,
    reload() {
      const updated = settings.reload();
      text.updateConfig(updated.text);
      image.updateConfig(updated.image);
      voice.updateConfig(updated.voice);
    },
  };
}

export { TextClient, ImageClient, VoiceClient };
