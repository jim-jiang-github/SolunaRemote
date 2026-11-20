use crate::validation::{is_private_ipv4, parse_address};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime},
    ClientConfig, ClientConnection, DigitallySignedStruct, Error as TlsError, SignatureScheme,
    StreamOwned,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use url::form_urlencoded;

#[derive(Clone, Debug)]
pub struct Target {
    pub ip: Ipv4Addr,
    pub address: String,
    pub port: u16,
    pub https_port: Option<u16>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ServerInfo {
    #[serde(rename = "@status_code")]
    pub status_code: String,
    #[serde(rename = "@status_message")]
    pub status_message: Option<String>,
    pub hostname: Option<String>,
    pub uniqueid: Option<String>,
    pub appversion: Option<String>,
    pub state: Option<String>,
    #[serde(rename = "HttpsPort")]
    pub https_port: Option<String>,
    #[serde(rename = "GfeVersion")]
    pub gfe_version: Option<String>,
    #[serde(rename = "PairStatus")]
    pub pair_status: Option<String>,
    #[serde(rename = "currentgame")]
    pub current_game: Option<String>,
    #[serde(rename = "ServerCodecModeSupport")]
    pub server_codecs: Option<String>,
    #[serde(rename = "App", default)]
    pub apps: Vec<AppInfo>,
    #[serde(rename = "sessionUrl0")]
    pub session_url: Option<String>,
    #[serde(rename = "plaincert")]
    pub plaincert: Option<String>,
    #[serde(rename = "challengeresponse")]
    pub challengeresponse: Option<String>,
    #[serde(rename = "pairingsecret")]
    pub pairingsecret: Option<String>,
    #[serde(rename = "paired")]
    pub paired: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AppInfo {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "AppTitle")]
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredHost {
    pub name: String,
    pub address: String,
}

pub fn resolve_lan(input: &str) -> Result<Target, String> {
    let (host, port, address) = parse_address(input)?;
    let addresses: Vec<Ipv4Addr> = if let Ok(ip) = host.parse::<Ipv4Addr>() {
        vec![ip]
    } else {
        (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|error| format!("主机名解析失败：{error}"))?
            .filter_map(|address| match address {
                SocketAddr::V4(address) => Some(*address.ip()),
                SocketAddr::V6(_) => None,
            })
            .collect()
    };
    if addresses.is_empty() || addresses.iter().any(|ip| !is_private_ipv4(*ip)) {
        return Err("主机名必须只解析到私有内网 IPv4 地址，已阻止公网目标。".into());
    }
    Ok(Target {
        ip: addresses[0],
        address,
        port,
        https_port: None,
    })
}

pub fn request_http(
    ip: Ipv4Addr,
    port: u16,
    endpoint: &str,
    timeout: Duration,
) -> Result<(u16, Vec<u8>), String> {
    if !is_private_ipv4(ip) || !endpoint.starts_with('/') || endpoint.contains(['\r', '\n', '#']) {
        return Err("拒绝非内网地址或无效请求路径。".into());
    }
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&SocketAddr::new(ip.into(), port), timeout)
        .map_err(|error| format!("连接超时或被拒绝：{error}"))?;
    stream
        .set_write_timeout(Some(remaining_time(deadline)?))
        .map_err(|error| format!("无法设置网络超时：{error}"))?;
    write!(
        stream,
        "GET {endpoint} HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    )
    .map_err(|error| format!("发送请求失败：{error}"))?;
    let mut response = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        stream
            .set_read_timeout(Some(remaining_time(deadline)?))
            .map_err(|error| format!("无法设置网络超时：{error}"))?;
        let count = stream
            .read(&mut buffer)
            .map_err(|error| format!("读取主机响应失败：{error}"))?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > 1_048_576 {
            return Err("主机响应超过 1 MiB。".into());
        }
    }
    parse_http_response(&response)
}

fn remaining_time(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("连接超时，请检查 Sunshine、防火墙及设备地址。".into());
    }
    Ok(remaining)
}

