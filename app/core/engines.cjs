const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { randomInt, randomUUID } = require("node:crypto");
const { validateSettings, appName } = require("./validation.cjs");
const { resolveLan } = require("./network.cjs");

function findExecutable(kind, platform = process.platform) {
  const candidates =
    platform === "win32"
      ? kind === "moonlight"
        ? [
            path.join(
              process.env.ProgramFiles || "C:\\Program Files",
              "Moonlight Game Streaming",
              "Moonlight.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA || "",
              "Programs",
              "Moonlight Game Streaming",
              "Moonlight.exe",
            ),
          ]
        : [
            path.join(
              process.env.ProgramFiles || "C:\\Program Files",
              "Sunshine",
              "sunshine.exe",
            ),
          ]
      : kind === "moonlight"
        ? [
            "/usr/bin/moonlight",
            "/usr/local/bin/moonlight",
            "/Applications/Moonlight.app/Contents/MacOS/Moonlight",
          ]
        : [
            "/usr/bin/sunshine",
            "/usr/local/bin/sunshine",
            "/Applications/Sunshine.app/Contents/MacOS/sunshine",
          ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

function validateExecutable(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable))
    throw new Error("请在设置中选择客户端可执行文件。");
  try {
    if (!fs.statSync(executable).isFile())
      throw new Error("选择的路径不是文件。");
  } catch (error) {
    throw new Error(
      `无法访问 Moonlight 可执行文件，请重新选择：${error.message}`,
    );
  }
  if (
    process.platform === "win32" &&
    path.extname(executable).toLowerCase() !== ".exe"
  )
    throw new Error("请选择 Moonlight.exe，不支持命令脚本。");
  return executable;
}

function streamArgs(target, app, input) {
  const settings = validateSettings(input);
  return [
    "stream",
    target,
    appName(app),
    "--resolution",
    settings.resolution,
    "--fps",
    String(settings.fps),
    "--bitrate",
    String(settings.bitrate),
    "--display-mode",
    settings.displayMode,
    "--video-codec",
    settings.codec,
    "--absolute-mouse",
    "--no-quit-after",
  ];
}

class Engines extends EventEmitter {
  constructor({ spawnImpl = spawn, resolveImpl = resolveLan } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.resolveImpl = resolveImpl;
    this.active = null;
  }

  status() {
    if (!this.active) return null;
    const { id, deviceId, kind, app, startedAt, pin } = this.active;
    return {
      id,
      deviceId,
      kind,
      app,
      startedAt,
      ...(kind === "pair" ? { pin } : {}),
    };
  }

  async start(kind, device, settings, appName) {
    if (!["pair", "stream"].includes(kind))
      throw new Error("无效的 Moonlight 操作。");
    if (this.active)
      throw new Error("已有配对或串流进程正在运行，请先结束当前操作。");
    // Reserve the operation before asynchronous DNS resolution to prevent double launches.
    const operation = {
      id: randomUUID(),
      deviceId: device.id,
      kind,
      app: appName ?? device.app,
      startedAt: new Date().toISOString(),
      pin: kind === "pair" ? String(randomInt(1000, 10000)) : undefined,
    };
    this.active = operation;
    try {
      const executable = validateExecutable(
        settings.moonlightPath || findExecutable("moonlight"),
      );
      const target = await this.resolveImpl(device.address);
      if (this.active !== operation) throw new Error("操作已取消。");
      const args =
        kind === "pair"
          ? ["pair", target.target, "--pin", operation.pin]
          : streamArgs(target.target, operation.app, settings);
      const child = this.spawnImpl(executable, args, {
        shell: false,
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      operation.child = child;
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk) => {
          output = (output + chunk.toString()).slice(-8000);
        });
      }
      const finish = (code, error) => {
        if (this.active !== operation) return;
        clearTimeout(operation.timer);
        this.active = null;
        this.emit("change", {
          ...this.publicResult(operation),
          code,
          success: !error && code === 0,
          error:
            error?.message ??
            (code === 0
              ? null
              : `Moonlight 退出（${code ?? "被中断"}）。${output.trim().slice(-1200) || "请检查配对状态、Sunshine 的 Desktop 应用及显示器是否可用。"}`),
        });
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
      operation.timer =
        kind === "pair"
          ? setTimeout(() => {
              const result = this.publicResult(operation);
              this.cancel(operation.id);
              this.emit("change", {
                ...result,
                success: false,
                error:
                  "配对窗口已超过 90 秒并关闭；配对结果请以 Moonlight 的提示为准。",
              });
            }, 90000)
          : null;
      this.emit("change", { ...this.publicResult(operation), started: true });
      return this.status();
    } catch (error) {
      if (this.active === operation) this.active = null;
      throw error;
    }
  }

  publicResult(operation) {
    return {
      id: operation.id,
      deviceId: operation.deviceId,
      kind: operation.kind,
      app: operation.app,
    };
  }

  cancel(id) {
    const operation = this.active;
    if (!operation || operation.id !== id) throw new Error("操作已经结束。");
    clearTimeout(operation.timer);
    this.active = null;
    // Only terminate the exact child launched by this app; never kill by executable name.
    operation.child?.kill();
    this.emit("change", { ...this.publicResult(operation), cancelled: true });
  }

  dispose() {
    if (this.active) this.cancel(this.active.id);
  }
}

module.exports = { Engines, streamArgs, findExecutable, validateExecutable };
