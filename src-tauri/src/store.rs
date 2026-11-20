use crate::validation::{Device, DeviceInput, Settings, Shortcut};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    version: u8,
    devices: Vec<Device>,
    settings: Settings,
    #[serde(default)]
    credentials: HashMap<String, SavedCredential>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SavedCredential {
    code: String,
    protected_password: String,
}

pub struct Store {
    file: PathBuf,
    data: Persisted,
    session_credentials: HashMap<String, (String, String)>,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let file = directory.join("devices.json");
        let data = match fs::read(&file) {
            Ok(bytes) => {
                let mut data: Persisted = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("无法读取设备数据，原文件已保留：{error}"))?;
                if data.version != 1 || data.devices.len() > 200 {
                    return Err("设备数据版本或格式无效；原文件已保留。".into());
                }
                data.settings = data.settings.validate()?;
                let mut ids = std::collections::HashSet::new();
                let mut addresses = std::collections::HashSet::new();
                for device in &mut data.devices {
                    let input = DeviceInput {
                        name: device.name.clone(),
                        address: device.address.clone(),
                        app: device.app.clone(),
                    }
                    .validate()?;
                    let id = crate::validation::text(device.id.clone(), "设备 ID", 64)?;
                    if !ids.insert(id.clone())
                        || !addresses.insert(input.address.clone())
                        || device.shortcuts.len() > 12
                    {
                        return Err("设备数据包含重复或无效记录。".into());
                    }
                    device.name = input.name;
                    device.address = input.address;
                    device.app = input.app;
                    device.id = id;
                    if let Some(last_paired_at) = &device.last_paired_at {
                        crate::validation::text(last_paired_at.clone(), "最近配对时间", 64)?;
                    }
                    for shortcut in &mut device.shortcuts {
                        shortcut.id =
                            crate::validation::text(shortcut.id.clone(), "快捷方式 ID", 64)?;
                        shortcut.name =
                            crate::validation::text(shortcut.name.clone(), "快捷方式名称", 48)?;
                        shortcut.app = crate::validation::app_name(shortcut.app.clone())?;
                    }
                }
                for (id, credential) in &data.credentials {
                    if !ids.contains(id)
                        || crate::access::validate_code(&credential.code).is_err()
                        || credential.protected_password.is_empty()
                        || credential.protected_password.len() > 16_384
                    {
                        return Err("保存的设备密码格式无效；原文件已保留。".into());
                    }
                }
                data
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Persisted {
                version: 1,
                devices: Vec::new(),
                settings: Settings::default(),
                credentials: HashMap::new(),
            },
            Err(error) => return Err(format!("无法读取设备数据，原文件已保留：{error}")),
        };
        Ok(Self {
            file,
            data,
            session_credentials: HashMap::new(),
        })
    }

    pub fn snapshot(&self) -> Result<PersistedSnapshot, String> {
        Ok(PersistedSnapshot {
            devices: self.data.devices.clone(),
            settings: self.data.settings.clone(),
        })
    }

    fn commit(&mut self, next: Persisted) -> Result<(), String> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| "无法定位设备数据目录。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建数据目录：{error}"))?;
        let temp = parent.join(format!("devices.{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|error| format!("无法序列化设备数据：{error}"))?;
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|error| format!("无法创建设备数据临时文件：{error}"))?;
            use std::io::Write;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("无法写入设备数据：{error}"))?;
            fs::rename(&temp, &self.file).map_err(|error| format!("无法保存设备数据：{error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        self.data = next;
        Ok(())
    }

    pub fn add(&mut self, input: DeviceInput) -> Result<Device, String> {
        let input = input.validate()?;
        if self.data.devices.len() >= 200 {
            return Err("设备数量已达到上限（200）。".into());
        }
        if self
            .data
            .devices
            .iter()
            .any(|device| device.address == input.address)
        {
            return Err("这个地址已经添加过了。".into());
        }
        let device = Device {
            id: Uuid::new_v4().to_string(),
            name: input.name,
            address: input.address,
            app: input.app,
            favorite: false,
            last_paired_at: None,
            shortcuts: Vec::new(),
        };
        let mut next = self.data.clone();
        next.devices.push(device.clone());
        self.commit(next)?;
        Ok(device)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if !self.data.devices.iter().any(|device| device.id == id) {
            return Err("设备不存在，请刷新设备列表。".into());
        }
        let mut next = self.data.clone();
        next.devices.retain(|device| device.id != id);
        next.credentials.remove(id);
        self.commit(next)?;
        self.session_credentials.remove(id);
        Ok(())
    }

    pub fn remember_password(
        &mut self,
        id: &str,
        code: &str,
        password: &str,
    ) -> Result<(), String> {
        self.device(id)?;
        let code = crate::access::validate_code(code)?;
        if password.is_empty() || password.chars().count() > 128 {
            return Err("访问密码格式无效。".into());
        }
        if let Some(protected_password) = crate::access::protect_password(password)? {
            let mut next = self.data.clone();
            next.credentials.insert(
                id.to_string(),
                SavedCredential {
                    code: code.clone(),
                    protected_password,
                },
            );
            self.commit(next)?;
        }
        self.session_credentials
            .insert(id.to_string(), (code, password.to_string()));
        Ok(())
    }

    pub fn remembered_password(&self, id: &str, code: &str) -> Result<Option<String>, String> {
        self.device(id)?;
        let code = crate::access::validate_code(code)?;
        if let Some((saved_code, password)) = self.session_credentials.get(id) {
            return Ok((saved_code == &code).then(|| password.clone()));
        }
        let password = match self.data.credentials.get(id) {
            Some(saved) if saved.code == code => {
                crate::access::unprotect_password(&saved.protected_password).map(Some)
            }
            _ => Ok(None),
        }?;
        if password
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.chars().count() > 128)
        {
            return Err("保存的设备密码格式无效。".into());
        }
        Ok(password)
    }

    pub fn device(&self, id: &str) -> Result<Device, String> {
        self.data
            .devices
            .iter()
            .find(|device| device.id == id)
            .cloned()
            .ok_or_else(|| "设备不存在，请刷新设备列表。".to_string())
    }

    pub fn favorite(&mut self, id: &str) -> Result<(), String> {
        let mut next = self.data.clone();
        let device = next
            .devices
            .iter_mut()
            .find(|device| device.id == id)
            .ok_or_else(|| "设备不存在，请刷新设备列表。".to_string())?;
        device.favorite = !device.favorite;
        self.commit(next)
    }

    pub fn settings(&mut self, settings: Settings) -> Result<(), String> {
        let mut next = self.data.clone();
        next.settings = settings.validate()?;
        self.commit(next)
    }

    pub fn shortcut(&mut self, device_id: &str, name: String, app: String) -> Result<(), String> {
        let name = crate::validation::text(name, "快捷方式名称", 48)?;
        let app = crate::validation::app_name(app)?;
        let mut next = self.data.clone();
        let device = next
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
            .ok_or_else(|| "设备不存在，请刷新设备列表。".to_string())?;
        if device.shortcuts.len() >= 12 {
            return Err("每台设备最多可添加 12 个快捷方式。".into());
        }
        device.shortcuts.push(Shortcut {
            id: Uuid::new_v4().to_string(),
            name,
            app,
        });
        self.commit(next)
    }

    pub fn remove_shortcut(&mut self, device_id: &str, shortcut_id: &str) -> Result<(), String> {
        let mut next = self.data.clone();
        let device = next
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
            .ok_or_else(|| "设备不存在，请刷新设备列表。".to_string())?;
        if !device
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.id == shortcut_id)
        {
            return Err("快捷启动不存在。".into());
        }
        device
            .shortcuts
            .retain(|shortcut| shortcut.id != shortcut_id);
        self.commit(next)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSnapshot {
    pub devices: Vec<Device>,
    pub settings: Settings,
}

