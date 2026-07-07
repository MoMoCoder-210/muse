-- 为 asset_images 增加方舟平台素材 ID
-- 上传至火山方舟 File API 后回写，供视频生成时引用
--
-- @author yt @date 20260707

ALTER TABLE asset_images ADD COLUMN ark_file_id TEXT;
