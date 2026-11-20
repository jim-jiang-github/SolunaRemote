#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "microsoft-store", not(target_os = "windows")))]
compile_error!("The microsoft-store feature requires Windows.");

mod access;
#[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
mod embedded;
mod host_control;
mod host_runtime;
mod network;
mod process;
mod store;
#[cfg(feature = "microsoft-store")]
mod store_updates;
mod validation;

use ring::rand::SecureRandom;
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::io::Read;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use url::Url;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

struct Backend {
    store: Mutex<store::Store>,
    access: Mutex<access::AccessState>,
    access_server: Mutex<Option<access::AccessServer>>,
    discovery: Mutex<Option<mdns_sd::ServiceDaemon>>,
    host: Arc<Mutex<host_runtime::HostRuntime>>,
    host_operation: Mutex<()>,
    #[cfg(target_os = "macos")]
    watching_accessibility: AtomicBool,
    control: Arc<Mutex<host_control::HostControl>>,
    client: Arc<Mutex<ClientRuntime>>,
    statuses: Mutex<HashMap<String, network::ValueStatus>>,
    resources: PathBuf,
}

#[derive(Default)]
struct BackendStartup {
    result: Mutex<Option<Result<Arc<Backend>, String>>>,
    ready: Condvar,
}

impl BackendStartup {
    fn finish(&self, result: Result<Backend, String>) {
        match self.result.lock() {
            Ok(mut state) => {
                *state = Some(result.map(Arc::new));
                self.ready.notify_all();
            }
            Err(_) => eprintln!("无法保存后端初始化结果。"),
        }
    }

    fn wait(&self) -> Result<Arc<Backend>, String> {
        let state = self
            .result
            .lock()
            .map_err(|_| "后端初始化状态不可用。".to_string())?;
        let state = self
            .ready
            .wait_while(state, |result| result.is_none())
            .map_err(|_| "后端初始化状态不可用。".to_string())?;
        state.as_ref().expect("initialization completed").clone()
    }
}

struct ClientRuntime {
    session: Option<Value>,
    operation_id: Option<String>,
    cancelled: Option<Arc<AtomicBool>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
}

impl ClientRuntime {
    fn new() -> Self {
        Self {
            session: None,
            operation_id: None,
            cancelled: None,
            stdin: None,
        }
    }

    fn clear(&mut self, operation_id: &str) {
        if self.operation_id.as_deref() == Some(operation_id) {
            self.session = None;
            self.operation_id = None;
            self.cancelled = None;
            self.stdin = None;
        }
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

fn bundled_resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

fn backend_snapshot(backend: &Backend) -> Result<Value, String> {
    let data = backend
        .store
        .lock()
        .map_err(|_| "本地设备数据不可用。".to_string())?
        .snapshot()?;
    let statuses = backend
        .statuses
        .lock()
        .map_err(|_| "设备状态不可用。".to_string())?
        .clone();
    let access = backend
        .access
        .lock()
        .map_err(|_| "本机访问配置不可用。".to_string())?;
    let access_server = backend
        .access_server
        .lock()
        .map_err(|_| "访问服务状态不可用。".to_string())?;
    let host = backend
        .host
        .lock()
        .map_err(|_| "Sunshine 主机状态不可用。".to_string())?;
    let (remote_active, remote_status_error) = if host.phase() == "running" {
        match host.remote_active() {
            Ok(active) => (Some(active), None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (Some(false), None)
    };
    let client = backend
        .client
        .lock()
        .map_err(|_| "客户端串流状态不可用。".to_string())?;
    let devices: Vec<Value> = data
        .devices
        .iter()
        .map(|device| {
            json!({
                "id": device.id,
                "name": device.name,
                "address": device.address,
                "app": device.app,
                "favorite": device.favorite,
                "lastPairedAt": device.last_paired_at,
                "shortcuts": device.shortcuts,
                "status": statuses.get(&device.id),
            })
        })
        .collect();
    let native_path = native_executable(&backend.resources)?;
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "windows") { "windows" } else { "other" },
        "microsoftStoreBuild": cfg!(feature = "microsoft-store"),
        "devices": devices,
        "settings": data.settings,
        "engines": {
            "nativeAvailable": native_available(&native_path),
        },
        "host": {
            "firewallManagedByPackage": cfg!(feature = "microsoft-store"),
            "available": host.available(),
            "phase": host.phase(),
            "error": host.error(),
            "remoteActive": remote_active,
            "remoteStatusError": remote_status_error,
            "pending": [],
            "access": {
                "code": access.code,
                "passwordConfigured": access.key.is_some(),
                "passwordMode": if access.is_temporary() { "temporary" } else { "fixed" },
                "passwordViewable": access.password().is_some(),
                "listening": access_server.as_ref().is_some_and(|server| server.is_listening()),
                "error": access.error,
                "rejectedAuth": access_server.as_ref().map_or(access.rejected_auth, |server| server.rejected_auth()),
            },
        },
        "session": client.session.clone(),
        "local": { "hostname": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default() },
    }))
}

#[tauri::command]
async fn check_store_updates(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(feature = "microsoft-store")]
    {
        return store_updates::check_and_request(app).await;
    }
    #[cfg(not(feature = "microsoft-store"))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
