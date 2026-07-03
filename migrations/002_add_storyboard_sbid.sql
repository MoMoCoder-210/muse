-- 002: 新增 storyboards.sbid 列，存储片段内的分镜编号（如 "1-1"）
-- 使用 ALTER TABLE ADD COLUMN，SQLite 的 ADD COLUMN 不允许 IF NOT EXISTS，
-- 如果列已存在会报错 "duplicate column name"，但 run_migrations 按文件名排序顺序执行，
-- 在已有数据库上首次运行时会成功添加，再次运行时会跳过（错误被忽略）。

ALTER TABLE storyboards ADD COLUMN sbid TEXT NOT NULL DEFAULT '';
