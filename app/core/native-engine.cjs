const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");
const { randomInt, randomUUID, randomBytes } = require("node:crypto");
const { authorize } = require("./access.cjs");
const { resolveLan } = require("./network.cjs");
const { validateSettings, appName } = require("./validation.cjs");
const { HostControl } = require("./host-control.cjs");

function findNativeExecutable() {
  const name =
    process.platform === "win32" ? "soluna-stream.exe" : "soluna-stream";
  return (
    [
      ...(process.env.SOLUNA_RESOURCES_DIR
        ? [path.join(process.env.SOLUNA_RESOURCES_DIR, "native", name)]
        : []),
      ...(process.resourcesPath
        ? [path.join(process.resourcesPath, "native", name)]
        : []),
      path.join(__dirname, "..", "..", "native", "bin", name),
    ].find((candidate) => fs.existsSync(candidate)) ?? ""
  );
}

function validateNativeExecutable(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable))
    throw new Error(
      "未找到 soluna-stream 原生引擎。请先运行 npm run build:native，或在设置中选择已编译的 soluna-stream.exe。",
    );
  if (
    process.platform === "win32" &&
    path.extname(executable).toLowerCase() !== ".exe"
  )
    throw new Error(
      "请选择编译后的 soluna-stream.exe，不支持命令脚本或其他客户端。",
    );
  try {
    if (!fs.statSync(executable).isFile()) throw new Error("路径不是文件");
  } catch (error) {
    throw new Error(`无法访问 soluna-stream 引擎：${error.message}`);
  }
  return executable;
}

class NativeEngine extends EventEmitter {
  constructor({
    directory,
    hostControl,
    spawnImpl = spawn,
    executeImpl = promisify(execFile),
    resolveImpl = resolveLan,
    authorizeImpl = authorize,
  }) {
    super();
    this.control = hostControl ?? new HostControl(directory);
    this.spawn = spawnImpl;
    this.execute = executeImpl;
    this.resolve = resolveImpl;
    this.authorize = authorizeImpl;
    this.active = null;
    this.children = new Set();
  }

  status() {
    if (!this.active) return null;
    const { id, deviceId, kind, app, startedAt, pin, phase, stats } =
      this.active;
    return {
      id,
      deviceId,
      kind,
      app,
      startedAt,
      phase,
      ...(kind === "pair" ? { pin } : {}),
      ...(stats ? { stats } : {}),
    };
  }

  result(operation) {
    const { id, deviceId, kind, app } = operation;
    return { id, deviceId, kind, app, engine: "native" };
  }

  async start(kind, device, input, name, credentials) {
    if (!["pair", "stream"].includes(kind))
      throw new Error("无效的原生引擎操作。");
    if (this.active || this.children.size)
      throw new Error("已有配对或串流正在运行，请先结束当前操作。");
    const settings = validateSettings(input);
    const executable = validateNativeExecutable(
      settings.nativePath || findNativeExecutable(),
    );
    const operation = {
      id: randomUUID(),
      deviceId: device.id,
      deviceName: device.name,
      kind,
      app: appName(name ?? device.app),
      startedAt: new Date().toISOString(),
      phase: "preparing",
      pin: kind === "pair" ? String(randomInt(1000, 10000)) : undefined,
      controller: new AbortController(),
      firstFrame: false,
      credentials,
    };
    this.active = operation;
    try {
      const target = await this.resolve(device.address);
      if (this.active !== operation) throw new Error("操作已取消。");
      this.emit("change", { ...this.result(operation), started: true });
      operation.timer =
        kind === "pair"
          ? setTimeout(() => {
              operation.controller.abort(
                new Error("配对超过 90 秒，请重新发起。"),
              );
            }, 90000)
          : null;
      operation.work = this.run(operation, target, executable, settings).catch(
        (error) => {
          this.finish(operation, error);
        },
      );
      return this.status();
    } catch (error) {
      if (this.active === operation) this.active = null;
      throw error;
    }
  }

