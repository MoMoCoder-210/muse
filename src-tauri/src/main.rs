//! Muse 桌面应用入口
//!
//! @author yt @date 20260702

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    muse_lib::run()
}
