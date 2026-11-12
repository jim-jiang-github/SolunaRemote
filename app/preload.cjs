const { contextBridge, ipcRenderer } = require("electron");

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
contextBridge.exposeInMainWorld("lan", {
  call: async (method, input) => {
    if (!allowed.has(method)) throw new Error("不支持的操作。");
    const result = await ipcRenderer.invoke("lan:call", method, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("lan:state", listener);
    return () => ipcRenderer.removeListener("lan:state", listener);
  },
  onEngine: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("lan:engine", listener);
    return () => ipcRenderer.removeListener("lan:engine", listener);
  },
});
