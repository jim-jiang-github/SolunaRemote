/* global window, document */
(async () => {
  const content = document.querySelector("#content");
  let state;
  let route = "assist";
  let selectedId = null;
  let partnerCode = "";
  let partnerPassword = "";
  let partnerPasswordRequest = 0;
  let localPassword = "";
  let localPasswordVisible = false;
  let connecting = false;
  let hostTogglePending = false;
  let removeId = null;
  let toastTimer;
  let refreshing = false;
  const themeToggle = document.querySelector("#theme-toggle");
  const themeStorageKey = "soluna-icon-theme";

  function setIconTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.iconTheme = isDark ? "dark" : "light";
    themeToggle?.setAttribute("aria-pressed", String(isDark));
    themeToggle?.setAttribute(
      "aria-label",
      isDark ? "切换到浅色主题" : "切换到深色主题",
    );
    themeToggle?.setAttribute(
      "title",
      isDark ? "切换到浅色主题" : "切换到深色主题",
    );
  }

  setIconTheme(
    localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light",
  );

  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const icon = (name, className = "") =>
    `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const button = (
    label,
    action,
    style = "secondary",
    symbol = "",
    extra = "",
  ) =>
    `<button type="button" class="button ${style}" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ""}${label}</button>`;
  const selected = () =>
    state.devices.find((device) => device.id === selectedId);
  const deviceOnline = (device) => device.status?.online;
  const statusLabel = (device) =>
    device.status ? (deviceOnline(device) ? "在线" : "离线") : "待检测";
  const disabled = (value) => (value ? "disabled" : "");
  const currentDevice = (element) => element.dataset.id || selectedId;

  function notify(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 6500);
  }

  function showStateLoadError(error) {
    content.innerHTML = `<div class="empty-state" role="alert"><h2>无法加载应用状态</h2><p>${escape(error.message)}</p>${button("重试", "retry-state")}</div>`;
  }

  function applyState(next) {
    if (!next || typeof next !== "object" || typeof next.version !== "string") {
      console.error("Ignoring invalid application state snapshot:", next);
      return false;
    }
    const remoteBecameActive =
      next.host?.remoteActive === true && state?.host?.remoteActive !== true;
    const active = document.activeElement;
    const activeId = active?.id;
    const selection =
      typeof active?.selectionStart === "number"
        ? [active.selectionStart, active.selectionEnd]
        : null;
    state = next;
    const remoteAlert = document.querySelector("#remote-control-alert");
    const remoteActive = state.host?.remoteActive === true;
    const remoteStatusError = state.host?.remoteStatusError;
    remoteAlert.hidden = !remoteActive && !remoteStatusError;
    document.querySelector("#remote-control-alert-detail").textContent =
      remoteStatusError && !remoteActive
        ? "无法确认远程连接状态；如有疑虑，请立即停止本机共享。"
        : "你可以立即断开远程连接。";
    if (remoteBecameActive) notify("有人正在远程控制本机。");
    document.documentElement.dataset.appReady = "true";
    if (selectedId && !selected()) {
      selectedId = null;
      route = "assist";
    }
    renderSidebar();
    if (route === "host" && document.activeElement?.closest("#host-controls"))
      return;
    if (route !== "settings" || !document.querySelector("#settings-form")) {
      renderContent();
      const restored = activeId && document.getElementById(activeId);
      if (restored) {
        restored.focus();
        if (selection && typeof restored.setSelectionRange === "function")
          restored.setSelectionRange(...selection);
      }
    }
    return true;
  }

  function renderSidebar() {
    document.querySelector("#app-version").textContent = state?.version
      ? `v${state.version}`
      : "";
    document
      .querySelectorAll("[data-route], [data-nav-route]")
      .forEach((element) =>
        element.classList.toggle(
          "active",
          (element.dataset.route || element.dataset.navRoute) === route,
        ),
      );
    document.querySelector("#statusbar-text").textContent = state?.session
      ? state.session.phase === "streaming"
        ? `正在串流 · 已渲染 ${state.session.stats?.rendered ?? 1} 帧`
        : state.session.kind === "pair"
          ? "正在验证设备访问权限"
          : "正在建立原生串流 · 等待首帧"
      : "";
  }

  function navigate(next, deviceId) {
    partnerPasswordRequest++;
    route = next;
    if (deviceId) selectedId = deviceId;
    renderSidebar();
    renderContent();
    content.scrollTop = 0;
  }

  function sessionBanner() {
    if (!state.session) return "";
    const device = state.devices.find(
      (entry) => entry.id === state.session.deviceId,
    );
    const label =
      state.session.kind === "pair"
        ? "正在验证设备访问权限"
        : state.session.phase === "streaming"
          ? "远程桌面已收到首帧"
          : "原生播放器连接中";
    return `<div class="session-banner"><span>${icon("signal")} <strong>${label}</strong> · ${escape(device?.name || "设备")}${state.session.kind === "stream" ? ` / ${escape(state.session.app)}` : ""}</span>${button("结束本次进程", "stop", "secondary")}</div>`;
  }

  function overview() {
    const hostState = state.host;
    const access = hostState.access;
    const running = hostState.phase === "running";
    const busy =
      hostTogglePending || ["starting", "stopping"].includes(hostState.phase);
    const shareDisabledReason = busy
      ? "正在处理共享状态，请稍候。"
      : !running && !hostState.available
        ? "共享引擎不可用，请检查应用是否完整。"
        : !running && !access.passwordConfigured
          ? "请先设置并保存访问密码。"
          : "";
    const recent = [...state.devices].reverse().slice(0, 5);
    const status = hostTogglePending
      ? running
        ? "正在关闭"
        : "正在开启"
      : {
          stopped: "未开启",
          starting: "正在开启",
          running: "正在协助",
          stopping: "正在关闭",
          error: "异常",
        }[hostState.phase] || "未知";
    const recentOptions = recent
      .map((device) => {
        const code = device.name.match(/\b\d{9}\b/)?.[0] || "";
        return `<option value="${escape(device.id)}" ${disabled(!code)}>${escape(device.name)} · ${statusLabel(device)}</option>`;
      })
      .join("");
    return `${sessionBanner()}
      <section class="assist-panel local-assist">
        <header class="assist-panel-heading">
          <div><h2>本设备</h2><p>${escape(state.local.hostname)}</p></div>
          <div class="share-state"><span class="status-pill ${running ? "online" : ""}" role="status" aria-live="polite"><span class="dot ${running ? "green" : ""}"></span>${status}</span><span class="share-button-wrap"${shareDisabledReason ? ' tabindex="0" aria-describedby="share-disabled-reason"' : ""}><button type="button" class="share-toggle" role="switch" aria-label="允许远程协助" aria-checked="${running}" aria-busy="${busy}" data-action="host-toggle" ${disabled(!!shareDisabledReason)}><span>允许远程协助</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>${shareDisabledReason ? `<span class="share-tooltip" id="share-disabled-reason" role="tooltip">${escape(shareDisabledReason)}</span>` : ""}</span></div>
        </header>
        <div class="local-assist-body">
          <div class="local-credential"><div><span class="field-label">本设备 ID</span><strong class="device-code">${escape(access.code)}</strong></div><button class="button secondary copy-code" data-action="copy-device-code">${icon("copy")}复制 ID</button></div>
          <form id="host-password-form" class="inline-credential-form">
            <div class="local-password-field"><label for="local-password">访问密码<span>${access.passwordConfigured ? (access.passwordMode === "temporary" ? "临时密码 · 重启刷新" : "固定密码") : "请设置一个访问密码"}</span></label><div class="password-input-wrap"><input id="local-password" name="password" type="${localPasswordVisible ? "text" : "password"}" required maxlength="128" autocomplete="new-password" placeholder="${access.passwordConfigured ? "••••••••" : "输入本设备的连接密码"}" value="${escape(localPassword)}" ${disabled(running || busy)} /><button class="password-visibility" type="button" data-action="show-host-password" aria-label="${localPasswordVisible ? "隐藏密码" : "显示密码"}" title="${localPasswordVisible ? "隐藏密码" : "显示密码"}" ${disabled(!access.passwordConfigured && !localPassword)}>${icon(localPasswordVisible ? "eye-off" : "eye")}</button></div></div>
            <button class="button secondary" type="submit" ${disabled(running || busy)}>设置固定密码</button>
          </form>
          <p class="assist-inline-note">${running ? "其他设备现在可以使用本设备 ID 与访问密码连接。" : "开启前须设置访问密码；首次开启可能需要系统管理员授权。仅允许本地子网连接。"}</p>
        </div>
      </section>
      <section class="assist-panel partner-assist">
        <header class="assist-panel-heading"><div><h2>远控伙伴设备</h2><p>输入对方的设备 ID 和访问密码，建立加密的内网连接。</p></div><select id="recent-connections" aria-label="最近连接"><option value="">最近连接${recent.length ? "" : "（暂无记录）"}</option>${recentOptions}</select></header>
        <form id="connect-form" class="partner-connect-form">
          <label>伙伴设备 ID<input id="partner-code" name="code" required pattern="[0-9]{9}" maxlength="9" inputmode="numeric" autocomplete="off" placeholder="输入 9 位设备 ID" value="${escape(partnerCode)}" /></label>
          <label>设备访问密码<input id="partner-password" name="password" type="password" required maxlength="128" autocomplete="off" placeholder="输入对方设置的访问密码" value="${escape(partnerPassword)}" /></label>
          <button class="button primary" type="submit" ${disabled(connecting || !state.engines.nativeAvailable || !!state.session)}>${connecting ? "正在连接…" : "连接"}</button>
          <p id="connect-error" class="form-error" role="alert"></p>
        </form>
      </section>`;
  }

  function detail() {
    const device = selected();
    if (!device) return overview();
    const online = deviceOnline(device);
    const available = state.engines.nativeAvailable;
    const blocked = !online || !available || !!state.session;
    const reason = !available
      ? "请先编译或配置 soluna-stream 原生引擎"
      : !online
        ? "设备尚未在线，请检查 Sunshine 后刷新"
        : state.session
          ? "请先结束当前原生串流"
          : "在独立 SDL 窗口打开远程桌面";
    return `${sessionBanner()}    <div class="page-heading"><div><div class="device-title-row"><span class="device-status-large ${online ? "online" : ""}"><span class="dot ${online ? "green" : ""}"></span>${statusLabel(device)}</span><h1>${escape(device.name)}</h1></div><p>${online ? `探测 ${device.status.latency} ms` : "最近连接设备"}</p></div><div class="heading-buttons"><button class="icon-button" data-action="favorite" aria-label="收藏设备">${icon("star")}</button><button class="icon-button" data-action="remove" aria-label="移除设备">${icon("trash")}</button></div></div>
      <div class="desktop-card"><button class="desktop-hero" data-action="stream" ${disabled(blocked)} title="${reason}" aria-label="进入桌面"><span class="hero-tag">${icon("shield")} LAN CONNECTION</span><span class="hero-cta">进入桌面 ${icon("arrow")}</span><span class="hero-caption">设备码 + 密码 · 内网直连</span><span class="hero-bottom">连接入口 · 非实时桌面预览</span></button><div class="desktop-actions">${button("设备码连接", "connect-code", "secondary", "link")}${button("串流设置", "settings", "secondary", "settings")}</div></div>
      <div class="device-notice ${online ? "" : "warning"}">${icon("shield")}<span>${online ? "输入对方设备码与访问密码即可连接，无需手工配对。Ctrl + Alt + F12 退出串流。" : escape(device.status?.error || "设备尚未在线，请开启对方的本机共享。")}</span></div>
      <div class="section-label"><h2>快速启动</h2><span>使用同一设备码与密码授权</span></div><div class="shortcut-grid">${device.shortcuts.map((shortcut) => `<div class="shortcut-card"><button class="shortcut-launch" data-action="launch-shortcut" data-shortcut="${escape(shortcut.id)}" ${disabled(blocked)}><span>${escape(shortcut.name)}</span></button><button class="small-icon-button" data-action="remove-shortcut" data-shortcut="${escape(shortcut.id)}" aria-label="删除快捷启动 ${escape(shortcut.name)}">${icon("close")}</button></div>`).join("")}<button class="add-shortcut" data-action="add-shortcut">${icon("plus")}添加快捷启动</button></div>`;
  }

  function settings() {
    const s = state.settings;
    const options = (values, chosen, labels = {}) =>
      values
        .map(
          (value) =>
            `<option value="${value}" ${chosen === value ? "selected" : ""}>${labels[value] || value}</option>`,
        )
        .join("");
    return `
      <div class="page-heading"><div><h1>连接，按你的习惯</h1><p>设置会应用于下一次原生串流，不会打断正在运行的窗口。</p></div></div>
      <form id="settings-form">
        <div class="settings-section">
          <h2>画面与性能</h2><p>第一版使用内网优化的桌面绝对鼠标模式，不会自动修改远端显示器分辨率。</p>
          <div class="form-grid">
            <label>分辨率<select name="resolution" aria-label="分辨率">${options(["1280x720", "1920x1080", "2560x1440", "3840x2160"], s.resolution, { "1280x720": "1280 × 720 · HD", "1920x1080": "1920 × 1080 · FHD", "2560x1440": "2560 × 1440 · QHD", "3840x2160": "3840 × 2160 · 4K" })}</select></label>
            <label>帧率<select name="fps" aria-label="帧率">${options([30, 60, 90, 120], s.fps, { 30: "30 FPS", 60: "60 FPS · 推荐", 90: "90 FPS", 120: "120 FPS" })}</select></label>
            <label>码率（Mbps）<input name="bitrate" type="number" min="1" max="150" step="1" value="${s.bitrate / 1000}" required/></label>
            <label>窗口模式<select name="displayMode" aria-label="窗口模式">${options(["borderless", "fullscreen", "windowed"], s.displayMode, { borderless: "无边框全屏 · 推荐", fullscreen: "独占全屏", windowed: "窗口模式" })}</select></label>
            <label>视频编码<select name="codec" aria-label="视频编码">${options(["auto", "H.264", "HEVC", "AV1"], s.codec, { auto: "自动协商 · 推荐" })}</select></label>
          </div>
          <span class="field-help">1080p / 60 FPS 建议 20 Mbps；更高分辨率和编码需双方硬件支持。</span>
        </div>
        <p class="form-error" id="settings-error" role="alert"></p>
        <div class="settings-bottom"><span class="field-help">数据仅保存在当前系统用户的应用目录中。</span><button type="submit" class="button primary">${icon("check")}保存设置</button></div>
      </form>`;
  }

  function host() {
    const h = state.host;
    const running = h.phase === "running";
    const busy = ["starting", "stopping"].includes(h.phase);
    const macOS = state.platform === "macos";
    const macOSPermissions = macOS
      ? `<div class="guide-step"><span class="step-number">03</span><div><h3>macOS 系统权限</h3><p>开启共享时会提前请求屏幕录制权限，不必等到对方连接。若系统未弹出提示，请在“隐私与安全性”中为 SolunaRemote 开启屏幕录制；Sunshine 需要辅助功能权限（部分版本称“设备控制和数据访问”）。若 macOS 防火墙已开启，需在防火墙选项中允许 Sunshine.app 与 SolunaRemote.app 接受传入连接；防火墙关闭时不要求授权，应用不会自动更改系统设置。</p><div class="button-row">${button("打开系统设置", "host-settings", "secondary", "settings")}${button("在 Finder 中显示 Sunshine.app", "host-reveal", "secondary")}${button("在 Finder 中显示 SolunaRemote", "host-reveal-soluna", "secondary")}</div></div></div>`
      : "";
    const labels = {
      stopped: "未共享",
      starting: "正在启动",
      running: "共享已开启",
      stopping: "正在停止",
      error: "共享异常",
    };
    return `<div class="page-heading"><div><h1>本机共享</h1><p>同一个程序，既能控制其他电脑，也能让其他电脑连接本机。无需另外安装 Sunshine 或 Moonlight。</p></div></div>
      <div class="host-panel"><span class="host-icon">${icon("sun")}</span><div><h2>${escape(state.local.hostname)} · ${labels[h.phase] || "未知状态"}</h2><p>${h.available ? "内置 Sunshine 服务端 · 应用管理生命周期" : "缺少内置共享引擎，请重新准备完整发行包"}</p></div>${button(running ? "停止本机共享" : "开启本机共享", running ? "host-stop" : "host-start", running ? "secondary" : "primary", "sun", disabled(busy || !h.available))}</div>
      ${h.error || h.access.error ? `<div class="device-notice warning">${icon("help")}<span>${escape(h.error || h.access.error)}</span></div>` : ""}
      <div class="host-panel"><div><h2>本机设备码：<span id="host-device-code">${escape(h.access.code)}</span></h2><p>${h.access.passwordConfigured ? "访问密码已设置，不在界面回显。" : "先设置访问密码，再开启共享。"}</p></div></div>
      <div id="host-controls"><div class="guide-step"><span class="step-number">01</span><div><h3>开启共享</h3><p>${macOS ? "若系统防火墙已开启，请允许 Sunshine.app 与 SolunaRemote.app 入站连接；应用不会代替你修改系统设置。" : "首次开启可能需要系统管理员授权，以便为本地子网配置必要的防火墙规则。"}</p></div></div>
      <div class="guide-step"><span class="step-number">02</span><div><h3>设置访问密码</h3><p>另一台电脑输入本机设备 ID 与此密码即可连接。密码无需复杂度组合，非空即可（最多 128 个字符）。应用会自动使用系统默认网络；默认网络变化后，重新保存访问密码即可。修改密码前须停止共享；下次开启共享会撤销以前的客户端授权。</p><form id="host-password-form"><label>本机访问密码<input name="password" type="password" required maxlength="128" autocomplete="new-password" ${disabled(running || busy)} /></label><button class="button secondary" type="submit" ${disabled(running || busy)}>保存访问密码</button></form></div></div>${macOSPermissions}</div>
      <p class="scope-note">共享默认关闭，不注册系统服务、不安装驱动。关闭应用会停止本机共享；配对与配置保存在当前用户的数据目录中。UPnP 已禁用，管理接口仅允许本机访问。仅在有权控制的设备上使用。</p>`;
  }

  function guide() {
    return `<div class="page-heading"><div><h1>连接指南</h1><p>两台电脑，同一个 SolunaRemote 程序。</p></div></div><div class="guide-step"><span class="step-number">01</span><div><h3>被控电脑</h3><p>设置访问密码并开启共享，首次开启时按提示批准系统管理员授权。将本机设备 ID 与密码提供给有权访问的人。</p></div></div><div class="guide-step"><span class="step-number">02</span><div><h3>控制电脑</h3><p>点击连接，输入对方的 9 位设备 ID 与访问密码。程序自动选择系统默认网络，并在后台完成设备验证；无需配对码或组播发现。</p></div></div><div class="guide-step"><span class="step-number">03</span><div><h3>退出与排障</h3><p>Ctrl + Alt + F12 或会话控制中心可断开连接。停止共享或关闭应用会停止被控访问。默认仅允许本地子网连接；跨子网需要另行配置网络路由和防火墙。没有云注册、公网中转或独立软件安装。</p></div></div>`;
  }

  function renderContent() {
    if (!state) return;
    const labels = {
      assist: "远程协助",
      detail: selected()?.name || "设备详情",
      settings: "设置",
      host: "本机共享",
      guide: "连接指南",
    };
    document.querySelector("#breadcrumb").innerHTML =
      route === "assist"
        ? "远程协助"
        : `远程协助 <span>/</span> ${escape(labels[route] || "远程桌面")}`;
    content.innerHTML =
      route === "assist"
        ? overview()
        : route === "detail"
          ? detail()
          : route === "settings"
            ? settings()
            : route === "host"
              ? host()
              : route === "guide"
                ? guide()
                : overview();
  }

  async function startHost() {
    if (hostTogglePending) return;
    const dialog = document.querySelector("#firewall-dialog");
    const retrying = dialog.open;
    const recheck = document.querySelector("#firewall-recheck");
    const errorField = document.querySelector("#firewall-error");
    hostTogglePending = true;
    recheck.disabled = true;
    errorField.textContent = "";
    renderContent();
    try {
      if (
        ["macos", "windows"].includes(state.platform) &&
        !state.host.firewallManagedByPackage
      ) {
        const allowed = await window.lan.call("hostFirewallStatus");
        if (retrying && !dialog.open) return;
        if (typeof allowed !== "boolean")
          throw new Error("无法读取防火墙状态，请稍后重新检查。");
        if (!allowed) {
          if (state.platform === "windows") {
            document.querySelector("#firewall-description").textContent =
              "首次共享需要管理员授权，为 SolunaRemote 和内置共享引擎添加内网入站规则。只允许所需端口和本地子网，不会关闭防火墙或开放 Web 管理端口。";
            document.querySelector("#firewall-help").textContent =
              "点击“授权并开启共享”，然后在 Windows 管理员权限提示中选择“是”。取消授权将不会开启共享；规则生效后无需重复授权。组织策略或其他阻止规则仍可能限制连接。";
            document.querySelector("#firewall-locate").hidden = true;
            document.querySelector("#firewall-settings").hidden = true;
            recheck.textContent = "授权并开启共享";
            if (!retrying) {
              dialog.showModal();
              return;
            }
          } else {
            errorField.textContent =
              "尚未检测到两个应用的入站授权。请在防火墙选项中允许传入连接后重新检查。";
            if (!dialog.open) dialog.showModal();
            return;
          }
        }
      }
      await window.lan.call("hostStart");
      if (dialog.open) dialog.close();
      notify(
        state.host.firewallManagedByPackage
          ? "本机共享已开启。商店版请在专用或域网络中连接；组织防火墙策略仍可能阻止访问。"
          : "本机共享已开启，可使用设备码与密码连接。",
      );
    } catch (error) {
      if (dialog.open) errorField.textContent = error.message;
      else throw error;
    } finally {
      hostTogglePending = false;
      recheck.disabled = false;
      renderContent();
    }
  }

  function requestHostStart() {
    if (hostTogglePending) return;
    if (state.platform !== "macos") return startHost();
    const dialog = document.querySelector("#host-permission-dialog");
    if (!dialog.open) {
      document.querySelector("#host-permission-error").textContent = "";
      dialog.showModal();
    }
  }

  const actions = {
    "toggle-theme": () => {
      const nextTheme =
        document.documentElement.dataset.iconTheme === "dark"
          ? "light"
          : "dark";
      localStorage.setItem(themeStorageKey, nextTheme);
      setIconTheme(nextTheme);
    },
    guide: () => navigate("guide"),
    settings: () => navigate("settings"),
    favorite: (element) => window.lan.call("favorite", currentDevice(element)),
    "connect-code": () => {
      navigate("assist");
      document.querySelector("#partner-code")?.focus();
    },
    "copy-device-code": async () => {
      const code = state.host.access.code;
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(code);
      else {
        const field = document.createElement("textarea");
        field.value = code;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        if (!document.execCommand("copy")) {
          field.remove();
          throw new Error("无法复制设备 ID。");
        }
        field.remove();
      }
      notify("本设备 ID 已复制。");
    },
    refresh: async () => {
      if (refreshing) return;
      refreshing = true;
      document.querySelector("#refresh-button").disabled = true;
      try {
        await window.lan.call(
          "refresh",
          route === "detail" ? selectedId : null,
        );
      } finally {
        refreshing = false;
        document.querySelector("#refresh-button").disabled = false;
      }
    },
    "retry-state": async () => {
      try {
        const next = await window.lan.call("state");
        if (!applyState(next))
          throw new Error("应用未返回有效状态，请稍后重试。");
        await actions.refresh();
      } catch (error) {
        if (!state) showStateLoadError(error);
        else notify(error.message);
      }
    },
    stream: () => actions["connect-code"](),
    admin: () => window.lan.call("openSunshine", selectedId),
    "local-admin": () => window.lan.call("openSunshine"),
    "host-start": requestHostStart,
    "firewall-recheck": startHost,
    "firewall-settings": () => window.lan.call("openFirewallSettings"),
    "host-stop": () => window.lan.call("hostStop"),
    "disconnect-remote": async () => {
      if (hostTogglePending) return;
      hostTogglePending = true;
      const disconnectButton = document.querySelector(
        '[data-action="disconnect-remote"]',
      );
      disconnectButton.disabled = true;
      try {
        await window.lan.call("hostStop");
        notify("已断开远程连接并停止本机共享。");
      } finally {
        hostTogglePending = false;
        disconnectButton.disabled = false;
        await window.lan.call("state").then(applyState);
      }
    },
    "host-settings": () => window.lan.call("openHostSettings"),
    "host-accessibility-settings": () =>
      window.lan.call("openHostAccessibilitySettings"),
    "host-permission-continue": () => {
      document.querySelector("#host-permission-dialog").close();
      return startHost();
    },
    "host-reveal": () => window.lan.call("revealHostApp"),
    "host-reveal-soluna": () => window.lan.call("revealSolunaApp"),
    "show-host-password": async () => {
      if (!localPasswordVisible && !localPassword) {
        localPassword = await window.lan.call("hostRevealPassword");
      }
      localPasswordVisible = !localPasswordVisible;
      renderContent();
    },
    "host-toggle": async () => {
      if (hostTogglePending) return;
      const running = state.host.phase === "running";
      if (!running) return requestHostStart();
      hostTogglePending = true;
      renderContent();
      try {
        await new Promise((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 0)),
        );
        await window.lan.call("hostStop");
      } finally {
        hostTogglePending = false;
        renderContent();
      }
    },
    "download-sunshine": () => window.lan.call("openLink", "sunshine"),
    stop: () => window.lan.call("cancel", state.session.id),
    remove: () => {
      removeId = selectedId;
      document.querySelector("#confirm-description").textContent =
        `确定从本机移除「${selected().name}」吗？`;
      document.querySelector("#confirm-dialog").showModal();
    },
    "add-shortcut": () => {
      document.querySelector("#shortcut-form").reset();
      document.querySelector("#shortcut-error").textContent = "";
      document.querySelector("#shortcut-dialog").showModal();
    },
    "remove-shortcut": (element) =>
      window.lan.call("removeShortcut", {
        deviceId: selectedId,
        shortcutId: element.dataset.shortcut,
      }),
    "launch-shortcut": () => {
      partnerCode = selected()?.name.match(/\b\d{9}\b/)?.[0] || "";
      renderContent();
      document.querySelector("#partner-password")?.focus();
    },
  };

  document.addEventListener("click", async (event) => {
    const element = event.target.closest("button");
    if (!element || element.disabled) return;
    try {
      if (element.dataset.route) navigate(element.dataset.route);
      else if (element.dataset.device)
        navigate("detail", element.dataset.device);
      else if (element.dataset.close)
        document.getElementById(element.dataset.close).close();
      else if (element.dataset.window)
        await window.lan.call("window", element.dataset.window);
      else if (
        element.dataset.action &&
        Object.hasOwn(actions, element.dataset.action)
      )
        await actions[element.dataset.action](element);
    } catch (error) {
      if (document.querySelector("#firewall-dialog").open)
        document.querySelector("#firewall-error").textContent = error.message;
      else if (document.querySelector("#host-permission-dialog").open)
        document.querySelector("#host-permission-error").textContent =
          error.message;
      else notify(error.message);
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "partner-code") {
      partnerPasswordRequest++;
      partnerCode = event.target.value.replace(/\D/g, "").slice(0, 9);
      partnerPassword = "";
      const passwordInput = document.querySelector("#partner-password");
      if (passwordInput) passwordInput.value = "";
    } else if (event.target.id === "partner-password") {
      partnerPasswordRequest++;
      partnerPassword = event.target.value;
    } else if (event.target.id === "local-password") {
      localPassword = event.target.value;
      const visibility = document.querySelector(
        '[data-action="show-host-password"]',
      );
      if (visibility)
        visibility.disabled =
          !state.host.access.passwordConfigured && !localPassword;
    }
  });

  document.addEventListener("change", async (event) => {
    if (event.target.id !== "recent-connections") return;
    const request = ++partnerPasswordRequest;
    if (!event.target.value) return;
    const device = state.devices.find(
      (entry) => entry.id === event.target.value,
    );
    const code = device?.name.match(/\b\d{9}\b/)?.[0];
    if (!device || !code) return;
    selectedId = device.id;
    partnerCode = code;
    partnerPassword = "";
    renderContent();
    document.querySelector("#partner-password")?.focus();
    try {
      const password = await window.lan.call("recentPassword", {
        deviceId: device.id,
        code,
      });
      if (request !== partnerPasswordRequest || route !== "assist") return;
      partnerPassword = password || "";
      const input = document.querySelector("#partner-password");
      if (input) input.value = partnerPassword;
    } catch (error) {
      if (request === partnerPasswordRequest) notify(error.message);
    }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id === "host-password-form") {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await window.lan.call("hostPassword", {
          password: form.elements.password.value,
        });
        localPassword = "";
        localPasswordVisible = false;
        renderSidebar();
        renderContent();
        notify("本设备访问密码已保存。");
      } catch (error) {
        notify(error.message);
      } finally {
        submit.disabled = false;
      }
      return;
    }
    if (event.target.id === "connect-form") {
      partnerPasswordRequest++;
      event.preventDefault();
      document.querySelector("#connect-error").textContent = "";
      const form = event.target;
      connecting = true;
      renderContent();
      try {
        const session = await window.lan.call("connectPassword", {
          code: form.elements.code.value,
          password: form.elements.password.value,
          shortcutId: null,
          deviceId: selectedId,
        });
        partnerPassword = "";
        partnerCode = "";
        connecting = false;
        selectedId = session.deviceId;
        renderSidebar();
        renderContent();
        notify("密码验证通过，正在等待远程桌面首帧。");
      } catch (error) {
        const message = error.message;
        connecting = false;
        renderContent();
        document.querySelector("#connect-error").textContent = message;
      } finally {
        connecting = false;
      }
      return;
    }
    if (event.target.id !== "settings-form") return;
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = form.elements;
      await window.lan.call("saveSettings", {
        moonlightPath: state.settings.moonlightPath,
        resolution: fields.resolution.value,
        fps: Number(fields.fps.value),
        bitrate: Number(fields.bitrate.value) * 1000,
        displayMode: fields.displayMode.value,
        codec: fields.codec.value,
      });
      renderContent();
      notify("设置已保存，下次启动原生串流时生效。");
    } catch (error) {
      document.querySelector("#settings-error").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  document
    .querySelector("#confirm-remove")
    ?.addEventListener("click", async () => {
      try {
        await window.lan.call("remove", removeId);
        document.querySelector("#confirm-dialog").close();
        navigate("assist");
        notify("已移除本地设备记录。");
      } catch (error) {
        notify(error.message);
      }
    });
  window.addEventListener("lan:close-confirmation-requested", () => {
    const dialog = document.querySelector("#close-confirm-dialog");
    if (!dialog.open) dialog.showModal();
  });
  document
    .querySelector("#cancel-close")
    .addEventListener("click", () =>
      document.querySelector("#close-confirm-dialog").close(),
    );
  document
    .querySelector("#confirm-close")
    .addEventListener("click", async () => {
      try {
        await window.lan.call("window", "confirm-close");
      } catch (error) {
        document.querySelector("#close-confirm-dialog").close();
        notify(error.message);
      }
    });

  if (!window.lan && window.__lanBridgeReady) await window.__lanBridgeReady;
  if (!window.lan) {
    content.innerHTML = `<div class="empty-state"><h2>请使用 SolunaRemote 桌面应用</h2><p>在项目目录运行 npm start。浏览器中不开放设备探测、文件访问或进程启动权限。</p></div>`;
    return;
  }
  window.lan.onState(applyState);
  window.lan.onEngine((event) => {
    if (event.started || event.progress) {
      if (event.warning) notify(event.warning);
      return;
    }
    if (event.firstFrame) {
      window.lan
        .call("state")
        .then(applyState)
        .catch((error) => notify(error.message));
      notify("远程桌面已收到并渲染首帧。");
      return;
    }
    window.lan
      .call("state")
      .then(applyState)
      .catch((error) => notify(error.message));
    notify(
      event.error ||
        (event.cancelled
          ? "已结束本次原生串流，远端应用保持运行。"
          : "原生串流窗口已关闭。"),
    );
  });
  content.innerHTML = `<div class="empty-state" role="status">正在加载应用状态…</div>`;
  let stateLoadTimeout;
  const stateLoadTimedOut = new Promise((_, reject) => {
    stateLoadTimeout = window.setTimeout(
      () => reject(new Error("读取应用状态超时，请重试。")),
      10000,
    );
  });
  Promise.race([window.lan.call("state"), stateLoadTimedOut])
    .then((data) => {
      if (!applyState(data))
        throw new Error("应用未返回有效状态，请退出后重新打开。");
      if (data.microsoftStoreBuild) {
        window.lan
          .call("checkStoreUpdates")
          .then((updateAvailable) => {
            if (updateAvailable)
              notify("微软商店发现可用更新，请在弹出的确认窗口中完成安装。");
          })
          .catch((error) => {
            console.error("Microsoft Store 更新检查失败：", error);
            notify("暂时无法检查 Microsoft Store 更新，请稍后重试。");
          });
      }
      return actions.refresh();
    })
    .catch((error) => {
      if (!state) showStateLoadError(error);
      else notify(error.message);
    })
    .finally(() => window.clearTimeout(stateLoadTimeout));
  window.setInterval(() => {
    if (!document.hidden && state && !refreshing)
      actions.refresh().catch((error) => notify(error.message));
  }, 15000);
})();
