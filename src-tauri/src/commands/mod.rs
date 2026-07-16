//! Muse 命令层 — Tauri IPC command 注册
//!

pub mod connection;
pub mod util;
pub mod video;

pub mod clip;
pub mod project;
pub mod script;
pub mod settings;
pub mod storyboard;
pub mod voice;

// 重新导出公共函数和结构体
pub use clip::*;
pub use connection::*;
pub use project::*;
pub use script::*;
pub use settings::*;
pub use storyboard::*;
pub use video::*;
pub use voice::*;
