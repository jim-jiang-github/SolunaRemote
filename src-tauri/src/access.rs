use crate::{process::background_command, validation::is_private_ipv4};
use if_addrs::{get_if_addrs, IfAddr};
use openssl::ssl::{SslAcceptor, SslConnector, SslMethod, SslStream, SslVersion};
use ring::rand::{SecureRandom, SystemRandom};
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const ACCESS_PORT: u16 = 47991;
const MAX_CONNECTIONS: usize = 8;
const MAX_REQUEST_HEADERS: usize = 8192;
const MAX_REQUEST_BODY: usize = 1024;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_CONNECTIONS_PER_WINDOW: u8 = 10;
const MAX_REPORTED_DISPLAYS: u32 = 32;

const RANGES: &[(u32, u32)] = &[
    (0x0a00_0000, 0x0100_0000),
    (0x7f00_0000, 0x0100_0000),
    (0xa9fe_0000, 0x0001_0000),
    (0xac10_0000, 0x0010_0000),
    (0xc0a8_0000, 0x0001_0000),
];

pub fn checksum(payload: &str) -> char {
    let sum: u32 = payload
        .bytes()
        .rev()
        .enumerate()
        .map(|(position, byte)| {
            let mut digit = u32::from(byte - b'0');
            if position % 2 == 0 {
                digit *= 2;
                if digit > 9 {
                    digit -= 9;
                }
            }
            digit
        })
        .sum();
    char::from(b'0' + ((10 - sum % 10) % 10) as u8)
}

pub fn validate_code(code: &str) -> Result<String, String> {
    if code.len() != 9 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("请输入 9 位数字设备码。".into());
    }
    if checksum(&code[..8]) != code.as_bytes()[8] as char {
        return Err("设备码校验失败，请检查输入。".into());
    }
    Ok(code.to_owned())
}

pub fn make_code() -> Result<String, String> {
    let mut random = [0_u8; 8];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "无法生成安全随机设备码。".to_string())?;
    let number = u64::from_be_bytes(random) % 100_000_000;
    let payload = format!("{number:08}");
    Ok(format!("{payload}{}", checksum(&payload)))
}

pub fn encode_address(address: Ipv4Addr) -> Result<String, String> {
    if !is_private_ipv4(address) {
        return Err("设备码仅支持内网 IPv4。".into());
    }
    let value = u32::from(address);
    let mut offset = 0_u32;
    for (start, size) in RANGES {
        if value >= *start && value < start + size {
            let payload = format!("{:08}", offset + value - start);
            return Ok(format!("{payload}{}", checksum(&payload)));
        }
        offset += size;
    }
    Err("设备码仅支持内网 IPv4。".into())
}

pub fn decode_address(code: &str) -> Option<Ipv4Addr> {
    let code = validate_code(code).ok()?;
    let mut offset = code[..8].parse::<u32>().ok()?;
    for (start, size) in RANGES {
        if offset < *size {
            return Some(Ipv4Addr::from(start + offset));
        }
        offset -= size;
    }
    None
}

pub fn default_address() -> Option<Ipv4Addr> {
    let interfaces = get_if_addrs().ok()?;
    let mut addresses: Vec<_> = interfaces
        .into_iter()
        .filter_map(|interface| match interface.addr {
            IfAddr::V4(address)
                if !interface.is_loopback()
                    && is_private_ipv4(address.ip)
                    && !address.ip.is_link_local() =>
            {
                Some((interface.name, address.ip))
            }
            _ => None,
        })
        .collect();
    if addresses.is_empty() {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let script = "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object { $i=Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; $a=Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; if($i -and $i.ConnectionState -eq 'Connected' -and $a){[pscustomobject]@{Name=$a.Name;Metric=[int]$_.RouteMetric+[int]$i.InterfaceMetric}} }; $r|Sort-Object Metric|Select-Object -ExpandProperty Name -Unique|ConvertTo-Json -Compress";
        if let Ok(output) = background_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    let names: Vec<String> = serde_json::from_str::<Vec<String>>(&text)
                        .or_else(|_| serde_json::from_str::<String>(&text).map(|value| vec![value]))
                        .unwrap_or_default();
                    if let Some(ip) = names.iter().find_map(|name| {
                        addresses
                            .iter()
                            .find(|(interface, _)| interface.eq_ignore_ascii_case(name))
                            .map(|(_, ip)| *ip)
                    }) {
                        return Some(ip);
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = background_command("route")
            .args(["-n", "get", "default"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(interface) = text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("interface: "))
                {
                    if let Some((_, address)) = addresses.iter().find(|(name, _)| name == interface)
                    {
                        return Some(*address);
                    }
                }
            }
        }
    }
    addresses.sort_by_key(|(name, _)| name.clone());
    addresses.first().map(|(_, address)| *address)
}

#[derive(Serialize, Deserialize)]
struct SavedAccess {
    code: String,
    address: Option<String>,
    key: Option<String>,
    #[serde(default)]
    protected_password: Option<String>,
}

pub struct AccessState {
    file: PathBuf,
    pub code: String,
    pub address: Option<Ipv4Addr>,
    pub key: Option<Vec<u8>>,
    password: Option<String>,
    temporary: bool,
    protected_password: Option<String>,
    pub error: Option<String>,
    pub rejected_auth: u64,
}

