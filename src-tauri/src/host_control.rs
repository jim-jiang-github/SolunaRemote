use crate::{
    network::{self, AppInfo, ServerInfo, Target},
    process::native_command,
    validation::{self, Settings},
};
use aes::{
    cipher::{BlockDecrypt, BlockEncrypt, KeyInit},
    Aes128,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{
        KeyPair, RsaKeyPair, UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256, RSA_PKCS1_SHA256,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use url::Url;
use uuid::Uuid;
use x509_parser::parse_x509_certificate;

#[derive(Clone)]
pub struct ClientIdentity {
    certificate: Vec<u8>,
    private_key: Vec<u8>,
    id: String,
}

#[derive(Serialize, Deserialize)]
struct PairingRecord {
    version: u8,
    certificate: String,
    uuid: String,
}

pub struct HostControl {
    directory: PathBuf,
    identity: Option<ClientIdentity>,
}

impl HostControl {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            identity: None,
        }
    }

    fn identity(&mut self, executable: &Path) -> Result<ClientIdentity, String> {
        if let Some(identity) = &self.identity {
            return Ok(identity.clone());
        }
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("无法创建客户端身份目录：{error}"))?;
        let output = native_command(executable)
            .arg("--identity")
            .arg(&self.directory)
            .output()
            .map_err(|error| format!("无法创建客户端身份：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "无法创建客户端身份：{}",
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(500)
                    .collect::<String>()
            ));
        }
        let certificate = fs::read(self.directory.join("client-cert.pem"))
            .map_err(|error| format!("无法读取客户端证书：{error}"))?;
        let private_key = fs::read(self.directory.join("client-key.pem"))
            .map_err(|error| format!("无法读取客户端私钥：{error}"))?;
        let certificate_der = network::parse_certificate(&certificate)?;
        let private_key_der = parse_private_key(&private_key)?;
        let key = RsaKeyPair::from_pkcs8(&private_key_der)
            .map_err(|_| "客户端私钥无效或不是 RSA PKCS#8 格式。".to_string())?;
        let (_, cert) = parse_x509_certificate(certificate_der.as_ref())
            .map_err(|_| "客户端证书格式无效。".to_string())?;
        if cert
            .tbs_certificate
            .subject_pki
            .subject_public_key
            .data
            .as_ref()
            != key.public_key().as_ref()
        {
            return Err("客户端证书与私钥不匹配，请恢复原有身份文件。".into());
        }
        let id = hex(&sha256(certificate_der.as_ref())[..8]);
        let identity = ClientIdentity {
            certificate,
            private_key,
            id,
        };
        self.identity = Some(identity.clone());
        Ok(identity)
    }

    pub fn pair(
        &mut self,
        target: &Target,
        executable: &Path,
        pin: &str,
        nonce: Option<&str>,
    ) -> Result<(), String> {
        if pin.len() != 4 || !pin.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("PIN 必须是四位数字。".into());
        }
        if nonce
            .is_some_and(|nonce| nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("内部连接标识无效。".into());
        }
        let identity = self.identity(executable)?;
        let state = self.info(target, &identity)?;
        if state
            .0
            .appversion
            .as_deref()
            .unwrap_or_default()
            .split('.')
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0)
            < 7
        {
            return Err("仅支持 Sunshine / GameStream 第 7 代及以上配对协议。".into());
        }
        let https_port = state.1;
        let target = Target {
            ip: target.ip,
            address: target.address.clone(),
            port: target.port,
            https_port: Some(https_port),
        };
        let mut salt = [0_u8; 16];
        random_bytes(&mut salt)?;
        let key = sha256(&[salt.as_slice(), pin.as_bytes()].concat())[..16].to_vec();
        let device_name = nonce
            .map(|nonce| format!("SolunaRemote-{nonce}"))
            .unwrap_or_else(|| "SolunaRemote".into());
        let parameters = vec![
            ("devicename".into(), device_name),
            ("updateState".into(), "1".into()),
        ];
        let begin = self.call(
            &target,
            "pair",
            &identity,
            None,
            false,
            &parameters,
            &[
                ("phrase", "getservercert".into()),
                ("salt", hex(&salt)),
                ("clientcert", hex(&identity.certificate)),
            ],
        )?;
        let server_certificate = decode_hex(required(&begin, "plaincert")?, 256, 16_384)?;
        let server_certificate_der = network::parse_certificate(&server_certificate)?;
        let (_, server) = parse_x509_certificate(server_certificate_der.as_ref())
            .map_err(|_| "Sunshine 证书格式无效。".to_string())?;
        let mut challenge = [0_u8; 16];
        random_bytes(&mut challenge)?;
        let response = self.call(
            &target,
            "pair",
            &identity,
            None,
            false,
            &parameters,
            &[("clientchallenge", hex(&aes(&challenge, &key, false)?))],
        )?;
        let decrypted = aes(
            &decode_hex(required(&response, "challengeresponse")?, 48, 64)?,
            &key,
            true,
        )?;
        let mut secret = [0_u8; 16];
        random_bytes(&mut secret)?;
        let reply = self.call(
            &target,
            "pair",
            &identity,
            None,
            false,
            &parameters,
            &[(
                "serverchallengeresp",
                hex(&aes(
                    &sha256(
                        &[
                            &decrypted[32..48],
                            &certificate_signature(&identity.certificate)?,
                            &secret,
                        ]
                        .concat(),
                    ),
                    &key,
                    false,
                )?),
            )],
        )?;
        let pairing_secret = decode_hex(required(&reply, "pairingsecret")?, 272, 1040)?;
        let server_secret = &pairing_secret[..16];
        let public_key = &server.tbs_certificate.subject_pki.subject_public_key.data;
        if UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, public_key)
            .verify(server_secret, &pairing_secret[16..])
            .is_err()
        {
            return Err("主机配对签名无效，已拒绝信任此主机。".into());
        }
        let expected = sha256(
            &[
                challenge.as_slice(),
                &certificate_signature(server_certificate_der.as_ref())?,
                server_secret,
            ]
            .concat(),
        );
        if !constant_time_eq(&expected, &decrypted[..32]) {
            return Err("PIN 验证失败，主机证书未保存。".into());
        }
        self.call(
            &target,
            "pair",
            &identity,
            None,
            false,
            &parameters,
            &[(
                "clientpairingsecret",
                hex(&[secret.as_slice(), &sign(&identity.private_key, &secret)?].concat()),
            )],
        )?;
        self.call(
            &target,
            "pair",
            &identity,
            Some(&server_certificate),
            true,
            &parameters,
            &[("phrase", "pairchallenge".into())],
        )?;
        let record = PairingRecord {
            version: 1,
            certificate: pem_certificate(server_certificate_der.as_ref())?,
            uuid: state.0.uniqueid.unwrap_or_default(),
        };
        let path = self.record_path(&target.address);
        let parent = path.parent().ok_or_else(|| "配对目录无效。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配对目录：{error}"))?;
        let temporary = parent.join(format!("pairing-{}.tmp", Uuid::new_v4()));
        fs::write(
            &temporary,
            serde_json::to_vec(&record).map_err(|error| format!("无法保存配对记录：{error}"))?,
        )
        .map_err(|error| format!("无法保存配对记录：{error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("无法保存配对记录：{error}"))?;
        Ok(())
    }

    pub fn launch(
        &mut self,
        target: &Target,
        executable: &Path,
        app: &str,
        settings: &Settings,
        launch_params: &str,
    ) -> Result<Value, String> {
        let settings = settings.clone().validate()?;
        let app = validation::app_name(app.to_owned())?;
        let identity = self.identity(executable)?;
        let path = self.record_path(&target.address);
        let record: PairingRecord = serde_json::from_slice(&fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "此客户端尚未与主机配对，请重新输入访问密码连接。".to_string()
            } else {
                format!("无法读取主机配对记录：{error}")
            }
        })?)
        .map_err(|error| format!("配对记录格式无效：{error}"))?;
        let certificate = record.certificate.into_bytes();
        let (info, https_port) = self.info(target, &identity)?;
        let target = Target {
            ip: target.ip,
            address: target.address.clone(),
            port: target.port,
            https_port: Some(https_port),
        };
        let server_info = self.call(
            &target,
            "serverinfo",
            &identity,
            Some(&certificate),
            true,
            &[],
            &[],
        )?;
        if server_info.pair_status.as_deref() != Some("1") {
            return Err("Sunshine 尚未信任此客户端，请重新 PIN 配对。".into());
        }
        let list = self.call(
            &target,
            "applist",
            &identity,
            Some(&certificate),
            true,
            &[],
            &[],
        )?;
        let matches: Vec<&AppInfo> = list
            .apps
            .iter()
            .filter(|entry| entry.title == app)
            .collect();
        if matches.len() != 1 {
            return Err(format!(
                "Sunshine 中没有唯一匹配的应用「{app}」，请检查 Applications。"
            ));
        }
        let app_id = matches[0]
            .id
            .parse::<u32>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or_else(|| "Sunshine 应用 ID 无效。".to_string())?;
        let current = info
            .current_game
            .as_deref()
            .unwrap_or("0")
            .parse::<u32>()
            .unwrap_or(0);
        if current != 0 && current != app_id {
            return Err("主机正在运行其他应用；请先在被控端结束该应用。".into());
        }
        let (width, height) = settings
            .resolution
            .split_once('x')
            .ok_or_else(|| "分辨率设置无效。".to_string())?;
        let mut key = [0_u8; 16];
        let mut iv = [0_u8; 16];
        random_bytes(&mut key)?;
        random_bytes(&mut iv[..4])?;
        let command = if current == app_id {
            "resume"
        } else {
            "launch"
        };
        let mut params: Vec<(String, String)> = form_urlencoded::parse(launch_params.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        params.extend([
            ("appid".into(), app_id.to_string()),
            ("mode".into(), format!("{width}x{height}x{}", settings.fps)),
            ("additionalStates".into(), "1".into()),
            ("sops".into(), "1".into()),
            ("rikey".into(), hex(&key)),
            (
                "rikeyid".into(),
                i32::from_be_bytes(iv[..4].try_into().unwrap()).to_string(),
            ),
            ("localAudioPlayMode".into(), "0".into()),
            ("surroundAudioInfo".into(), (0x030002_u32).to_string()),
            ("remoteControllersBitmap".into(), "0".into()),
            ("gcmap".into(), "0".into()),
            ("gcpersist".into(), "0".into()),
        ]);
        let launch = self.call(
            &target,
            command,
            &identity,
            Some(&certificate),
            true,
            &params,
            &[],
        )?;
        let rtsp = Url::parse(
            launch
                .session_url
                .as_deref()
                .ok_or_else(|| "Sunshine 未返回串流地址。".to_string())?,
        )
        .map_err(|_| "Sunshine 返回的 RTSP 地址无效。".to_string())?;
        let expected_host = target.ip.to_string();
        if !["rtsp", "rtspenc"].contains(&rtsp.scheme())
            || rtsp.host_str() != Some(expected_host.as_str())
            || rtsp.username() != ""
            || rtsp.password().is_some()
            || rtsp
                .port()
                .is_none_or(|port| !(1024..=65535).contains(&port))
        {
            return Err("Sunshine 返回的 RTSP 地址不是已验证的内网主机。".into());
        }
        Ok(serde_json::json!({
            "address": target.ip.to_string(),
            "appVersion": info.appversion.unwrap_or_default(),
            "gfeVersion": info.gfe_version.unwrap_or_default(),
            "serverCodecs": info.server_codecs.unwrap_or_else(|| "1".into()).parse::<u32>().unwrap_or(1),
            "rtspUrl": rtsp.as_str(),
            "width": width.parse::<u32>().unwrap_or(1920),
            "height": height.parse::<u32>().unwrap_or(1080),
            "fps": settings.fps,
            "bitrate": settings.bitrate,
            "displayMode": settings.display_mode,
            "codec": settings.codec,
            "key": hex(&key),
            "iv": hex(&iv),
        }))
    }

    fn info(
        &self,
        target: &Target,
        identity: &ClientIdentity,
    ) -> Result<(ServerInfo, u16), String> {
        let info = self.call(target, "serverinfo", identity, None, false, &[], &[])?;
        let https_port = info
            .https_port
            .as_deref()
            .unwrap_or("47984")
            .parse::<u16>()
            .ok()
            .filter(|port| (1024..=65535).contains(port))
            .ok_or_else(|| "Sunshine HTTPS 端口无效。".to_string())?;
        Ok((info, https_port))
    }

    fn call(
        &self,
        target: &Target,
        command: &str,
        identity: &ClientIdentity,
        server_certificate: Option<&[u8]>,
        secure: bool,
        parameters: &[(String, String)],
        extra: &[(&str, String)],
    ) -> Result<ServerInfo, String> {
        let mut pairs = vec![
            ("uniqueid", identity.id.clone()),
            ("uuid", Uuid::new_v4().simple().to_string()),
        ];
        pairs.extend(
            parameters
                .iter()
                .map(|(key, value)| (key.as_str(), value.clone())),
        );
        pairs.extend(extra.iter().map(|(key, value)| (*key, value.clone())));
        let query = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().map(|(key, value)| (*key, value.as_str())))
            .finish();
        let endpoint = format!("/{command}?{query}");
        let (status, body) = if secure {
            network::request_https(
                target.ip,
                target.https_port.unwrap_or(target.port),
                "GET",
                &endpoint,
                None,
                std::time::Duration::from_secs(8),
                server_certificate,
                Some((&identity.certificate, &identity.private_key)),
            )?
        } else {
            network::request_http(
                target.ip,
                target.port,
                &endpoint,
                std::time::Duration::from_secs(if command == "pair" { 35 } else { 8 }),
            )?
        };
        if status != 200 {
            return Err(format!("Sunshine 返回 HTTP {status}。"));
        }
        Self::parse_control_response(command, &body)
    }

    fn parse_control_response(command: &str, body: &[u8]) -> Result<ServerInfo, String> {
        let xml =
            std::str::from_utf8(body).map_err(|_| "Sunshine 响应不是有效 XML。".to_string())?;
        if xml.len() > 1_048_576
            || xml.to_ascii_uppercase().contains("<!DOCTYPE")
            || xml.contains("<!ENTITY")
        {
            return Err("Sunshine 响应格式无效或超过大小限制。".into());
        }
        let info: ServerInfo = quick_xml::de::from_str(xml).map_err(|error| {
            format!("Sunshine {command} 响应不是有效的 GameStream XML：{error}")
        })?;
        if info.status_code != "200" {
            return Err(format!(
                "Sunshine 拒绝请求（{}）：{}",
                info.status_code,
                info.status_message
                    .unwrap_or_else(|| "请检查配对、显示器和编码器。".into())
            ));
        }
        if command == "pair" && info.paired.as_deref() != Some("1") {
            return Err("Sunshine 拒绝配对，请确认 PIN 或检查是否已有其他配对请求。".into());
        }
        Ok(info)
    }

    fn record_path(&self, address: &str) -> PathBuf {
        self.directory
            .join(format!("host-{}.json", hex(&sha256(address.as_bytes()))))
    }
}

