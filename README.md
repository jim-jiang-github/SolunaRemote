# SolunaRemote

基于 Electron 的内网远程桌面入口，搭配
[Sunshine](https://github.com/SunshineStream/Sunshine) 和
[moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) 使用。

v0.4 是同一个程序里的服务端与客户端，**无需单独安装 Sunshine 或 Moonlight**。
用户仅输入 **12 位设备码 + 访问密码**，不展示、不要求输入四位配对码。
「本机共享」启动随包 Sunshine 子进程，自动完成底层协议授权，退出即停止，不注册系统服务、
不安装驱动。客户端使用自行编译的 **soluna-stream** 原生进程，无需外部客户端：
Electron 管理配对与应用；moonlight-common-c 处理 GameStream；FFmpeg 解码，SDL2
负责独立窗口、音频输出与键鼠，Opus 解码双声道音频。

采用浅色双栏、设备详情、桌面入口和快速启动布局，品牌、图标组合和桌面插画为本项目原创，不包含网易 UU 的标识、壁纸或其他素材。原来的浏览器设备清单原型已替换为桌面应用。

## 开发与运行

项目目录为 `C:\Users\jijiang\Github\SolunaRemote`。应用名、窗口标题、原生引擎、
应用标识、防火墙规则和发行包已统一使用 SolunaRemote 品牌。第三方依赖的正式名称、
官方来源和许可证保留，不将上游项目冒充为本项目。

此目录使用独立的 `%APPDATA%\SolunaRemote` 配置，不自动搬运旧版本的设备、
证书或访问密码。两端都应使用本版本，并重新设置共享密码、授权控制端内网地址；
新品牌的密码派生标识和发现服务与旧测试版本不互通。原目录及原配置保留不动。

需要支持当前 Electron / ESLint 工具链的 Node.js（推荐 Node.js 24 LTS；本次使用 Node.js 26）。

```powershell
npm ci
npm run build:native
npm run prepare:host
npm start
```

应用无需前端开发服务器或云端账号。直接在普通浏览器打开渲染页不会获得文件、网络或进程权限，必须使用 Electron 启动。

```powershell
npm test
npm run lint
npm run format:check
npm run test:e2e
npm run test:native
node tests\native-ui.cjs
npm run pack
npm run dist
node tests\packaged-smoke.cjs
node tests\packaged-smoke.cjs release\SolunaRemote-0.4.0-windows-x64.exe --portable
```

原生构建需要 Visual Studio 2026 C++ 桌面开发工具和 Git。`scripts\build-native.ps1`
首次下载 vcpkg 和 CMake 清单中固定的依赖及 moonlight-common-c 递归子模块，输出
`native\bin\soluna-stream.exe`、运行库及许可文本；不安装 Sunshine，不修改防火墙。
依赖构建可能耗时较长。可设置 `VCPKG_ROOT` 复用已有 vcpkg。

`pack` 生成 `release\win-unpacked\SolunaRemote.exe`，`dist` 生成 Windows 便携包，
两者包含 `native\bin` 客户端与 `host\bin` 的官方 Sunshine 便携引擎。
`prepare:host` 固定版本与官方 SHA256，打包前检查引擎；不运行上游安装程序。
Sunshine 官方二进制包含静态 Qt 托盘支持，本程序关闭该托盘；因此「客户端无 Qt」
不代表官方服务端二进制内部也完全没有 Qt。用户只使用 SolunaRemote 界面。
构建未做代码签名，Windows 可能提示未知发布者。`packaged-smoke` 使用独立临时目录。

macOS 源码构建入口为 `native\CMakeLists.txt`，需要 CMake、SDL2、FFmpeg、Opus、OpenSSL、
nlohmann-json（建议同一 vcpkg 工具链）；配置、构建后将可执行文件及动态库置于 `native\bin`。
macOS 的 VideoToolbox、窗口、权限、签名和分发尚未实测，不能视为已支持的发行包。

## Windows 虚拟机 SSH 部署入口

将项目中的 **`vm-ssh-setup` 整个文件夹复制到 Windows 11 测试虚拟机**（建议放在桌面），双击里面的 **`START.bat`**，在 Windows 管理员权限提示中选择“是”。不要在宿主机运行。文件夹包含 BAT 入口、自动提权启动脚本、SSH 配置脚本、公钥和 `settings.json`，不含私钥，也不需要 Node.js。

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
私钥和已核验的主机记录不在项目中；本会话没有原先部署会话的私钥。找不到文件时应恢复原有文件，
或由虚拟机管理员明确授权安装新公钥，不能将“TCP 22 可达”当作已登录。

本机到虚拟机的只读复测命令：

```powershell
node scripts\test-vm.cjs 172.22.98.13
node scripts\test-vm.cjs 172.22.98.13 --identity $key --known-hosts $knownHosts --user 'windev2407eval\user'
```

输出 JSON 包含 TCP 22、GameStream HTTP/HTTPS、管理端口及真实 `/serverinfo` 探测。
只有明确提供原有身份和信任文件才执行 SSH `whoami`，始终启用严格主机密钥检查。
探测失败返回非零退出码；不会安装软件、修改证书、跳过授权或修改防火墙。

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

1. **被控电脑**：启动同一个 SolunaRemote，在「本机共享」设置至少 12 个字符的访问密码，然后开启共享。页面显示当前设备码。输入控制端私有 IPv4，点击授权设备访问并确认管理员提示。仅放行该地址的串流端口、TCP 47991 密码认证和 UDP 5353 设备发现，不开放 Web 管理端口，不关闭防火墙。
2. **控制电脑**：启动 SolunaRemote，使用随包 soluna-stream；源码版先运行 `npm run build:native`。首次建议 H.264、720p、30 FPS。
3. 点击「设备码连接」，填写对方的设备码和访问密码。设备码编码所选内网 IPv4 与校验位，可直接解析，不依赖组播、不扫描网段、不访问云注册中心。mDNS 保留为辅助发现机制。
4. 双方通过标准 TLS 1.2 ECDHE-PSK + ChaCha20-Poly1305 验证密码并加密控制请求，不依赖未知自签名证书。PSK 由 scrypt（N=32768, r=8, p=1）从密码与设备码派生；密码本身不传输、不保存。程序内部使用随机一次性标识和临时 PIN 完成 Sunshine 原生授权，用户不参与此步骤。
5. 点击「进入桌面」，在独立的 SDL 窗口使用远程桌面。按 `Ctrl + Alt + F12` 或关闭窗口退出。只有收到并实际渲染首帧才显示串流成功。

Windows 会话窗口使用紧凑浅色顶栏，显示远端设备名、桌面标签、实际连接状态和连接时长。
「控制中心」可切换全屏、静音、开关性能悬浮层及断开连接；顶栏支持拖动、边缘缩放、
最小化与最大化，操作顶栏不会把点击发给远端。性能层显示实际渲染 FPS、收到的编码视频码率、
协议 RTT 和 Opus 包数，不是示例数据；码率不包含网络开销，RTT 不是端到端画面延迟。
第一版是单桌面串流，不提供多显示器切换；macOS 暂保留 SDL 原生标题栏，尚未验证。
`node tests\native-ui.cjs` 使用合成 H.264 / Opus 驱动真实 SDL 窗口，实际点击控制中心、
性能开关和断开连接并保存截图；不代表真实远端键鼠、网络或扬声器出声已验证。

`tests\live-password.cjs` 是显式启用的真实虚拟机联调入口，不属于模拟测试：
它使用隔离客户端配置，通过 SSH 的本地 CDP 转发操作测试虚拟机中的同一应用，
验证错误密码被拒绝、正确密码连接、实际渲染帧以及真实鼠标点击和键盘输入。
此测试会更新虚拟机测试配置的访问密码并在结束时停止共享；不要用于日常配置。
运行原生 UI 自动化期间不要切换本地焦点；测试只允许向已核验的所属原生窗口注入输入，
失去前台焦点会终止，截图也要求该窗口保持前台。联调不证明扬声器有声或 macOS 支持。

内置主机的管理身份由主进程生成，保存在当前用户的 `host` 数据目录，不发送到 renderer；
管理 API 只从本机请求，并固定验证该实例生成的证书。共享默认关闭，不自动开机运行。
保持被控桌面登录、屏幕捕获和编码器可用。切勿同时运行占用相同端口的独立 Sunshine。
底层继续使用 Sunshine 协议；新的设备码/密码入口要求两端都运行 SolunaRemote。

访问密码派生密钥保存在当前用户的 `access\access.json`，它也是敏感凭据，不要分享。
每次开启共享会撤销以前的 Sunshine 客户端证书授权，连接必须重新验证访问密码。
密码只能在停止共享时修改，修改后下次开启生效。密码错误会拒绝连接；服务端限制每个地址
每分钟至多 10 次 TLS 连接和 8 个同时连接。强随机密码仍然必要：PSK 身份认证不能让弱密码免受离线猜测。
设备码不是公网 ID，也不是全球注册的永久身份；它对应所选网卡的内网 IP。
在「共享网卡」选择与控制端互通的接口；DHCP 或网卡变化后须停止共享、重新选择网卡并设置密码，
设备码也会改变。跨子网是否可达取决于内网路由和防火墙，不通过云端补救。

### 串流与配对状态的边界

- 在线状态来自实际 HTTP `/serverinfo` GameStream XML 检测，不是模拟数据。显示的“探测 ms”包含连接与 HTTP 耗时，**不是**视频串流延迟。
- Node 主进程实现 Sunshine 第 7 代配对、双向证书 HTTPS、应用列表和 launch/resume；证书只在完整 PIN 证明成功后保存。
- 对每台主机固定其证书，不使用全局 TLS 验证关闭开关。证书变化会报错，需要确认主机身份后重新配对。
- 进程配置（含临时输入加密密钥）通过 stdin 传递，不写入命令行、日志或 renderer；stdout 使用有界 JSON 事件报告连接阶段、首帧及帧数。
- 串流打开 **独立 SDL 窗口**；Electron 不嵌入渲染表面。当前使用 SDR/YUV420、双声道、绝对鼠标和常用键盘按键；没有剪贴板、IME 文本同步或手柄。
- Windows 尝试 FFmpeg D3D11VA，macOS 代码路径尝试 VideoToolbox，不可用时明确报告并使用软件解码。硬解码帧需要 CPU 拷贝到 SDL，**不是零拷贝**。默认 auto 首版选择 H.264；HEVC/AV1 取决于双方编解码器。
- 配对 90 秒总超时，串流有无首帧超时；进程启动或 HTTP 在线不等于连接成功。原生 self-test 使用自行生成的 H.264 I_PCM 图像与 Opus 静音，验证本机解码、SDL 窗口和音频排队，不证明真实网络、硬解码、扬声器有声或远端输入。
- 一次只管理一个本工具的串流或配对；取消通过 stdin 请求退出，超时只终止已跟踪子进程，不按进程名清理，不关闭远端应用。若主机有其他应用运行则拒绝启动，不强制抢占。
- 快速启动只能选择 Sunshine 已配置的应用名称，不会在远端执行脚本或任意命令。

## 仅内网的约束

主进程允许 RFC1918 IPv4（`10/8`、`172.16/12`、`192.168/16`）、IPv4 回环和链路本地地址。拒绝公网、IPv6、网址、命令片段；主机名的全部 IPv4 解析结果都必须通过相同检查。探测、串流和管理链接使用校验后的数字地址，避免再次解析主机名；HTTP 不跟随重定向，响应有大小和时间限制。

应用不注册公网服务，不做 NAT 穿透、网段扫描、云中转或自动更新。mDNS 查询仅作用于本地组播。外部 GitHub 发布页仅在你主动点击下载按钮时由系统浏览器打开。

**这不代替操作系统的网络策略。** 内置主机禁用 UPnP，禁止路由器端口转发。
防火墙按钮只在用户明确操作并批准管理员权限后添加/更新本应用规则，限制到一个指定内网地址；
不会删除已有组织规则，因此应检查是否存在其他宽泛规则。规则在停止共享后保留，
但本应用子进程会退出、停止监听。私有地址也可能经过 VPN；不强制二层同一子网。
原生客户端再次拒绝公网目标，RTSP 地址必须匹配已校验主机。

## 已实现

- 隔离的 Electron 主进程、沙箱 preload 和受限 IPC；无 Node.js 渲染器权限。
- 手动添加 / 移除设备、收藏、搜索、按设备保存的快速启动。
- 原子写入的设备与串流配置持久化；损坏文件保留并明确报错，不静默清空。
- mDNS 查找 Sunshine、手动刷新和每 15 秒的可见窗口状态检测。
- 原生引擎启动、实际 PIN 协议、首帧状态、取消与进程退出处理。
- 内置 Sunshine 生命周期、应用内 PIN 授权、受限防火墙入口和原生客户端文件选择。
- 1080p / 1440p / 4K、30–120 FPS、码率、编码和显示模式配置。

暂不包含文件传输、终端、端口映射、嵌入式播放器、无人值守系统服务或驱动安装。
未找到引擎或设备离线时，连接动作禁用并显示原因。内置服务端当前仅提供 Windows 包。

## 数据与测试

设备及设置存储于 Electron `app.getPath("userData")` 下的 `devices.json`；
Windows 默认为 `%APPDATA%\SolunaRemote\devices.json`。
`identity` 子目录保存独立客户端私钥、证书及按主机地址保存的已验证证书。不要分享此目录。Windows 使用当前用户目录的 ACL，其他系统创建私钥文件为 0600、目录为 0700。本工具不读取已有 Moonlight 身份；旧 `moonlightPath` 仅保留以免破坏原有数据，新版本使用 `nativePath`，留空选择随包引擎。旧 HTML localStorage 不自动迁移。

需要独立配置时，可以通过 `--user-data-dir=C:\absolute\profile` 指定绝对数据目录；这不会迁移或覆盖原有配置。便携 EXE 默认仍使用当前系统用户的应用数据目录，并不将配对凭据放在 EXE 旁。

单元测试覆盖内网、DNS、持久化、原生生命周期、内部挑战签名、固定证书及 launch/resume；
访问密码测试使用真实 TLS-PSK 握手，并在 Node/OpenSSL 与 Electron/BoringSSL 中分别运行，
包括错误密码拒绝、正确密码成功和敏感信息不进入状态快照。协议测试仍不等于真实 Sunshine。
Electron UI 使用真实窗口和独立临时目录，明确模拟设备码发现、密码认证、控制 API 与原生 JSON 播放器；
覆盖设备码入口、错误密码阻止启动、成功连接/停止、状态恢复、本机密码/共享开关、设置持久化与移除。

UI 测试不等于真实 Sunshine / Moonlight 串流验证。真实双机的 PIN 授权、画面/声音、硬件编解码、键鼠、UDP 连接质量及平台打包签名需在安装引擎后实测。测试截图输出到 `test-results`，不写入应用数据目录。

## 上游许可

本项目的 `native\src` 以 GPL-3.0-or-later 提供，链接 GPL 系列的 moonlight-common-c。
构建固定上游提交 `d5b38a3ac63927a11bebd8337df024f11eba34d5` 及其递归子模块。
发布原生二进制时必须保留 `native\bin\licenses`，并按各许可证提供本项目原生源码、
构建脚本及全部对应上游源码；仅附许可证不等于满足源码提供义务。源码保存在本次构建的
`native\build\_deps` 与 `native\.tools\vcpkg\buildtrees`，分发前应归档完整对应源码，
不要依赖可被清理的本机构建缓存。Sunshine 随包便携引擎同样需要遵循 GPL 源码提供义务；
版本、来源和分发要求见 `host\THIRD-PARTY-NOTICES.txt`。对外分发前归档完整对应源码，
不能仅用源码链接替代许可证要求。上游内置 Web 素材保持原样，不用作本项目品牌。