impl AccessState {
    pub fn open(directory: &Path) -> Result<Self, String> {
        Self::open_with_address(directory, default_address())
    }

    fn open_with_address(directory: &Path, address: Option<Ipv4Addr>) -> Result<Self, String> {
        let file = directory.join("access.json");
        let (mut state, should_save) = match fs::read(&file) {
            Ok(bytes) => {
                let saved: SavedAccess = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("无法读取访问配置，原文件已保留：{error}"))?;
                let key = saved.key.as_deref().map(decode_key).transpose()?;
                let saved_address = saved
                    .address
                    .as_deref()
                    .and_then(|value| value.parse::<Ipv4Addr>().ok())
                    .or_else(|| decode_legacy_address(&saved.code))
                    .or_else(|| decode_address(&saved.code));
                let current_code = match address {
                    Some(address) => Some(encode_address(address)?),
                    None => None,
                };
                let new_code = || match &current_code {
                    Some(code) => Ok(code.clone()),
                    None => make_code(),
                };
                if saved.code.len() == 12 && decode_legacy_address(&saved.code).is_some() {
                    (Self::new(file.clone(), new_code()?, address, None), true)
                } else if let Ok(code) = validate_code(&saved.code) {
                    if address.is_some_and(|ip| {
                        saved_address == Some(ip) && decode_address(&code) == Some(ip)
                    }) {
                        let mut state = Self::new(file.clone(), code, address, key);
                        state.restore_password(saved.protected_password)?;
                        (state, false)
                    } else if address.is_none() && saved_address.is_none() {
                        let mut state = Self::new(file.clone(), code, address, key);
                        state.restore_password(saved.protected_password)?;
                        (state, false)
                    } else {
                        (Self::new(file.clone(), new_code()?, address, None), true)
                    }
                } else {
                    (Self::new(file.clone(), new_code()?, address, None), true)
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let code = match address {
                    Some(address) => encode_address(address)?,
                    None => make_code()?,
                };
                (Self::new(file.clone(), code, address, None), true)
            }
            Err(error) => return Err(format!("无法读取访问配置，原文件已保留：{error}")),
        };
        if should_save {
            state.save()?;
        }
        if state.key.is_none() && state.address.is_some() {
            state.generate_temporary()?;
        }
        Ok(state)
    }

    fn new(file: PathBuf, code: String, address: Option<Ipv4Addr>, key: Option<Vec<u8>>) -> Self {
        Self {
            file,
            code,
            address,
            key,
            password: None,
            temporary: false,
            protected_password: None,
            error: None,
            rejected_auth: 0,
        }
    }

    pub fn set_password(&mut self, password: &str) -> Result<(), String> {
        let address =
            default_address().ok_or_else(|| "未检测到可用网络，请连接网络后重试。".to_string())?;
        let code = encode_address(address)?;
        let key = password_key(password, &code)?;
        let protected_password = protect_password(password)?;
        let previous = (
            self.code.clone(),
            self.address,
            self.key.clone(),
            self.password.clone(),
            self.temporary,
            self.protected_password.clone(),
        );
        self.code = code;
        self.address = Some(address);
        self.key = Some(key);
        self.password = Some(password.to_owned());
        self.temporary = false;
        self.protected_password = protected_password;
        if let Err(error) = self.save() {
            (
                self.code,
                self.address,
                self.key,
                self.password,
                self.temporary,
                self.protected_password,
            ) = previous;
            return Err(error);
        }
        Ok(())
    }

    fn generate_temporary(&mut self) -> Result<(), String> {
        const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let rng = SystemRandom::new();
        let mut password = String::with_capacity(8);
        while password.len() < 8 {
            let mut byte = [0u8; 1];
            rng.fill(&mut byte)
                .map_err(|_| "无法生成临时密码。".to_string())?;
            let limit = 256 - 256 % ALPHABET.len();
            if usize::from(byte[0]) < limit {
                password.push(char::from(ALPHABET[usize::from(byte[0]) % ALPHABET.len()]));
            }
        }
        self.key = Some(password_key(&password, &self.code)?);
        self.password = Some(password);
        self.temporary = true;
        Ok(())
    }

    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    pub fn is_temporary(&self) -> bool {
        self.temporary
    }

