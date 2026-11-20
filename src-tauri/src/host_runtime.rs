use crate::process::background_command;
use openssl::{
    ssl::{SslConnector, SslMethod, SslVerifyMode},
    x509::X509,
};
use ring::rand::SecureRandom;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

const MANAGEMENT_PORT: u16 = 47990;
const RESERVED_PORTS: [u16; 4] = [47984, 47989, 47990, 48010];
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

pub struct HostRuntime {
    directory: PathBuf,
    executable: PathBuf,
    child: Option<Child>,
    phase: String,
    error: Option<String>,
    certificate: Option<X509>,
    authorization: Option<String>,
}

impl HostRuntime {
    pub fn new(directory: PathBuf, executable: PathBuf) -> Self {
        Self {
            directory,
            executable,
            child: None,
            phase: "stopped".into(),
            error: None,
            certificate: None,
            authorization: None,
        }
    }

    pub fn phase(&self) -> &str {
        &self.phase
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn available(&self) -> bool {
        self.executable.is_file()
    }

    pub fn start(&mut self) -> Result<(), String> {
        if !matches!(self.phase.as_str(), "stopped" | "error") {
            return Err("本机共享已启动或正在处理，请勿重复启动。".into());
        }
        if self.child.is_some() {
            return Err("上一个共享进程尚未退出。".into());
        }
        if !self.available() {
            return Err("发行包缺少内置 Sunshine。".into());
        }

        self.phase = "starting".into();
        self.error = None;
        self.certificate = None;
        self.authorization = None;
        let result = self.start_inner();
        if let Err(error) = &result {
            self.error = Some(error.clone());
            self.phase = "error".into();
            let _ = self.stop_child();
        }
        result
    }

    fn start_inner(&mut self) -> Result<(), String> {
        ensure_ports_free()?;
        fs::create_dir_all(self.directory.join("credentials"))
            .map_err(|error| format!("无法创建 Sunshine 配置目录：{error}"))?;

        let config_path = self.directory.join("sunshine.conf");
        let config = format!(
            "sunshine_name = SolunaRemote\n\
             upnp = disabled\n\
             system_tray = disabled\n\
             origin_web_ui_allowed = pc\n\
             address_family = ipv4\n\
             min_log_level = 2\n\
             file_apps = {}\n\
             file_state = {}\n\
             credentials_file = {}\n\
             log_path = {}\n\
             pkey = {}\n\
             cert = {}\n",
            self.directory.join("apps.json").display(),
            self.directory.join("state.json").display(),
            self.directory.join("web.json").display(),
            self.directory.join("sunshine.log").display(),
            self.directory
                .join("credentials")
                .join("cakey.pem")
                .display(),
            self.directory
                .join("credentials")
                .join("cacert.pem")
                .display(),
        );
        write_private(&config_path, config.as_bytes())?;
        let apps_path = self.directory.join("apps.json");
        if !apps_path.exists() {
            write_private(
                &apps_path,
                br#"{"env":{},"apps":[{"name":"Desktop","image-path":"desktop.png"}]}"#,
            )?;
        }

        let log_path = self.directory.join("sunshine-process.log");
        let stdout = open_append(&log_path)?;
        let stderr = stdout
            .try_clone()
            .map_err(|error| format!("无法准备 Sunshine 日志：{error}"))?;
        let mut command = background_command(&self.executable);
        command
            .arg(&config_path)
            .current_dir(
                self.executable
                    .parent()
                    .ok_or_else(|| "Sunshine 程序路径无效。".to_string())?,
            )
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        self.child = Some(
            command
                .spawn()
                .map_err(|error| format!("无法启动内置 Sunshine：{error}"))?,
        );

        let certificate_path = self.directory.join("credentials").join("cacert.pem");
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut last_error = "管理端口尚未就绪。".to_string();
        loop {
            if self.child.as_mut().is_none_or(|child| {
                child
                    .try_wait()
                    .map(|status| status.is_some())
                    .unwrap_or(true)
            }) {
                return Err(
                    "内置 Sunshine 在初始化完成前意外退出；请检查 sunshine-process.log。".into(),
                );
            }
            if certificate_path.is_file() {
                match fs::read(&certificate_path)
                    .map_err(|error| format!("无法读取 Sunshine 管理证书：{error}"))
                    .and_then(|bytes| X509::from_pem(&bytes).map_err(|error| error.to_string()))
                    .and_then(|certificate| {
                        self.certificate = Some(certificate);
                        self.request(MANAGEMENT_PORT, "GET", "/welcome", None, false)
                            .map(|_| ())
                    }) {
                    Ok(()) => break,
                    Err(error) => last_error = error,
                }
            }
            if Instant::now() >= deadline {
                return Err(format!("内置 Sunshine 启动超时：{last_error}"));
            }
            thread::sleep(Duration::from_millis(300));
        }

        self.initialize_management_credentials()?;
        self.phase = "running".into();
        Ok(())
    }

    fn initialize_management_credentials(&mut self) -> Result<(), String> {
        let path = self.directory.join("manager.json");
        let credentials: Value = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Sunshine 管理凭据文件无效：{error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut random = [0_u8; 32];
                ring::rand::SystemRandom::new()
                    .fill(&mut random)
                    .map_err(|_| "无法生成 Sunshine 管理凭据。".to_string())?;
                let credentials = json!({
                    "username": "solunaremote",
                    "password": random.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                });
                write_private(
                    &path,
                    &serde_json::to_vec(&credentials)
                        .map_err(|error| format!("无法保存 Sunshine 管理凭据：{error}"))?,
                )?;
                credentials
            }
            Err(error) => return Err(format!("无法读取 Sunshine 管理凭据：{error}")),
        };
        let username = credentials["username"]
            .as_str()
            .ok_or_else(|| "Sunshine 管理用户名无效。".to_string())?;
        let password = credentials["password"]
            .as_str()
            .ok_or_else(|| "Sunshine 管理密码无效。".to_string())?;
        if username.is_empty()
            || password.is_empty()
            || username.contains(['\r', '\n', ':'])
            || password.contains(['\r', '\n'])
        {
            return Err("Sunshine 管理凭据格式无效。".into());
        }
        use base64::Engine;
        self.authorization = Some(format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        ));
        match self.api("/api/pin", None) {
            Ok(_) => Ok(()),
            Err(error) if error.contains("HTTP 30") || error.contains("HTTP 401") => {
                let setup = json!({
                    "currentUsername": username,
                    "currentPassword": password,
                    "newUsername": username,
                    "newPassword": password,
                    "confirmNewPassword": password,
                });
                let response = self.api("/api/password", Some(&setup))?;
                if response["status"] == true {
                    Ok(())
                } else {
                    Err("Sunshine 管理身份初始化失败。".into())
                }
            }
            Err(error) => Err(error),
        }
    }

    pub fn pending(&mut self) -> Result<Vec<Value>, String> {
        if self.phase != "running" {
            return Err("请先开启本机共享。".into());
        }
        let response = self.api("/api/pin", None)?;
        let pairings = response["pairings"]
            .as_array()
            .ok_or_else(|| "Sunshine 返回无效配对列表。".to_string())?;
        pairings
            .iter()
            .map(|item| {
                let id = item["id"]
                    .as_str()
                    .filter(|value| {
                        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    .ok_or_else(|| "Sunshine 返回无效配对标识。".to_string())?;
                let name = item["name"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(128)
                    .collect::<String>();
                let address = item["address"]
                    .as_str()
                    .unwrap_or_default()
                    .trim_start_matches("::ffff:")
                    .parse::<Ipv4Addr>()
                    .map_err(|_| "Sunshine 返回非内网配对请求。".to_string())?;
                if !crate::validation::is_private_ipv4(address) {
                    return Err("Sunshine 返回非内网配对请求。".into());
                }
                Ok(json!({"id": id, "name": name, "address": address.to_string()}))
            })
            .collect()
    }

    pub fn approve(&mut self, pairing_id: &str, pin: &str) -> Result<(), String> {
        if self.phase != "running" {
            return Err("请先开启本机共享。".into());
        }
        if pin.len() != 4 || !pin.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("PIN 必须是四位数字。".into());
        }
        let pending = self.pending()?;
        if !pending.iter().any(|entry| entry["id"] == pairing_id) {
            return Err("请选择仍在等待的配对请求。".into());
        }
        self.api(
            "/api/pin",
            Some(&json!({"pairing_id": pairing_id, "pin": pin, "name": "SolunaRemote"})),
        )?;
        Ok(())
    }

    pub fn approve_access_pair(
        &mut self,
        nonce: &str,
        pin: &str,
        address: Ipv4Addr,
    ) -> Result<(), String> {
        if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("内部连接标识无效。".into());
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if self.phase != "running" {
                return Err("本机共享已停止。".into());
            }
            let matches: Vec<String> = self
                .pending()?
                .into_iter()
                .filter(|item| {
                    item["name"] == format!("SolunaRemote-{nonce}")
                        && item["address"] == address.to_string()
                })
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                .collect();
            if matches.len() == 1 {
                return self.approve(&matches[0], pin);
            }
            if matches.len() > 1 {
                return Err("发现多个匹配的内部配对请求。".into());
            }
            thread::sleep(Duration::from_millis(200));
        }
        Err("内部连接授权超时。".into())
    }

    pub fn unpair_all(&self) -> Result<(), String> {
        if self.phase != "running" {
            return Err("请先开启本机共享。".into());
        }
        self.api("/api/clients/unpair-all", Some(&json!({})))?;
        Ok(())
    }

    pub fn remote_active(&self) -> Result<bool, String> {
        if self.phase != "running" {
            return Ok(false);
        }
        let (status, response) = self.request(MANAGEMENT_PORT, "GET", "/serverinfo", None, true)?;
        if status != 200 {
            return Err(format!("无法读取 Sunshine 远程连接状态：HTTP {status}"));
        }
        serverinfo_has_active_session(&response)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.phase = "stopping".into();
        let result = self.stop_child();
        self.authorization = None;
        self.certificate = None;
        self.phase = if result.is_ok() {
            "stopped".into()
        } else {
            "error".into()
        };
        if let Err(error) = &result {
            self.error = Some(error.clone());
        } else {
            self.error = None;
        }
        result
    }

    fn stop_child(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        if child
            .try_wait()
            .map_err(|error| format!("无法检查 Sunshine 进程状态：{error}"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("无法停止内置 Sunshine：{error}"))?;
        }
        child
            .wait()
            .map_err(|error| format!("无法等待 Sunshine 退出：{error}"))?;
        Ok(())
    }

    fn api(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        if self.authorization.is_none() {
            return Err("Sunshine 管理凭据尚未初始化。".into());
        }
        let method = Self::management_method(body);
        let (status, response) = self.request(MANAGEMENT_PORT, method, path, body, true)?;
        if status != 200 {
            let detail = String::from_utf8_lossy(&response)
                .chars()
                .take(200)
                .collect::<String>();
            return Err(format!(
                "Sunshine 管理请求 {path} 失败：HTTP {status}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("：{detail}")
                }
            ));
        }
        let response: Value = serde_json::from_slice(&response)
            .map_err(|_| "Sunshine 返回无效管理响应。".to_string())?;
        if response["status"] == false {
            return Err("Sunshine 拒绝管理操作。".into());
        }
        Ok(response)
    }

    fn management_method(body: Option<&Value>) -> &'static str {
        if body.is_some() {
            "POST"
        } else {
            "GET"
        }
    }

    fn request(
        &self,
        port: u16,
        method: &str,
        path: &str,
        body: Option<&Value>,
        authenticated: bool,
    ) -> Result<(u16, Vec<u8>), String> {
        if port != MANAGEMENT_PORT
            || !path.starts_with('/')
            || path.contains(['\r', '\n', '#'])
            || !matches!(method, "GET" | "POST")
        {
            return Err("Sunshine 管理请求格式无效。".into());
        }
        let address = ("127.0.0.1", port)
            .to_socket_addrs()
            .map_err(|error| format!("无法解析 Sunshine 管理地址：{error}"))?
            .next()
            .ok_or_else(|| "Sunshine 管理地址无效。".to_string())?;
        let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|error| format!("Sunshine 管理连接失败：{error}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(8)))
            .and_then(|_| tcp.set_write_timeout(Some(Duration::from_secs(8))))
            .map_err(|error| format!("无法设置 Sunshine 管理超时：{error}"))?;
        let certificate = self
            .certificate
            .as_ref()
            .ok_or_else(|| "Sunshine 管理证书尚未加载。".to_string())?;
        let mut connector = SslConnector::builder(SslMethod::tls_client())
            .map_err(|error| format!("无法创建 Sunshine 管理 TLS：{error}"))?;
        connector.set_verify(SslVerifyMode::NONE);
        let mut stream = connector
            .build()
            .connect("localhost", tcp)
            .map_err(|error| format!("Sunshine 管理 TLS 失败：{error}"))?;
        let peer = stream
            .ssl()
            .peer_certificate()
            .ok_or_else(|| "Sunshine 管理端未提供证书。".to_string())?;
        if peer
            .to_der()
            .map_err(|error| format!("无法读取 Sunshine 管理证书：{error}"))?
            != certificate
                .to_der()
                .map_err(|error| format!("无法读取已固定管理证书：{error}"))?
        {
            return Err("内置主机的管理证书发生变化。".into());
        }
        let data = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| format!("Sunshine 管理请求无效：{error}"))?
            .unwrap_or_default();
        if data.len() > 1_048_576 {
            return Err("Sunshine 管理请求超过大小限制。".into());
        }
        let authorization = if authenticated {
            format!(
                "Authorization: {}\r\n",
                self.authorization
                    .as_deref()
                    .ok_or_else(|| "Sunshine 管理凭据尚未初始化。".to_string())?
            )
        } else {
            String::new()
        };
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{authorization}Content-Length: {}\r\n{}\r\n",
            data.len(),
            if method == "POST" {
                "Content-Type: application/json\r\n".into()
            } else {
                String::new()
            }
        )
        .and_then(|_| stream.write_all(&data))
        .map_err(|error| format!("发送 Sunshine 管理请求失败：{error}"))?;
        let mut response = Vec::new();
        stream
            .take(1_048_577)
            .read_to_end(&mut response)
            .map_err(|error| format!("读取 Sunshine 管理响应失败：{error}"))?;
        if response.len() > 1_048_576 {
            return Err("Sunshine 管理响应超过大小限制。".into());
        }
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| "Sunshine 返回无效 HTTP 响应。".to_string())?;
        let headers = std::str::from_utf8(&response[..split])
            .map_err(|_| "Sunshine 返回无效 HTTP 响应头。".to_string())?;
        let status = headers
            .lines()
            .next()
            .and_then(|line| line.split_ascii_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| "Sunshine 返回无效 HTTP 状态码。".to_string())?;
        let body = &response[split + 4..];
        let body = if headers.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("transfer-encoding")
                    && value.trim().eq_ignore_ascii_case("chunked")
            })
        }) {
            decode_chunked(body)?
        } else {
            body.to_vec()
        };
        Ok((status, body))
    }
}