pub fn request_https(
    ip: Ipv4Addr,
    port: u16,
    method: &str,
    endpoint: &str,
    body: Option<&[u8]>,
    timeout: Duration,
    pinned_certificate: Option<&[u8]>,
    identity: Option<(&[u8], &[u8])>,
) -> Result<(u16, Vec<u8>), String> {
    if !is_private_ipv4(ip) {
        return Err("仅允许内网设备连接。".into());
    }
    let tcp = TcpStream::connect_timeout(&SocketAddr::new(ip.into(), port), timeout)
        .map_err(|error| format!("TLS 连接失败：{error}"))?;
    tcp.set_read_timeout(Some(timeout))
        .and_then(|_| tcp.set_write_timeout(Some(timeout)))
        .map_err(|error| format!("无法设置 TLS 超时：{error}"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let algorithms = provider.signature_verification_algorithms.clone();
    let (certificates, private_key) = match identity {
        Some((certificate, key)) => (
            read_certificates(certificate)?,
            Some(read_private_key(key)?.ok_or_else(|| "客户端私钥缺失。".to_string())?),
        ),
        None => (Vec::new(), None),
    };
    let builder = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|error| format!("无法配置 TLS 协议：{error}"))?;
    let pinned =
        pinned_certificate.ok_or_else(|| "TLS 请求必须提供已固定的主机证书。".to_string())?;
    let certificate = parse_certificate(pinned)?;
    let config_builder = builder
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertificateVerifier {
            certificate,
            algorithms,
        }));
    let config = match private_key {
        Some(key) => config_builder
            .with_client_auth_cert(certificates, key)
            .map_err(|error| format!("客户端 TLS 身份无效：{error}"))?,
        None => config_builder.with_no_client_auth(),
    };
    let server_name = ServerName::IpAddress(ip.into());
    let connection = ClientConnection::new(Arc::new(config), server_name)
        .map_err(|error| format!("无法初始化 TLS：{error}"))?;
    let mut stream = StreamOwned::new(connection, tcp);
    request_stream(&mut stream, ip, port, method, endpoint, body)
}

#[derive(Debug)]
struct PinnedCertificateVerifier {
    certificate: CertificateDer<'static>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedCertificateVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if end_entity.as_ref() == self.certificate.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(TlsError::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(message, certificate, signed, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, certificate, signed, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

pub fn parse_certificate(bytes: &[u8]) -> Result<CertificateDer<'static>, String> {
    if bytes.starts_with(b"-----BEGIN") {
        let mut reader = Cursor::new(bytes);
        let certificate = rustls_pemfile::certs(&mut reader)
            .next()
            .transpose()
            .map_err(|error| format!("TLS 证书无效：{error}"))?
            .ok_or_else(|| "TLS 证书缺失。".to_string())?;
        Ok(certificate)
    } else if bytes.len() <= 16_384 {
        Ok(CertificateDer::from(bytes.to_vec()))
    } else {
        Err("TLS 证书超过大小限制。".into())
    }
}

fn read_certificates(bytes: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    let mut reader = Cursor::new(bytes);
    let certificates: Result<Vec<_>, _> = rustls_pemfile::certs(&mut reader).collect();
    certificates.map_err(|error| format!("客户端证书无效：{error}"))
}

fn read_private_key(bytes: &[u8]) -> Result<Option<PrivateKeyDer<'static>>, String> {
    let mut reader = Cursor::new(bytes);
    rustls_pemfile::private_key(&mut reader).map_err(|error| format!("客户端私钥无效：{error}"))
}

fn request_stream<S: Read + Write>(
    stream: &mut S,
    ip: Ipv4Addr,
    port: u16,
    method: &str,
    endpoint: &str,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), String> {
    if !is_private_ipv4(ip)
        || !endpoint.starts_with('/')
        || endpoint.contains(['\r', '\n', '#'])
        || !matches!(method, "GET" | "POST")
    {
        return Err("拒绝非内网地址或无效请求路径。".into());
    }
    let body = body.unwrap_or_default();
    if body.len() > 1_048_576 {
        return Err("请求数据超过 1 MiB。".into());
    }
    let content_type = if body.is_empty() {
        ""
    } else {
        "Content-Type: application/json\r\n"
    };
    write!(
        stream,
        "{method} {endpoint} HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\nAccept: */*\r\n{content_type}Content-Length: {}\r\n\r\n",
        body.len()
    )
    .and_then(|_| stream.write_all(body))
    .map_err(|error| format!("发送请求失败：{error}"))?;
    let response = read_framed_response(stream)?;
    parse_http_response(&response)
}

