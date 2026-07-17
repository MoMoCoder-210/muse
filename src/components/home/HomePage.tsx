import { APP_NAME } from "../../config/muse";

type HomePageProps = {
  version: string;
  onCreateProject: () => void;
  onGoToProjects: () => void;
};

/**
 * 首页组件
 */
export function HomePage({ version, onCreateProject, onGoToProjects }: HomePageProps) {
  return (
    <section className="home-screen">
      <div className="home-card">
        <h1>{APP_NAME}</h1>

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
        </div>
      </div>
    </section>
  );
}
