-- ============================================================================
-- Muse 开发期增量脚本
-- 说明：为已有数据库追加开发中新增的表/列，发布时合并到 001_schema.sql 后删除此文件。
-- 所有语句均支持重复执行（重复时自动跳过）。
-- ============================================================================

-- 1. assets 表新增 selected_image_id 列
ALTER TABLE assets ADD COLUMN selected_image_id TEXT;

-- 2. 新增 asset_images 表（一资产多图片支持）
CREATE TABLE IF NOT EXISTS asset_images (
    id              TEXT PRIMARY KEY,
    asset_id        TEXT NOT NULL REFERENCES assets(id),
    prompt          TEXT NOT NULL,
    size            TEXT,
    style           TEXT,
    image_path      TEXT NOT NULL,
    thumb_path      TEXT,
    is_selected     INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'generation',
    task_id         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asset_images_asset
    ON asset_images(asset_id);

CREATE INDEX IF NOT EXISTS idx_asset_images_selected
    ON asset_images(asset_id, is_selected)
    WHERE is_selected = 1;