    fn restore_password(&mut self, protected: Option<String>) -> Result<(), String> {
        if let Some(value) = protected {
            let password = unprotect_password(&value)?;
            if self.key.as_ref() != Some(&password_key(&password, &self.code)?) {
                return Err("保存的密码与访问密钥不匹配，原配置已保留。".into());
            }
            self.password = Some(password);
            self.protected_password = Some(value);
        }
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| "无法定位访问配置目录。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建访问配置目录：{error}"))?;
        let saved = SavedAccess {
            code: self.code.clone(),
            address: self.address.map(|address| address.to_string()),
            key: if self.temporary {
                None
            } else {
                self.key.as_deref().map(encode_key)
            },
            protected_password: self.protected_password.clone(),
        };
        let bytes =
            serde_json::to_vec(&saved).map_err(|error| format!("无法保存访问配置：{error}"))?;
        let temporary = parent.join(format!("access-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("无法创建访问配置临时文件：{error}"))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("无法写入访问配置：{error}"))?;
            fs::rename(&temporary, &self.file).map_err(|error| format!("无法保存访问配置：{error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn protect_password(password: &str) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    Ok(Some(STANDARD.encode(dpapi(password.as_bytes(), true)?)))
}

#[cfg(target_os = "windows")]
pub(crate) fn unprotect_password(value: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(value)
        .map_err(|error| format!("保存的密码格式无效：{error}"))?;
    String::from_utf8(dpapi(&bytes, false)?).map_err(|_| "保存的密码编码无效。".to_string())
}

#[cfg(target_os = "windows")]
fn dpapi(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let input = Blob {
        len: u32::try_from(bytes.len()).map_err(|_| "密码数据过长。".to_string())?,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(format!(
            "Windows 密码保护失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    if output.data.is_null() {
        return Err("Windows 密码保护返回空数据。".into());
    }
    let result = unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
    unsafe {
        if !encrypt {
            std::ptr::write_bytes(output.data, 0, output.len as usize);
        }
        LocalFree(output.data.cast());
    }
    Ok(result)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn protect_password(_password: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn unprotect_password(_value: &str) -> Result<String, String> {
    Err("此系统无法读取 Windows 保护的密码；原配置已保留。".into())
}

fn decode_legacy_address(code: &str) -> Option<Ipv4Addr> {
    if code.len() != 12 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = code[..10].parse::<u64>().ok()?;
    let checksum = code[10..].parse::<u32>().ok()?;
    if value > u32::MAX as u64 || value % 97 != u64::from(checksum) {
        return None;
    }
    let address = Ipv4Addr::from(value as u32);
    is_private_ipv4(address).then_some(address)
}

fn decode_key(value: &str) -> Result<Vec<u8>, String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("本机访问配置密钥格式无效；原文件已保留。".into());
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| "本机访问配置密钥格式无效；原文件已保留。".to_string())
        })
        .collect()
}

fn encode_key(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn password_key(password: &str, code: &str) -> Result<Vec<u8>, String> {
    validate_code(code)?;
    if password.is_empty() || password.chars().count() > 128 {
        return Err("设备码需为 9 位数字，访问密码需为 1–128 个字符。".into());
    }
    let params = Params::new(15, 8, 1, 32).map_err(|error| format!("密码派生参数无效：{error}"))?;
    let salt = format!("SolunaRemote-access-v1:{code}");
    let mut key = vec![0_u8; 32];
    scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut key)
        .map_err(|error| format!("无法派生访问密码密钥：{error}"))?;
    Ok(key)
}

pub fn authorize(
    address: Ipv4Addr,
    code: &str,
    password: &str,
    pair: Option<(&str, &str)>,
) -> Result<Option<u32>, String> {
    authorize_on(address, ACCESS_PORT, code, password, pair)
}

fn authorize_on(
    address: Ipv4Addr,
    port: u16,
    code: &str,
    password: &str,
    pair: Option<(&str, &str)>,
) -> Result<Option<u32>, String> {
    if !is_private_ipv4(address) {
        return Err("仅允许内网设备连接。".into());
    }
    let code = validate_code(code)?;
    let key = password_key(password, &code)?;
    let mut builder = SslConnector::builder(SslMethod::tls_client())
        .map_err(|error| format!("无法创建访问 TLS 客户端：{error}"))?;
    builder
        .set_min_proto_version(Some(SslVersion::TLS1_2))
        .and_then(|_| builder.set_max_proto_version(Some(SslVersion::TLS1_2)))
        .and_then(|_| builder.set_cipher_list("ECDHE-PSK-CHACHA20-POLY1305"))
        .map_err(|error| format!("无法配置访问 TLS 客户端：{error}"))?;
    let identity = code.as_bytes().to_vec();
    builder.set_psk_client_callback(move |_ssl, _hint, identity_output, key_output| {
        if identity_output.len() <= identity.len() || key_output.len() < key.len() {
            return Err(openssl::error::ErrorStack::get());
        }
        identity_output[..identity.len()].copy_from_slice(&identity);
        identity_output[identity.len()] = 0;
        key_output[..key.len()].copy_from_slice(&key);
        Ok(key.len())
    });

    let timeout = Duration::from_secs(35);
    let address = SocketAddr::new(address.into(), port);
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(8)).map_err(|error| {
        format!("无法连接对方设备，请确认对方已开启共享、网络可达且防火墙允许入站连接：{error}")
    })?;
    tcp.set_read_timeout(Some(timeout))
        .and_then(|_| tcp.set_write_timeout(Some(timeout)))
        .map_err(|error| format!("无法设置访问连接超时：{error}"))?;
    let connector = builder.build();
    let mut stream = connector
        .connect("solunaremote", tcp)
        .map_err(|error| format!("设备码或密码验证失败：{error}"))?;
    let path = if pair.is_some() {
        "/pair"
    } else {
        "/authenticate"
    };
    let body = pair
        .map(|(pin, nonce)| serde_json::json!({"pin": pin, "nonce": nonce}).to_string())
        .unwrap_or_default();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|error| format!("无法发送访问验证请求：{error}"))?;
    let mut response = Vec::new();
    stream
        .take(4097)
        .read_to_end(&mut response)
        .map_err(|error| format!("无法读取访问验证响应：{error}"))?;
    if response.len() > 4096 {
        return Err("设备响应过大。".into());
    }
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "设备返回了无效的访问验证响应。".to_string())?;
    let headers = std::str::from_utf8(&response[..split])
        .map_err(|_| "设备返回了无效的访问验证状态。".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_ascii_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok());
    let body: serde_json::Value = serde_json::from_slice(&response[split + 4..])
        .map_err(|_| "设备返回了无效的访问验证数据。".to_string())?;
    if status != Some(200) || body["ok"] != true {
        return Err("设备拒绝连接，请检查共享状态和 PIN。".into());
    }
    if pair.is_some() {
        return Ok(None);
    }
    let display_count = reported_display_count(&body)?;
    Ok(Some(display_count))
}

