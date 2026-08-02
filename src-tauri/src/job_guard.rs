//! Windows Job Object 守护。
//!
//! 把超分子进程（realesrgan / ffmpeg / worker）加入一个 Job Object，并设置
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：当本进程退出时（无论是正常退出、
//! 崩溃还是被任务管理器强杀），Windows 内核会自动终止 Job 内所有子进程。
//!
//! 这解决了"应用被强制关闭后，realesrgan/ffmpeg 残留为孤儿进程、占用
//! upscaler/ffmpeg 资源文件，导致下次编译或启动失败"的问题。

use std::process::Child;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// HANDLE 是指针大小整数；用 usize 存储以便跨线程共享（Send+Sync）。
static JOB: OnceLock<usize> = OnceLock::new();

/// 创建并注册 Job Object（应用启动时调用一次）。
pub fn init_job() {
    // SAFETY: 传 null 表示创建无名 Job；返回 NULL 表示失败，忽略即可。
    let job: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        log::warn!("[job] 创建 Job Object 失败");
        return;
    }

    // 设置 KILL_ON_JOB_CLOSE
    // SAFETY: info 结构体对齐正确，写入长度正确。
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        log::warn!("[job] 设置 KILL_ON_JOB_CLOSE 失败");
        // SAFETY: 有效句柄
        unsafe {
            CloseHandle(job);
        }
        return;
    }

    // 只保留第一个成功创建的 job
    let _ = JOB.set(job as usize);
    log::info!("[job] Job Object 已就绪（KILL_ON_JOB_CLOSE）");
}

/// 把子进程加入全局 Job（放入后，父进程退出时该子进程会被内核自动终止）。
pub fn assign_child(child: &Child) {
    let Some(job) = JOB.get().copied() else {
        return;
    };
    // 用子进程 PID 打开句柄（AssignProcessToJobObject 要求）
    // SAFETY: pid 来自操作系统；请求权限位合法。
    let proc: HANDLE = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id()) };
    if proc.is_null() {
        log::warn!("[job] OpenProcess({}) 失败", child.id());
        return;
    }
    // SAFETY: 打开的句柄有效；Job handle 有效。
    let ok = unsafe { AssignProcessToJobObject(job as HANDLE, proc) };
    // SAFETY: 有效句柄
    unsafe {
        CloseHandle(proc);
    }
    if ok == 0 {
        // 子进程已在其他 Job 中时 assign 会失败，这里仅记录不阻断
        log::warn!("[job] AssignProcessToJobObject({}) 失败", child.id());
    }
}