fn required<'a>(info: &'a ServerInfo, field: &str) -> Result<&'a str, String> {
    match field {
        "plaincert" => info.plaincert.as_deref(),
        "challengeresponse" => info.challengeresponse.as_deref(),
        "pairingsecret" => info.pairingsecret.as_deref(),
        _ => None,
    }
    .ok_or_else(|| format!("Sunshine 配对响应缺少字段 {field}。"))
}

fn decode_hex(value: &str, min: usize, max: usize) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0
        || value.len() < min * 2
        || value.len() > max * 2
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Sunshine 配对数据长度或格式无效。".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Sunshine 配对数据格式无效。".to_string())
        })
        .collect()
}

fn aes(data: &[u8], key: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() % 16 != 0 || key.len() != 16 {
        return Err("无效的 AES 配对数据。".into());
    }
    let cipher = Aes128::new_from_slice(key).map_err(|_| "AES 配对密钥无效。".to_string())?;
    let mut output = data.to_vec();
    for chunk in output.chunks_exact_mut(16) {
        let mut block = aes::Block::clone_from_slice(chunk);
        if decrypt {
            cipher.decrypt_block(&mut block);
        } else {
            cipher.encrypt_block(&mut block);
        }
        chunk.copy_from_slice(&block);
    }
    Ok(output)
}