fn reported_display_count(body: &serde_json::Value) -> Result<u32, String> {
    let display_count = if body["displayCount"].is_null() {
        1
    } else {
        body["displayCount"]
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .ok_or_else(|| "设备返回了无效的显示器数量。".to_string())?
    };
    if !(1..=MAX_REPORTED_DISPLAYS).contains(&display_count) {
        return Err("对方显示器数量超出支持范围（1–32）。".into());
    }
    Ok(display_count)
}

pub fn psk_acceptor(code: &str, key: &[u8]) -> Result<SslAcceptor, String> {
    validate_code(code)?;
    if key.len() != 32 {
        return Err("访问密钥长度无效。".into());
    }

    let mut acceptor = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls_server())
        .map_err(|error| format!("无法创建访问 TLS 服务：{error}"))?;
    acceptor
        .set_min_proto_version(Some(SslVersion::TLS1_2))
        .and_then(|_| acceptor.set_max_proto_version(Some(SslVersion::TLS1_2)))
        .and_then(|_| acceptor.set_cipher_list("ECDHE-PSK-CHACHA20-POLY1305"))
        .map_err(|error| format!("无法配置访问 TLS 服务：{error}"))?;

    let expected_code = code.as_bytes().to_vec();
    let psk = key.to_vec();
    acceptor.set_psk_server_callback(move |_ssl, identity, output| {
        if identity != Some(expected_code.as_slice()) || output.len() < psk.len() {
            return Ok(0);
        }
        output[..psk.len()].copy_from_slice(&psk);
        Ok(psk.len())
    });

    Ok(acceptor.build())
}

pub struct AccessServer {
    address: SocketAddr,
    shutdown: Arc<AtomicBool>,
    listening: Arc<AtomicBool>,
    rejected_auth: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

pub(crate) type PairHandler =
    Arc<dyn Fn(&PairRequest, Ipv4Addr) -> Result<(), String> + Send + Sync>;

#[derive(Deserialize)]
pub(crate) struct PairRequest {
    pub(crate) pin: String,
    pub(crate) nonce: String,
}

impl AccessServer {
    pub(crate) fn start(code: &str, key: &[u8], pair_handler: PairHandler) -> Result<Self, String> {
        Self::start_on(("0.0.0.0", ACCESS_PORT), code, key, Some(pair_handler))
    }