pub(crate) fn read_framed_response(stream: &mut impl Read) -> Result<Vec<u8>, String> {
    const LIMIT: usize = 1_048_576;
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        read_response_bytes(stream, &mut response, 1, LIMIT)?;
    }
    let headers =
        std::str::from_utf8(&response).map_err(|_| "主机返回无效 HTTP 响应头。".to_string())?;
    let mut content_length = None;
    let mut chunked = false;
    for line in headers.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err("主机返回重复的响应长度。".into());
                }
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "主机返回无效响应长度。".to_string())?,
                );
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                if chunked || !value.trim().eq_ignore_ascii_case("chunked") {
                    return Err("主机返回不支持的响应编码。".into());
                }
                chunked = true;
            }
        }
    }
    if chunked && content_length.is_some() {
        return Err("主机返回冲突的响应长度。".into());
    }
    if let Some(length) = content_length {
        read_response_bytes(stream, &mut response, length, LIMIT)?;
    } else if chunked {
        loop {
            let start = response.len();
            while !response[start..].ends_with(b"\r\n") {
                read_response_bytes(stream, &mut response, 1, LIMIT)?;
            }
            let length = std::str::from_utf8(&response[start..response.len() - 2])
                .ok()
                .and_then(|line| line.split(';').next())
                .and_then(|line| usize::from_str_radix(line.trim(), 16).ok())
                .ok_or_else(|| "主机返回无效分块长度。".to_string())?;
            let length_with_terminator = length
                .checked_add(2)
                .ok_or_else(|| "主机分块响应超过大小限制。".to_string())?;
            read_response_bytes(stream, &mut response, length_with_terminator, LIMIT)?;
            if !response.ends_with(b"\r\n") {
                return Err("主机返回无效分块结束标记。".into());
            }
            if length == 0 {
                break;
            }
        }
    } else {
        return Err("主机未提供响应长度。".into());
    }
    Ok(response)
}

fn read_response_bytes(
    stream: &mut impl Read,
    response: &mut Vec<u8>,
    count: usize,
    limit: usize,
) -> Result<(), String> {
    let start = response.len();
    let end = start
        .checked_add(count)
        .filter(|end| *end <= limit)
        .ok_or_else(|| "主机响应超过大小限制。".to_string())?;
    response.resize(end, 0);
    stream
        .read_exact(&mut response[start..])
        .map_err(|error| format!("读取主机响应失败：{error}"))
}

fn parse_http_response(response: &[u8]) -> Result<(u16, Vec<u8>), String> {
    if response.len() > 1_048_576 {
        return Err("主机响应超过 1 MiB。".into());
    }
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "主机返回了无效的 HTTP 响应。".to_string())?;
    let headers = std::str::from_utf8(&response[..split])
        .map_err(|_| "主机返回了无效的 HTTP 状态行。".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "主机返回了无效的 HTTP 状态码。".to_string())?;
    let body = &response[split + 4..];
    if headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        return Ok((status, decode_chunked(body)?));
    }
    Ok((status, body.to_vec()))
}

fn decode_chunked(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut cursor = 0;
    loop {
        let end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| "分块 HTTP 响应格式无效。".to_string())?;
        let size = std::str::from_utf8(&bytes[cursor..end])
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|line| usize::from_str_radix(line, 16).ok())
            .ok_or_else(|| "分块 HTTP 响应长度无效。".to_string())?;
        cursor = end + 2;
        if size == 0 {
            return Ok(output);
        }
        let chunk_end = cursor
            .checked_add(size)
            .filter(|chunk_end| {
                chunk_end
                    .checked_add(2)
                    .is_some_and(|end| end <= bytes.len())
            })
            .ok_or_else(|| "分块 HTTP 响应不完整。".to_string())?;
        output.extend_from_slice(&bytes[cursor..chunk_end]);
        if output.len() > 1_048_576 || bytes.get(chunk_end..chunk_end + 2) != Some(b"\r\n") {
            return Err("分块 HTTP 响应超过限制或格式无效。".into());
        }
        cursor = chunk_end + 2;
    }
}

pub fn query_endpoint(command: &str, params: &[(&str, String)]) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())))
        .finish();
    format!("/{command}?{query}")
}

pub fn server_info(target: &Target) -> Result<ServerInfo, String> {
    let (status, body) = request_http(
        target.ip,
        target.port,
        "/serverinfo",
        Duration::from_millis(2500),
    )?;
    if status != 200 {
        return Err(format!("Sunshine 返回 HTTP {status}，请检查 HTTP 端口。"));
    }
    let xml = std::str::from_utf8(&body).map_err(|_| "主机信息不是有效 XML。".to_string())?;
    if xml.len() > 65_536
        || xml.to_ascii_uppercase().contains("<!DOCTYPE")
        || xml.contains("<!ENTITY")
    {
        return Err("主机返回了无效或过大的 GameStream 信息。".into());
    }
    let info: ServerInfo = quick_xml::de::from_str(xml)
        .map_err(|_| "主机返回的 GameStream 信息格式无效。".to_string())?;
    if info.status_code != "200"
        || info.hostname.as_deref().unwrap_or_default().is_empty()
        || info.uniqueid.as_deref().unwrap_or_default().is_empty()
    {
        return Err("该地址不是可识别的 Sunshine / GameStream 主机。".into());
    }
    Ok(info)
}

