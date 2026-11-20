use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

pub const RESOLUTIONS: &[&str] = &["1280x720", "1920x1080", "2560x1440", "3840x2160"];
pub const FRAME_RATES: &[u32] = &[30, 60, 90, 120];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub moonlight_path: String,
    pub resolution: String,
    pub fps: u32,
    pub bitrate: u32,
    pub display_mode: String,
    pub codec: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            moonlight_path: String::new(),
            resolution: "1920x1080".into(),
            fps: 60,
            bitrate: 20_000,
            display_mode: "borderless".into(),
            codec: "auto".into(),
        }
    }
}

impl Settings {
    pub fn validate(self) -> Result<Self, String> {
        if !RESOLUTIONS.contains(&self.resolution.as_str()) {
            return Err("不支持的分辨率。".into());
        }
        if !FRAME_RATES.contains(&self.fps) {
            return Err("不支持的帧率。".into());
        }
        if !(1_000..=150_000).contains(&self.bitrate) {
            return Err("码率需为 1000–150000 Kbps。".into());
        }
        if !["windowed", "borderless", "fullscreen"].contains(&self.display_mode.as_str()) {
            return Err("不支持的窗口模式。".into());
        }
        if !["auto", "H.264", "HEVC", "AV1"].contains(&self.codec.as_str()) {
            return Err("不支持的视频编码。".into());
        }
        if self.moonlight_path.len() > 4096 {
            return Err("设置格式无效。".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub address: String,
    pub app: String,
    pub favorite: bool,
    pub last_paired_at: Option<String>,
    pub shortcuts: Vec<Shortcut>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub name: String,
    pub app: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeviceInput {
    pub name: String,
    pub address: String,
    #[serde(default = "default_app")]
    pub app: String,
}

fn default_app() -> String {
    "Desktop".into()
}

impl DeviceInput {
    pub fn validate(self) -> Result<Self, String> {
        let name = text(self.name, "设备名称", 48)?;
        let address = parse_address(&self.address)?.2;
        let app = app_name(self.app)?;
        Ok(Self { name, address, app })
    }
}

pub fn text(value: String, label: &str, max: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!(
            "{label}不能为空，且不能包含控制字符或超过 {max} 个字符。"
        ));
    }
    Ok(trimmed.to_owned())
}

pub fn app_name(value: String) -> Result<String, String> {
    let name = text(value, "Sunshine 应用名称", 100)?;
    if name.starts_with('-') {
        return Err("应用名称不能以连字符开头，以免被识别为命令行选项。".into());
    }
    Ok(name)
}

pub fn is_private_ipv4(address: Ipv4Addr) -> bool {
    address.is_private() || address.is_loopback() || address.is_link_local()
}

pub fn parse_address(value: &str) -> Result<(String, u16, String), String> {
    let value = text(value.to_owned(), "设备地址", 253)?.to_ascii_lowercase();
    if value.contains(['/', '\\', '?', '#', '@']) || value.chars().any(char::is_whitespace) {
        return Err("请填写 IPv4 地址或主机名，可附带 Sunshine HTTP 端口；不要填写网址。".into());
    }
    let (host, port) = match value.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && !port.is_empty() => {
            if !port.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("设备地址或端口格式无效。".into());
            }
            let port = port
                .parse::<u16>()
                .map_err(|_| "Sunshine HTTP 端口需在 1024–65514 之间。".to_string())?;
            (host, port)
        }
        Some((_, _)) if value.contains(':') => {
            return Err("主机名格式无效；当前版本暂不支持 IPv6。".into())
        }
        _ => (value.as_str(), 47989),
    };
    if !(1024..=65514).contains(&port) {
        return Err("Sunshine HTTP 端口需在 1024–65514 之间，为协议的相邻端口预留空间。".into());
    }
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() || host.len() > 253 {
        return Err("主机名格式无效。".into());
    }
    if host
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        let address = host
            .parse::<Ipv4Addr>()
            .map_err(|_| "仅允许私有内网、回环或链路本地 IPv4 地址。".to_string())?;
        if !is_private_ipv4(address) || host != address.to_string() {
            return Err("仅允许私有内网、回环或链路本地 IPv4 地址。".into());
        }
    } else if !host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err("主机名格式无效；当前版本暂不支持 IPv6。".into());
    }
    let normalized = if port == 47989 {
        host.to_owned()
    } else {
        format!("{host}:{port}")
    };
    Ok((host.to_owned(), port, normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_validation_matches_lan_policy() {
        assert_eq!(
            parse_address(" Studio.LOCAL.:47989 ").unwrap(),
            ("studio.local".into(), 47989, "studio.local".into())
        );
        assert_eq!(
            parse_address("192.168.1.2:48089").unwrap().2,
            "192.168.1.2:48089"
        );
        for value in [
            "8.8.8.8",
            "192.168.1.2:0",
            "192.168.1.2:65515",
            "https://192.168.1.2",
            "999.1.1.1",
            "::1",
            "a..local",
            "host;evil",
        ] {
            assert!(parse_address(value).is_err(), "{value}");
        }
    }

    #[test]
    fn settings_enforce_supported_values_and_limits() {
        assert_eq!(
            Settings::default().clone().validate().unwrap(),
            Settings::default()
        );
        assert!(Settings {
            bitrate: 999,
            ..Settings::default()
        }
        .validate()
        .is_err());
        assert!(Settings {
            codec: "invalid".into(),
            ..Settings::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn legacy_engine_path_is_ignored_when_loading_settings() {
        let settings: Settings =
            serde_json::from_str(r#"{"nativePath":"C:\\legacy\\soluna-stream.exe"}"#).unwrap();
        assert_eq!(settings, Settings::default());
        assert!(serde_json::to_value(settings)
            .unwrap()
            .get("nativePath")
            .is_none());
    }

    #[test]
    fn text_rejects_control_characters_even_at_the_edges() {
        assert_eq!(text(" Studio ".into(), "名称", 48).unwrap(), "Studio");
        for value in ["\nStudio", "Studio\t", "A\u{0}B"] {
            assert!(text(value.into(), "名称", 48).is_err(), "{value:?}");
        }
    }
}
