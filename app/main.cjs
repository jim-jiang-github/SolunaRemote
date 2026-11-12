const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { Store } = require("./core/store.cjs");
const { HostManager } = require("./core/host-manager.cjs");
const { AccessServer, discoverCode } = require("./core/access.cjs");
const {
  NativeEngine,
  findNativeExecutable,
  validateNativeExecutable,
} = require("./core/native-engine.cjs");
const { probe, discover, resolveLan } = require("./core/network.cjs");
const { text, appName: validateAppName } = require("./core/validation.cjs");

const rendererFile = path.join(__dirname, "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
const links = Object.freeze({
  sunshine: "https://github.com/SunshineStream/Sunshine/releases",
});

async function bootstrap(options = {}) {
  app.setName("SolunaRemote");
  const userDataDir =
    options.userDataDir || app.commandLine.getSwitchValue("user-data-dir");
  if (userDataDir) {
    if (!path.isAbsolute(userDataDir))
      throw new Error("用户数据目录必须为绝对路径。");
    app.setPath("userData", userDataDir);
  }
  if (!options.allowMultiple && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  let store;
  try {
    store = new Store(app.getPath("userData"));
  } catch (error) {
    dialog.showErrorBox("SolunaRemote 无法启动", error.message);
    app.quit();
    return;
  }
  const engines =
    options.engines ??
    new NativeEngine({
      directory: path.join(app.getPath("userData"), "identity"),
    });
  const discoverHosts = options.discover ?? discover;
  const host =
    options.host ??
    new HostManager({
      directory: path.join(app.getPath("userData"), "host"),
    });
  const access =
    options.access ??
    new AccessServer({
      directory: path.join(app.getPath("userData"), "access"),
      host,
      onChange: () => {
        if (window) publish();
      },
    });
  await access.init();
  const openExternal =
    options.openExternal ?? ((url) => shell.openExternal(url));
  const status = new Map();
  let window;
  let discovering = false;
  const refreshing = new Map();
  let connection = null;

  function send(channel, data) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, data);
  }

  function snapshot() {
    const data = store.snapshot();
    const nativePath = data.settings.nativePath || findNativeExecutable();
    let nativeAvailable = false;
    if (nativePath) {
      try {
        validateNativeExecutable(nativePath);
        nativeAvailable = true;
      } catch (_error) {
        /* An invalid configured path is shown as missing in the UI. */
      }
    }
    return {
      ...data,
      devices: data.devices.map((device) => ({
        ...device,
        status: status.get(device.id) ?? null,
      })),
      engines: {
        nativePath,
        nativeAvailable,
      },
      host: { ...host.status(), access: access.status() },
      session: engines.status(),
      local: {
        hostname: os.hostname(),
        addresses: Object.values(os.networkInterfaces())
          .flat()
          .filter((entry) => entry.family === "IPv4" && !entry.internal)
          .map((entry) => entry.address),
      },
      version: app.getVersion(),
    };
  }

  function publish() {
    send("lan:state", snapshot());
  }

  async function check(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const device = store.device(id);
    const work = probe(device.address)
      .then((result) => {
        if (store.data.devices.some((entry) => entry.id === id))
          status.set(id, result);
        publish();
        return result;
      })
      .finally(() => refreshing.delete(id));
    refreshing.set(id, work);
    return work;
  }

  const methods = {
    state: () => snapshot(),
    hostPassword: async (input) => {
      await access.setPassword(
        typeof input === "string" ? input : input?.password,
        typeof input === "string" ? undefined : input?.address,
      );
      publish();
    },
    hostStart: async () => {
      if (!access.status().passwordConfigured)
        throw new Error("请先设置本机访问密码。");
      if (!["stopped", "error"].includes(host.status().phase))
        throw new Error("本机共享已开启或正在处理。");
      try {
        await host.start();
        await host.api("/api/clients/unpair-all", {});
        await access.start();
      } catch (error) {
        await access.stop();
        await host.stop();
        throw error;
      }
    },
    hostStop: async () => {
      await access.stop();
      await host.stop();
    },
    connectPassword: async (input) => {
      if (
        !input ||
        typeof input.password !== "string" ||
        input.password.length < 12 ||
        input.password.length > 128
      )
        throw new Error("请输入对方设置的 12–128 位访问密码。");
      if (connection || engines.status()) throw new Error("已有连接正在处理。");
      const work = { cancelled: false, operation: null };
      connection = work;
      try {
        const target = await (options.discoverCode ?? discoverCode)(input.code);
        if (work.cancelled) throw new Error("连接已取消。");
        let device = store
          .snapshot()
          .devices.find((entry) => entry.address === target.address);
        if (!device)
          device = store.add({
            name: `设备 ${input.code}`,
            address: target.address,
            app: "Desktop",
          });
        publish();
        await check(device.id);
        if (work.cancelled) throw new Error("连接已取消。");
        const shortcut =
          input.shortcutId && device.id === input.deviceId
            ? device.shortcuts.find((entry) => entry.id === input.shortcutId)
            : null;
        if (input.shortcutId && !shortcut)
          throw new Error("此快捷启动不属于目标设备。");
        await engines.start(
          "stream",
          device,
          store.snapshot().settings,
          shortcut?.app ?? device.app,
          { code: input.code, password: input.password },
        );
        const operation = engines.active;
        if (!operation) throw new Error("连接未能启动。");
        work.operation = operation;
        if (work.cancelled) {
          engines.cancel(operation.id);
          throw new Error("连接已取消。");
        }
        await operation.work;
        if (operation.error) throw operation.error;
        const session = engines.status();
        if (!session) throw new Error("连接已取消或结束。");
        return session;
      } finally {
        if (connection === work) connection = null;
      }
    },
    cancelConnect: () => {
      if (!connection) return;
      connection.cancelled = true;
      if (
        connection.operation &&
        engines.status()?.id === connection.operation.id
      )
        engines.cancel(connection.operation.id);
    },
    hostAllowClient: (address) => host.allowClient(address),
    add: async (input) => {
      const device = store.add(input);
      publish();
      await check(device.id);
      return device.id;
    },
    remove: (id) => {
      if (engines.status()?.deviceId === id)
        throw new Error("请先结束该设备的原生串流，再移除设备。");
      store.remove(id);
      status.delete(id);
      publish();
    },
    favorite: (id) => {
      store.update(id, (device) => {
        device.favorite = !device.favorite;
      });
      publish();
    },
    refresh: async (id) => {
      if (id) return check(id);
      const devices = store.snapshot().devices;
      for (let index = 0; index < devices.length; index += 8)
        await Promise.all(
          devices.slice(index, index + 8).map((device) => check(device.id)),
        );
      return snapshot();
    },
    discover: async () => {
      if (discovering) throw new Error("正在搜索局域网，请稍候。");
      discovering = true;
      try {
        return await discoverHosts();
      } finally {
        discovering = false;
      }
    },
    saveSettings: (input) => {
      if (input?.nativePath) validateNativeExecutable(input.nativePath);
      store.settings(input);
      publish();
    },
    pickNative: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 soluna-stream 原生引擎",
        properties: ["openFile"],
        ...(process.platform === "win32"
          ? {
              filters: [
                { name: "soluna-stream executable", extensions: ["exe"] },
              ],
            }
          : {}),
      });
      if (result.canceled) return null;
      return validateNativeExecutable(result.filePaths[0]);
    },
    shortcut: (input) => {
      const name = text(input?.name, "快捷方式名称", 48);
      const appName = validateAppName(input?.app);
      store.update(input.deviceId, (device) => {
        if (device.shortcuts.length >= 12)
          throw new Error("每台设备最多可添加 12 个快捷方式。");
        device.shortcuts.push({
          id: require("node:crypto").randomUUID(),
          name,
          app: appName,
        });
      });
      publish();
    },
    removeShortcut: (input) => {
      store.update(input?.deviceId, (device) => {
        if (!device.shortcuts.some((entry) => entry.id === input.shortcutId))
          throw new Error("快捷启动不存在。");
        device.shortcuts = device.shortcuts.filter(
          (entry) => entry.id !== input.shortcutId,
        );
      });
      publish();
    },
    cancel: (id) => engines.cancel(id),
    openSunshine: async (id) => {
      const target = await resolveLan(
        id ? store.device(id).address : "127.0.0.1",
      );
      await openExternal(`https://${target.ip}:${target.port + 1}/`);
    },
    openLink: async (key) => {
      if (!Object.hasOwn(links, key)) throw new Error("不支持的外部链接。");
      await openExternal(links[key]);
    },
    window: (action) => {
      if (action === "minimize") window.minimize();
      else if (action === "maximize")
        window.isMaximized() ? window.unmaximize() : window.maximize();
      else if (action === "close") window.close();
      else throw new Error("无效的窗口操作。");
    },
  };

  ipcMain.handle("lan:call", async (event, method, input) => {
    if (
      event.senderFrame?.url !== rendererUrl ||
      event.sender !== window?.webContents ||
      !Object.hasOwn(methods, method)
    )
      return { ok: false, error: "不允许的请求。" };
    try {
      return { ok: true, value: await methods[method](input) };
    } catch (error) {
      return { ok: false, error: error.message || "操作失败，请重试。" };
    }
  });
  engines.on("change", (event) => {
    publish();
    send("lan:engine", event);
  });
  host.on("change", () => {
    publish();
    if (["stopped", "error"].includes(host.status().phase))
      access
        .stop()
        .catch((error) =>
          dialog.showErrorBox("访问入口关闭失败", error.message),
        );
  });

  function createWindow() {
    window = new BrowserWindow({
      width: 1300,
      height: 900,
      minWidth: 940,
      minHeight: 680,
      frame: false,
      backgroundColor: "#f6f8fc",
      title: "SolunaRemote",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => {
      if (
        (!engines.status() &&
          !["running", "starting"].includes(host.status().phase)) ||
        options.skipCloseConfirmation
      )
        return;
      const choice = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["继续使用", "结束进程并退出"],
        defaultId: 0,
        cancelId: 0,
        title: "远程连接仍在运行",
        message:
          "退出将结束本程序的客户端串流和本机共享，已连接本机的设备将断开；不会关闭远端应用。",
      });
      if (choice === 0) event.preventDefault();
    });
    window.loadFile(rendererFile);
    return window;
  }

  createWindow();
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    methods.cancelConnect();
    engines.dispose();
    access
      .stop()
      .then(() => host.stop())
      .then(() => {
        quitting = true;
        app.quit();
      })
      .catch((error) => {
        dialog.showErrorBox("本机共享尚未退出", error.message);
      });
  });
  return { store, engines, host, window, methods };
}

if (require.main === module)
  bootstrap().catch((error) => {
    dialog.showErrorBox("SolunaRemote 启动失败", error.message);
    app.quit();
  });
module.exports = { bootstrap };
