import { APP_NAME } from "../../config/muse";

type HomePageProps = {
  version: string;
  onCreateProject: () => void;
  onGoToProjects: () => void;
};

export function HomePage({ version, onCreateProject, onGoToProjects }: HomePageProps) {
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
        </div>
      </div>
    </section>
  );
}
