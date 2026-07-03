//! Muse 桌面应用入口
//!
//! @author yt @date 20260702

// release 模式下在 Windows 上隐藏额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    muse_lib::run()
}