fn serverinfo_has_active_session(response: &[u8]) -> Result<bool, String> {
    let xml =
        std::str::from_utf8(response).map_err(|_| "Sunshine 返回无效远程连接状态。".to_string())?;
    let current_game = xml
        .split_once("<currentgame>")
        .and_then(|(_, value)| value.split_once("</currentgame>").map(|(value, _)| value))
        .ok_or_else(|| "Sunshine 返回无效远程连接状态。".to_string())?
        .trim()
        .parse::<u32>()
        .map_err(|_| "Sunshine 返回无效远程连接状态。".to_string())?;
    Ok(current_game > 0)
}

fn decode_chunked(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| "Sunshine 返回无效分块响应。".to_string())?;
        let length = std::str::from_utf8(&bytes[cursor..line_end])
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|line| usize::from_str_radix(line.trim(), 16).ok())
            .ok_or_else(|| "Sunshine 返回无效分块长度。".to_string())?;
        cursor = line_end + 2;
        if length == 0 {
            if bytes.get(cursor..cursor + 2) != Some(b"\r\n") {
                return Err("Sunshine 返回无效分块结束标记。".into());
            }
            return Ok(output);
        }
        let end = cursor
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "Sunshine 分块响应被截断。".to_string())?;
        output.extend_from_slice(&bytes[cursor..end]);
        if output.len() > 1_048_576 || bytes.get(end..end + 2) != Some(b"\r\n") {
            return Err("Sunshine 分块响应无效或超过大小限制。".into());
        }
        cursor = end + 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_requests_use_get_for_reads_and_post_for_mutations() {
        assert_eq!(HostRuntime::management_method(None), "GET");
        assert_eq!(HostRuntime::management_method(Some(&json!({}))), "POST");
    }

    #[test]
    fn serverinfo_reports_active_remote_desktop_sessions() {
        assert_eq!(
            serverinfo_has_active_session(b"<root><currentgame>1</currentgame></root>"),
            Ok(true)
        );
        assert_eq!(
            serverinfo_has_active_session(b"<root><currentgame>0</currentgame></root>"),
            Ok(false)
        );
        assert!(serverinfo_has_active_session(b"<root></root>").is_err());
    }

    #[test]
    fn chunked_management_responses_are_decoded_with_size_checks() {
        assert_eq!(
            decode_chunked(b"4\r\ntest\r\n5\r\n data\r\n0\r\n\r\n").unwrap(),
            b"test data"
        );
        assert!(decode_chunked(b"z\r\ninvalid\r\n0\r\n\r\n").is_err());
        assert!(decode_chunked(b"5\r\ncut\r\n0\r\n\r\n").is_err());
    }

    #[test]
    fn host_runtime_reports_missing_executable_without_spawning() {
        let directory = std::env::temp_dir().join(format!(
            "solunaremote-host-runtime-{}",
            uuid::Uuid::new_v4()
        ));
        let mut host = HostRuntime::new(directory, PathBuf::from("missing-sunshine"));
        assert!(!host.available());
        assert!(host.start().is_err());
        assert_eq!(host.phase(), "stopped");
    }
}

fn ensure_ports_free() -> Result<(), String> {
    for port in RESERVED_PORTS {
        let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
            .map_err(|_| format!("端口 {port} 已被占用，请先关闭其他 Sunshine 或共享实例。"))?;
        drop(listener);
    }
    Ok(())
}

fn open_append(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("无法打开 Sunshine 日志：{error}"))
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("无法创建 Sunshine 配置：{error}"))?;
    file.write_all(contents)
        .map_err(|error| format!("无法写入 Sunshine 配置：{error}"))
}