    fn start_on<A: std::net::ToSocketAddrs>(
        address: A,
        code: &str,
        key: &[u8],
        pair_handler: Option<PairHandler>,
    ) -> Result<Self, String> {
        let acceptor = Arc::new(psk_acceptor(code, key)?);
        let listener =
            TcpListener::bind(address).map_err(|error| format!("无法监听访问端口：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("无法配置访问服务：{error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("无法读取访问服务地址：{error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let listening = Arc::new(AtomicBool::new(true));
        let rejected_auth = Arc::new(AtomicU64::new(0));
        let thread_shutdown = Arc::clone(&shutdown);
        let thread_listening = Arc::clone(&listening);
        let thread_rejected_auth = Arc::clone(&rejected_auth);
        let thread = thread::Builder::new()
            .name("soluna-access".into())
            .spawn(move || {
                accept_connections(
                    listener,
                    acceptor,
                    thread_shutdown,
                    thread_listening,
                    thread_rejected_auth,
                    pair_handler,
                )
            })
            .map_err(|error| format!("无法启动访问服务线程：{error}"))?;
        Ok(Self {
            address,
            shutdown,
            listening,
            rejected_auth,
            thread: Some(thread),
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn rejected_auth(&self) -> u64 {
        self.rejected_auth.load(Ordering::Relaxed)
    }

    pub fn is_listening(&self) -> bool {
        self.listening.load(Ordering::Acquire)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.shutdown.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "访问服务线程异常退出。".to_string())?;
        }
        Ok(())
    }
}

impl Drop for AccessServer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn accept_connections(
    listener: TcpListener,
    acceptor: Arc<SslAcceptor>,
    shutdown: Arc<AtomicBool>,
    listening: Arc<AtomicBool>,
    rejected_auth: Arc<AtomicU64>,
    pair_handler: Option<PairHandler>,
) {
    let active = Arc::new(AtomicUsize::new(0));
    let attempts = Arc::new(Mutex::new(HashMap::<IpAddr, (Instant, u8)>::new()));
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !shutdown.load(Ordering::Acquire) {
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let worker = workers.remove(index);
                let _ = worker.join();
            } else {
                index += 1;
            }
        }
        match listener.accept() {
            Ok((stream, address)) => {
                if !is_private_ipv4(match address.ip() {
                    IpAddr::V4(address) => address,
                    IpAddr::V6(_) => continue,
                }) || !allow_attempt(address.ip(), &attempts)
                {
                    continue;
                }
                if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let acceptor = Arc::clone(&acceptor);
                let active = Arc::clone(&active);
                let thread_active = Arc::clone(&active);
                let rejected_auth = Arc::clone(&rejected_auth);
                let pair_handler = pair_handler.clone();
                let worker = thread::Builder::new()
                    .name("soluna-access-client".into())
                    .spawn(move || {
                        let _active = ActiveConnection(thread_active);
                        serve_connection(stream, &acceptor, &rejected_auth, pair_handler);
                    });
                if let Ok(worker) = worker {
                    workers.push(worker);
                } else {
                    active.fetch_sub(1, Ordering::AcqRel);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
    listening.store(false, Ordering::Release);
}

struct ActiveConnection(Arc<AtomicUsize>);

impl Drop for ActiveConnection {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn allow_attempt(address: IpAddr, attempts: &Mutex<HashMap<IpAddr, (Instant, u8)>>) -> bool {
    let Ok(mut attempts) = attempts.lock() else {
        return false;
    };
    let now = Instant::now();
    attempts.retain(|_, (since, _)| now.duration_since(*since) < RATE_WINDOW);
    let entry = attempts.entry(address).or_insert((now, 0));
    if now.duration_since(entry.0) >= RATE_WINDOW {
        *entry = (now, 0);
    }
    if entry.1 >= MAX_CONNECTIONS_PER_WINDOW {
        return false;
    }
    entry.1 += 1;
    true
}

fn serve_connection(
    stream: TcpStream,
    acceptor: &SslAcceptor,
    rejected_auth: &AtomicU64,
    pair_handler: Option<PairHandler>,
) {
    if stream
        .set_nonblocking(false)
        .and_then(|_| stream.set_read_timeout(Some(CONNECTION_TIMEOUT)))
        .and_then(|_| stream.set_write_timeout(Some(CONNECTION_TIMEOUT)))
        .is_err()
    {
        return;
    }
    let mut stream = match acceptor.accept(stream) {
        Ok(stream) => stream,
        Err(_) => {
            rejected_auth.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    let response = match read_request(&mut stream) {
        Ok(Request::Authenticate) => match local_display_count() {
            Ok(display_count) => response(
                200,
                "OK",
                serde_json::json!({"ok": true, "displayCount": display_count})
                    .to_string()
                    .as_bytes(),
            ),
            Err(_) => response(
                503,
                "Service Unavailable",
                br#"{"error":"display query failed"}"#,
            ),
        },
        Ok(Request::Pair(request)) => match (
            pair_handler,
            stream
                .get_ref()
                .peer_addr()
                .ok()
                .map(|address| address.ip()),
        ) {
            (Some(handler), Some(IpAddr::V4(address))) => match handler(&request, address) {
                Ok(()) => response(200, "OK", br#"{"ok":true}"#),
                Err(_) => response(403, "Forbidden", br#"{"error":"pairing failed"}"#),
            },
            _ => response(
                503,
                "Service Unavailable",
                br#"{"error":"pairing service is not available"}"#,
            ),
        },
        Ok(Request::NotFound) => response(404, "Not Found", br#"{"error":"not found"}"#),
        Err(()) => response(400, "Bad Request", br#"{"error":"invalid request"}"#),
    };
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

#[cfg(target_os = "windows")]
fn local_display_count() -> Result<u32, String> {
    use std::{ffi::c_void, ptr};

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    type MonitorEnumProc =
        unsafe extern "system" fn(*mut c_void, *mut c_void, *mut Rect, isize) -> i32;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumDisplayMonitors(
            dc: *mut c_void,
            clip: *const Rect,
            callback: Option<MonitorEnumProc>,
            data: isize,
        ) -> i32;
    }

    unsafe extern "system" fn count_monitor(
        _monitor: *mut c_void,
        _dc: *mut c_void,
        _rect: *mut Rect,
        data: isize,
    ) -> i32 {
        let count = unsafe { &mut *(data as *mut u32) };
        *count = count.saturating_add(1);
        1
    }

    let mut count = 0;
    if unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(count_monitor),
            &mut count as *mut u32 as isize,
        )
    } == 0
    {
        return Err(format!(
            "无法读取 Windows 显示器列表：{}",
            std::io::Error::last_os_error()
        ));
    }
    if count > MAX_REPORTED_DISPLAYS {
        return Err("对方显示器数量超出支持范围（最多 32 台）。".into());
    }
    Ok(count.max(1))
}

#[cfg(target_os = "macos")]
fn local_display_count() -> Result<u32, String> {
    const MAX_DISPLAYS: usize = 32;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGGetActiveDisplayList(
            max_displays: u32,
            active_displays: *mut u32,
            display_count: *mut u32,
        ) -> i32;
    }

    let mut displays = [0_u32; MAX_DISPLAYS];
    let mut count = 0;
    let status =
        unsafe { CGGetActiveDisplayList(displays.len() as u32, displays.as_mut_ptr(), &mut count) };
    if status != 0 {
        return Err(format!("无法读取 macOS 显示器列表（错误码 {status}）。"));
    }
    if count > MAX_REPORTED_DISPLAYS {
        return Err("对方显示器数量超出支持范围（最多 32 台）。".into());
    }
    Ok(count.max(1))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn local_display_count() -> Result<u32, String> {
    Err("当前平台暂不支持读取显示器数量。".into())
}

enum Request {
    Authenticate,
    Pair(PairRequest),
    NotFound,
}

fn read_request(stream: &mut SslStream<TcpStream>) -> Result<Request, ()> {
    let deadline = Instant::now() + CONNECTION_TIMEOUT;
    let mut headers = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while headers.len() < MAX_REQUEST_HEADERS {
        set_remaining_timeout(stream.get_ref(), deadline)?;
        stream.read_exact(&mut byte).map_err(|_| ())?;
        headers.push(byte[0]);
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !headers.ends_with(b"\r\n\r\n") {
        return Err(());
    }
    let (request, content_length) = parse_request_head(&headers)?;
    let mut body = vec![0_u8; content_length];
    set_remaining_timeout(stream.get_ref(), deadline)?;
    stream.read_exact(&mut body).map_err(|_| ())?;
    match request {
        Request::Pair(_) => {
            let request: PairRequest = serde_json::from_slice(&body).map_err(|_| ())?;
            if request.pin.len() != 4
                || !request.pin.bytes().all(|byte| byte.is_ascii_digit())
                || request.nonce.len() != 32
                || !request.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(());
            }
            Ok(Request::Pair(request))
        }
        request => Ok(request),
    }
}

fn parse_request_head(headers: &[u8]) -> Result<(Request, usize), ()> {
    let text = std::str::from_utf8(&headers).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(())?;
    let mut parts = request_line.split_ascii_whitespace();
    if parts.next() != Some("POST") {
        return Err(());
    }
    let path = parts.next().ok_or(())?;
    if parts.next() != Some("HTTP/1.1") || parts.next().is_some() || !path.starts_with('/') {
        return Err(());
    }
    let mut content_length = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(());
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| ())?);
        }
    }
    let content_length = content_length.unwrap_or(0);
    if content_length > MAX_REQUEST_BODY {
        return Err(());
    }
    let request = match path {
        "/authenticate" => Request::Authenticate,
        "/pair" => Request::Pair(PairRequest {
            pin: String::new(),
            nonce: String::new(),
        }),
        _ => Request::NotFound,
    };
    Ok((request, content_length))
}

fn set_remaining_timeout(stream: &TcpStream, deadline: Instant) -> Result<(), ()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(());
    }
    stream.set_read_timeout(Some(remaining)).map_err(|_| ())
}

fn response(status: u16, reason: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use openssl::ssl::{SslConnector, SslMethod};
    use std::{
        io,
        net::{TcpListener, TcpStream},
        thread,
        time::Duration,
    };

    fn psk_client(code: &str, key: &[u8]) -> Result<SslConnector, String> {
        let mut connector = SslConnector::builder(SslMethod::tls_client())
            .map_err(|error| format!("无法创建访问 TLS 客户端：{error}"))?;
        connector
            .set_min_proto_version(Some(SslVersion::TLS1_2))
            .and_then(|_| connector.set_max_proto_version(Some(SslVersion::TLS1_2)))
            .and_then(|_| connector.set_cipher_list("ECDHE-PSK-CHACHA20-POLY1305"))
            .map_err(|error| format!("无法配置访问 TLS 客户端：{error}"))?;

        let identity = code.as_bytes().to_vec();
        let psk = key.to_vec();
        connector.set_psk_client_callback(move |_ssl, _hint, identity_output, key_output| {
            if identity_output.len() <= identity.len() || key_output.len() < psk.len() {
                return Err(openssl::error::ErrorStack::get());
            }
            identity_output[..identity.len()].copy_from_slice(&identity);
            identity_output[identity.len()] = 0;
            key_output[..psk.len()].copy_from_slice(&psk);
            Ok(psk.len())
        });

        Ok(connector.build())
    }

    fn local_tls_handshake(
        client_code: &str,
        client_key: &[u8],
        server_code: &str,
        server_key: &[u8],
    ) -> Result<String, String> {
        let acceptor = psk_acceptor(server_code, server_key)?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("无法启动本地 TLS 测试：{error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("无法读取本地 TLS 测试地址：{error}"))?;
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_secs(3)))?;
            stream.set_write_timeout(Some(Duration::from_secs(3)))?;
            acceptor
                .accept(stream)
                .map(|stream| stream.ssl().current_cipher().unwrap().name().to_owned())
                .map_err(|error| io::Error::other(format!("访问 TLS 握手失败：{error}")))
        });

        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|error| format!("无法连接本地 TLS 测试：{error}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(3))))
            .map_err(|error| format!("无法设置本地 TLS 测试超时：{error}"))?;
        let connector = psk_client(client_code, client_key)?;
        let client_result = connector
            .connect("localhost", stream)
            .map(|stream| stream.ssl().current_cipher().unwrap().name().to_owned())
            .map_err(|error| format!("访问 TLS 客户端握手失败：{error}"));
        let server_result = server
            .join()
            .map_err(|_| "访问 TLS 测试服务线程异常退出。".to_string())?
            .map_err(|error| format!("访问 TLS 服务端握手失败：{error}"));
        let client_cipher = client_result?;
        let server_cipher = server_result?;
        if client_cipher != server_cipher {
            return Err("访问 TLS 两端协商的密码套件不一致。".into());
        }
        Ok(client_cipher)
    }

    fn tls_request(
        address: SocketAddr,
        code: &str,
        key: &[u8],
        path: &str,
        body: Option<&str>,
    ) -> Result<String, String> {
        let connector = psk_client(code, key).unwrap();
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|error| error.to_string())?;
        let mut stream = connector
            .connect("localhost", stream)
            .map_err(|error| error.to_string())?;
        let body = body.unwrap_or_default();
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .map_err(|error| error.to_string())?;
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|error| error.to_string())?;
        Ok(response)
    }

    #[test]
    fn device_codes_round_trip_private_ipv4() {
        for address in [
            "10.0.0.0",
            "10.255.255.255",
            "127.0.0.1",
            "169.254.0.1",
            "172.22.98.13",
            "172.31.255.254",
            "192.168.1.20",
            "192.168.255.255",
        ] {
            let address = address.parse().unwrap();
            let code = encode_address(address).unwrap();
            assert_eq!(code.len(), 9);
            assert_eq!(decode_address(&code), Some(address));
            let corrupted = format!("{}{}", &code[..8], (code.as_bytes()[8] - b'0' + 1) % 10);
            assert_eq!(decode_address(&corrupted), None);
        }
        assert!(encode_address("8.8.8.8".parse().unwrap()).is_err());
    }

    #[test]
    fn password_key_is_derived_and_never_accepts_empty_password() {
        let code = encode_address("10.0.0.1".parse().unwrap()).unwrap();
        let one = password_key("x", &code).unwrap();
        assert_eq!(one.len(), 32);
        assert_eq!(one, password_key("x", &code).unwrap());
        assert!(password_key("", &code).is_err());
    }

    #[test]
    fn password_key_matches_the_node_scrypt_parameters() {
        let key = password_key("long-test-password", "340382852").unwrap();
        assert_eq!(
            key,
            [
                0xce, 0x44, 0xb2, 0xd6, 0xf9, 0x8a, 0x2b, 0x04, 0x2e, 0xa7, 0x4b, 0x4e, 0x22, 0x8f,
                0x2d, 0xbf, 0x89, 0xc0, 0xa2, 0x23, 0x69, 0xfd, 0x9d, 0x6d, 0x1c, 0xf0, 0x1e, 0xff,
                0x3c, 0x26, 0x14, 0x89,
            ]
        );
    }

    #[test]
    fn tls_psk_accepts_matching_device_identity_and_key() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        assert_eq!(
            local_tls_handshake(code, &key, code, &key).unwrap(),
            "ECDHE-PSK-CHACHA20-POLY1305"
        );
    }

    #[test]
    fn tls_psk_rejects_wrong_key_or_device_identity() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        let wrong_key = password_key("wrong-password", code).unwrap();
        let wrong_code = encode_address("192.168.1.1".parse().unwrap()).unwrap();
        assert!(local_tls_handshake(code, &wrong_key, code, &key).is_err());
        assert!(local_tls_handshake(&wrong_code, &key, code, &key).is_err());
    }