fn certificate_signature(pem_or_der: &[u8]) -> Result<Vec<u8>, String> {
    let certificate_der = network::parse_certificate(pem_or_der)?;
    let (_, certificate) = parse_x509_certificate(certificate_der.as_ref())
        .map_err(|_| "证书格式无效。".to_string())?;
    Ok(certificate.signature_value.data.to_vec())
}

fn sign(private_key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let private_key = parse_private_key(private_key)?;
    let key = RsaKeyPair::from_pkcs8(&private_key)
        .map_err(|_| "客户端私钥无效或不是 RSA PKCS#8 格式。".to_string())?;
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        data,
        &mut signature,
    )
    .map_err(|_| "无法创建配对签名。".to_string())?;
    Ok(signature)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn random_bytes(bytes: &mut [u8]) -> Result<(), String> {
    SystemRandom::new()
        .fill(bytes)
        .map_err(|_| "无法生成安全随机数。".to_string())
}

fn parse_private_key(pem: &[u8]) -> Result<Vec<u8>, String> {
    let mut reader = Cursor::new(pem);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|error| format!("客户端私钥无效：{error}"))?
        .map(|key| key.secret_der().to_vec())
        .ok_or_else(|| "客户端私钥缺失。".into())
}

fn pem_certificate(der: &[u8]) -> Result<String, String> {
    let encoded = STANDARD.encode(der);
    let lines: Result<Vec<_>, _> = encoded
        .as_bytes()
        .chunks(64)
        .map(std::str::from_utf8)
        .collect();
    let lines = lines
        .map_err(|error| format!("无法编码 Sunshine 证书：{error}"))?
        .join("\n");
    Ok(format!(
        "-----BEGIN CERTIFICATE-----\n{lines}\n-----END CERTIFICATE-----\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_pairing_cipher_matches_the_aes_128_ecb_vector() {
        let key = decode_hex("000102030405060708090a0b0c0d0e0f", 16, 16).unwrap();
        let plaintext = decode_hex("00112233445566778899aabbccddeeff", 16, 16).unwrap();
        let ciphertext = decode_hex("69c4e0d86a7b0430d8cdb78070b4c55a", 16, 16).unwrap();

        assert_eq!(aes(&plaintext, &key, false).unwrap(), ciphertext);
        assert_eq!(aes(&ciphertext, &key, true).unwrap(), plaintext);
    }

    #[test]
    fn pairing_rejects_malformed_hex_and_aes_inputs() {
        assert_eq!(decode_hex("00ff", 2, 2).unwrap(), vec![0, 255]);
        for value in ["0", "gg", "00ff00", ""] {
            assert!(decode_hex(value, 2, 2).is_err(), "{value:?}");
        }
        assert!(aes(&[0; 15], &[0; 16], false).is_err());
        assert!(aes(&[0; 16], &[0; 15], false).is_err());
        assert!(aes(&[], &[0; 16], false).is_err());
    }

    #[test]
    fn pairing_response_rejects_bad_status_unsafe_or_oversized_xml() {
        let valid = br#"<root status_code="200"><paired>1</paired></root>"#;
        assert_eq!(
            HostControl::parse_control_response("pair", valid)
                .unwrap()
                .paired
                .as_deref(),
            Some("1")
        );
        for invalid in [
            br#"<root status_code="401"/>"#.as_slice(),
            br#"<root status_code="200"><paired>0</paired></root>"#,
            br#"<!DOCTYPE root><root status_code="200"><paired>1</paired></root>"#,
            b"<root",
            &[0xff],
        ] {
            assert!(HostControl::parse_control_response("pair", invalid).is_err());
        }
        assert!(HostControl::parse_control_response("pair", &vec![b'x'; 1_048_577]).is_err());
    }
}
