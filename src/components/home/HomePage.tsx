import { APP_NAME } from "../../config/muse";

type HomePageProps = {
  version: string;
  onCreateProject: () => void;
  onGoToProjects: () => void;
  onOpenSettings: () => void;
};

/**
 * 首页组件
 *
 * 展示应用主界面，包含品牌信息、快速操作入口与版本号。
 *
 * @author yt @date 20260702
 */
export function HomePage({ version, onCreateProject, onGoToProjects, onOpenSettings }: HomePageProps) {
  return (
    <section className="home-screen">
      <div className="home-card">
        <div className="brand-badge">{APP_NAME}</div>
        <h1>{APP_NAME}</h1>
        <p>为剧本到完整视频产出的AI工作台</p>

        <div className="home-actions">
          <button type="button" className="primary-button" onClick={onCreateProject}>
            创建项目
          </button>
          <button type="button" className="secondary-button" onClick={onGoToProjects}>
            项目管理
          </button>
        </div>

        <div className="home-meta">
          <span>版本：{version}</span>
          <button
            type="button"
            className="home-settings-btn"
            onClick={onOpenSettings}
            aria-label="打开设置"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </div>
    </section>
  );
}