    #[test]
    fn access_server_authenticates_and_rejects_unimplemented_pairing() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        let mut server = AccessServer::start_on("127.0.0.1:0", code, &key, None).unwrap();
        let auth = tls_request(server.address(), code, &key, "/authenticate", None).unwrap_or_else(
            |error| panic!("{error}; rejected handshakes: {}", server.rejected_auth()),
        );
        assert!(auth.starts_with("HTTP/1.1 200 OK\r\n"));
        let body: serde_json::Value =
            serde_json::from_str(auth.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["ok"], true);
        let display_count = body["displayCount"].as_u64().unwrap() as u32;
        assert!((1..=MAX_REPORTED_DISPLAYS).contains(&display_count));
        let pair = tls_request(
            server.address(),
            code,
            &key,
            "/pair",
            Some(r#"{"pin":"1234","nonce":"0123456789abcdef0123456789abcdef"}"#),
        )
        .unwrap();
        assert!(pair.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(pair.contains("pairing service is not available"));
        assert!(server.is_listening());
        server.stop().unwrap();
        assert!(!server.is_listening());
    }

    #[test]
    fn reported_display_count_validates_values_and_supports_legacy_hosts() {
        assert_eq!(
            reported_display_count(&serde_json::json!({"ok": true})).unwrap(),
            1
        );
        assert_eq!(
            reported_display_count(&serde_json::json!({"displayCount": 3})).unwrap(),
            3
        );
        assert!(reported_display_count(&serde_json::json!({"displayCount": 0})).is_err());
        assert!(reported_display_count(&serde_json::json!({"displayCount": 33})).is_err());
        assert!(reported_display_count(&serde_json::json!({"displayCount": "3"})).is_err());
    }

    #[test]
    fn psk_client_authorizes_against_a_local_access_server() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        let mut server = AccessServer::start_on("127.0.0.1:0", code, &key, None).unwrap();
        let port = server.address().port();
        authorize_on(Ipv4Addr::LOCALHOST, port, code, "test-password", None).unwrap();
        assert!(
            authorize_on(Ipv4Addr::LOCALHOST, port, code, "incorrect-password", None,).is_err()
        );
        server.stop().unwrap();
    }

