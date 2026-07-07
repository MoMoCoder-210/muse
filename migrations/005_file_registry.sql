-- 005: 资产图片文件注册表优化
-- 核心原则：文件创建后永不重命名，asset_images.id 是唯一身份标识

-- asset_images 增加 file_name 字段，记录原始文件名（不可变，仅用于日志/调试）
ALTER TABLE asset_images ADD COLUMN file_name TEXT NOT NULL DEFAULT '';
