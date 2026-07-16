//! Muse 命令层 — Tauri IPC command 注册
//!

pub mod util;
pub mod video;
pub mod connection;

pub mod project;
pub mod clip;
pub mod script;
pub mod storyboard;
pub mod settings;
pub mod voice;

// 重新导出公共函数和结构体
pub use project::*;
pub use clip::*;
pub use script::*;
pub use storyboard::*;
pub use video::*;
pub use settings::*;
pub use connection::*;
pub use voice::*;
