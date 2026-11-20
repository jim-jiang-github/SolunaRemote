# SolunaRemote

基于 Tauri / WebView2 的内网远程桌面入口，搭配
[Sunshine](https://github.com/SunshineStream/Sunshine) 和
[moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) 使用。

v0.4 是同一个程序里的服务端与客户端，**无需单独安装 Sunshine 或 Moonlight**。
用户仅输入 **9 位设备码 + 访问密码**，不展示、不要求输入四位配对码。
「本机共享」启动随包 Sunshine 子进程，自动完成底层协议授权，退出即停止，不注册系统服务、
不安装驱动。客户端使用自行编译的 **soluna-stream** 原生进程，无需外部客户端：
Tauri/WebView2 显示界面，Rust 提供原生后端；
moonlight-common-c 处理 GameStream；FFmpeg 解码，SDL2
负责独立窗口、音频输出与键鼠，Opus 解码双声道音频。

**Rust 后端已接通设备码密码验证、Sunshine 配对与启动、原生串流进程和取消流程。**
设备与设置管理、Sunshine 子进程启停及固定证书的本机管理 API、TLS-PSK 访问认证、
设备码 mDNS 广播、服务端内部 PIN 配对、远端控制协议和 SDL 串流生命周期现由 Rust
后端管理。两台 Windows 测试虚拟机已实际连接并收到 1920×1080 首帧，客户端使用软件解码；
键盘输入、鼠标移动及单击和音频包已在两台 Windows 虚拟机间验证；实际扬声器出声和不同网络防火墙环境尚未完成验收。
旧 Node.js 后端已移除；Node.js 仅用于部分开发与测试工具，不是运行依赖。
旧后端的专用单元测试不再运行，其中部分协议测试尚未迁移至 Rust。

采用浅色远程协助布局，当前本地版只提供远程协助页面和设置，不展示账号式「我的设备」或独立的本机共享入口。页面集中显示本机设备 ID、访问密码与共享状态、伙伴设备连接表单和本机最近连接记录；数据仅保存在当前用户的本机目录中。品牌、图标组合和桌面插画为本项目原创，不包含网易 UU 的标识、壁纸或其他素材。

## 开发与运行

项目目录为 `C:\Users\jijiang\Github\SolunaRemote`。应用名、窗口标题、原生引擎、
应用标识、防火墙规则和发行包已统一使用 SolunaRemote 品牌。第三方依赖的正式名称、
官方来源和许可证保留，不将上游项目冒充为本项目。

此目录使用独立的 `%APPDATA%\SolunaRemote` 配置，不自动搬运旧版本的设备、
证书或访问密码。两端都应使用本版本，并重新设置共享密码；
新品牌的密码派生标识和发现服务与旧测试版本不互通。原目录及原配置保留不动。
从旧版升级时，原 12 位设备码会迁移为 9 位码并清除旧派生密钥；请在「远程协助」页面重新设置访问密码，并让连接双方更新到本版本。

源码开发与 JavaScript 自动化测试需要 Node.js（推荐 Node.js 24 LTS）、Rust stable、Visual Studio C++ Build Tools
和 WebView2 Runtime。已打包应用使用 Rust 后端；Node.js 仅用于开发脚本和自动化测试，不是运行依赖。

```powershell
npm ci
npm run build:native
npm run prepare:host
npm start
```

`npm start` 启动 Tauri 开发版；`npm run dist` 生成 Tauri NSIS 安装包。
Tauri/WebView2 负责桌面界面，Rust 进程直接运行本地后端；前端 JavaScript 和 Sunshine 的管理页面资源随应用提供，不需要 Node.js 运行时。
应用无需前端开发服务器或云端账号。直接在普通浏览器打开渲染页不会获得桌面桥接权限。

```powershell
npm test
npm run lint
npm run format:check
npm run test:native
node tests\native-ui.cjs
npm run test:tauri
npm run test:portable
npm run dist:tauri
```

原生构建需要 Visual Studio 2026 C++ 桌面开发工具和 Git。`scripts\build-native.ps1`
首次下载 vcpkg 和 CMake 清单中固定的依赖及 moonlight-common-c 递归子模块，输出
`native\bin\soluna-stream.exe`、运行库及许可文本；不安装 Sunshine，不修改防火墙。
依赖构建可能耗时较长。可设置 `VCPKG_ROOT` 复用已有 vcpkg。

`dist:tauri` 生成 `src-tauri\target\release\bundle\nsis` 下的安装包，随包带有
原生客户端和 Sunshine 引擎；发行包不携带 Node.js runtime、`node_modules` 或 JavaScript 后端；用户数据仍存于 `%APPDATA%\SolunaRemote`。
Windows 直接运行目录必须同时包含 `SolunaRemote.exe`、同级的
`libssl-3-x64.dll`、`libcrypto-3-x64.dll` 和 `vcruntime140.dll`，以及完整的 `resources` 目录。
其中两个 OpenSSL DLL 应与构建 Rust 应用时使用的版本一致，不能只依赖开发机的 PATH。
准备好原生引擎、Sunshine 和 Tauri 资源后，可以不使用 Node.js 或安装包构建新的直接运行目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-direct.ps1 -OutputDirectory release\SolunaRemote-direct
```

输出目录必须尚不存在，避免覆盖已有文件。

实验性的 Windows 单 EXE、按需加载核心 DLL 的构建使用 MSYS2 UCRT64（含 GCC、CMake、Ninja、
SDL2 及 Sunshine 的构建依赖）和 Rust GNU 主机工具链：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-embedded.ps1 -OutputDirectory release\SolunaRemote-embedded
```

该目录只有一个项目 EXE；`soluna-host.dll`、`soluna-stream.dll`、其他运行时 DLL、
Sunshine 资源和许可证均需随目录保留。两个引擎在同一 EXE 的内部子进程中按需加载，
不包含 Sunshine Web UI。此入口不改变现有 NSIS、MSIX 或 macOS 构建流程。
主机应用列表保存在用户数据目录，不需要在发行目录中附带默认 `apps.json`；
保留的桌面封面和默认封面用于兼容现有应用 ID 和客户端封面请求。

Rust Release 配置启用体积优化。`prepare:host` 固定 Sunshine 版本与官方 SHA256，
打包前检查引擎；不运行上游安装程序。
Sunshine 官方二进制包含静态 Qt 托盘支持，本程序关闭该托盘；因此「客户端无 Qt」
不代表官方服务端二进制内部也完全没有 Qt。用户只使用 SolunaRemote 界面。
构建未做代码签名，Windows 可能提示未知发布者。

### Microsoft Store / MSIX

`npm run dist:msix` 使用 Windows SDK 的 MakeAppx 构建 x64 MSIX，不使用 NSIS。
当前 MSIX 首版最低支持 Windows 11（10.0.22000），使用系统提供的 Evergreen WebView2 Runtime；
运行时仍需保留 WebView2，组织精简镜像应单独验证。现有 NSIS / 直接运行版的系统要求不变。
需先完成 `npm run build:native` 和 `npm run prepare:host`，并安装 Windows 11 SDK。
脚本会准备资源、以独立的 `microsoft-store` Cargo feature 和 target 目录编译，再验证并打包清单。
不复用普通版已编译的 EXE，避免把提权流程误打进商店包。
打包前还会检查所有 EXE/DLL 的 x64 架构和 PE 证书目录范围。
当前上游 Sunshine `v2026.914.233613` lite 包的 EXE 含有指向文件之外的无效证书目录，
会令 MSIX 签名返回 `0x800700C1`，即使 MakeAppx 和 WACK 静态检查通过也会发生。
脚本仅对 SHA256 精确匹配的已知文件，在 MSIX 暂存副本中清空该无效目录的 8 字节；
不改动代码段、不移除有效签名，也不修改 `host\bin` 原始文件。其他文件的无效目录会直接阻止打包。
MSIX 还包含仅有 `.keep` 的 `resources\host\config` 目录：
Sunshine 启动时无条件检查程序旁的该目录，缺失时会尝试在只读的 WindowsApps 中创建并失败。
实际配置、证书与日志仍通过绝对路径写入用户数据目录，不从开发机复制任何 Sunshine 用户配置。

尚未取得 Partner Center 身份时，只能生成明确标注的未签名预览包：

```powershell
npm run dist:msix -- -Preview -OutputDirectory release\SolunaRemote-msix-preview
```

预览包不能提交商店，也不能直接作为普通用户可安装的正式版本分发。
正式包的身份必须与 Partner Center 的“产品管理 > 产品标识”一致；自动发布工作流已配置当前产品身份：

```powershell
npm run dist:msix -- -IdentityName "<Package/Identity/Name>" -Publisher "<Package/Identity/Publisher>" -PublisherDisplayName "<PublisherDisplayName>" -Version 1.0.3.0 -OutputDirectory release\SolunaRemote-msix-store
```

输出目录必须尚不存在。生成的 `*.msix` 未签名，可通过身份匹配的 Partner Center 产品提交；
商店通过审核后为分发包签名，无需在仓库中存放证书。默认包版本由 `package.json` 版本追加 `.0` 得到，
也可传 `-Version 1.0.0.0`；四段均须在 0–65535 内，商店包第一段必须大于 0，最后一段固定为 0。
仓库内部应用版本仍为 0.x，而商店当前版本为 1.0.2.0，所以正式商店打包必须显式指定更高的包版本；预览包仍可使用 0.x。
`layout` 子目录保留原始包内容，便于 Windows App Certification Kit 和安装验证。

#### GitHub Actions 自动提交

`.github\workflows\publish-microsoft-store.yml` 在推送 `vMAJOR.MINOR.PATCH` 格式的 tag 时，
会构建 Windows NSIS 安装程序（`.exe`）、Store MSIX，并分别为 Apple Silicon 和 Intel Mac 构建 DMG；
这些安装包会作为 GitHub Actions artifacts 保存 30 天。MSIX 会自动提交到 Microsoft Store。
例如 `v1.0.3` 会生成商店包版本 `1.0.3.0`。
当前已发布版本为 `1.0.2.0`，因此 tag 必须更高。

在 GitHub 仓库 **Settings > Secrets and variables > Actions** 中添加
`AZURE_AD_TENANT_ID`、`AZURE_AD_APPLICATION_CLIENT_ID`、`AZURE_AD_APPLICATION_SECRET` 和
`SELLER_ID`。对应 Entra 应用需要已在 Partner Center 授权并具有 Manager 角色。
不要把这些凭据写入仓库或 tag。

该流程会提交商店审核；实际上架时间仍由 Microsoft 认证流程决定。Microsoft Store Developer CLI
当前仅支持免费商品的自动更新。仅在所有需要发布的源代码与构建脚本都已提交后创建并推送 release tag。
macOS DMG 使用临时签名且不会公证；首次下载打开时，macOS 可能要求用户在系统设置中确认。

商店版不会调用管理员提权或 PowerShell 防火墙脚本。
MSIX 清单通过 `windows.firewallRules` 为本应用的 TCP 47991 / UDP 5353，
以及内置 Sunshine 的 TCP 47984 / 47989 / 48010、UDP 47998–48000 / 48002 声明入站规则；
不开放 Web 管理端口 47990，不安装驱动、服务或上游管理工具。
规则仅覆盖专用和域网络，**不放行公用网络**。
此清单机制不支持普通版规则的 `LocalSubnet` 来源限定；它按程序、端口和网络配置文件限制，
不能视为相同的子网边界，组织策略和其他阻止规则仍可能阻止访问。
如果网络不是你信任的局域网，不要将其改成专用网络来开启共享。

打包成功不等于已通过商店认证：提交时需要说明 `runFullTrust` 用于桌面捕获、键鼠控制和启动随包引擎，
并准备隐私政策、第三方许可证、商店素材及已安装 MSIX 的实际双机串流验证。
无商店身份或测试签名时，仅能检查清单、包完整性和解包后应用启动；
不能据此宣称安装、包身份或防火墙注册已经验证。不要为测试关闭系统签名校验。
解包后可运行 `node tests\packaged-smoke.cjs <解包目录>\SolunaRemote.exe --msix`，
检查依赖、界面启动、后端商店构建标记和导航，但这不替代安装态测试。

macOS 源码构建需要初始化 Sunshine 及其子模块，并安装 CMake、SDL2、FFmpeg、Opus、OpenSSL、
nlohmann-json、pkg-config、Rust 和 Node.js。在 Mac 上运行 `npm run prepare:host:macos`
从 `third-party/Sunshine` 编译精简主机，再运行 `npm run start:tauri:macos`
启动 Tauri 开发版，或 `npm run dist:tauri:macos` 构建 DMG。Tauri 资源准备会构建并包含
原生 `soluna-stream`。主机编译阶段会生成临时的 Sunshine.app；资源准备仅提取其中的共享引擎二进制，
并将引擎、依赖库和必要资源放入唯一的 `SolunaRemote.app`，不再释放或安装独立的 `Sunshine.app`。
程序以编译时固定的归档哈希和辅助程序签名哈希校验随包资源。代码使用临时签名，不能将其当作官方签名或公证。
DMG 构建会将客户端依赖的动态库复制进应用包，并对应用进行临时签名。
构建使用 `host/build-macos-local` 和 `host/bin-macos-local`；脚本只复用自己创建的构建目录，不覆盖已有产物。

从 macOS 15 或更新版本发起连接时，SolunaRemote 会在访问密码验证前检查到目标的本地网络权限。
系统明确拒绝时，应用会自动打开“系统设置 > 隐私与安全性 > 本地网络”，连接表单也会保留手动打开设置的按钮。授权后重新连接即可。

macOS 本机共享不强制开启系统防火墙；防火墙关闭时直接继续启动，不要求防火墙授权。
若防火墙已开启，需在“系统设置 > 网络 > 防火墙”选项中允许
Finder 定位到的 SolunaRemote.app 接受传入连接。点击开启共享后，若检查未通过，应用会显示授权说明。
用户点击“打开防火墙设置”后自行操作，再点击“重新检查并开启共享”；只有检查通过才启动。
定位按钮只显示当前版本的 SolunaRemote.app，取消不会启动共享。应用不会代替用户开启防火墙或添加规则。
开启共享前会检查辅助功能权限（部分 macOS 版本称为“设备控制和数据访问”）；未授权时会自动打开对应的系统设置。
从应用打开辅助功能设置后，应用会在 5 分钟内复查授权。确认当前版本已获授权且没有运行中的共享或串流时，会自动重新打开；重新打开后再开启共享。
开启共享时会提前请求屏幕录制权限，无需等待客户端连接；如果系统没有弹出提示，请在
“隐私与安全性 > 屏幕录制”中为 SolunaRemote 授权。相关权限必须由用户明确授予。
Sunshine 的 macOS 支持仍属实验性，此入口用于测试，不代表
macOS 已完成发行验收、代码签名、公证或 GitHub Actions 打包验证。

## Windows 虚拟机 SSH 部署入口

先在**连接端电脑**双击 `vm-ssh-setup\PREPARE-HOST.bat`，按提示为新私钥设置口令。
脚本在本机用户目录下的受限文件夹生成私钥，并将对应公钥放入 `vm-ssh-setup`；
输出会列出私钥路径。只复制 `vm-ssh-setup` 文件夹到目标机，私钥留在连接端，不能放进脚本或复制到虚拟机。
目标机仍只需运行一次 `START.bat`（除非 Windows 安装功能后要求重启）。脚本追加新公钥，
不替换已有授权。连接前仍须通过可信控制台核对目标机的主机密钥指纹。

将整个 `vm-ssh-setup` 文件夹复制到 Windows 11 测试虚拟机（建议放在桌面），双击里面的 **`START.bat`**，在 Windows 管理员权限提示中选择“是”。不要在宿主机运行。文件夹包含 BAT 入口、自动提权启动脚本、SSH 配置脚本、公钥和 `settings.json`，不含私钥，也不需要 Node.js。启动脚本会安装 `solunaremote-vm-v2.pub`；与它匹配的私钥应留在连接端。

完成后窗口会保留结果；同目录的 `setup.log` 记录本次执行详情，包含用户名、虚拟机 IP 和主机密钥指纹。失败或取消权限授权会明确报错，不会显示成功。若需要另一管理员账号授权，SSH 用户是实际批准提权的本地管理员账号。

若提示 `Failed to start service`，新版脚本会在 `setup.log` 中补充服务退出码、服务程序路径、原始异常和最近的 Windows/OpenSSH 事件；请提供该日志以定位原因，不要为此关闭防火墙或盲目替换系统权限。该错误发生在服务启动阶段，并不代表网络或密钥认证失败。

服务启动失败后，还会执行最长 8 秒的前台 `sshd -ddd` 调试并记录输出。调试前验证仅监听 `127.0.0.1:22222`，有其他监听地址的自定义配置会跳过；结束时只停止本次调试子进程。调试以当前管理员而非服务的 LocalSystem 身份运行，因此即使前台能够启动，也不会标记服务成功。

针对“管理员前台可启动、LocalSystem 服务退出”的情况，会先对已停止且启动路径为标准 `sshd.exe` 的 LocalSystem 服务临时追加 `-E` 文件日志重试。重试使用原配置端口及已限制来源的防火墙，不修改服务账号、配置或主机密钥；结束时停止本次服务重试并在 `finally` 中恢复原启动命令。日志文件仅授权 SYSTEM/Administrators，保存在 `%ProgramData%\ssh\setup-service-*.log`，内容也写入 `setup.log` 的 `SSH LOCALSYSTEM SERVICE LOG` 部分。若在临时重试期间断电，应按日志打印的原命令恢复服务启动路径。

默认 `settings.json` 只允许宿主机 `172.22.96.1` 连接；更换宿主机网络时修改其中的 `AllowedRemoteAddress` 数组。可在命令行运行 `START.bat --check` 做无修改预览，不会弹出提权提示。高级用法仍可在虚拟机管理员 PowerShell 中直接运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Enable-VmSsh.ps1 -AllowedRemoteAddress 172.22.96.1
```

这里的 `172.22.96.1` 是本次宿主机的 Hyper-V Default Switch 地址，不是虚拟机地址。虚拟机若使用外部交换机，应改为实际连接它的宿主机 IPv4；可以传入多个明确地址，不接受通配符或整个网段。先追加 `-WhatIf` 可预览，不安装或修改系统。脚本需要访问 Windows 可选功能源，安装失败会直接报错；如果提示重启，请重启虚拟机后重跑。

脚本安装 Windows OpenSSH Server、设置 `sshd` 自动启动、保留并追加公钥，修正管理员公钥文件的 ACL，并将 `OpenSSH-Server-In-TCP` 规则限制到指定来源的 TCP 22（适用于包括 Hyper-V 未识别网络在内的所有防火墙配置文件）。不会关闭防火墙、开放其他端口、修改密码登录策略或覆盖已有 `sshd_config`；遇到不兼容的自定义 SSH 配置会报错。已有其他规则或组织策略仍可能放行或阻止 SSH，本脚本不会删除这些规则。重复执行不会重复添加同一公钥。

生成主机密钥后，脚本只对 `%ProgramData%\ssh` 下的三份标准主机私钥 `ssh_host_rsa_key`、`ssh_host_ecdsa_key`、`ssh_host_ed25519_key` 修正权限：所有者设为内置 Administrators，关闭继承，仅允许 SYSTEM 和 Administrators 完全控制。这样避免管理员生成的私钥在 LocalSystem 服务下因 `Bad owner` / `no hostkeys available` 被拒绝。不会递归修改目录权限，不替换现有密钥内容或指纹；权限设置失败会直接报错。

**权限边界：** 使用运行脚本的当前本地管理员账号；这是部署用的管理员 SSH 权限。遵循 Windows OpenSSH 默认行为，公钥写入共享的 `%ProgramData%\ssh\administrators_authorized_keys`，因此该密钥可用于其他被 SSH 策略允许登录的本地管理员账号，而非只绑定一个用户名。只把公钥复制到虚拟机，绝不要复制私钥。

执行完成后保留输出的 **SSH user、VM IPv4 和主机密钥指纹**。在宿主机连接时，用实际用户名和虚拟机地址替换下面的 `User` / `VM_IP`：

```powershell
$key = 'C:\absolute\path\to\original-vm-private-key'
$knownHosts = 'C:\absolute\path\to\verified-known-hosts'
ssh -i $key -o IdentitiesOnly=yes -o "UserKnownHostsFile=$knownHosts" -o StrictHostKeyChecking=yes User@VM_IP whoami
```

首次连接必须通过可信的虚拟机控制台核对 SHA256 指纹后再保存信任记录，不能关闭主机密钥校验。
私钥和已核验的主机记录不在项目中。应使用准备部署文件夹时输出的私钥路径，或恢复先前的私钥；
找不到时可由虚拟机管理员授权安装新公钥，不能将“TCP 22 可达”当作已登录。

本机可用以下只读命令检查虚拟机 SSH 端口：

```powershell
Test-NetConnection VM_IP -Port 22
```

端口可达不代表 SSH 已认证，实际登录仍需使用上面的严格主机密钥验证命令。

连接成功后，可以复制当前版本的便携包（不在 SSH 会话中启动桌面 GUI）：

```powershell
# 在宿主机项目目录执行；首次构建或源码更新后运行 npm run dist。
$version = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
$artifact = ".\release\SolunaRemote-$version-windows-x64.exe"
ssh -i $key -o IdentitiesOnly=yes User@VM_IP 'powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force C:\SolunaRemote | Out-Null"'
scp -i $key -o IdentitiesOnly=yes $artifact 'User@VM_IP:C:/SolunaRemote/'
```

`scp` 远端目标使用的是 SCP 协议路径语法；在虚拟机已登录的桌面中运行 `C:\SolunaRemote` 下的 EXE。SSH 非交互会话不等于桌面会话，不能据此验证画面、键鼠、Sunshine 捕获或 Moonlight 串流；这些仍需在虚拟机交互桌面中测试。SSH 连接和包复制成功也不代表串流成功。测试结束后可在虚拟机管理员 PowerShell 中执行 `Stop-Service sshd`、`Set-Service sshd -StartupType Disabled`、`Disable-NetFirewallRule -Name OpenSSH-Server-In-TCP` 停止此部署入口（这也会影响原有 SSH 使用者）。

## 两台电脑的首次连接

1. **被控电脑**：启动同一个 SolunaRemote，在「远程协助」页面查看本机 9 位设备 ID 和临时密码，或设置固定密码（非空即可，无需复杂度组合；最多 128 个字符），再开启协助。临时密码保存在内存中，应用重启时刷新，**不会在每次远控结束时自动刷新**。Windows 上新设的固定密码使用当前用户的系统数据保护加密保存，可重启后查看；旧版只保存派生密钥的密码不能找回，须重新设置才能查看。其他系统的固定密码仅在本次运行中可查看。Windows 开启共享前会检查当前应用路径对应的防火墙规则；缺少授权时先显示说明，点击“授权并开启共享”后才请求 Windows 管理员权限。批准后仅添加或启用本应用和内置 Sunshine 所需的本地子网入站规则，包含串流端口、TCP 47991 密码认证和 UDP 5353 设备发现，不开放 Web 管理端口、不关闭防火墙。规则复查通过才启动共享，已生效的规则不重复请求授权；取消、授权失败或规则未生效会明确报错，组织策略和其他阻止规则仍可能影响连接。
2. **控制电脑**：启动 SolunaRemote，使用随包 soluna-stream；源码版先运行 `npm run build:native`。首次建议 H.264、720p、30 FPS。

   密码验证成功后，最近连接会记住该设备的密码，选择设备时自动填充。Windows 使用当前用户的系统数据保护加密保存；其他系统仅在当前应用运行期间记住。删除设备会删除其已保存密码。旧连接记录没有保存过的密码，需要重新连接一次；对方的临时密码刷新后也需重新输入。

3. 在「远程协助」页面填写对方的 9 位设备 ID 和访问密码，点击「连接」。设备 ID 可在本地校验并解析，不依赖组播、不扫描网段、不访问云注册中心。应用自动选择系统默认网络；mDNS 保留为辅助发现机制。连接记录会显示在同页的「最近连接」中。
4. 双方通过标准 TLS 1.2 ECDHE-PSK + ChaCha20-Poly1305 验证密码并加密控制请求，不依赖未知自签名证书。PSK 由 scrypt（N=32768, r=8, p=1）从密码与设备码派生；密码本身不传输。Windows 固定密码使用系统数据保护加密存储。程序内部使用随机一次性标识和临时 PIN 完成 Sunshine 原生授权，用户不参与此步骤。
5. 点击「进入桌面」，在独立的 SDL 窗口使用远程桌面。按 `Ctrl + Alt + F12` 或关闭窗口退出。只有收到并实际渲染首帧才显示串流成功。

Windows 会话窗口使用紧凑浅色顶栏，显示远端设备名、桌面标签、实际连接状态和连接时长。
「控制中心」可切换全屏、静音、开关性能悬浮层及断开连接；顶栏支持拖动、边缘缩放、
最小化与最大化，操作顶栏不会把点击发给远端。性能层显示实际渲染 FPS、收到的编码视频码率、
协议 RTT 和 Opus 包数，不是示例数据；码率不包含网络开销，RTT 不是端到端画面延迟。
Windows 串流窗口支持远端多显示器切换：标题栏可快速切换显示屏 1–3，
「控制中心」的显示屏网格可选 1–12。切换通过 Sunshine 的
`Ctrl+Alt+Shift+F1` 至 `Ctrl+Alt+Shift+F12` 热键发送；显示屏数量由被控端决定，
超出实际屏幕数量的编号不会产生有效画面。macOS 暂保留 SDL 原生标题栏，尚未验证。
`node tests\native-ui.cjs` 使用合成 H.264 / Opus 驱动真实 SDL 窗口，实际点击控制中心、
性能开关和断开连接并保存截图；不代表真实远端键鼠、网络或扬声器出声已验证。

`tests\live-password.cjs` 是显式启用的真实虚拟机联调入口，不属于模拟测试：
它启动 Tauri 客户端并使用隔离配置，通过 SSH 的本地 CDP 转发操作测试虚拟机中的同一应用，
验证错误密码被拒绝、正确密码连接、实际渲染帧以及真实鼠标点击和键盘输入。
此测试会更新虚拟机测试配置的访问密码并在结束时停止共享；不要用于日常配置。
`test:portable` 启动 Release 文件夹中的 Tauri EXE，检查随包资源、后端和页面导航。
运行原生 UI 自动化期间不要切换本地焦点；测试只允许向已核验的所属原生窗口注入输入，
失去前台焦点会终止，截图也要求该窗口保持前台。联调不证明扬声器有声或 macOS 支持。

内置主机的管理身份由主进程生成，保存在当前用户的 `host` 数据目录，不发送到 renderer；
管理 API 只从本机请求，并固定验证该实例生成的证书。共享默认关闭，不自动开机运行。
保持被控桌面登录、屏幕捕获和编码器可用。切勿同时运行占用相同端口的独立 Sunshine。
底层继续使用 Sunshine 协议；新的设备码/密码入口要求两端都运行 SolunaRemote。

访问密码派生密钥保存在当前用户的 `access\access.json`，它也是敏感凭据，不要分享。
每次开启共享会撤销以前的 Sunshine 客户端证书授权，连接必须重新验证访问密码。
密码只能在停止共享时修改，修改后下次开启生效。密码错误会拒绝连接；服务端限制每个地址
每分钟至多 10 次 TLS 连接和 8 个同时连接。密码不强制复杂度组合，但 PSK 身份认证不能让弱密码免受离线猜测，建议使用难猜的密码。
设备 ID 不是公网 ID，也不是全球注册的永久身份；它由应用根据系统默认网络生成。
应用会自动选择系统默认路由，不需要手动选择网卡。默认网络变化后，设备 ID 会更新，
并需要重新保存访问密码。跨子网是否可达取决于网络路由和防火墙，不通过云端补救。

### 串流与配对状态的边界

- 在线状态来自实际 HTTP `/serverinfo` GameStream XML 检测，不是模拟数据。显示的“探测 ms”包含连接与 HTTP 耗时，**不是**视频串流延迟。
- Rust 客户端流程通过 TLS-PSK 验证设备码与密码，并行完成受 PIN 保护的 Sunshine 配对，固定主机证书后查询应用并请求 launch/resume；Windows 双虚拟机已验证首帧、键盘输入和鼠标移动及单击。
- 对每台主机固定其证书，不使用全局 TLS 验证关闭开关。证书变化会报错，需要确认主机身份后重新配对。
- 进程配置（含临时输入加密密钥）通过 stdin 传递，不写入命令行、日志或 renderer；stdout 使用有界 JSON 事件报告连接阶段、首帧及帧数。
- 串流打开 **独立 SDL 窗口**，不嵌入桌面界面。当前使用 SDR/YUV420、双声道、绝对鼠标和常用键盘按键；没有剪贴板、IME 文本同步或手柄。
- Windows 尝试 FFmpeg D3D11VA，macOS 代码路径尝试 VideoToolbox，不可用时明确报告并使用软件解码。硬解码帧需要 CPU 拷贝到 SDL，**不是零拷贝**。默认 auto 首版选择 H.264；HEVC/AV1 取决于双方编解码器。
- Sunshine 内部 PIN 授权有 20 秒等待上限，原生串流在 30 秒内未收到首帧会报错；进程启动或 HTTP 在线不等于连接成功。原生 self-test 使用自行生成的 H.264 I_PCM 图像与 Opus 静音，验证本机解码、SDL 窗口和音频排队，不证明真实网络、硬解码、扬声器有声或远端输入。
- 一次只管理一个本工具的串流或配对；取消会中止当前操作或通过 stdin 请求原生进程退出，协议调用可能要等当前网络超时后才完全停止。不按进程名清理，不关闭远端应用。若主机有其他应用运行则拒绝启动，不强制抢占。
- 快速启动只能选择 Sunshine 已配置的应用名称，不会在远端执行脚本或任意命令。

## 仅内网的约束

主进程允许 RFC1918 IPv4（`10/8`、`172.16/12`、`192.168/16`）、IPv4 回环和链路本地地址。拒绝公网、IPv6、网址、命令片段；主机名的全部 IPv4 解析结果都必须通过相同检查。探测、串流和管理链接使用校验后的数字地址，避免再次解析主机名；HTTP 不跟随重定向，响应有大小和时间限制。

应用不注册公网服务，不做 NAT 穿透、网段扫描、云中转或自动更新。mDNS 查询仅作用于本地组播。外部 GitHub 发布页仅在你主动点击下载按钮时由系统浏览器打开。

**这不代替操作系统的网络策略。** 内置主机禁用 UPnP，禁止路由器端口转发。
开启共享时，仅在需要且用户批准管理员权限后添加/更新本应用规则，来源限制为 Windows 定义的 `LocalSubnet`；
不会删除已有组织规则，因此应检查是否存在其他宽泛规则。规则在停止共享后保留，
但本应用子进程会退出、停止监听。规则适用于所有防火墙配置文件，`LocalSubnet` 可能包括公共网络或 VPN 接口的本地子网，并非严格限制为私有 IPv4。
原生客户端再次拒绝公网目标，RTSP 地址必须匹配已校验主机。

## 已实现

- Tauri 原生窗口和受限命令桥接；Rust 后端在应用进程内运行，渲染器没有 Node.js 权限。
- 单页远程协助、本机设备 ID 与共享控制、伙伴设备连接和本地最近连接记录，不依赖账号或联网服务。
- 连接成功后保留本机设备记录、收藏和按设备保存的快速启动。
- 原子写入的设备与串流配置持久化；损坏文件保留并明确报错，不静默清空。
- mDNS 查找 Sunshine、手动刷新和每 15 秒的可见窗口状态检测。
- 原生引擎启动、实际 PIN 协议、首帧状态、取消与进程退出处理。
- 内置 Sunshine 生命周期、应用内 PIN 授权、受限防火墙入口和原生客户端文件选择。
- 1080p / 1440p / 4K、30–120 FPS、码率、编码和显示模式配置。

暂不包含文件传输、终端、端口映射、嵌入式播放器、无人值守系统服务或驱动安装。
未找到引擎或设备离线时，连接动作禁用并显示原因。内置服务端当前仅提供 Windows 包。

## 数据与测试

设备及设置存储于 `%APPDATA%\SolunaRemote\devices.json`。
`identity` 子目录保存独立客户端私钥、证书及按主机地址保存的已验证证书。不要分享此目录。Windows 使用当前用户目录的 ACL，其他系统创建私钥文件为 0600、目录为 0700。本工具不读取已有 Moonlight 身份；原生客户端始终使用随包引擎，不提供可执行文件路径设置。旧 `moonlightPath` 会保留以兼容已有数据，旧 HTML localStorage 不自动迁移。

需要独立配置时，可以通过 `--user-data-dir=C:\absolute\profile` 指定绝对数据目录；这不会迁移或覆盖原有配置。便携 EXE 默认仍使用当前系统用户的应用数据目录，并不将配对凭据放在 EXE 旁。

单元测试覆盖内网、DNS、持久化、原生生命周期、内部挑战签名、固定证书及 launch/resume；
访问密码测试使用真实 TLS-PSK 握手与 Node/OpenSSL，包括错误密码拒绝、正确密码成功和敏感信息不进入状态快照。
`test:tauri` 启动真实 Tauri/WebView2 界面和后端，并探测指定虚拟机；协议测试仍不等于真实 Sunshine 串流。

UI 测试不等于完整的真实串流验收。双虚拟机已验证配对、首帧、键盘、鼠标移动及单击和接收音频包；其他鼠标操作、实际扬声器出声、硬件编解码、UDP 连接质量及平台打包签名仍需实测。测试截图输出到 `test-results`，不写入应用数据目录。

## 上游许可

本项目的 `native\src` 以 GPL-3.0-or-later 提供，链接 GPL 系列的 moonlight-common-c。
构建固定上游提交 `d5b38a3ac63927a11bebd8337df024f11eba34d5` 及其递归子模块。
发布原生二进制时必须保留 `native\bin\licenses`，并按各许可证提供本项目原生源码、
构建脚本及全部对应上游源码；仅附许可证不等于满足源码提供义务。源码保存在本次构建的
`native\build\_deps` 与 `native\.tools\vcpkg\buildtrees`，分发前应归档完整对应源码，
不要依赖可被清理的本机构建缓存。Sunshine 随包便携引擎同样需要遵循 GPL 源码提供义务；
版本、来源和分发要求见 `host\THIRD-PARTY-NOTICES.txt`。对外分发前归档完整对应源码，
不能仅用源码链接替代许可证要求。上游内置 Web 素材保持原样，不用作本项目品牌。