async fn backend_call(
    app: tauri::AppHandle,
    startup: State<'_, Arc<BackendStartup>>,
    method: String,
    input: Value,
) -> Result<Value, String> {
    let allowed = [
        "state",
        "hostPassword",
        "hostRevealPassword",
        "recentPassword",
        "hostStart",
        "hostStop",
        "connectPassword",
        "cancelConnect",
        "add",
        "remove",
        "favorite",
        "refresh",
        "discover",
        "saveSettings",
        "shortcut",
        "removeShortcut",
        "cancel",
        "sunshineUrl",
        "openHostSettings",
        "openHostAccessibilitySettings",
        "openLocalNetworkSettings",
        "hostAccessibilityStatus",
        "hostFirewallStatus",
        "openFirewallSettings",
        "revealSolunaApp",
    ];
    if !allowed.contains(&method.as_str()) {
        return Err("不允许的后端请求。".to_string());
    }
    let startup = Arc::clone(startup.inner());
    let state = tauri::async_runtime::spawn_blocking(move || startup.wait())
        .await
        .map_err(|error| format!("等待后端初始化失败：{error}"))??;
    let result = match method.as_str() {
        "state" => backend_snapshot(&state)?,
        "add" => {
            let input: validation::DeviceInput =
                serde_json::from_value(input).map_err(|error| format!("设备格式无效：{error}"))?;
            let device = state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .add(input)?;
            let status = network::probe(&device.address);
            state
                .statuses
                .lock()
                .map_err(|_| "设备状态不可用。".to_string())?
                .insert(device.id.clone(), status);
            json!(device.id)
        }
        "remove" => {
            let id = input
                .as_str()
                .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
            let mut store = state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?;
            let client = state
                .client
                .lock()
                .map_err(|_| "客户端串流状态不可用。".to_string())?;
            if client
                .session
                .as_ref()
                .and_then(|session| session["deviceId"].as_str())
                == Some(id)
            {
                return Err("请先结束该设备的原生串流，再移除设备。".into());
            }
            store.remove(id)?;
            drop(client);
            state
                .statuses
                .lock()
                .map_err(|_| "设备状态不可用。".to_string())?
                .remove(id);
            Value::Null
        }
        "favorite" => {
            let id = input
                .as_str()
                .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
            state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .favorite(id)?;
            Value::Null
        }
        "saveSettings" => {
            let settings: validation::Settings =
                serde_json::from_value(input).map_err(|error| format!("设置格式无效：{error}"))?;
            state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .settings(settings)?;
            Value::Null
        }
        "shortcut" => {
            let device_id = input["deviceId"]
                .as_str()
                .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
            let name = input["name"]
                .as_str()
                .ok_or_else(|| "快捷方式名称无效。".to_string())?;
            let app_name = input["app"]
                .as_str()
                .ok_or_else(|| "Sunshine 应用名称无效。".to_string())?;
            state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .shortcut(device_id, name.to_owned(), app_name.to_owned())?;
            Value::Null
        }
        "removeShortcut" => {
            let device_id = input["deviceId"]
                .as_str()
                .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
            let shortcut_id = input["shortcutId"]
                .as_str()
                .ok_or_else(|| "快捷方式 ID 格式无效。".to_string())?;
            state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .remove_shortcut(device_id, shortcut_id)?;
            Value::Null
        }
        "refresh" => {
            let ids = {
                let store = state
                    .store
                    .lock()
                    .map_err(|_| "本地设备数据不可用。".to_string())?;
                let snapshot = store.snapshot()?;
                if let Some(id) = input.as_str() {
                    vec![store.device(id)?]
                } else {
                    snapshot.devices
                }
            };
            for device in ids {
                let status = network::probe(&device.address);
                state
                    .statuses
                    .lock()
                    .map_err(|_| "设备状态不可用。".to_string())?
                    .insert(device.id, status);
            }
            backend_snapshot(&state)?
        }
        "discover" => serde_json::to_value(network::discover(Duration::from_millis(4500))?)
            .map_err(|error| format!("无法返回发现结果：{error}"))?,
        "sunshineUrl" => {
            let target = if input.is_null() || input.as_str() == Some("") {
                "127.0.0.1:47990".to_owned()
            } else {
                let id = input
                    .as_str()
                    .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
                let store = state
                    .store
                    .lock()
                    .map_err(|_| "本地设备数据不可用。".to_string())?;
                let device = store.device(id)?;
                let parsed = network::resolve_lan(&device.address)?;
                format!("{}:{}", parsed.ip, parsed.port + 1)
            };
            json!(format!("https://{target}/"))
        }
        "openHostSettings" => {
            open_host_settings()?;
            Value::Null
        }
        "openHostAccessibilitySettings" => {
            #[cfg(target_os = "macos")]
            let needs_access = !host_accessibility_status();
            open_host_accessibility_settings()?;
            #[cfg(target_os = "macos")]
            if needs_access {
                watch_accessibility_grant(&app, &state)?;
            }
            Value::Null
        }
        "openLocalNetworkSettings" => {
            open_local_network_settings()?;
            Value::Null
        }
        "hostAccessibilityStatus" => json!(host_accessibility_status()),
        "hostFirewallStatus" => {
            #[cfg(feature = "microsoft-store")]
            return Err("商店版本的防火墙规则由 MSIX 包管理；仅在专用或域网络中提供共享，不请求管理员授权。".into());
            #[cfg(not(feature = "microsoft-store"))]
            {
                json!(check_host_firewall(&state.resources,)?)
            }
        }
        "openFirewallSettings" => {
            open_firewall_settings()?;
            Value::Null
        }
        "revealSolunaApp" => {
            reveal_soluna_app()?;
            Value::Null
        }
        "hostRevealPassword" => {
            let access = state
                .access
                .lock()
                .map_err(|_| "本机访问配置不可用。".to_string())?;
            json!(access
                .password()
                .ok_or_else(|| "旧密码无法找回，请停止协助并重新设置固定密码。".to_string())?)
        }
        "recentPassword" => {
            let id = input["deviceId"]
                .as_str()
                .ok_or_else(|| "设备 ID 格式无效。".to_string())?;
            let code = input["code"]
                .as_str()
                .ok_or_else(|| "设备码格式无效。".to_string())?;
            let password = state
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?
                .remembered_password(id, code)?;
            return Ok(json!(password));
        }
        "hostPassword" => {
            let _operation = state
                .host_operation
                .try_lock()
                .map_err(|_| "本机共享正在处理，请稍后重试。".to_string())?;
            let host = state
                .host
                .lock()
                .map_err(|_| "Sunshine 主机状态不可用。".to_string())?;
            if host.phase() != "stopped" && host.phase() != "error" {
                return Err("请先停止本机共享，再更改访问密码。".into());
            }
            drop(host);
            let mut access = state
                .access
                .lock()
                .map_err(|_| "本机访问配置不可用。".to_string())?;
            let password = input
                .as_str()
                .or_else(|| input["password"].as_str())
                .ok_or_else(|| "访问密码格式无效。".to_string())?;
            access.set_password(password)?;
            Value::Null
        }
        "hostStart" => {
            let _operation = state
                .host_operation
                .try_lock()
                .map_err(|_| "本机共享正在处理，请稍后重试。".to_string())?;
            {
                let host = state
                    .host
                    .lock()
                    .map_err(|_| "Sunshine 主机状态不可用。".to_string())?;
                if !host.available() {
                    return Err("发行包缺少内置 Sunshine。".into());
                }
                if !matches!(host.phase(), "stopped" | "error") {
                    return Err("本机共享已启动或正在处理，请勿重复启动。".into());
                }
            }
            let (code, key) = {
                let access = state
                    .access
                    .lock()
                    .map_err(|_| "本机访问配置不可用。".to_string())?;
                let key = access
                    .key
                    .clone()
                    .ok_or_else(|| "请先设置本机访问密码。".to_string())?;
                (access.code.clone(), key)
            };
            #[cfg(not(feature = "microsoft-store"))]
            ensure_host_firewall(
                || check_host_firewall(&state.resources),
                || authorize_host_firewall(&state.resources),
            )?;
            #[cfg(target_os = "macos")]
            ensure_macos_screen_capture_access()?;
            {
                let mut host = state
                    .host
                    .lock()
                    .map_err(|_| "Sunshine 主机状态不可用。".to_string())?;
                host.start()?;
                if let Err(error) = host.unpair_all() {
                    let _ = host.stop();
                    return Err(error);
                }
            }
            let pair_active = Arc::new(AtomicBool::new(false));
            let pair_host = Arc::clone(&state.host);
            let pair_handler: access::PairHandler = Arc::new(move |request, address| {
                if pair_active
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err("已有连接正在验证，请稍后重试。".into());
                }
                struct PairGuard(Arc<AtomicBool>);
                impl Drop for PairGuard {
                    fn drop(&mut self) {
                        self.0.store(false, Ordering::Release);
                    }
                }
                let _guard = PairGuard(Arc::clone(&pair_active));
                pair_host
                    .lock()
                    .map_err(|_| "Sunshine 主机状态不可用。".to_string())?
                    .approve_access_pair(&request.nonce, &request.pin, address)
            });
            let server = match access::AccessServer::start(&code, &key, pair_handler) {
                Ok(server) => server,
                Err(error) => {
                    if let Ok(mut host) = state.host.lock() {
                        let _ = host.stop();
                    }
                    return Err(error);
                }
            };
            let discovery = match network::publish_access(&code, server.address().port()) {
                Ok(discovery) => discovery,
                Err(error) => {
                    let mut server = server;
                    let _ = server.stop();
                    if let Ok(mut host) = state.host.lock() {
                        let _ = host.stop();
                    }
                    return Err(error);
                }
            };
            *state
                .access_server
                .lock()
                .map_err(|_| "访问服务状态不可用。".to_string())? = Some(server);
            *state
                .discovery
                .lock()
                .map_err(|_| "设备发现状态不可用。".to_string())? = Some(discovery);
            Value::Null
        }
        "hostStop" => {
            let _operation = state
                .host_operation
                .try_lock()
                .map_err(|_| "本机共享正在处理，请稍后重试。".to_string())?;
            let mut stop_error = None;
            if let Some(discovery) = state
                .discovery
                .lock()
                .map_err(|_| "设备发现状态不可用。".to_string())?
                .take()
            {
                if let Err(error) = discovery.shutdown() {
                    stop_error = Some(format!("无法停止设备发现：{error}"));
                }
            }
            if let Some(mut server) = state
                .access_server
                .lock()
                .map_err(|_| "访问服务状态不可用。".to_string())?
                .take()
            {
                if let Err(error) = server.stop() {
                    stop_error.get_or_insert(error);
                }
            }
            if let Err(error) = state
                .host
                .lock()
                .map_err(|_| "Sunshine 主机状态不可用。".to_string())?
                .stop()
            {
                stop_error.get_or_insert(error);
            }
            if let Some(error) = stop_error {
                return Err(error);
            }
            Value::Null
        }
        "connectPassword" => connect_password(&app, &state, input)?,
        "cancelConnect" => {
            cancel_client(&state, None)?;
            Value::Null
        }
        "cancel" => {
            let id = input
                .as_str()
                .ok_or_else(|| "操作 ID 格式无效。".to_string())?;
            cancel_client(&state, Some(id))?;
            Value::Null
        }
        _ => return Err("不允许的后端请求。".into()),
    };
    let snapshot = backend_snapshot(&state)?;
    let _ = app.emit("lan:state", snapshot);
    Ok(result)
}

