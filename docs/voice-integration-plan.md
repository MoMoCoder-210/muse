# 声音集成方案

> Seedance 2.0 支持音频参考输入，通过 `音频1`、`音频2` 在提示词中引用。
> 本文定义角色声音生成 → 视频带声音生成的完整流程。

---

## 一、Seedance API 音频能力

### 1. 音频输入结构

```json
{
  "type": "audio_url",
  "audio_url": { "url": "https://xxx.mp3" },
  "role": "reference_audio"
}
```

- content 数组中可传入 0~3 个音频
- 音频需为公网可访问的 URL
- 在 prompt 中用 `音频1`、`音频2` 按顺序引用

### 2. 音色参考 prompt 格式

```
[角色名]说："[台词内容]"，音色参考音频1
```

示例：
```
张建国说："妈，我是为您好啊。"，音色参考音频1。
王桂芳说："你拉我干什么？"，音色参考音频2。
```

---

## 二、角色声音生成（资产管理侧）

### 触发入口

在资产管理面板中，角色资产卡片增加「生成声音」操作：

```
┌─────────────────────────┐
│  👤 李秀兰              │
│  ┌──────────────────┐   │
│  │   [角色图片]      │   │
│  └──────────────────┘   │
│  [设为资产图] [生成声音] │  ← 新增按钮
└─────────────────────────┘
```

### 生成流程

1. **用户点击「生成声音」** → 弹出声音样本生成弹窗
   - 输入参考文本（默认："你好，我是李秀兰"）
   - 选择音色风格（老年女声 / 青年女声 / 男声...）

2. **调用 VoiceClient.synthesize()**
   - 生成一段 3-5 秒的参考音频文件
   - 保存到 `{project_dir}/voices/{asset_id}_ref.mp3`

3. **写入数据库**
   - 在 `assets` 表新增 `voice_path` 字段（可选）
   - 或新建 `asset_voices` 表：

```sql
CREATE TABLE IF NOT EXISTS asset_voices (
    id          TEXT PRIMARY KEY,
    asset_id    TEXT NOT NULL REFERENCES assets(id),
    file_path   TEXT NOT NULL,          -- 本地音频路径
    sample_text TEXT NOT NULL,          -- 生成该声音的参考文本
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

4. **更新绑定图片流程**
   - 原有的 `add_asset_image` 逻辑同时检查 voice
   - 如果 assets 有 `selected_voice_id` → 在 storyboard_assets 关联时带上 voice 信息

---

## 三、视频生成时带上声音

### 触发入口

在分镜面板（StoryboardPanel）的视频生成参数区：

```
┌──────────────────────────────┐
│ 生成参数                      │
│ 模型 [kling-v1 ▾]            │
│ 时长 [5s ▾] 分辨率 [1080p ▾] │
│ 宽高比 [16:9 ▾]              │
│ ☑ 生成有声视频               │  ← 复选框
│ [生成视频]                    │
└──────────────────────────────┘
```

### handler 流程（新增 `generate-storyboard-video.ts`）

```
输入: storyboard_id
  ↓
1. 查询 storyboard 的关联资产（角色/场景/物品）
  ↓
2. 对每个角色资产，查询其 active voice_path
  ├─ 有 voice → 上传到公网 URL（TOS 或 AssetClient）
  └─ 无 voice → 跳过（该角色无声音，不算错误）
  ↓
3. 构建 Seedance prompt：
   - 拼接视频画面描述（来自 animationPrompt）
   - 按台词顺序插入音色参考：`角色名说："台词"，音色参考音频N`
  ↓
4. 构建 content 数组：
   [文本, 角色图片1, 角色图片2, 场景图片1, 音频1, 音频2]
  ↓
5. 调用 VideoClient.generate()
   - generateAudio: true
   - references: [...音频URL]
  ↓
6. 下载结果视频 → 写入 storyboards.video_path
```

### prompt 组装示例

```
输入素材：
  - 图片1: 李秀兰角色图
  - 图片2: 张建国角色图
  - 图片3: 王桂芳角色图
  - 图片4: 老宅卧室场景图
  - 音频1: 李秀兰声音
  - 音频2: 张建国声音
  - 音频3: 王桂芳声音

动画描述：
  c01,2s,[空间:老宅卧室][姿态:李秀兰-站立，张建国-站在她身后]
  张建国说："妈，我是为您好啊。"，音色参考音频2。
  李秀兰说："我一个退休金一千八的，够花。"，音色参考音频1。

  c02,3s,[空间:老宅卧室][姿态:王桂芳-被张建国拉住]
  王桂芳说："你拉我干什么？"，音色参考音频3。

生成 prompt：
  参考图片1、图片2、图片3、图片4的人物与场景，
  张建国说："妈，我是为您好啊。"，音色参考音频2。
  李秀兰说："我一个退休金一千八的，够花。"，音色参考音频1。
  c01,2s,[空间:老宅卧室][姿态:李秀兰-站立，张建国-站在她身后] 张建国挤出笑容。
  c02,3s,[空间:老宅卧室][姿态:王桂芳-被张建国拉住] 王桂芳气急败坏。
```

---

## 四、实施步骤

| 优先级 | 步骤 | 说明 |
|--------|------|------|
| P0 | assets 表加 `voice_path`、`selected_voice_id` 字段 | 或新建 asset_voices 表 |
| P0 | AssetImageGallery 加「生成声音」按钮 + 弹窗 | 调用 VoiceClient |
| P0 | 新建 `generate-storyboard-video.ts` handler | 核心视频生成逻辑 |
| P1 | 图片/音频上传到公网 | 可复用 AssetClient.uploadImage 逻辑 |
| P1 | StoryboardPanel 加「生成视频」按钮 | 后端接口联调 |
| P2 | 视频回填到 storyboards.video_path | 分镜面板预览播放 |
| P2 | 批量生成队列 | 多分镜按序生成 |

---

## 五、关键决策点

1. **音频存放**：用 TOS（火山对象存储）还是 AssetClient（方舟 Files API）？建议用 AssetClient，统一素材管理。

2. **没有声音的角色**：跳过，Seedance 会用默认 TTS 合成该角色的台词。

3. **声音样本长度**：Seedance 的音色参考只需要 3-5 秒即可，不需要完整台词。

4. **是否每个角色都要声音**：不是。选项——可为每个角色单独配一个参考音频，也可以不配（Seedance 自行合成）。
