/* global window, document */
// The Tauri API may be injected after the deferred document scripts start.
(() => {
  function showBootError(message) {
    const content = document.querySelector("#content");
    if (!content) return;
    const panel = document.createElement("div");
    panel.className = "empty-state";
    panel.setAttribute("role", "alert");
    const heading = document.createElement("h2");
    heading.textContent = "界面启动失败";
    const detail = document.createElement("p");
    detail.textContent = message || "请退出后重新打开应用。";
    panel.append(heading, detail);
    content.replaceChildren(panel);
  }

  window.addEventListener(
    "error",
    (event) => {
      if (document.documentElement.dataset.appReady === "true") return;
      const target = event.target;
      showBootError(
        event.message ||
          (target instanceof window.HTMLScriptElement
            ? `无法加载脚本：${target.src}`
            : ""),
      );
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    if (document.documentElement.dataset.appReady !== "true")
      showBootError(event.reason?.message || String(event.reason));
  });

  window.__lanBridgeReady = new Promise((resolve) => {
    if (window.lan) {
      resolve();
      return;
    }
    const deadline = Date.now() + 5000;
    function install() {
      const tauri = window.__TAURI__;
      if (!tauri?.core?.invoke || !tauri.event?.listen || !tauri.window) {
        if (Date.now() >= deadline) {
          resolve();
          return;
        }
        window.setTimeout(install, 20);
        return;
      }

      if (window.navigator.platform.startsWith("Mac"))
        document.documentElement.dataset.platform = "macos";

      async function invoke(command, args) {
        try {
          return await tauri.core.invoke(command, args);
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      const allowed = new Set([
        "state",
        "hostStart",
        "hostPassword",
        "hostRevealPassword",
        "recentPassword",
        "connectPassword",
        "cancelConnect",
        "hostStop",
        "add",
        "remove",
        "favorite",
        "refresh",
        "discover",
        "saveSettings",
        "shortcut",
        "removeShortcut",
        "cancel",
        "openSunshine",
        "openHostSettings",
        "openHostAccessibilitySettings",
        "hostFirewallStatus",
        "openFirewallSettings",
        "revealHostApp",
        "revealSolunaApp",
        "openLink",
        "window",
      ]);

      async function call(method, input) {
        if (!allowed.has(method)) throw new Error("不支持的操作。");
        if (method === "openLink") return invoke("open_link", { key: input });
        if (method === "openSunshine") {
          const url = await invoke("backend_call", {
            method: "sunshineUrl",
            input: input ?? null,
          });
          return invoke("open_external", { url });
        }
        if (method === "window") {
          if (input === "close") {
            const state = await invoke("backend_call", {
              method: "state",
              input: null,
            });
            if (
              state.session ||
              ["running", "starting", "stopping"].includes(state.host.phase)
            ) {
              window.dispatchEvent(
                new window.Event("lan:close-confirmation-requested"),
              );
              return;
            }
          }
          return invoke("window_action", {
            action: input === "confirm-close" ? "close" : input,
          });
        }
        return invoke("backend_call", { method, input: input ?? null });
      }

      function listen(channel, callback) {
        return tauri.event.listen(channel, (event) => callback(event.payload));
      }

      window.lan = {
        call,
        onState: (callback) => listen("lan:state", callback),
        onEngine: (callback) => listen("lan:engine", callback),
      };

      listen("lan:window-close-requested", () => {
        call("window", "close").catch((error) =>
          console.error("窗口关闭失败：", error),
        );
      }).catch((error) => console.error("窗口关闭事件注册失败：", error));

      document.addEventListener("mousedown", (event) => {
        if (
          event.button !== 0 ||
          event.target.closest("button, input, select, textarea, a")
        )
          return;
        if (event.target.closest(".titlebar"))
          tauri.window
            .getCurrentWindow()
            .startDragging()
            .catch((error) => console.error("窗口拖动失败：", error));
      });
      document.addEventListener("dblclick", (event) => {
        if (
          event.target.closest(".titlebar") &&
          !event.target.closest("button, input, select, textarea, a")
        )
          tauri.window
            .getCurrentWindow()
            .toggleMaximize()
            .catch((error) => console.error("窗口最大化失败：", error));
      });
      resolve();
    }
    install();
  });
})();
