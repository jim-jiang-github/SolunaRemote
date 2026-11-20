use std::{sync::mpsc, time::Duration};
use tauri::AppHandle;
use windows::{
    core::AgileReference,
    Services::Store::StoreContext,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct WinRtApartment;

impl WinRtApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| format!("无法初始化 Microsoft Store 更新服务：{error}"))?;
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub async fn check_and_request(app: AppHandle) -> Result<bool, String> {
    let updates = tauri::async_runtime::spawn_blocking(check_available_updates)
        .await
        .map_err(|error| format!("Microsoft Store 更新检查任务失败：{error}"))??;
    let Some(updates) = updates else {
        return Ok(false);
    };

    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = request_install(updates);
        if sender.send(result).is_err() {
            eprintln!("无法返回 Microsoft Store 更新请求结果。");
        }
    })
    .map_err(|error| format!("无法启动 Microsoft Store 更新请求：{error}"))?;

    receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|error| format!("等待 Microsoft Store 更新请求超时：{error}"))??;
    Ok(true)
}

fn check_available_updates() -> Result<
    Option<
        AgileReference<
            windows_collections::IVectorView<windows::Services::Store::StorePackageUpdate>,
        >,
    >,
    String,
> {
    let _apartment = WinRtApartment::initialize()?;
    let context =
        StoreContext::GetDefault().map_err(|error| format!("无法连接 Microsoft Store：{error}"))?;
    let updates = context
        .GetAppAndOptionalStorePackageUpdatesAsync()
        .map_err(|error| format!("无法检查 Microsoft Store 更新：{error}"))?
        .join()
        .map_err(|error| format!("Microsoft Store 更新检查失败：{error}"))?;
    if updates
        .Size()
        .map_err(|error| format!("无法读取 Microsoft Store 更新列表：{error}"))?
        == 0
    {
        Ok(None)
    } else {
        AgileReference::new(&updates)
            .map(Some)
            .map_err(|error| format!("无法传递 Microsoft Store 更新列表：{error}"))
    }
}

fn request_install(
    updates: AgileReference<
        windows_collections::IVectorView<windows::Services::Store::StorePackageUpdate>,
    >,
) -> Result<(), String> {
    let updates = updates
        .resolve()
        .map_err(|error| format!("无法读取 Microsoft Store 更新列表：{error}"))?;
    let context =
        StoreContext::GetDefault().map_err(|error| format!("无法连接 Microsoft Store：{error}"))?;
    let operation = context
        .RequestDownloadAndInstallStorePackageUpdatesAsync(&updates)
        .map_err(|error| format!("无法启动 Microsoft Store 更新：{error}"))?;
    drop(operation);
    Ok(())
}