impl PersistedSnapshot {
    pub fn device(&self, id: &str) -> Result<&Device, String> {
        self.devices
            .iter()
            .find(|device| device.id == id)
            .ok_or_else(|| "设备不存在，请刷新设备列表。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("solunaremote-store-{}", Uuid::new_v4()))
    }

    #[test]
    fn recent_password_is_bound_to_device_and_code_and_removed_with_device() {
        let directory = temp_dir();
        let mut store = Store::open(&directory).unwrap();
        let device = store
            .add(DeviceInput {
                name: "test".into(),
                address: "192.168.1.5".into(),
                app: "Desktop".into(),
            })
            .unwrap();
        let code = crate::access::encode_address("192.168.1.5".parse().unwrap()).unwrap();
        let other_code = crate::access::encode_address("192.168.1.6".parse().unwrap()).unwrap();
        let password = "test-password-not-plaintext";
        store
            .remember_password(&device.id, &code, password)
            .unwrap();
        assert_eq!(
            store
                .remembered_password(&device.id, &code)
                .unwrap()
                .as_deref(),
            Some(password)
        );
        assert_eq!(
            store.remembered_password(&device.id, &other_code).unwrap(),
            None
        );
        assert!(!fs::read_to_string(directory.join("devices.json"))
            .unwrap()
            .contains(password));
        assert!(!serde_json::to_string(&store.snapshot().unwrap())
            .unwrap()
            .contains(password));
        store
            .remember_password(&device.id, &code, "updated-test-password")
            .unwrap();
        assert_eq!(
            store
                .remembered_password(&device.id, &code)
                .unwrap()
                .as_deref(),
            Some("updated-test-password")
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            Store::open(&directory)
                .unwrap()
                .remembered_password(&device.id, &code)
                .unwrap()
                .as_deref(),
            Some("updated-test-password")
        );
        store.remove(&device.id).unwrap();
        assert!(store.remembered_password(&device.id, &code).is_err());
        assert!(Store::open(&directory).unwrap().data.credentials.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn device_changes_persist_and_duplicate_addresses_are_rejected() {
        let directory = temp_dir();
        let mut store = Store::open(&directory).unwrap();
        let device = store
            .add(DeviceInput {
                name: " Studio ".into(),
                address: "192.168.1.5".into(),
                app: "Desktop".into(),
            })
            .unwrap();
        assert_eq!(device.name, "Studio");
        assert!(store
            .add(DeviceInput {
                name: "Duplicate".into(),
                address: "192.168.1.5".into(),
                app: "Desktop".into(),
            })
            .is_err());
        store.favorite(&device.id).unwrap();
        let reopened = Store::open(&directory).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot.devices.len(), 1);
        assert!(snapshot.devices[0].favorite);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_existing_settings_are_not_overwritten() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("devices.json");
        fs::write(&file, "{invalid").unwrap();
        assert!(Store::open(&directory).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{invalid");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn duplicate_device_ids_after_normalization_are_rejected_without_overwriting() {
        let directory = temp_dir();
        let mut store = Store::open(&directory).unwrap();
        let device = store
            .add(DeviceInput {
                name: "First".into(),
                address: "192.168.1.5".into(),
                app: "Desktop".into(),
            })
            .unwrap();
        let file = directory.join("devices.json");
        let mut data: Persisted = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let mut duplicate = device.clone();
        duplicate.id = format!(" {} ", device.id);
        duplicate.address = "192.168.1.6".into();
        data.devices.push(duplicate);
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(&file, &bytes).unwrap();
        assert!(Store::open(&directory).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_write_does_not_change_in_memory_state() {
        let directory = temp_dir();
        let mut store = Store::open(&directory).unwrap();
        fs::create_dir_all(directory.join("devices.json")).unwrap();
        assert!(store
            .add(DeviceInput {
                name: "First".into(),
                address: "192.168.1.5".into(),
                app: "Desktop".into(),
            })
            .is_err());
        assert!(store.snapshot().unwrap().devices.is_empty());
        assert!(directory.join("devices.json").is_dir());
        fs::remove_dir_all(directory).unwrap();
    }
}
