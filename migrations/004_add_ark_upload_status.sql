-- 为 asset_images 增加方舟上传状态追踪
-- ark_upload_status: 'pending' | 'uploaded' | 'failed'，NULL 表示无需上传（旧记录）
-- ark_upload_error: 上传失败时的错误信息
--
-- @author yt @date 20260707

ALTER TABLE asset_images ADD COLUMN ark_upload_status TEXT;
ALTER TABLE asset_images ADD COLUMN ark_upload_error TEXT;
