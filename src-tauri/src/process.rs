use std::{ffi::OsStr, process::Command};

pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn native_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = background_command(program);
    #[cfg(all(target_os = "windows", feature = "embedded-sunshine"))]
    command.arg("--soluna-stream");
    command
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn background_process_has_no_console_window() {
        let script = "Add-Type -Name Native -Namespace Test -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'; [Test.Native]::GetConsoleWindow().ToInt64()";
        let output = background_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .expect("PowerShell should start");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[test]
    fn native_command_selects_the_embedded_entry_point() {
        let command = native_command("example.exe");
        let args: Vec<_> = command.get_args().collect();
        if cfg!(feature = "embedded-sunshine") {
            assert_eq!(args, [std::ffi::OsStr::new("--soluna-stream")]);
        } else {
            assert!(args.is_empty());
        }
    }
}