fn connect_password(
    app: &tauri::AppHandle,
    backend: &Backend,
    input: Value,
) -> Result<Value, String> {
    let code = input["code"]
        .as_str()
        .ok_or_else(|| "设备码格式无效。".to_string())?;
    let code = access::validate_code(code)?;
    let password = input["password"]
        .as_str()
        .ok_or_else(|| "请输入对方设置的访问密码（最多 128 个字符）。".to_string())?
        .to_owned();
    if password.is_empty() || password.chars().count() > 128 {
        return Err("请输入对方设置的访问密码（最多 128 个字符）。".into());
    }

    let operation_id = uuid::Uuid::new_v4().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut client = backend
            .client
            .lock()
            .map_err(|_| "客户端串流状态不可用。".to_string())?;
        if client.operation_id.is_some() {
            return Err("已有配对或串流正在运行，请先结束当前操作。".into());
        }
        client.operation_id = Some(operation_id.clone());
        client.cancelled = Some(Arc::clone(&cancelled));
        client.session = Some(json!({
            "id": operation_id,
            "deviceId": input["deviceId"].as_str().unwrap_or_default(),
            "kind": "stream",
            "app": "Desktop",
            "startedAt": unix_time_seconds(),
            "phase": "preparing",
        }));
    }

    let result = (|| {
        #[cfg(target_os = "macos")]
        let encoded_ip = access::decode_address(&code);
        #[cfg(target_os = "macos")]
        if let Some(ip) = encoded_ip {
            check_local_network_permission(ip)?;
        }
        let target = network::discover_code(&code, Duration::from_secs(8))?;
        #[cfg(target_os = "macos")]
        if encoded_ip.is_none() {
            check_local_network_permission(target.ip)?;
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("连接已取消。".into());
        }
        let device = {
            let mut store = backend
                .store
                .lock()
                .map_err(|_| "本地设备数据不可用。".to_string())?;
            let snapshot = store.snapshot()?;
            let device = if let Some(device) = snapshot
                .devices
                .iter()
                .find(|device| device.address == target.address)
            {
                device.clone()
            } else {
                store.add(validation::DeviceInput {
                    name: format!("设备 {code}"),
                    address: target.address.clone(),
                    app: "Desktop".into(),
                })?
            };
            let mut client = backend
                .client
                .lock()
                .map_err(|_| "客户端串流状态不可用。".to_string())?;
            if client.operation_id.as_deref() == Some(operation_id.as_str()) {
                if let Some(session) = client.session.as_mut() {
                    session["deviceId"] = json!(device.id);
                    session["app"] = json!(device.app);
                }
            }
            device
        };
        let shortcut = if let Some(shortcut_id) = input["shortcutId"].as_str() {
            if input["deviceId"].as_str() != Some(device.id.as_str()) {
                return Err("此快捷启动不属于目标设备。".into());
            }
            Some(
                device
                    .shortcuts
                    .iter()
                    .find(|entry| entry.id == shortcut_id)
                    .ok_or_else(|| "此快捷启动不属于目标设备。".to_string())?
                    .app
                    .clone(),
            )
        } else {
            None
        };
        let app_name = validation::app_name(shortcut.unwrap_or_else(|| device.app.clone()))?;
        if let Ok(mut client) = backend.client.lock() {
            if client.operation_id.as_deref() == Some(operation_id.as_str()) {
                if let Some(session) = client.session.as_mut() {
                    session["app"] = json!(app_name);
                }
            }
        }
        let settings = backend
            .store
            .lock()
            .map_err(|_| "本地设备数据不可用。".to_string())?
            .snapshot()?
            .settings
            .validate()?;
        let executable = native_executable(&backend.resources)?;
        validate_native_path(&executable.to_string_lossy())?;
        let capabilities = process::native_command(&executable)
            .arg("--capabilities")
            .output()
            .map_err(|error| format!("无法检查原生引擎：{error}"))?;
        if !capabilities.status.success() || capabilities.stdout.len() > 16_384 {
            return Err("所选程序不是兼容的 soluna-stream 原生引擎。".into());
        }
        let capabilities: Value = serde_json::from_slice(&capabilities.stdout)
            .map_err(|_| "所选程序不是兼容的 soluna-stream 原生引擎。".to_string())?;
        if capabilities["event"] != "capabilities"
            || capabilities["protocol"] != 1
            || !capabilities["launchParams"].is_string()
        {
            return Err("所选程序不是兼容的 soluna-stream 原生引擎。".into());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("连接已取消。".into());
        }

        let remote_display_count = access::authorize(target.ip, &code, &password, None)?
            .ok_or_else(|| "对方未返回显示器数量。".to_string())?;
        if cancelled.load(Ordering::Acquire) {
            return Err("连接已取消。".into());
        }
        backend
            .store
            .lock()
            .map_err(|_| "本地设备数据不可用。".to_string())?
            .remember_password(&device.id, &code, &password)?;
        let mut random = [0_u8; 2];
        ring::rand::SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "无法生成安全随机 PIN。".to_string())?;
        let pin = (1000 + u16::from_be_bytes(random) % 9000).to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        std::thread::scope(|scope| {
            let control = Arc::clone(&backend.control);
            let pair_target = target.clone();
            let pair_executable = executable.clone();
            let pair_pin = pin.clone();
            let pair_nonce = nonce.clone();
            let pair = scope.spawn(move || {
                control
                    .lock()
                    .map_err(|_| "客户端配对状态不可用。".to_string())?
                    .pair(&pair_target, &pair_executable, &pair_pin, Some(&pair_nonce))
            });
            let access_target = target.ip;
            let access_code = code.clone();
            let access_password = password.clone();
            let access_pin = pin.clone();
            let access_nonce = nonce.clone();
            let authorize = scope.spawn(move || {
                access::authorize(
                    access_target,
                    &access_code,
                    &access_password,
                    Some((&access_pin, &access_nonce)),
                )
                .map(|_| ())
            });
            pair.join()
                .map_err(|_| "客户端 PIN 配对线程异常退出。".to_string())??;
            authorize
                .join()
                .map_err(|_| "设备访问授权线程异常退出。".to_string())??;
            Ok::<(), String>(())
        })?;
        if cancelled.load(Ordering::Acquire) {
            return Err("连接已取消。".into());
        }

        let config = backend
            .control
            .lock()
            .map_err(|_| "客户端配对状态不可用。".to_string())?
            .launch(
                &target,
                &executable,
                &app_name,
                &settings,
                capabilities["launchParams"].as_str().unwrap_or_default(),
            )?;
        let mut config = config;
        config["deviceName"] = json!(device.name);
        config["displayCount"] = json!(remote_display_count);
        let mut child = process::native_command(&executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 soluna-stream：{error}"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法连接原生串流输入。".to_string())?;
        let config_line =
            serde_json::to_vec(&config).map_err(|error| format!("无法序列化串流配置：{error}"))?;
        stdin
            .write_all(&config_line)
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("无法发送串流配置：{error}"))?;
        let writer = Arc::new(Mutex::new(stdin));
        {
            let mut client = backend
                .client
                .lock()
                .map_err(|_| "客户端串流状态不可用。".to_string())?;
            if client.operation_id.as_deref() != Some(operation_id.as_str())
                || cancelled.load(Ordering::Acquire)
            {
                let _ = writer.lock().map(|mut input| input.write_all(b"stop\n"));
                return Err("连接已取消。".into());
            }
            client.session = Some(json!({
                "id": operation_id,
                "deviceId": device.id,
                "kind": "stream",
                "app": app_name,
                "startedAt": unix_time_seconds(),
                "phase": "launching",
            }));
            client.stdin = Some(Arc::clone(&writer));
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取原生串流状态。".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取原生串流错误。".to_string())?;
        let app_handle = app.clone();
        let client_state = Arc::clone(&backend.client);
        let monitor_id = operation_id.clone();
        let monitor_device_id = device.id.clone();
        let monitor_app_name = app_name.clone();
        std::thread::Builder::new()
            .name("soluna-stream-monitor".into())
            .spawn(move || {
                monitor_stream(
                    app_handle,
                    client_state,
                    monitor_id,
                    monitor_device_id,
                    monitor_app_name,
                    child,
                    stdout,
                    stderr,
                    cancelled,
                )
            })
            .map_err(|error| format!("无法监控原生串流：{error}"))?;
        Ok(json!({
            "id": operation_id,
            "deviceId": device.id,
            "kind": "stream",
            "app": app_name,
            "engine": "native",
        }))
    })();

    if result.is_err() {
        if let Ok(mut client) = backend.client.lock() {
            client.clear(&operation_id);
        }
        if let Ok(snapshot) = backend_snapshot(backend) {
            let _ = app.emit("lan:state", snapshot);
        }
    }
    result
}

