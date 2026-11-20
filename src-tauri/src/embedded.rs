use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path};

pub const HOST_DLL: &str = "soluna-host.dll";
pub const STREAM_DLL: &str = "soluna-stream.dll";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

pub fn component_exists(executable: &Path, name: &str) -> bool {
    executable
        .parent()
        .is_some_and(|directory| directory.join(name).is_file())
}

fn entry_point(name: &str, symbol: &'static [u8]) -> Result<*mut c_void, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位应用程序：{error}"))?;
    let directory = exe.parent().ok_or("应用程序目录无效。")?;
    let path = directory.join(name);
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Restrict dependency lookup to the DLL's own directory and Windows' trusted directories.
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x0000_1100) };
    if module.is_null() {
        return Err(format!(
            "无法加载 {}：{}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let entry = unsafe { GetProcAddress(module, symbol.as_ptr()) };
    if entry.is_null() {
        return Err(format!(
            "{} 缺少入口函数：{}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(entry)
}

pub fn run_stream(argc: i32, argv: *mut *mut u16) -> Result<i32, String> {
    let entry = entry_point(STREAM_DLL, b"soluna_stream_main\0")?;
    let main: unsafe extern "C" fn(i32, *mut *mut u16) -> i32 =
        unsafe { std::mem::transmute(entry) };
    Ok(unsafe { main(argc, argv) })
}

pub fn run_host(argc: i32, argv: *mut *mut std::ffi::c_char) -> Result<i32, String> {
    let entry = entry_point(HOST_DLL, b"soluna_sunshine_main\0")?;
    let main: unsafe extern "C" fn(i32, *mut *mut std::ffi::c_char) -> i32 =
        unsafe { std::mem::transmute(entry) };
    Ok(unsafe { main(argc, argv) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_component_reports_an_error() {
        let executable = std::env::current_exe().unwrap();
        assert!(!component_exists(
            &executable,
            "missing-soluna-component.dll"
        ));
        let error = entry_point("missing-soluna-component.dll", b"missing\0").unwrap_err();
        assert!(error.contains("missing-soluna-component.dll"));
    }
}
