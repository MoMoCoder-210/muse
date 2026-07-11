//! 模型渠道连通性测试
//!
//! 对 OpenAI 兼容端点的 `/models` 发起带 Bearer 鉴权的 GET，
//! 依据状态码判断鉴权与可达性。所有渠道均走 OpenAI 兼容协议，
//! 故同一套校验逻辑即可覆盖 text / image / voice / asset。
//!
//! 日志说明：本命令为全局设置操作，无 project 上下文（无 `log_path`），
//! 故用 `eprintln!` 输出到 stderr 便于开发期排障，不入项目日志。
//!
//! @author yt @date 20260710

use serde::Serialize;

/// 测试连接返回结果
#[derive(Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
}

/// 将 ureq 传输层错误转换为可读文案
fn transport_message(t: &ureq::Transport) -> String {
    if let Some(msg) = t.message() {
        msg.to_string()
    } else {
        format!("{:?}", t.kind())
    }
}

#[tauri::command]
pub fn test_connection(
    api_key: String,
    base_url: String,
    timeout_ms: Option<u64>,
) -> Result<TestConnectionResult, String> {
    let key = api_key.trim();
    let base = base_url.trim();

    if base.is_empty() {
        return Ok(TestConnectionResult { ok: false, message: "请先填写 Base URL".into() });
    }
    if key.is_empty() {
        return Ok(TestConnectionResult { ok: false, message: "请先填写 API Key".into() });
    }

    // 规范化：补全协议头
    let normalized = if base.starts_with("http://") || base.starts_with("https://") {
        base.to_string()
    } else {
        format!("https://{}", base)
    };
    let normalized = normalized.trim_end_matches('/').to_string();
    let url = format!("{}/models", normalized);

    eprintln!("[连接测试] 开始请求 {url}");

    let timeout = std::time::Duration::from_millis(
        timeout_ms.unwrap_or(10000).min(60000).max(1000),
    );
    let agent = ureq::AgentBuilder::new()
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build();

    let result = agent
        .get(&url)
        .set("Authorization", &format!("Bearer {}", key))
        .set("Accept", "application/json")
        .call();

    match result {
        Ok(resp) => {
            let status = resp.status();
            if (200..300).contains(&status) {
                eprintln!("[连接测试] 成功 (HTTP {status})");
                Ok(TestConnectionResult { ok: true, message: "连接成功，鉴权通过".into() })
            } else if status == 401 || status == 403 {
                eprintln!("[连接测试] 鉴权失败 (HTTP {status})");
                Ok(TestConnectionResult {
                    ok: false,
                    message: format!("API Key 无效或无访问权限 (HTTP {})", status),
                })
            } else if status == 404 {
                // 部分 OpenAI 兼容服务未实现 /models，但地址本身可达
                eprintln!("[连接测试] 地址可达但 /models 未实现 (HTTP 404)");
                Ok(TestConnectionResult {
                    ok: true,
                    message: "地址可达，但 /models 接口未实现（可直接试用生成）".into(),
                })
            } else if (500..600).contains(&status) {
                eprintln!("[连接测试] 服务端错误 (HTTP {status})");
                Ok(TestConnectionResult { ok: false, message: format!("服务端错误 (HTTP {})", status) })
            } else {
                eprintln!("[连接测试] 被拒绝 (HTTP {status})");
                Ok(TestConnectionResult { ok: false, message: format!("请求被拒绝 (HTTP {})", status) })
            }
        }
        Err(e) => {
            let message = match e {
                ureq::Error::Status(code, _) => {
                    if code == 401 || code == 403 {
                        "API Key 无效或无访问权限".to_string()
                    } else if (400..500).contains(&code) {
                        format!("请求被拒绝 (HTTP {})", code)
                    } else {
                        format!("服务端错误 (HTTP {})", code)
                    }
                }
                ureq::Error::Transport(t) => format!("无法连接到该地址：{}", transport_message(&t)),
            };
            eprintln!("[连接测试] 失败：{message}");
            Ok(TestConnectionResult { ok: false, message })
        }
    }
}
