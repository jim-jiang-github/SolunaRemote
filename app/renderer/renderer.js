/* global window, document */
(() => {
  const content = document.querySelector("#content");
  let state;
  let route = "devices";
  let selectedId = null;
  let search = "";
  let discovery = [];
  let connectShortcut = null;
  let connecting = false;
  let removeId = null;
  let toastTimer;
  let refreshing = false;
  let scanning = false;

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

  function applyState(next) {
    state = next;
    if (selectedId && !selected()) {
      selectedId = null;
      route = "devices";
    }
    renderSidebar();
    if (route === "host" && document.activeElement?.closest("#host-controls"))
      return;
    if (route !== "settings" || !document.querySelector("#settings-form"))
      renderContent();
  }

  function renderSidebar() {
    document.querySelector("#nav-count").textContent = String(
      state.devices.length,
    );
    document.querySelector("#local-name").textContent = state.local.hostname;
    document.querySelector("#app-version").textContent = `v${state.version}`;
    document
      .querySelectorAll("[data-route]")
      .forEach((element) =>
        element.classList.toggle("active", element.dataset.route === route),
      );
    document.querySelector("#sidebar-devices").innerHTML = state.devices.length
      ? state.devices
          .map(
            (device) =>
              `<button class="sidebar-device ${selectedId === device.id && route === "detail" ? "active" : ""}" data-device="${escape(device.id)}" title="${escape(device.name)}"><span class="device-mini">${icon("monitor")}</span><span class="sidebar-device-name">${escape(device.name)}</span><span class="dot ${deviceOnline(device) ? "green" : ""}"></span></button>`,
          )
          .join("")
      : `<p class="sidebar-placeholder">还没有设备<br/>添加一台电脑，开始内网连接。</p>`;
    document.querySelector("#statusbar-text").textContent = state.session
      ? state.session.phase === "streaming"
        ? `正在串流 · 已渲染 ${state.session.stats?.rendered ?? 1} 帧`
        : state.session.kind === "pair"
          ? "正在验证设备访问权限"
          : "正在建立原生串流 · 等待首帧"
      : "安全连接，从你的局域网开始";
  }

  function navigate(next, deviceId) {
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

  function features() {
    return `<div class="feature-hints"><div class="feature-hint">${icon("shield")}<div><strong>只在你的内网</strong><p>私有 IPv4 校验，无公网中转。</p></div></div><div class="feature-hint">${icon("signal")}<div><strong>为低延迟而生</strong><p>Sunshine 编码，Moonlight 解码。</p></div></div><div class="feature-hint">${icon("key")}<div><strong>设备码与密码</strong><p>加密验证，不传输明文密码。</p></div></div></div>`;
  }

  function deviceCard(device) {
    return `<article class="device-card"><div class="device-card-header"><span class="status-pill ${deviceOnline(device) ? "online" : ""}"><span class="dot ${deviceOnline(device) ? "green" : ""}"></span>${statusLabel(device)}</span><button class="small-icon-button ${device.favorite ? "starred" : ""}" data-action="favorite" data-id="${escape(device.id)}" aria-label="${device.favorite ? "取消收藏" : "收藏"} ${escape(device.name)}">${icon("star")}</button></div><button class="device-open" data-device="${escape(device.id)}"><span class="card-monitor">${icon("monitor")}</span><h3>${escape(device.name)}</h3><p>${escape(device.address)}</p></button><div class="card-footer"><span>${deviceOnline(device) ? `探测 ${device.status.latency} ms · GameStream` : "Sunshine 主机"}</span>${icon("arrow")}</div></article>`;
  }

  function overview() {
    const favorites = route === "favorites";
    const devices = state.devices.filter(
      (device) =>
        (!favorites || device.favorite) &&
        `${device.name} ${device.address}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
    return `${sessionBanner()}<div class="page-heading"><div><h1>${favorites ? "收藏设备" : "你的设备，随时连接"}</h1><p>${favorites ? "把常用的电脑放在触手可及的位置。" : "同一个程序，同时作为服务端和客户端。"}</p></div><div class="heading-buttons">${button("设备码连接", "connect-code", "primary", "link")}${button("发现设备", "discover", "secondary", "search")}${button("添加设备", "add", "secondary", "plus")}</div></div><div class="overview-banner"><div><h2>熟悉的桌面，不必就在身边。</h2><p>输入对方的设备码与访问密码，即可连接内网桌面。<br/>无需注册账号，无需另装 Sunshine 或 Moonlight。</p></div><span class="banner-icon">${icon("monitor")}</span></div><div class="section-label"><h2>${favorites ? "我的收藏" : "全部设备"}</h2><span class="count-pill">${devices.length}</span><span class="spacer"></span><input id="device-search" class="search-input" aria-label="搜索设备" placeholder="搜索名称或内网地址" value="${escape(search)}"/></div>${devices.length ? `<div class="device-grid">${devices.map(deviceCard).join("")}</div>` : `<div class="empty-state"><div class="empty-visual">${icon(favorites ? "star" : "monitor")}</div><h2>${search ? "没有找到匹配的设备" : favorites ? "还没有收藏设备" : "从你的第一台电脑开始"}</h2><p>${search ? "试试其他设备名称或内网地址。" : favorites ? "点击设备卡片右上角的星标，即可在这里快速找到它。" : "对方开启本机共享后，输入其设备码与访问密码即可连接。"}</p><div class="empty-actions">${button("设备码连接", "connect-code", "primary", "link")}${button("连接指南", "guide", "secondary", "help")}</div></div>`}${features()}`;
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
    return `${sessionBanner()}<div class="page-heading"><div><div class="device-title-row"><span class="device-status-large ${online ? "online" : ""}"><span class="dot ${online ? "green" : ""}"></span>${statusLabel(device)}</span><h1>${escape(device.name)}</h1></div><p>${escape(device.address)}${online ? ` · 探测 ${device.status.latency} ms` : ""}</p></div><div class="heading-buttons"><button class="icon-button" data-action="favorite" aria-label="收藏设备">${icon("star")}</button><button class="icon-button" data-action="remove" aria-label="移除设备">${icon("trash")}</button></div></div>
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
          <h2>soluna-stream · 无 Qt <span class="engine-status ${state.engines.nativeAvailable ? "ok" : ""}">${state.engines.nativeAvailable ? "已找到客户端" : "尚未配置"}</span></h2>
          <p>Electron 管理配对与应用；moonlight-common-c 接收串流，FFmpeg 解码，SDL 提供独立窗口、音频与键鼠。</p>
          <label>客户端可执行文件<div class="input-action"><input name="nativePath" id="native-path" value="${escape(s.nativePath)}" placeholder="${escape(state.engines.nativePath || "选择编译后的 soluna-stream.exe")}" spellcheck="false"/><button class="button secondary" type="button" data-action="pick-native">浏览文件</button></div></label>
          <span class="field-help">留空使用随包引擎。开发环境先运行 npm run build:native。</span>
        </div>
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
    const labels = {
      stopped: "未共享",
      starting: "正在启动",
      running: "共享已开启",
      stopping: "正在停止",
      error: "共享异常",
    };
    return `<div class="page-heading"><div><h1>本机共享</h1><p>同一个程序，既能控制其他电脑，也能让其他电脑连接本机。无需另外安装 Sunshine 或 Moonlight。</p></div></div>
      <div class="host-panel"><span class="host-icon">${icon("sun")}</span><div><h2>${escape(state.local.hostname)} · ${labels[h.phase] || "未知状态"}</h2><p>${escape(state.local.addresses.join(" · ") || "暂无可用的 IPv4 地址")}<br/>${h.available ? "内置 Sunshine 服务端 · 应用管理生命周期" : "缺少内置共享引擎，请重新准备完整发行包"}</p></div>${button(running ? "停止本机共享" : "开启本机共享", running ? "host-stop" : "host-start", running ? "secondary" : "primary", "sun", disabled(busy || !h.available))}</div>
      ${h.error || h.access.error ? `<div class="device-notice warning">${icon("help")}<span>${escape(h.error || h.access.error)}</span></div>` : ""}
      <div class="host-panel"><div><h2>本机设备码：<span id="host-device-code">${escape(h.access.code)}</span></h2><p>${h.access.passwordConfigured ? "访问密码已设置，不在界面回显。" : "先设置访问密码，再开启共享。"}</p></div></div>
      <div id="host-controls"><div class="guide-step"><span class="step-number">01</span><div><h3>允许指定内网设备连接</h3><p>填写控制端电脑的私有 IPv4，不是本机地址。此按钮会请求管理员权限，仅为内置引擎放行该设备的串流端口，不开放管理页面。</p><label>控制端 IPv4<input id="host-client-address" placeholder="例如 192.168.1.20" value="${escape(h.allowedAddress || "")}" /></label>${button("授权此设备访问（管理员）", "host-allow", "secondary", "shield")}</div></div>
      <div class="guide-step"><span class="step-number">02</span><div><h3>设置访问密码</h3><p>另一台电脑输入设备码与此密码即可连接，不需要配对码。设备码对应所选内网 IP；切换网卡或 IP 变化后需重新设置。修改密码前须停止共享；下次开启共享会撤销以前的客户端授权。</p><form id="host-password-form"><label>共享网卡<select name="address" ${disabled(running || busy)}>${(h.access.addresses ?? state.local.addresses).map((address) => `<option value="${escape(address)}" ${address === h.access.address ? "selected" : ""}>${escape(address)}</option>`).join("")}</select></label><label>本机访问密码<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" ${disabled(running || busy)} /></label><button class="button secondary" type="submit" ${disabled(running || busy)}>保存访问密码</button></form></div></div></div>
      <p class="scope-note">共享默认关闭，不注册系统服务、不安装驱动。关闭应用会停止本机共享；配对与配置保存在当前用户的数据目录中。UPnP 已禁用，管理接口仅允许本机访问。仅在有权控制的设备上使用。</p>`;
  }

  function guide() {
    return `<div class="page-heading"><div><h1>连接指南</h1><p>两台电脑，同一个 SolunaRemote 程序。</p></div></div><div class="guide-step"><span class="step-number">01</span><div><h3>被控电脑</h3><p>打开本机共享，选择可互通的共享网卡，设置至少 12 个字符的访问密码，授权控制端内网地址并开启共享。将本机设备码与密码提供给有权访问的人。</p></div></div><div class="guide-step"><span class="step-number">02</span><div><h3>控制电脑</h3><p>点击设备码连接，输入对方的 12 位设备码与访问密码。程序直接解析内网地址、使用 TLS-PSK 验证密码并自动完成底层授权；不展示或要求输入配对码，也不依赖组播发现。</p></div></div><div class="guide-step"><span class="step-number">03</span><div><h3>退出与排障</h3><p>Ctrl + Alt + F12 或会话控制中心可断开连接。停止共享或关闭应用会停止被控访问。设备码随所选网卡 IP 改变；跨子网需要内网路由和防火墙允许。没有云注册、公网中转或独立软件安装。</p></div></div>`;
  }

  function renderContent() {
    if (!state) return;
    const labels = {
      devices: "全部设备",
      favorites: "收藏设备",
      detail: selected()?.name || "设备详情",
      settings: "设置",
      host: "本机共享",
      guide: "连接指南",
    };
    document.querySelector("#breadcrumb").innerHTML =
      `工作空间 <span>/</span> ${escape(labels[route])}`;
    content.innerHTML =
      route === "detail"
        ? detail()
        : route === "settings"
          ? settings()
          : route === "host"
            ? host()
            : route === "guide"
              ? guide()
              : overview();
  }

  function openDevice(input = {}) {
    const form = document.querySelector("#device-form");
    form.reset();
    form.elements.name.value = input.name || "";
    form.elements.address.value = input.address || "";
    document.querySelector("#device-error").textContent = "";
    document.querySelector("#device-dialog").showModal();
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    const results = document.querySelector("#discovery-results");
    results.innerHTML = `<div class="discovery-empty">正在搜索局域网中的 Sunshine 主机…</div>`;
    try {
      discovery = await window.lan.call("discover");
      results.innerHTML = discovery.length
        ? discovery
            .map(
              (device, index) =>
                `<div class="discovery-row"><div><strong>${escape(device.name)}</strong><span>${escape(device.address)}</span></div>${button(state.devices.some((item) => item.address === device.address) ? "已添加" : "添加", "discovered-add", "secondary", "", `data-index="${index}" ${disabled(state.devices.some((item) => item.address === device.address))}`)}</div>`,
            )
            .join("")
        : `<div class="discovery-empty">暂未发现 Sunshine 主机。<br/>请检查主机已启动、设备处于同一子网，或使用手动添加。</div>`;
    } catch (error) {
      results.textContent = error.message;
    } finally {
      scanning = false;
    }
  }

  function connect(shortcut = null) {
    connectShortcut = shortcut;
    const form = document.querySelector("#connect-form");
    form.reset();
    form.elements.code.value = selected()?.name.match(/\b\d{12}\b/)?.[0] || "";
    document.querySelector("#connect-error").textContent = "";
    document.querySelector("#connect-dialog").showModal();
  }

  const actions = {
    add: () => openDevice(),
    discover: async () => {
      document.querySelector("#discover-dialog").showModal();
      await scan();
    },
    rescan: scan,
    "discovered-add": (element) => {
      document.querySelector("#discover-dialog").close();
      openDevice(discovery[Number(element.dataset.index)]);
    },
    "all-devices": () => navigate("devices"),
    guide: () => navigate("guide"),
    settings: () => navigate("settings"),
    favorite: (element) => window.lan.call("favorite", currentDevice(element)),
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
    stream: () => connect(),
    "connect-code": () => connect(),
    admin: () => window.lan.call("openSunshine", selectedId),
    "local-admin": () => window.lan.call("openSunshine"),
    "host-start": async () => {
      await window.lan.call("hostStart");
      notify("本机共享已开启，可使用设备码与密码连接。");
    },
    "host-stop": () => window.lan.call("hostStop"),
    "host-allow": async () => {
      await window.lan.call(
        "hostAllowClient",
        document.querySelector("#host-client-address").value.trim(),
      );
      notify("已为指定内网设备授权串流端口。");
    },
    "download-sunshine": () => window.lan.call("openLink", "sunshine"),
    "pick-native": async () => {
      const executable = await window.lan.call("pickNative");
      if (executable) document.querySelector("#native-path").value = executable;
    },
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
    "launch-shortcut": (element) => connect(element.dataset.shortcut),
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
      notify(error.message);
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "device-search") return;
    search = event.target.value;
    const position = event.target.selectionStart;
    renderContent();
    const input = document.querySelector("#device-search");
    input.focus();
    input.setSelectionRange(position, position);
  });

  document
    .querySelector("#device-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const id = await window.lan.call("add", {
          name: form.elements.name.value,
          address: form.elements.address.value,
          app: form.elements.app.value,
        });
        document.querySelector("#device-dialog").close();
        navigate("detail", id);
        notify("设备已添加，连接信息保存在本机。");
      } catch (error) {
        document.querySelector("#device-error").textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });

  document
    .querySelector("#shortcut-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await window.lan.call("shortcut", {
          deviceId: selectedId,
          name: form.elements.name.value,
          app: form.elements.app.value,
        });
        document.querySelector("#shortcut-dialog").close();
        notify("快捷启动已添加。");
      } catch (error) {
        document.querySelector("#shortcut-error").textContent = error.message;
      } finally {
        submit.disabled = false;
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
          address: form.elements.address.value,
        });
        form.reset();
        renderContent();
        notify("访问密码已保存。");
      } catch (error) {
        notify(error.message);
      } finally {
        submit.disabled = false;
      }
      return;
    }
    if (event.target.id === "connect-form") {
      event.preventDefault();
      document.querySelector("#connect-error").textContent = "";
      const form = event.target;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      connecting = true;
      try {
        const session = await window.lan.call("connectPassword", {
          code: form.elements.code.value,
          password: form.elements.password.value,
          shortcutId: connectShortcut,
          deviceId: selectedId,
        });
        form.elements.password.value = "";
        connecting = false;
        document.querySelector("#connect-dialog").close();
        navigate("detail", session.deviceId);
        notify("密码验证通过，正在等待远程桌面首帧。");
      } catch (error) {
        document.querySelector("#connect-error").textContent = error.message;
      } finally {
        connecting = false;
        submit.disabled = false;
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
        nativePath: fields.nativePath.value.trim(),
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
    .addEventListener("click", async () => {
      try {
        await window.lan.call("remove", removeId);
        document.querySelector("#confirm-dialog").close();
        navigate("devices");
        notify("已移除本地设备记录。");
      } catch (error) {
        notify(error.message);
      }
    });

  if (!window.lan) {
    content.innerHTML = `<div class="empty-state"><h2>请使用 Electron 启动 SolunaRemote</h2><p>在项目目录运行 npm start。浏览器中不开放设备探测、文件访问或进程启动权限。</p></div>`;
    return;
  }
  document.querySelector("#connect-dialog").addEventListener("close", () => {
    document.querySelector("#connect-form").elements.password.value = "";
    if (connecting)
      window.lan.call("cancelConnect").catch((error) => notify(error.message));
  });
  window.lan.onState(applyState);
  window.lan.onEngine((event) => {
    if (event.started || event.progress) {
      if (event.warning) notify(event.warning);
      return;
    }
    if (event.firstFrame) {
      notify("远程桌面已收到并渲染首帧。");
      return;
    }
    notify(
      event.error ||
        (event.cancelled
          ? "已结束本次原生串流，远端应用保持运行。"
          : "原生串流窗口已关闭。"),
    );
  });
  window.lan
    .call("state")
    .then((data) => {
      applyState(data);
      return actions.refresh();
    })
    .catch((error) => notify(error.message));
  window.setInterval(() => {
    if (!document.hidden && state && !refreshing)
      actions.refresh().catch((error) => notify(error.message));
  }, 15000);
})();
