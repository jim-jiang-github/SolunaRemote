/* global window, document */
// The Tauri API may be injected after the deferred document scripts start.
(() => {
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

      const { invoke } = tauri.core;
      const allowed = new Set([
        "state",
        "hostStart",
        "hostPassword",
        "connectPassword",
        "cancelConnect",
        "hostStop",
        "hostAllowClient",
        "add",
        "remove",
        "favorite",
        "refresh",
        "discover",
        "saveSettings",
        "pickNative",
        "shortcut",
        "removeShortcut",
        "cancel",
        "openSunshine",
        "openLink",
        "window",
      ]);

      async function call(method, input) {
        if (!allowed.has(method)) throw new Error("不支持的操作。");
        if (method === "pickNative")
          return invoke("pick_native").then((path) =>
            path
              ? invoke("backend_call", {
                  method: "validateNativePath",
                  input: path,
                })
              : null,
          );
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
              (state.session ||
                ["running", "starting"].includes(state.host.phase)) &&
              !window.confirm(
                "退出将结束本程序的客户端串流和本机共享，已连接本机的设备将断开；不会关闭远端应用。确定退出吗？",
              )
            )
              return;
          }
          return invoke("window_action", { action: input });
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

      document.addEventListener("mousedown", (event) => {
        if (
          event.button !== 0 ||
          event.target.closest("button, input, select, textarea, a")
        )
          return;
        if (event.target.closest(".titlebar"))
          tauri.window.getCurrentWindow().startDragging();
      });
      document.addEventListener("dblclick", (event) => {
        if (
          event.target.closest(".titlebar") &&
          !event.target.closest("button, input, select, textarea, a")
        )
          tauri.window.getCurrentWindow().toggleMaximize();
      });
      resolve();
    }
    install();
  });
})();
