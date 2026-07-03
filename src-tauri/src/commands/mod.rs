//! Muse 命令层 — Tauri IPC command 注册
//!
//! 所有前端可调用的命令分散在子模块中定义。
//!
//! @author yt @date 20260703

pub(crate) mod util;

pub mod project;
pub mod clip;
pub mod script;
pub mod settings;

// 重新导出公共函数和结构体
pub use project::*;
pub use clip::*;
pub use script::*;
pub use settings::*;