fn monitor_stream(
    app: tauri::AppHandle,
    client_state: Arc<Mutex<ClientRuntime>>,
    operation_id: String,
    device_id: String,
    app_name: String,
    mut child: Child,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    cancelled: Arc<AtomicBool>,
) {
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0_u8; 1024];
        while let Ok(count) = std::io::Read::read(&mut reader, &mut buffer) {
            if count == 0 {
                break;
            }
            text.push_str(&String::from_utf8_lossy(&buffer[..count]));
            if text.len() > 4000 {
                text.drain(..text.len() - 4000);
            }
        }
        text
    });
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut saw_frame = false;
    let mut protocol_error = None;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) if line.len() > 65_536 => {
                protocol_error = Some("原生引擎输出超过限制，已终止。".to_string());
                let _ = child.kill();
                break;
            }
            Ok(_) => {}
            Err(error) => {
                protocol_error = Some(format!("无法读取原生引擎状态：{error}"));
                let _ = child.kill();
                break;
            }
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            protocol_error = Some("原生引擎协议错误：事件不是有效 JSON。".into());
            let _ = child.kill();
            break;
        };
        let event_name = event["event"].as_str().unwrap_or_default();
        let mut payload = json!({
            "id": operation_id,
            "deviceId": device_id,
            "kind": "stream",
            "app": app_name,
            "engine": "native",
            "progress": true,
        });
        if event_name == "first-frame" {
            saw_frame = true;
            payload["progress"] = Value::Bool(false);
            payload["firstFrame"] = Value::Bool(true);
            payload["width"] = event["width"].clone();
            payload["height"] = event["height"].clone();
        } else if event_name == "connected" || event_name == "stage" {
        } else if event_name == "stats" {
            if let Ok(mut client) = client_state.lock() {
                if client.operation_id.as_deref() == Some(operation_id.as_str()) {
                    if let Some(session) = client.session.as_mut() {
                        session["stats"] = json!({
                            "decoded": event["decoded"],
                            "rendered": event["rendered"],
                            "audioPackets": event["audioPackets"],
                            "keyboardEvents": event["keyboardEvents"],
                        });
                    }
                }
            }
        } else if event_name == "error" {
            payload["warning"] = event["message"].clone();
            protocol_error = event["message"].as_str().map(str::to_owned);
        } else if event_name == "warning" {
            payload["warning"] = event["message"].clone();
        } else {
            continue;
        }
        if matches!(event_name, "first-frame" | "connected" | "stage") {
            if let Ok(mut client) = client_state.lock() {
                if client.operation_id.as_deref() == Some(operation_id.as_str()) {
                    if let Some(session) = client.session.as_mut() {
                        update_stream_phase(session, &event, saw_frame);
                    }
                }
            }
        }
        let _ = app.emit("lan:engine", payload);
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait().ok();
    let stderr = stderr_thread.join().unwrap_or_default();
    let cancelled = cancelled.load(Ordering::Acquire);
    let error = protocol_error.or_else(|| {
        if !cancelled && !saw_frame {
            Some(if stderr.trim().is_empty() {
                "串流已结束，但没有收到渲染首帧。".to_string()
            } else {
                format!("soluna-stream 已退出：{}", stderr.trim())
            })
        } else if !cancelled && !status.is_some_and(|status| status.success()) {
            Some(format!(
                "soluna-stream 已退出：{}",
                stderr.trim().chars().take(1000).collect::<String>()
            ))
        } else {
            None
        }
    });
    if let Ok(mut client) = client_state.lock() {
        client.clear(&operation_id);
    }
    let mut event = json!({
        "id": operation_id,
        "deviceId": device_id,
        "kind": "stream",
        "app": app_name,
        "cancelled": cancelled,
        "success": !cancelled && error.is_none(),
    });
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    let _ = app.emit("lan:engine", event);
}

fn update_stream_phase(session: &mut Value, event: &Value, saw_frame: bool) {
    if saw_frame {
        session["phase"] = json!("streaming");
    } else if event["event"] == "connected" {
        session["phase"] = json!("waiting-frame");
    } else if event["event"] == "stage" {
        session["phase"] = event["name"].clone();
    }
}

fn cancel_client(backend: &Backend, operation_id: Option<&str>) -> Result<(), String> {
    let mut client = backend
        .client
        .lock()
        .map_err(|_| "客户端串流状态不可用。".to_string())?;
    if client.operation_id.is_none() && operation_id.is_none() {
        return Ok(());
    }
    let active_id = client
        .operation_id
        .as_deref()
        .ok_or_else(|| "操作已经结束。".to_string())?;
    if operation_id.is_some_and(|id| id != active_id) {
        return Err("操作已经结束。".into());
    }
    if let Some(cancelled) = &client.cancelled {
        cancelled.store(true, Ordering::Release);
    }
    if let Some(session) = client.session.as_mut() {
        session["phase"] = json!("stopping");
    }
    if let Some(stdin) = &client.stdin {
        stdin
            .lock()
            .map_err(|_| "原生串流输入不可用。".to_string())?
            .write_all(b"stop\n")
            .map_err(|error| format!("无法停止原生串流：{error}"))?;
    }
    Ok(())
}