    #[test]
    fn psk_client_authorizes_the_internal_pair_request() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        let handled = Arc::new(AtomicBool::new(false));
        let handler_state = Arc::clone(&handled);
        let handler: PairHandler = Arc::new(move |request, address| {
            assert_eq!(request.pin, "1234");
            assert_eq!(request.nonce, "0123456789abcdef0123456789abcdef");
            assert_eq!(address, Ipv4Addr::LOCALHOST);
            handler_state.store(true, Ordering::Release);
            Ok(())
        });
        let mut server = AccessServer::start_on("127.0.0.1:0", code, &key, Some(handler)).unwrap();
        authorize_on(
            Ipv4Addr::LOCALHOST,
            server.address().port(),
            code,
            "test-password",
            Some(("1234", "0123456789abcdef0123456789abcdef")),
        )
        .unwrap();
        assert!(handled.load(Ordering::Acquire));
        server.stop().unwrap();
    }

    #[test]
    fn access_server_routes_authenticated_pair_requests_to_host_handler() {
        let code = "340382852";
        let key = password_key("test-password", code).unwrap();
        let handled = Arc::new(AtomicBool::new(false));
        let handler_state = Arc::clone(&handled);
        let handler: PairHandler = Arc::new(move |request, address| {
            assert_eq!(request.pin, "1234");
            assert_eq!(request.nonce, "0123456789abcdef0123456789abcdef");
            assert_eq!(address, Ipv4Addr::LOCALHOST);
            handler_state.store(true, Ordering::Release);
            Ok(())
        });
        let mut server = AccessServer::start_on("127.0.0.1:0", code, &key, Some(handler)).unwrap();
        let response = tls_request(
            server.address(),
            code,
            &key,
            "/pair",
            Some(r#"{"pin":"1234","nonce":"0123456789abcdef0123456789abcdef"}"#),
        )
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(handled.load(Ordering::Acquire));
        server.stop().unwrap();
    }

    #[test]
    fn access_request_parser_rejects_ambiguous_or_unbounded_requests() {
        for request in [
            "GET /authenticate HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /authenticate HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            "POST /authenticate HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST /authenticate HTTP/1.1\r\nContent-Length: 1025\r\n\r\n",
        ] {
            assert!(parse_request_head(request.as_bytes()).is_err());
        }
    }

    #[test]
    fn access_configuration_persists_only_the_derived_key() {
        let directory =
            std::env::temp_dir().join(format!("solunaremote-access-{}", uuid::Uuid::new_v4()));
        let address = "192.168.1.20".parse().unwrap();
        let mut access = AccessState::open_with_address(&directory, Some(address)).unwrap();
        let code = access.code.clone();
        access.key = Some(password_key("test-password", &code).unwrap());
        access.temporary = false;
        access.save().unwrap();

        let reopened = AccessState::open_with_address(&directory, Some(address)).unwrap();
        assert_eq!(reopened.code, code);
        assert_eq!(reopened.key, access.key);
        let persisted = fs::read_to_string(directory.join("access.json")).unwrap();
        assert!(!persisted.contains("test-password"));
        assert!(persisted.contains(&encode_key(access.key.as_deref().unwrap())));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn changed_default_address_clears_the_saved_password() {
        let directory =
            std::env::temp_dir().join(format!("solunaremote-access-{}", uuid::Uuid::new_v4()));
        let old_address = "192.168.1.20".parse().unwrap();
        let mut access = AccessState::open_with_address(&directory, Some(old_address)).unwrap();
        access.key = Some(password_key("test-password", &access.code).unwrap());
        access.temporary = false;
        access.save().unwrap();

        let changed =
            AccessState::open_with_address(&directory, Some("192.168.1.21".parse().unwrap()))
                .unwrap();
        assert!(changed.is_temporary());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn temporary_password_is_private_and_regenerated_on_restart() {
        let directory =
            std::env::temp_dir().join(format!("solunaremote-access-{}", uuid::Uuid::new_v4()));
        let address = Some("192.168.1.20".parse().unwrap());
        let first = AccessState::open_with_address(&directory, address).unwrap();
        let password = first.password().unwrap().to_owned();
        assert_eq!(password.len(), 8);
        assert!(first.is_temporary());
        assert_eq!(
            first.key.as_ref().unwrap(),
            &password_key(&password, &first.code).unwrap()
        );
        let persisted = fs::read_to_string(directory.join("access.json")).unwrap();
        assert!(!persisted.contains(&password));
        assert!(!persisted.contains(&encode_key(first.key.as_deref().unwrap())));
        let second = AccessState::open_with_address(&directory, address).unwrap();
        assert!(second.is_temporary());
        assert_ne!(second.password(), Some(password.as_str()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protected_fixed_password_round_trips_and_rejects_mismatched_key() {
        let directory =
            std::env::temp_dir().join(format!("solunaremote-access-{}", uuid::Uuid::new_v4()));
        let address = Some("192.168.1.20".parse().unwrap());
        let mut state = AccessState::open_with_address(&directory, address).unwrap();
        let password = "fixed password test";
        state.key = Some(password_key(password, &state.code).unwrap());
        state.temporary = false;
        state.protected_password = protect_password(password).unwrap();
        state.save().unwrap();
        let persisted = fs::read_to_string(directory.join("access.json")).unwrap();
        assert!(!persisted.contains(password));
        let reopened = AccessState::open_with_address(&directory, address).unwrap();
        assert_eq!(reopened.password(), Some(password));
        state.key = Some(password_key("different", &state.code).unwrap());
        state.save().unwrap();
        assert!(AccessState::open_with_address(&directory, address).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
