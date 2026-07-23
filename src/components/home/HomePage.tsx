import { APP_NAME } from "../../config/muse";

type HomePageProps = {
  version: string;
  onCreateProject: () => void;
  onGoToProjects: () => void;
};

/**
 * Apple 风格首页
 *
 * 极简居中卡片：品牌名、行动按钮、版本信息。
 * 毛玻璃背景 + 柔和阴影，与环境融为一体。
 */
export function HomePage({ version, onCreateProject, onGoToProjects }: HomePageProps) {
  return (
    <section className="home-screen">
      <div className="home-card">
        <h1>{APP_NAME}</h1>
        <p>AI 驱动的视频创作工作台，从灵感到成片，一站完成。</p>

        <div className="home-actions">
          <button type="button" className="primary-button" onClick={onCreateProject}>
            创建作品
          </button>
          <button type="button" className="secondary-button" onClick={onGoToProjects}>
            作品管理
          </button>
        </div>

        <div className="home-meta">
          <span>v{version}</span>
        </div>
      </div>
    </section>
  );
}
