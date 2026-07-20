//! Muse 桌面应用入口
//!

// Windows 上始终隐藏控制台窗口（debug/release 均不弹出终端）
#![windows_subsystem = "windows"]

fn main() {
    muse_lib::run()
}