pub fn probe(address: &str) -> ValueStatus {
    let started = Instant::now();
    match resolve_lan(address).and_then(|target| server_info(&target)) {
        Ok(info) => ValueStatus {
            online: true,
            hostname: info.hostname.map(|name| name.chars().take(100).collect()),
            uuid: info.uniqueid.map(|id| id.chars().take(100).collect()),
            version: info.appversion.unwrap_or_else(|| "未知".into()),
            busy: info.state.unwrap_or_default().contains("BUSY"),
            latency: Some(started.elapsed().as_millis() as u64),
            error: None,
        },
        Err(error) => ValueStatus {
            online: false,
            hostname: None,
            uuid: None,
            version: String::new(),
            busy: false,
            latency: None,
            error: Some(error),
        },
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueStatus {
    pub online: bool,
    pub hostname: Option<String>,
    pub uuid: Option<String>,
    pub version: String,
    pub busy: bool,
    pub latency: Option<u64>,
    pub error: Option<String>,
}

pub fn discover(duration: Duration) -> Result<Vec<DiscoveredHost>, String> {
    let daemon = ServiceDaemon::new().map_err(|error| format!("局域网发现启动失败：{error}"))?;
    let receiver = daemon
        .browse("_nvstream._tcp.local.")
        .map_err(|error| format!("局域网发现启动失败：{error}"))?;
    let deadline = Instant::now() + duration;
    let mut found = HashMap::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(ServiceEvent::ServiceResolved(service)) => {
                let ip = service
                    .get_addresses()
                    .iter()
                    .filter_map(|address| match address {
                        std::net::IpAddr::V4(ip) if is_private_ipv4(*ip) => Some(*ip),
                        _ => None,
                    })
                    .next();
                if let Some(ip) = ip {
                    if !(1024..=65514).contains(&service.get_port()) {
                        continue;
                    }
                    let port = service.get_port();
                    let address = if port == 47989 {
                        ip.to_string()
                    } else {
                        format!("{ip}:{port}")
                    };
                    found.insert(
                        address.clone(),
                        DiscoveredHost {
                            name: service.get_fullname().chars().take(48).collect(),
                            address,
                        },
                    );
                }
            }
            Ok(_) => {}
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    let _ = daemon.stop_browse("_nvstream._tcp.local.");
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}

pub fn publish_access(code: &str, port: u16) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|error| format!("设备码广播失败：{error}"))?;
    let mut properties = HashMap::new();
    properties.insert("code".to_string(), code.to_string());
    properties.insert("protocol".to_string(), "1".to_string());
    let service = ServiceInfo::new(
        "_solunaremote._tcp.local.",
        &format!("SolunaRemote-{code}"),
        "solunaremote.local.",
        "",
        port,
        properties,
    )
    .map_err(|error| format!("设备码广播失败：{error}"))?
    .enable_addr_auto();
    daemon
        .register(service)
        .map_err(|error| format!("设备码广播失败：{error}"))?;
    Ok(daemon)
}