fn unix_time_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[cfg(any(not(feature = "microsoft-store"), test))]
fn ensure_host_firewall(
    check: impl Fn() -> Result<bool, String>,
    authorize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !check()? {
        authorize()?;
        if !check()? {
            return Err("防火墙规则未生效，未开启远程协助。请检查管理员授权、组织策略或现有阻止规则后重试。".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_macos_screen_capture_access() -> Result<(), String> {
    ensure_screen_capture_access(
        || unsafe { CGPreflightScreenCaptureAccess() },
        || unsafe { CGRequestScreenCaptureAccess() },
    )
}

#[cfg(any(target_os = "macos", test))]
fn ensure_screen_capture_access(
    preflight: impl FnOnce() -> bool,
    request: impl FnOnce() -> bool,
) -> Result<(), String> {
    if preflight() || request() {
        Ok(())
    } else {
        Err("请在系统弹窗中允许 SolunaRemote 录制屏幕；如果没有看到弹窗，请前往“系统设置 > 隐私与安全性 > 屏幕录制”启用 SolunaRemote，然后重新开启共享。".into())
    }
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn check_host_firewall(resources: &Path) -> Result<bool, String> {
    let app = std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    let host = windows_host_executable(resources, &app);
    let command = format!(
        "& {{\n{}\n}} -Executable '{}' -AppExecutable '{}'; exit $LASTEXITCODE",
        include_str!("../../app/host-firewall-check.ps1"),
        host.to_string_lossy().replace('\'', "''"),
        app.to_string_lossy().replace('\'', "''"),
    );
    let output = process::background_command(system_powershell()?)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &base64_utf16(&command),
        ])
        .output()
        .map_err(|error| format!("无法检查防火墙授权：{error}"))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(3) => Ok(false),
        _ => Err(format!(
            "无法检查系统防火墙规则：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

#[cfg(target_os = "macos")]
fn check_host_firewall(_resources: &Path) -> Result<bool, String> {
    let firewall = "/usr/libexec/ApplicationFirewall/socketfilterfw";
    let state = Command::new(firewall)
        .arg("--getglobalstate")
        .output()
        .map_err(|error| format!("无法检查 macOS 防火墙状态：{error}"))?;
    if !state.status.success() {
        return Err(format!(
            "无法检查 macOS 防火墙状态：{}",
            String::from_utf8_lossy(&state.stderr).trim()
        ));
    }
    if !macos_firewall_enabled(&String::from_utf8_lossy(&state.stdout))? {
        return Ok(true);
    }
    let apps = Command::new(firewall)
        .arg("--listapps")
        .output()
        .map_err(|error| format!("无法检查 SolunaRemote 防火墙授权：{error}"))?;
    if !apps.status.success() {
        return Err(format!(
            "无法检查 SolunaRemote 防火墙授权：{}",
            String::from_utf8_lossy(&apps.stderr).trim()
        ));
    }
    let listing = String::from_utf8_lossy(&apps.stdout);
    let app = macos_application_bundle_path()?;
    let app_executable = macos_application_firewall_path()?;
    let host_executable = app.join("Contents").join("MacOS").join("soluna-host");
    Ok(macos_firewall_allows_app(&listing, &app_executable)
        && macos_firewall_allows_app(&listing, &host_executable))
}

#[cfg(target_os = "macos")]
fn macos_application_bundle_path() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    Ok(executable
        .ancestors()
        .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("app"))
        .unwrap_or(&executable)
        .to_path_buf())
}

#[cfg(target_os = "macos")]
fn macos_application_firewall_path() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    Ok(executable)
}

#[cfg(any(target_os = "macos", test))]
fn macos_firewall_enabled(output: &str) -> Result<bool, String> {
    if output.contains("(State = 0)") {
        Ok(false)
    } else if output.contains("(State = 1)") {
        Ok(true)
    } else {
        Err("无法识别 macOS 防火墙状态，请检查系统防火墙设置。".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_firewall_allows_app(listing: &str, app: &Path) -> bool {
    let expected = app.to_string_lossy();
    let lines: Vec<&str> = listing.lines().collect();
    lines.iter().enumerate().any(|(index, line)| {
        line.split_once(':')
            .is_some_and(|(_, path)| path.trim() == expected)
            && lines
                .get(index + 1)
                .is_some_and(|policy| policy.contains("Allow incoming connections"))
    })
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn authorize_host_firewall(resources: &Path) -> Result<(), String> {
    let app_executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    let executable = windows_host_executable(resources, &app_executable);
    if !executable.is_file() {
        return Err("发行包缺少内置 Sunshine。".into());
    }
    let outer = format!(
        "$ErrorActionPreference='Stop'; $process=Start-Process -FilePath '{}' -Verb RunAs -Wait -PassThru -ArgumentList @('--authorize-firewall'); exit $process.ExitCode",
        app_executable.to_string_lossy().replace('\'', "''"),
    );
    let output = process::background_command(system_powershell()?)
        .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
        .output()
        .map_err(|error| format!("无法启动防火墙授权：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            "防火墙授权未完成，未开启远程协助。请在 Windows 管理员权限提示中选择“是”；若仍失败，请检查组织策略或现有规则冲突。".into()
        } else {
            format!("防火墙授权失败：{detail}")
        });
    }
    Ok(())
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn elevated_firewall(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("防火墙授权参数无效。".into());
    }
    let app = std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    #[cfg(debug_assertions)]
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    #[cfg(not(debug_assertions))]
    let resources = app
        .parent()
        .ok_or_else(|| "无法定位应用目录。".to_string())?
        .join("resources");
    let host = windows_host_executable(&resources, &app);
    let script = include_str!("../../app/host-firewall.ps1");
    let command = format!(
        "& {{\n{script}\n}} -Executable '{}' -AppExecutable '{}'; exit $LASTEXITCODE",
        host.to_string_lossy().replace('\'', "''"),
        app.to_string_lossy().replace('\'', "''"),
    );
    let output = process::background_command(system_powershell()?)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &base64_utf16(&command),
        ])
        .output()
        .map_err(|error| format!("无法运行防火墙授权：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "防火墙授权失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn windows_host_executable(resources: &Path, app: &Path) -> PathBuf {
    if cfg!(feature = "embedded-sunshine") {
        app.to_path_buf()
    } else {
        resources.join("host").join("sunshine.exe")
    }
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn system_powershell() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(format!(
            "无法定位 Windows 系统目录：{}",
            std::io::Error::last_os_error()
        ));
    }
    buffer.truncate(length);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer))
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe"))
}

#[cfg(target_os = "macos")]
fn authorize_host_firewall(_resources: &Path) -> Result<(), String> {
    Err(
        "防火墙检查未通过。请在已开启的防火墙中允许 SolunaRemote.app 接受传入连接，再重新检查。"
            .into(),
    )
}

#[cfg(target_os = "macos")]
fn open_firewall_settings() -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall")
        .status()
        .map_err(|error| format!("无法打开防火墙设置：{error}"))?;
    if !status.success() {
        return Err("无法打开防火墙设置，请手动前往“系统设置 > 网络 > 防火墙”。".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_firewall_settings() -> Result<(), String> {
    Err("此操作仅适用于 macOS。".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn check_host_firewall(_resources: &Path) -> Result<bool, String> {
    Err("当前平台暂不支持本机共享防火墙授权。".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn authorize_host_firewall(_resources: &Path) -> Result<(), String> {
    Err("当前平台暂不支持本机共享防火墙授权。".into())
}

#[cfg(target_os = "macos")]
fn open_host_settings() -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .args(["-a", "System Settings"])
        .status()
        .map_err(|error| format!("无法打开系统设置：{error}"))?;
    if !status.success() {
        return Err("无法打开 macOS 系统设置。".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_host_settings() -> Result<(), String> {
    Err("此操作仅适用于 macOS。".into())
}

#[cfg(target_os = "macos")]
fn open_host_accessibility_settings() -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status()
        .map_err(|error| format!("无法打开键鼠控制权限设置：{error}"))?;
    if !status.success() {
        return Err("无法打开键鼠控制权限设置，请手动前往“系统设置 > 隐私与安全性 > 辅助功能”或“设备控制和数据访问”。".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_host_accessibility_settings() -> Result<(), String> {
    Err("此操作仅适用于 macOS。".into())
}

#[cfg(target_os = "macos")]
fn check_local_network_permission(ip: std::net::Ipv4Addr) -> Result<(), String> {
    extern "C" {
        fn soluna_local_network_denied(host: *const std::ffi::c_char) -> bool;
    }
    let host = std::ffi::CString::new(ip.to_string()).expect("IPv4 has no embedded NUL");
    if unsafe { soluna_local_network_denied(host.as_ptr()) } {
        return Err("LOCAL_NETWORK_DENIED".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_local_network_settings() -> Result<(), String> {
    let manual = "请手动前往“系统设置 > 隐私与安全性 > 本地网络”。";
    let status = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
        .status()
        .map_err(|error| format!("无法打开本地网络设置：{error}。{manual}"))?;
    if !status.success() {
        return Err(format!("无法打开本地网络设置。{manual}"));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_local_network_settings() -> Result<(), String> {
    Err("此操作仅适用于 macOS。".into())
}

#[cfg(target_os = "macos")]
fn host_accessibility_status() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn watch_accessibility_grant(app: &tauri::AppHandle, backend: &Arc<Backend>) -> Result<(), String> {
    if backend.watching_accessibility.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let app = app.clone();
    let state = Arc::clone(backend);
    std::thread::Builder::new()
        .name("soluna-accessibility-grant".into())
        .spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(300);
            while std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_secs(1));
                if !host_accessibility_status() {
                    continue;
                }
                let Ok(_operation) = state.host_operation.try_lock() else {
                    continue;
                };
                let Ok(host) = state.host.try_lock() else {
                    continue;
                };
                let Ok(client) = state.client.try_lock() else {
                    continue;
                };
                if !matches!(host.phase(), "starting" | "running" | "stopping")
                    && client.operation_id.is_none()
                {
                    app.request_restart();
                    return;
                }
            }
            state.watching_accessibility.store(false, Ordering::Release);
        })
        .map(|_| ())
        .map_err(|error| {
            backend
                .watching_accessibility
                .store(false, Ordering::Release);
            format!("无法监测辅助功能授权；授权后请手动退出并重新打开 SolunaRemote：{error}")
        })
}

#[cfg(not(target_os = "macos"))]
fn host_accessibility_status() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn reveal_soluna_app() -> Result<(), String> {
    let app = macos_application_bundle_path()?;
    let status = Command::new("/usr/bin/open")
        .arg("-R")
        .arg(app)
        .status()
        .map_err(|error| format!("无法在 Finder 中显示 SolunaRemote：{error}"))?;
    if !status.success() {
        return Err("无法在 Finder 中显示 SolunaRemote。".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn reveal_soluna_app() -> Result<(), String> {
    Err("此操作仅适用于 macOS。".into())
}

#[cfg(target_os = "macos")]
fn prepare_macos_sunshine(resources: &Path, user_data: &Path) -> Result<Option<PathBuf>, String> {
    let host_resources = resources.join("host");
    let archive = host_resources.join("soluna-host.zip");
    if !archive.is_file() {
        return Ok(None);
    }
    let release_path = host_resources.join("release.json");
    let release: Value = serde_json::from_slice(
        &std::fs::read(&release_path)
            .map_err(|error| format!("无法读取 Sunshine 发行信息：{error}"))?,
    )
    .map_err(|error| format!("Sunshine 发行信息无效：{error}"))?;
    let archive_manifest: Value = serde_json::from_slice(
        &std::fs::read(host_resources.join("soluna-host.zip.json"))
            .map_err(|error| format!("无法读取 Sunshine 资源校验信息：{error}"))?,
    )
    .map_err(|error| format!("Sunshine 资源校验信息无效：{error}"))?;
    let version = release["version"]
        .as_str()
        .filter(|value| {
            value.starts_with('v')
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
        .ok_or_else(|| "Sunshine 发行版本格式无效。".to_string())?;
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("此 Mac 的处理器架构不受 Sunshine 支持。".into()),
    };
    if release["architecture"].as_str() != Some(architecture) {
        return Err("内置 Sunshine 与此 Mac 的处理器架构不匹配。".into());
    }
    let archive_sha256 = sha256_file(&archive)?;
    let expected_archive_sha256 = option_env!("SOLUNA_MAC_HOST_ARCHIVE_SHA256")
        .ok_or_else(|| "程序缺少本地 Sunshine 的完整性校验信息。".to_string())?;
    if archive_manifest["version"] != version
        || archive_manifest["architecture"].as_str() != Some(architecture)
        || archive_sha256 != expected_archive_sha256
        || archive_manifest["sha256"].as_str() != Some(archive_sha256.as_str())
        || archive_manifest["cdhash"].as_str() != option_env!("SOLUNA_MAC_HOST_CDHASH")
    {
        return Err("内置共享引擎资源校验失败。".into());
    }
    let app = std::env::current_exe()
        .map_err(|error| format!("无法定位应用程序：{error}"))?
        .ancestors()
        .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("app"))
        .map(Path::to_path_buf);
    let (executable, assets) = if let Some(app) = app {
        let contents = app.join("Contents");
        (
            contents.join("MacOS").join("soluna-host"),
            contents.join("Resources").join("assets"),
        )
    } else {
        let executable = prepare_macos_development_host(&archive, user_data, version)?;
        let contents = executable
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "开发版共享引擎目录无效。".to_string())?
            .to_path_buf();
        (executable, contents.join("Resources").join("assets"))
    };
    if !assets.join("desktop.png").is_file() || !assets.join("box.png").is_file() {
        return Err("SolunaRemote 应用包缺少共享引擎资源。".into());
    }
    verify_macos_sunshine(&executable)?;
    Ok(Some(executable))
}

#[cfg(target_os = "macos")]
fn prepare_macos_development_host(
    archive: &Path,
    user_data: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    let directory = user_data.join("host").join("development").join(version);
    let contents = directory.join("Contents");
    let executable = contents.join("MacOS").join("soluna-host");
    if executable.is_file() {
        return Ok(executable);
    }
    if directory.exists() {
        return Err("已有的开发版共享引擎目录不完整；请先检查该目录。".into());
    }

    let parent = directory
        .parent()
        .ok_or_else(|| "开发版共享引擎目录无效。".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建开发版共享引擎目录：{error}"))?;
    let temporary = parent.join(format!(".soluna-host-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&temporary)
        .map_err(|error| format!("无法创建临时共享引擎目录：{error}"))?;
    let result = (|| {
        let extracted = temporary.join("extracted");
        let output = Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(archive)
            .arg(&extracted)
            .output()
            .map_err(|error| format!("无法解压开发版共享引擎：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "无法解压开发版共享引擎：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let payload = extracted.join("soluna-host");
        let source_executable = payload.join("soluna-host");
        let source_frameworks = payload.join("Frameworks");
        let source_assets = payload.join("assets");
        if !source_assets.join("desktop.png").is_file() || !source_assets.join("box.png").is_file()
        {
            return Err("开发版共享引擎归档缺少必要资源。".into());
        }
        verify_macos_sunshine(&source_executable)?;

        let package = temporary.join("package");
        let package_contents = package.join("Contents");
        let package_executable = package_contents.join("MacOS").join("soluna-host");
        let package_frameworks = package_contents.join("Frameworks");
        let package_assets = package_contents.join("Resources").join("assets");
        std::fs::create_dir_all(
            package_executable
                .parent()
                .ok_or_else(|| "开发版主机目录无效。".to_string())?,
        )
        .map_err(|error| format!("无法创建开发版主机目录：{error}"))?;
        std::fs::create_dir_all(&package_frameworks)
            .map_err(|error| format!("无法创建开发版依赖目录：{error}"))?;
        std::fs::create_dir_all(&package_assets)
            .map_err(|error| format!("无法创建开发版资源目录：{error}"))?;
        for (source, destination) in [
            (&source_executable, &package_executable),
            (&source_frameworks, &package_frameworks),
            (&source_assets, &package_assets),
        ] {
            let copied = Command::new("/usr/bin/ditto")
                .arg(source)
                .arg(destination)
                .output()
                .map_err(|error| format!("无法复制开发版共享引擎资源：{error}"))?;
            if !copied.status.success() {
                return Err(format!(
                    "无法复制开发版共享引擎资源：{}",
                    String::from_utf8_lossy(&copied.stderr).trim()
                ));
            }
        }
        verify_macos_sunshine(&package_executable)?;
        std::fs::rename(&package, &directory)
            .map_err(|error| format!("无法安装开发版共享引擎：{error}"))?;
        Ok(executable.clone())
    })();
    let cleanup = std::fs::remove_dir_all(&temporary)
        .map_err(|error| format!("无法清理临时共享引擎目录：{error}"));
    let executable = result?;
    cleanup?;
    Ok(executable)
}

#[cfg(target_os = "macos")]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法读取 Sunshine 资源：{error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let length = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取 Sunshine 资源：{error}"))?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(target_os = "macos")]
fn verify_macos_sunshine(executable: &Path) -> Result<(), String> {
    if !executable.is_file() {
        return Err("SolunaRemote 应用包缺少共享引擎。".into());
    }
    let verification = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(executable)
        .output()
        .map_err(|error| format!("无法验证共享引擎签名：{error}"))?;
    if !verification.status.success() {
        return Err(format!(
            "共享引擎签名无效：{}",
            String::from_utf8_lossy(&verification.stderr).trim()
        ));
    }
    let identity = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(executable)
        .output()
        .map_err(|error| format!("无法读取共享引擎签名：{error}"))?;
    let details = format!(
        "{}{}",
        String::from_utf8_lossy(&identity.stdout),
        String::from_utf8_lossy(&identity.stderr)
    );
    let expected = option_env!("SOLUNA_MAC_HOST_CDHASH")
        .ok_or_else(|| "程序缺少本地 Sunshine 的签名校验信息。".to_string())?;
    if !identity.status.success()
        || !details
            .lines()
            .any(|line| line == "Identifier=local.solunaremote.desktop")
        || !details
            .lines()
            .any(|line| line.strip_prefix("CDHash=") == Some(expected))
    {
        return Err("SolunaRemote 应用包中的共享引擎与本地构建的签名不匹配。".into());
    }
    Ok(())
}

#[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
fn base64_utf16(value: &str) -> String {
    let bytes: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn native_executable(resources: &Path) -> Result<PathBuf, String> {
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    {
        let _ = resources;
        std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))
    }

    #[cfg(not(all(target_os = "windows", feature = "embedded-sunshine")))]
    {
        let name = if cfg!(target_os = "windows") {
            "soluna-stream.exe"
        } else {
            "soluna-stream"
        };
        Ok(resources.join("native").join(name))
    }
}

fn native_available(executable: &Path) -> bool {
    if !executable.is_file() {
        return false;
    }
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    return embedded::component_exists(executable, embedded::STREAM_DLL);
    #[cfg(not(all(target_os = "windows", feature = "embedded-sunshine")))]
    true
}

fn validate_native_path(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("随包 soluna-stream 原生引擎路径无效。".into());
    }
    if cfg!(target_os = "windows") && path.extension().and_then(|ext| ext.to_str()) != Some("exe") {
        return Err("随包 soluna-stream 原生引擎格式无效。".into());
    }
    if !path.is_file() {
        return Err(format!(
            "随包 soluna-stream 引擎不可用：文件不存在（{}）。",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
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
        "close" => window.destroy(),
        _ => return Err("无效的窗口操作。".to_string()),
    }
    .map_err(|error| format!("窗口操作失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the prepared local macOS Sunshine resources"]
    fn macos_local_host_stages_one_helper_and_rejects_replaced_archives() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let root = std::env::temp_dir().join(format!("soluna-host-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let helper = prepare_macos_sunshine(&resources, &root).unwrap().unwrap();
        assert!(helper.is_file());
        assert!(!helper
            .ancestors()
            .any(|path| path.extension().and_then(|extension| extension.to_str()) == Some("app")));
        let copy = root.join("resources").join("host");
        std::fs::create_dir_all(&copy).unwrap();
        for name in ["soluna-host.zip", "soluna-host.zip.json", "release.json"] {
            std::fs::copy(resources.join("host").join(name), copy.join(name)).unwrap();
        }
        let archive = copy.join("soluna-host.zip");
        let mut bytes = std::fs::read(&archive).unwrap();
        bytes.push(0);
        std::fs::write(archive, bytes).unwrap();
        assert!(prepare_macos_sunshine(&root.join("resources"), &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backend_startup_wakes_waiters_and_reports_initialization_failure() {
        let startup = Arc::new(BackendStartup::default());
        let waiter = Arc::clone(&startup);
        let thread = std::thread::spawn(move || waiter.wait().err());
        startup.finish(Err("初始化失败".into()));
        assert_eq!(thread.join().unwrap().as_deref(), Some("初始化失败"));
        assert_eq!(startup.wait().err().as_deref(), Some("初始化失败"));
    }

    #[test]
    fn late_connection_events_do_not_revert_streaming_phase() {
        let mut session = json!({"phase": "starting"});
        update_stream_phase(
            &mut session,
            &json!({"event": "stage", "name": "RTSP"}),
            false,
        );
        assert_eq!(session["phase"], "RTSP");
        update_stream_phase(&mut session, &json!({"event": "connected"}), false);
        assert_eq!(session["phase"], "waiting-frame");
        update_stream_phase(&mut session, &json!({"event": "first-frame"}), true);
        assert_eq!(session["phase"], "streaming");
        update_stream_phase(&mut session, &json!({"event": "connected"}), true);
        update_stream_phase(
            &mut session,
            &json!({"event": "stage", "name": "late"}),
            true,
        );
        assert_eq!(session["phase"], "streaming");
    }

    #[test]
    fn firewall_is_rechecked_after_authorization_and_failures_stop_startup() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        assert!(ensure_host_firewall(
            || {
                calls.set(calls.get() + 1);
                Ok(calls.get() > 1)
            },
            || Ok(())
        )
        .is_ok());
        assert_eq!(calls.get(), 2);
        assert!(ensure_host_firewall(|| Ok(false), || Err("cancelled".into())).is_err());
        assert!(ensure_host_firewall(|| Ok(false), || Ok(())).is_err());
        assert!(ensure_host_firewall(
            || Err("check failed".into()),
            || panic!("must not authorize")
        )
        .is_err());
    }

    #[test]
    fn existing_firewall_authorization_does_not_prompt_again() {
        assert!(ensure_host_firewall(
            || Ok(true),
            || panic!("existing firewall authorization must not request elevation")
        )
        .is_ok());
    }

    #[test]
    fn macos_disabled_firewall_does_not_require_authorization() {
        let enabled = macos_firewall_enabled("Firewall is disabled. (State = 0)\n").unwrap();
        assert!(!enabled);
        assert!(ensure_host_firewall(
            || Ok(!enabled),
            || panic!("disabled firewall must not request authorization")
        )
        .is_ok());
        assert!(macos_firewall_enabled("Firewall is enabled. (State = 1)\n").unwrap());
        assert!(macos_firewall_enabled("").is_err());
        assert!(macos_firewall_enabled("unexpected state").is_err());
    }

    #[test]
    fn screen_capture_permission_is_requested_before_host_startup() {
        use std::cell::Cell;

        let requested = Cell::new(false);
        assert!(ensure_screen_capture_access(
            || false,
            || {
                requested.set(true);
                true
            }
        )
        .is_ok());
        assert!(requested.get());

        assert!(ensure_screen_capture_access(
            || true,
            || { panic!("must not request access when already authorized") }
        )
        .is_ok());

        let error = ensure_screen_capture_access(|| false, || false).unwrap_err();
        assert!(error.contains("屏幕录制"));
        assert!(error.contains("隐私与安全性"));
    }

    #[test]
    fn macos_firewall_requires_an_exact_allowed_app_path() {
        let app = Path::new("/Applications/SolunaRemote.app/Contents/MacOS/soluna-host");
        let allowed = format!(
            "Total number of apps = 1\n1 : {}\n             (Allow incoming connections)\n",
            app.display()
        );
        let blocked = format!(
            "Total number of apps = 1\n1 : {}\n             (Block all incoming connections)\n",
            app.display()
        );
        let wrong_app = "Total number of apps = 1\n1 : /Applications/Other.app\n             (Allow incoming connections)\n";
        assert!(macos_firewall_allows_app(&allowed, app));
        assert!(!macos_firewall_allows_app(&blocked, app));
        assert!(!macos_firewall_allows_app(wrong_app, app));
    }

    #[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
    #[test]
    fn elevated_firewall_rejects_invalid_arguments_before_running_commands() {
        assert!(elevated_firewall(&["127.0.0.1".into()]).is_err());
        assert!(elevated_firewall(&["8.8.8.8".into()]).is_err());
        assert!(elevated_firewall(&["10.0.0.1".into(), "extra".into()]).is_err());
    }
}

fn initialize_backend(app: &tauri::AppHandle) -> Result<Backend, String> {
    let user_data = user_data_dir()?;
    std::fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;
    let store = store::Store::open(&user_data)?;
    let access = access::AccessState::open(&user_data.join("access"))?;
    let resources = bundled_resources(app)?;
    #[cfg(target_os = "macos")]
    let sunshine_host = prepare_macos_sunshine(&resources, &user_data)?;
    #[cfg(not(all(target_os = "windows", feature = "embedded-sunshine")))]
    let host_name = if cfg!(target_os = "windows") {
        "sunshine.exe"
    } else {
        "sunshine"
    };
    #[cfg(all(
        not(all(target_os = "windows", feature = "embedded-sunshine")),
        target_os = "macos"
    ))]
    let host_executable = sunshine_host
        .as_ref()
        .cloned()
        .unwrap_or_else(|| resources.join("host").join(host_name));
    #[cfg(all(
        not(all(target_os = "windows", feature = "embedded-sunshine")),
        not(target_os = "macos")
    ))]
    let host_executable = resources.join("host").join(host_name);
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    let host = host_runtime::HostRuntime::new_embedded(
        user_data.join("host"),
        std::env::current_exe().map_err(|error| error.to_string())?,
        resources.join("host"),
    );
    #[cfg(not(all(target_os = "windows", feature = "embedded-sunshine")))]
    let host = host_runtime::HostRuntime::new(user_data.join("host"), host_executable);
    Ok(Backend {
        store: Mutex::new(store),
        access: Mutex::new(access),
        access_server: Mutex::new(None),
        discovery: Mutex::new(None),
        host: Arc::new(Mutex::new(host)),
        host_operation: Mutex::new(()),
        #[cfg(target_os = "macos")]
        watching_accessibility: AtomicBool::new(false),
        control: Arc::new(Mutex::new(host_control::HostControl::new(
            user_data.join("identity"),
        ))),
        client: Arc::new(Mutex::new(ClientRuntime::new())),
        statuses: Mutex::new(HashMap::new()),
        resources,
    })
}

fn main() {
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--soluna-stream")) {
        use std::os::windows::ffi::OsStrExt;
        let mut args = std::env::args_os()
            .enumerate()
            .filter(|(index, _)| *index != 1)
            .map(|(_, arg)| {
                arg.encode_wide()
                    .chain(std::iter::once(0))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let mut pointers = args
            .iter_mut()
            .map(|arg| arg.as_mut_ptr())
            .collect::<Vec<_>>();
        let argc = i32::try_from(pointers.len()).expect("too many stream arguments");
        pointers.push(std::ptr::null_mut());
        let result = embedded::run_stream(argc, pointers.as_mut_ptr()).unwrap_or_else(|error| {
            println!("{}", json!({"event": "error", "message": error}));
            1
        });
        std::process::exit(result);
    }
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--sunshine-host")) {
        let args = std::env::args_os()
            .enumerate()
            .filter(|(index, _)| *index != 1)
            .map(|(_, arg)| {
                std::ffi::CString::new(
                    arg.into_string()
                        .expect("Sunshine arguments must be valid Unicode"),
                )
                .expect("Sunshine arguments must not contain NUL")
            })
            .collect::<Vec<_>>();
        let mut pointers = args
            .iter()
            .map(|arg| arg.as_ptr().cast_mut())
            .collect::<Vec<_>>();
        let argc = i32::try_from(pointers.len()).expect("too many Sunshine arguments");
        pointers.push(std::ptr::null_mut());
        let result = embedded::run_host(argc, pointers.as_mut_ptr()).unwrap_or_else(|error| {
            eprintln!("{error}");
            1
        });
        std::process::exit(result);
    }
    #[cfg(all(target_os = "windows", not(feature = "microsoft-store")))]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args
            .first()
            .is_some_and(|arg| arg == "--authorize-firewall")
        {
            if let Err(error) = elevated_firewall(&args[1..]) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
    }
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            backend_call,
            check_store_updates,
            open_link,
            open_external,
            window_action
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.emit("lan:window-close-requested", ()) {
                        eprintln!("无法发送窗口关闭请求：{error}");
                    }
                }
            }
        })
        .setup(|app| {
            let startup = Arc::new(BackendStartup::default());
            app.manage(Arc::clone(&startup));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    tauri::async_runtime::spawn_blocking(move || initialize_backend(&handle))
                        .await
                        .map_err(|error| format!("后端初始化失败：{error}"))
                        .and_then(|result| result);
                startup.finish(result);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(startup) = app.try_state::<Arc<BackendStartup>>() {
                let backend = startup.result.lock().ok().and_then(|result| {
                    result
                        .as_ref()
                        .and_then(|result| result.as_ref().ok())
                        .cloned()
                });
                let Some(backend) = backend else { return };
                if let Err(error) = cancel_client(&backend, None) {
                    eprintln!("无法停止客户端串流：{error}");
                }
                match backend.host.lock() {
                    Ok(mut host) => {
                        if let Err(error) = host.stop() {
                            eprintln!("无法停止 Sunshine：{error}");
                        }
                    }
                    Err(_) => eprintln!("无法停止 Sunshine：主机状态不可用。"),
                };
            }
        }
    });
}
