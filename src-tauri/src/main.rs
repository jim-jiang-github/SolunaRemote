#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::Ipv4Addr,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use url::Url;

#[derive(Clone)]
struct Bridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

impl Bridge {
    fn request(&self, method: String, input: Value) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.inner
            .pending
            .lock()
            .map_err(|_| "后端请求队列不可用。".to_string())?
            .insert(id, sender);

        let request = json!({ "id": id, "method": method, "input": input });
        let write_result = {
            let mut input = self
                .inner
                .input
                .lock()
                .map_err(|_| "后端输入通道不可用。".to_string())?;
            match input.as_mut() {
                Some(input) => writeln!(input, "{request}")
                    .and_then(|_| input.flush())
                    .map_err(|error| format!("无法联系应用后端：{error}")),
                None => Err("应用后端已关闭。".to_string()),
            }
        };
        if let Err(error) = write_result {
            if let Ok(mut pending) = self.inner.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }

        receiver
            .recv()
            .map_err(|_| "应用后端未能返回结果。".to_string())?
    }

    fn stop(&self) {
        if let Ok(mut input) = self.inner.input.lock() {
            input.take();
        }
        let Ok(mut child) = self.inner.child.lock() else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
}

fn resources_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    }
    #[cfg(not(debug_assertions))]
    {
        app.path()
            .resource_dir()
            .map(|path| path.join("resources"))
            .map_err(|error| format!("无法定位应用资源：{error}"))
    }
}

fn user_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let app_data = std::env::var_os("APPDATA")
            .ok_or_else(|| "无法定位 Windows 应用数据目录。".to_string())?;
        Ok(PathBuf::from(app_data).join("SolunaRemote"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "无法定位用户主目录。".to_string())?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("SolunaRemote"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "无法定位用户主目录。".to_string())?;
        Ok(PathBuf::from(home).join(".config").join("SolunaRemote"))
    }
}

fn start_backend(app: &tauri::AppHandle) -> Result<Bridge, String> {
    let resources = resources_dir(app)?;
    let node = resources.join("node.exe");
    let runner = resources.join("app").join("backend-runner.cjs");
    if !node.is_file() || !runner.is_file() {
        return Err("Tauri 后端资源未准备好，请重新运行构建脚本。".to_string());
    }
    let user_data = user_data_dir()?;
    std::fs::create_dir_all(&user_data)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;

    let mut command = Command::new(node);
    command
        .arg(runner)
        .current_dir(&resources)
        .env("SOLUNA_RESOURCES_DIR", &resources)
        .env("SOLUNA_USER_DATA_DIR", user_data)
        .env("SOLUNA_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动应用后端：{error}"))?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接应用后端输入通道。".to_string())?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接应用后端输出通道。".to_string())?;
    let pending = Arc::new(Mutex::new(HashMap::<
        u64,
        mpsc::Sender<Result<Value, String>>,
    >::new()));
    let response_pending = Arc::clone(&pending);
    let app_handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(event) = message.get("event").and_then(Value::as_str) {
                let payload = message.get("value").cloned().unwrap_or(Value::Null);
                let _ = app_handle.emit(event, payload);
                continue;
            }
            let Some(id) = message.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Ok(mut pending) = response_pending.lock() else {
                continue;
            };
            if let Some(sender) = pending.remove(&id) {
                let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(message.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    Err(message
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("操作失败，请重试。")
                        .to_string())
                };
                let _ = sender.send(result);
            }
        }
        if let Ok(mut pending) = response_pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("应用后端已退出。".to_string()));
            }
        }
    });

    Ok(Bridge {
        inner: Arc::new(BridgeInner {
            input: Mutex::new(Some(input)),
            child: Mutex::new(child),
            pending,
            next_id: AtomicU64::new(1),
        }),
    })
}

#[tauri::command]
async fn backend_call(
    state: State<'_, Bridge>,
    method: String,
    input: Value,
) -> Result<Value, String> {
    let allowed = [
        "state",
        "hostPassword",
        "hostStart",
        "hostStop",
        "hostAllowClient",
        "connectPassword",
        "cancelConnect",
        "add",
        "remove",
        "favorite",
        "refresh",
        "discover",
        "saveSettings",
        "validateNativePath",
        "shortcut",
        "removeShortcut",
        "cancel",
        "sunshineUrl",
    ];
    if !allowed.contains(&method.as_str()) {
        return Err("不允许的后端请求。".to_string());
    }
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bridge.request(method, input))
        .await
        .map_err(|error| format!("应用后端任务失败：{error}"))?
}

#[tauri::command]
async fn pick_native() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择 soluna-stream 原生引擎")
            .add_filter("soluna-stream executable", &["exe"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

fn open_external_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "无效的外部链接。".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("仅允许安全的 HTTPS 链接。".to_string());
    }
    let github = parsed.host_str() == Some("github.com")
        && parsed.path() == "/SunshineStream/Sunshine/releases"
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    let local_host = parsed
        .host_str()
        .and_then(|host| host.parse::<Ipv4Addr>().ok())
        .is_some_and(is_allowed_lan_ip)
        && parsed.path() == "/"
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if !github && !local_host {
        return Err("外部链接不在允许范围内。".to_string());
    }
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开外部链接：{error}"))
}

fn is_allowed_lan_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

#[tauri::command]
fn open_link(key: String) -> Result<(), String> {
    if key != "sunshine" {
        return Err("不支持的外部链接。".to_string());
    }
    open_external_url("https://github.com/SunshineStream/Sunshine/releases")
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open_external_url(&url)
}

#[tauri::command]
fn window_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "应用窗口不可用。".to_string())?;
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window
                .is_maximized()
                .map_err(|error| format!("无法读取窗口状态：{error}"))?
            {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => return Err("无效的窗口操作。".to_string()),
    }
    .map_err(|error| format!("窗口操作失败：{error}"))
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            backend_call,
            pick_native,
            open_link,
            open_external,
            window_action
        ])
        .setup(|app| {
            let bridge = start_backend(app.handle()).map_err(std::io::Error::other)?;
            app.manage(bridge);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(bridge) = handle.try_state::<Bridge>() {
                bridge.stop();
            }
        }
    });
}
