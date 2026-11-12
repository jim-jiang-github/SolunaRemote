const net = require("node:net");

const RESOLUTIONS = ["1280x720", "1920x1080", "2560x1440", "3840x2160"];
const FRAME_RATES = [30, 60, 90, 120];
const DEFAULT_SETTINGS = Object.freeze({
  moonlightPath: "",
  nativePath: "",
  resolution: "1920x1080",
  fps: 60,
  bitrate: 20000,
  displayMode: "borderless",
  codec: "auto",
});

function text(value, label, max = 64) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new Error(
      `${label}不能为空，且不能包含控制字符或超过 ${max} 个字符。`,
    );
  }
  return value.trim();
}

function appName(value) {
  const name = text(value, "Sunshine 应用名称", 100);
  if (name.startsWith("-"))
    throw new Error(
      "应用名称不能以连字符开头，以免被 Moonlight 识别为命令行选项。",
    );
  return name;
}

function isPrivateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function parseAddress(input) {
  const value = text(input, "设备地址", 253).toLowerCase();
  const match = /^([^:/\\?#@\s]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match)
    throw new Error(
      "请填写 IPv4 地址或主机名，可附带 Sunshine HTTP 端口；不要填写网址。",
    );
  const host = match[1].replace(/\.$/, "");
  const port = match[2] ? Number(match[2]) : 47989;
  if (port < 1024 || port > 65514)
    throw new Error(
      "Sunshine HTTP 端口需在 1024–65514 之间，为协议的相邻端口预留空间。",
    );
  if (/^[\d.]+$/.test(host)) {
    if (!isPrivateIPv4(host))
      throw new Error(
        "仅允许私有内网、回环或链路本地 IPv4 地址，不能连接公网地址。",
      );
  } else {
    if (
      host.length > 253 ||
      !host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw new Error("主机名格式无效；当前版本暂不支持 IPv6。");
    }
  }
  return { host, port, address: port === 47989 ? host : `${host}:${port}` };
}

function validateSettings(input) {
  if (!input || typeof input !== "object") throw new Error("设置格式无效。");
  if (!RESOLUTIONS.includes(input.resolution))
    throw new Error("不支持的分辨率。");
  if (!FRAME_RATES.includes(input.fps)) throw new Error("不支持的帧率。");
  if (
    !Number.isInteger(input.bitrate) ||
    input.bitrate < 1000 ||
    input.bitrate > 150000
  )
    throw new Error("码率需为 1000–150000 Kbps。");
  if (!["windowed", "borderless", "fullscreen"].includes(input.displayMode))
    throw new Error("不支持的窗口模式。");
  if (!["auto", "H.264", "HEVC", "AV1"].includes(input.codec))
    throw new Error("不支持的视频编码。");
  if (
    typeof input.moonlightPath !== "string" ||
    input.moonlightPath.length > 4096
  )
    throw new Error("设置格式无效。");
  if (
    input.nativePath !== undefined &&
    (typeof input.nativePath !== "string" || input.nativePath.length > 4096)
  )
    throw new Error("原生引擎路径格式无效。");
  return {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS).map((key) => [
        key,
        input[key] ?? DEFAULT_SETTINGS[key],
      ]),
    ),
  };
}

function validateDevice(input) {
  if (!input || typeof input !== "object") throw new Error("设备格式无效。");
  return {
    name: text(input.name, "设备名称", 48),
    address: parseAddress(input.address).address,
    app: appName(input.app ?? "Desktop"),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  RESOLUTIONS,
  FRAME_RATES,
  text,
  appName,
  isPrivateIPv4,
  parseAddress,
  validateSettings,
  validateDevice,
};