pub fn discover_code(code: &str, duration: Duration) -> Result<Target, String> {
    let code = crate::access::validate_code(code)?;
    if let Some(ip) = crate::access::decode_address(&code) {
        return Ok(Target {
            ip,
            address: ip.to_string(),
            port: 47989,
            https_port: None,
        });
    }

    let daemon = ServiceDaemon::new().map_err(|error| format!("设备码发现失败：{error}"))?;
    let receiver = daemon
        .browse("_solunaremote._tcp.local.")
        .map_err(|error| format!("设备码发现失败：{error}"))?;
    let deadline = Instant::now() + duration;
    let mut found = HashMap::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(ServiceEvent::ServiceResolved(service))
                if service.get_property_val_str("code") == Some(code.as_str())
                    && service.get_property_val_str("protocol") == Some("1")
                    && service.get_port() == 47991 =>
            {
                for address in service.get_addresses() {
                    if let std::net::IpAddr::V4(ip) = address {
                        if is_private_ipv4(*ip) && !ip.is_loopback() {
                            found.insert(*ip, ());
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    let _ = daemon.stop_browse("_solunaremote._tcp.local.");
    let _ = daemon.shutdown();
    if found.len() != 1 {
        return Err(if found.is_empty() {
            "未找到设备码，请确认两台电脑在同一局域网且对方已开启共享。".into()
        } else {
            "设备码有多个匹配，请检查局域网。".into()
        });
    }
    let ip = *found.keys().next().unwrap();
    Ok(Target {
        ip,
        address: ip.to_string(),
        port: 47989,
        https_port: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpListener};

    #[test]
    #[ignore = "requires an isolated running Sunshine host"]
    fn embedded_sunshine_https_response() {
        let certificate = std::fs::read(std::env::var_os("SOLUNA_TEST_CERT").unwrap()).unwrap();
        let port = std::env::var("SOLUNA_TEST_HTTPS_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let (status, _) = request_https(
            Ipv4Addr::LOCALHOST,
            port,
            "GET",
            "/api/pin",
            None,
            Duration::from_secs(5),
            Some(&certificate),
            None,
        )
        .unwrap();
        assert_eq!(status, 307);
    }

    fn read_request_headers(stream: &mut TcpStream) {
        let mut headers = Vec::new();
        let mut byte = [0; 1];
        while !headers.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
            assert!(headers.len() <= 8192);
        }
    }

    fn finish_response(stream: &mut TcpStream) {
        stream.shutdown(Shutdown::Write).unwrap();
        let mut remaining = Vec::new();
        let _ = stream.read_to_end(&mut remaining);
    }

    #[test]
    fn http_probe_decodes_chunked_gamestream_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            let xml = r#"<root status_code="200"><hostname>Fixture</hostname><uniqueid>id</uniqueid></root>"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                xml.len(),
                xml
            )
            .unwrap();
            stream.shutdown(std::net::Shutdown::Write).unwrap();
            let mut remaining = Vec::new();
            stream.read_to_end(&mut remaining).unwrap();
        });
        let target = Target {
            ip: Ipv4Addr::LOCALHOST,
            address: format!("127.0.0.1:{port}"),
            port,
            https_port: None,
        };
        assert_eq!(
            server_info(&target).unwrap().hostname.as_deref(),
            Some("Fixture")
        );
        server.join().unwrap();
    }

    #[test]
    fn http_probe_has_a_total_deadline_even_when_response_trickles() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            for _ in 0..15 {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
        });
        let started = Instant::now();
        let result = request_http(
            Ipv4Addr::LOCALHOST,
            port,
            "/serverinfo",
            Duration::from_millis(180),
        );
        let elapsed = started.elapsed();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(500), "elapsed: {elapsed:?}");
        server.join().unwrap();
    }

    #[test]
    fn http_probe_rejects_redirect_without_following_it() {
        let destination = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        destination.set_nonblocking(true).unwrap();
        let destination_port = destination.local_addr().unwrap().port();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_headers(&mut stream);
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{destination_port}/serverinfo\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            finish_response(&mut stream);
        });
        let target = Target {
            ip: Ipv4Addr::LOCALHOST,
            address: format!("127.0.0.1:{port}"),
            port,
            https_port: None,
        };
        assert!(server_info(&target).unwrap_err().contains("HTTP 302"));
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn http_probe_rejects_oversized_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_headers(&mut stream);
            let _ = stream.write_all(&vec![b'x'; 1_048_577]);
            let _ = stream.shutdown(Shutdown::Write);
        });
        let error = request_http(
            Ipv4Addr::LOCALHOST,
            port,
            "/serverinfo",
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("1 MiB"), "{error}");
        server.join().unwrap();
    }

    #[test]
    fn http_probe_rejects_unsafe_gamestream_xml() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_headers(&mut stream);
            let xml = r#"<!DOCTYPE root [<!ENTITY x "Fixture">]><root status_code="200"><hostname>&x;</hostname><uniqueid>id</uniqueid></root>"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{xml}",
                xml.len()
            )
            .unwrap();
            finish_response(&mut stream);
        });
        let target = Target {
            ip: Ipv4Addr::LOCALHOST,
            address: format!("127.0.0.1:{port}"),
            port,
            https_port: None,
        };
        assert!(server_info(&target).is_err());
        server.join().unwrap();
    }

    #[test]
    fn chunked_response_rejects_overflowing_chunk_length() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            usize::MAX
        );
        assert!(parse_http_response(response.as_bytes()).is_err());
    }

    #[test]
    fn gamestream_application_list_uses_element_fields() {
        let xml = r#"<root status_code="200"><App><AppTitle>Desktop &amp; Test</AppTitle><ID>123</ID></App></root>"#;
        let info: ServerInfo = quick_xml::de::from_str(xml).unwrap();
        assert_eq!(info.apps.len(), 1);
        assert_eq!(info.apps[0].title, "Desktop & Test");
        assert_eq!(info.apps[0].id, "123");
    }
}