  async run(operation, target, executable, settings) {
    const { signal } = operation.controller;
    const { stdout } = await this.execute(executable, ["--capabilities"], {
      signal,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16384,
    });
    const capabilities = JSON.parse(stdout);
    if (
      capabilities.event !== "capabilities" ||
      capabilities.protocol !== 1 ||
      typeof capabilities.launchParams !== "string"
    )
      throw new Error(
        "所选程序不是兼容的 soluna-stream 引擎，请选择随包或自行编译的原生引擎。",
      );
    if (this.active !== operation) return;
    if (operation.kind === "pair") {
      operation.phase = "waiting-pin";
      this.emit("change", { ...this.result(operation), progress: true });
      await this.control.pair(target, executable, operation.pin, signal);
      signal.throwIfAborted();
      this.finish(operation);
      return;
    }
    operation.phase = "launching";
    if (operation.credentials) {
      const { code, password } = operation.credentials;
      operation.credentials = undefined;
      const nonce = randomBytes(16).toString("hex");
      const pin = String(randomInt(1000, 10000));
      try {
        await this.authorize(target, code, password, undefined, signal);
        await Promise.all([
          this.control.pair(target, executable, pin, signal, nonce),
          this.authorize(target, code, password, { nonce, pin }, signal),
        ]);
      } catch (error) {
        operation.controller.abort(error);
        throw error;
      }
    }
    const config = await this.control.launch(
      target,
      executable,
      operation.app,
      settings,
      signal,
      capabilities.launchParams,
    );
    if (this.active !== operation) return;
    const child = this.spawn(executable, [], {
      shell: false,
      windowsHide: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    operation.child = child;
    this.children.add(child);
    let pending = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > 65536) {
        this.stopChild(child);
        this.finish(operation, new Error("原生引擎输出超过限制，已终止。"));
        return;
      }
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(operation, JSON.parse(line));
        } catch (error) {
          this.stopChild(child);
          this.finish(
            operation,
            new Error(`原生引擎协议错误：${error.message}`),
          );
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.once("error", (error) => {
      if (this.active === operation) {
        this.stopChild(child);
        this.finish(
          operation,
          new Error(`无法向原生引擎发送配置：${error.message}`),
        );
      }
    });
    child.once("error", (error) => this.finish(operation, error));
    child.once("close", (code) => {
      clearTimeout(child.stopTimer);
      this.children.delete(child);
      const error =
        operation.error ||
        (code !== 0
          ? new Error(
              `soluna-stream 退出（${code ?? "被中断"}）。${stderr.slice(-1000)}`,
            )
          : !operation.firstFrame
            ? new Error("串流已结束，但没有收到渲染首帧。")
            : null);
      this.finish(operation, error);
    });
    child.stdin.write(
      `${JSON.stringify({ ...config, deviceName: operation.deviceName })}\n`,
    );
    operation.frameTimer = setTimeout(() => {
      if (!operation.firstFrame && this.active === operation) {
        this.stopChild(child);
        this.finish(
          operation,
          new Error(
            "35 秒内没有渲染首帧，请检查 Sunshine 显示器、编码器和 UDP 防火墙。",
          ),
        );
      }
    }, 35000);
  }

  receive(operation, event) {
    if (this.active !== operation || operation.cancelled) return;
    if (!event || typeof event.event !== "string")
      throw new Error("事件格式无效");
    const text = (value) => String(value ?? "").slice(0, 500);
    if (event.event === "error") {
      operation.error = new Error(
        `${text(event.message)}${event.code ? ` (${text(event.code)})` : ""}`,
      );
      this.emit("change", {
        ...this.result(operation),
        progress: true,
        warning: operation.error.message,
      });
    } else if (event.event === "first-frame") {
      if (
        !Number.isInteger(event.width) ||
        !Number.isInteger(event.height) ||
        event.width <= 0 ||
        event.width > 7680 ||
        event.height <= 0 ||
        event.height > 4320
      )
        throw new Error("首帧尺寸无效");
      clearTimeout(operation.frameTimer);
      operation.firstFrame = true;
      operation.phase = "streaming";
      this.emit("change", { ...this.result(operation), firstFrame: true });
    } else if (event.event === "connected" || event.event === "stage") {
      if (!operation.firstFrame)
        operation.phase =
          event.event === "connected" ? "waiting-frame" : text(event.name);
      this.emit("change", { ...this.result(operation), progress: true });
    } else if (event.event === "warning") {
      this.emit("change", {
        ...this.result(operation),
        progress: true,
        warning: text(event.message),
      });
    } else if (event.event === "stats") {
      if (
        ![event.decoded, event.rendered, event.audioPackets].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        (event.keyboardEvents !== undefined &&
          (!Number.isSafeInteger(event.keyboardEvents) ||
            event.keyboardEvents < 0))
      )
        throw new Error("统计数据无效");
      operation.stats = {
        decoded: event.decoded,
        rendered: event.rendered,
        audioPackets: event.audioPackets,
        ...(event.keyboardEvents !== undefined
          ? { keyboardEvents: event.keyboardEvents }
          : {}),
      };
      this.emit("change", { ...this.result(operation), progress: true });
    }
  }

  finish(operation, error) {
    if (this.active !== operation) return;
    operation.error = error;
    clearTimeout(operation.timer);
    clearTimeout(operation.frameTimer);
    this.active = null;
    this.emit(
      "change",
      operation.cancelled
        ? { ...this.result(operation), cancelled: true }
        : {
            ...this.result(operation),
            success: !error,
            error: error?.message ?? null,
          },
    );
  }

  stopChild(child) {
    if (child.exitCode !== null || child.stopTimer) return;
    if (child.stdin.writable) child.stdin.end("stop\n");
    child.stopTimer = setTimeout(() => child.kill(), 3000);
    child.stopTimer.unref();
  }

  cancel(id) {
    const operation = this.active;
    if (!operation || operation.id !== id) throw new Error("操作已经结束。");
    clearTimeout(operation.timer);
    clearTimeout(operation.frameTimer);
    operation.cancelled = true;
    operation.controller.abort(new Error("操作已取消。"));
    if (operation.child) {
      operation.phase = "stopping";
      this.stopChild(operation.child);
      this.emit("change", { ...this.result(operation), progress: true });
      return;
    }
    this.active = null;
    this.emit("change", { ...this.result(operation), cancelled: true });
  }

  dispose() {
    if (this.active) this.cancel(this.active.id);
    for (const child of this.children) child.kill();
  }
}

module.exports = {
  NativeEngine,
  findNativeExecutable,
  validateNativeExecutable,
};
