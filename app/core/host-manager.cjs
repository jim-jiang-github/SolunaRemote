const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");
const { isPrivateIPv4 } = require("./validation.cjs");

function findHostExecutable() {
  return (
    [
      ...(process.env.SOLUNA_RESOURCES_DIR
        ? [path.join(process.env.SOLUNA_RESOURCES_DIR, "host", "sunshine.exe")]
        : []),
      ...(process.resourcesPath
        ? [path.join(process.resourcesPath, "host", "sunshine.exe")]
        : []),
      path.join(__dirname, "..", "..", "host", "bin", "sunshine.exe"),
    ].find((candidate) => syncFs.existsSync(candidate)) ?? ""
  );
}

function localRequest(
  port,
  endpoint,
  { body, cert, authorization, signal } = {},
) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const request = (cert ? https : http).request(
      {
        host: "127.0.0.1",
        port,
        path: endpoint,
        method: data ? "POST" : "GET",
        signal,
        ...(cert
          ? {
              ca: cert,
              rejectUnauthorized: true,
              checkServerIdentity: (_hostname, peer) =>
                peer.raw?.equals(new crypto.X509Certificate(cert).raw)
                  ? undefined
                  : new Error("内置主机的管理证书发生变化。"),
            }
          : {}),
        headers: {
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(authorization ? { Authorization: authorization } : {}),
        },
      },
      (response) => {
        let value = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          value += chunk;
          if (Buffer.byteLength(value) > 1024 * 1024)
            response.destroy(new Error("内置主机响应超过限制。"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200)
            reject(
              new Error(`内置主机管理请求失败：HTTP ${response.statusCode}`),
            );
          else resolve(value);
        });
      },
    );
    request.setTimeout(8000, () =>
      request.destroy(new Error("内置主机管理请求超时。")),
    );
    request.on("error", reject);
    request.end(data);
  });
}

async function assertPortsFree() {
  for (const port of [47984, 47989, 47990, 48010]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", () =>
        reject(
          new Error(
            `端口 ${port} 已被占用，请先关闭其他 Sunshine 或共享实例。`,
          ),
        ),
      );
      server.listen({ host: "0.0.0.0", port, exclusive: true }, () =>
        server.close(resolve),
      );
    });
  }
}

class HostManager extends EventEmitter {
  constructor({
    directory,
    executable = findHostExecutable(),
    spawnImpl = spawn,
    requestImpl = localRequest,
    portsImpl = assertPortsFree,
  }) {
    super();
    this.directory = directory;
    this.executable = executable;
    this.spawn = spawnImpl;
    this.request = requestImpl;
    this.ports = portsImpl;
    this.phase = "stopped";
    this.error = null;
    this.pending = [];
    this.log = "";
    this.child = null;
    this.pollTimer = null;
    this.operation = null;
    this.allowedAddress = null;
  }

  status() {
    return {
      available: Boolean(this.executable),
      phase: this.phase,
      error: this.error,
      pending: this.pending,
      allowedAddress: this.allowedAddress,
    };
  }

  publish() {
    this.emit("change", this.status());
  }

  async api(endpoint, body) {
    const raw = await this.request(47990, endpoint, {
      body,
      cert: this.cert,
      authorization: this.authorization,
      signal: this.operation?.signal,
    });
    const result = JSON.parse(raw);
    if (result.status === false) throw new Error("内置主机拒绝操作。");
    return result;
  }

  async start() {
    if (this.phase !== "stopped" && this.phase !== "error")
      throw new Error("本机共享已启动或正在处理，请勿重复启动。");
    if (this.child) throw new Error("上一个共享进程尚未退出。");
    if (!this.executable)
      throw new Error(
        "发行包缺少内置 Sunshine，请先运行 npm run prepare:host 后重新打包。",
      );
    this.phase = "starting";
    this.error = null;
    this.log = "";
    this.operation = new AbortController();
    const operation = this.operation;
    this.publish();
    try {
      await this.ports();
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const configFile = path.join(this.directory, "sunshine.conf");
      const config = [
        "sunshine_name = SolunaRemote",
        "upnp = disabled",
        "system_tray = disabled",
        "origin_web_ui_allowed = pc",
        "address_family = ipv4",
        "min_log_level = 2",
        `file_apps = ${path.join(this.directory, "apps.json")}`,
        `file_state = ${path.join(this.directory, "state.json")}`,
        `credentials_file = ${path.join(this.directory, "web.json")}`,
        `log_path = ${path.join(this.directory, "sunshine.log")}`,
        `pkey = ${path.join(this.directory, "credentials", "cakey.pem")}`,
        `cert = ${path.join(this.directory, "credentials", "cacert.pem")}`,
      ].join("\n");
      await fs.mkdir(path.join(this.directory, "credentials"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(configFile, config, { mode: 0o600 });
      try {
        await fs.writeFile(
          path.join(this.directory, "apps.json"),
          JSON.stringify({
            env: {},
            apps: [{ name: "Desktop", "image-path": "desktop.png" }],
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      operation.signal.throwIfAborted();
      const child = this.spawn(this.executable, [configFile], {
        cwd: path.dirname(this.executable),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const record = (data) => {
        this.log = (this.log + data.toString()).slice(-12000);
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      child.once("error", (error) => this.fail(error));
      child.once("close", (code) => {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(this.pollTimer);
        this.pending = [];
        this.authorization = null;
        if (this.phase !== "stopping" && this.phase !== "error") {
          this.fail(
            new Error(
              `内置主机意外退出（${code ?? "被中断"}），请检查显示器、编码器或端口。`,
            ),
          );
        } else if (this.phase === "stopping") {
          this.phase = "stopped";
          this.publish();
        }
      });
      const deadline = Date.now() + 60000;
      let lastError;
      while (Date.now() < deadline) {
        operation.signal.throwIfAborted();
        if (this.child !== child || this.phase === "error")
          throw new Error(this.error || "内置主机未能启动。");
        try {
          this.cert = await fs.readFile(
            path.join(this.directory, "credentials", "cacert.pem"),
            "utf8",
          );
          await this.request(47990, "/welcome", {
            cert: this.cert,
            signal: operation.signal,
          });
          break;
        } catch (error) {
          if (/HTTP 30[1278]|HTTP 401/.test(error.message)) break;
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          `内置主机启动超时：${lastError?.message || "管理端口未就绪"}。请查看 ${path.join(this.directory, "sunshine.log")}`,
        );
      let credentials;
      const credentialPath = path.join(this.directory, "manager.json");
      try {
        credentials = JSON.parse(await fs.readFile(credentialPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        credentials = {
          username: "solunaremote",
          password: crypto.randomBytes(32).toString("base64url"),
        };
        // Persist before the API call so a crash cannot lose the sole management credential.
        await fs.writeFile(credentialPath, JSON.stringify(credentials), {
          flag: "wx",
          mode: 0o600,
        });
      }
      this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
      // Initial setup is idempotent: authenticate with the persisted credential first.
      try {
        await this.api("/api/pin");
      } catch (error) {
        if (!/HTTP 30[1278]|HTTP 401/.test(error.message)) throw error;
        const setup = await this.request(47990, "/api/password", {
          cert: this.cert,
          authorization: this.authorization,
          signal: operation.signal,
          body: {
            currentUsername: credentials.username,
            currentPassword: credentials.password,
            newUsername: credentials.username,
            newPassword: credentials.password,
            confirmNewPassword: credentials.password,
          },
        });
        if (JSON.parse(setup).status !== true)
          throw new Error("内置主机管理身份初始化失败。");
      }
      operation.signal.throwIfAborted();
      await this.refreshPending();
      this.phase = "running";
      this.publish();
      this.schedulePoll();
      return this.status();
    } catch (error) {
      if (this.phase === "stopping" || this.phase === "stopped") throw error;
      this.fail(error);
      if (this.child) this.child.kill();
      throw error;
    }
  }

  fail(error) {
    this.phase = "error";
    this.error = error.message;
    this.pending = [];
    clearTimeout(this.pollTimer);
    this.operation?.abort(error);
    this.publish();
  }

  async refreshPending() {
    const result = await this.api("/api/pin");
    if (!Array.isArray(result.pairings))
      throw new Error("内置主机返回无效配对列表。");
    this.pending = result.pairings.map((item) => {
      const address = String(item.address ?? "").replace(/^::ffff:/, "");
      if (!/^[a-f0-9]{32}$/i.test(item.id) || !isPrivateIPv4(address))
        throw new Error("内置主机收到非内网或无效配对请求。");
      return {
        id: item.id,
        name: String(item.name ?? "").slice(0, 128),
        address,
      };
    });
  }

  schedulePoll() {
    this.pollTimer = setTimeout(async () => {
      if (this.phase !== "running") return;
      try {
        await this.refreshPending();
        this.publish();
        this.schedulePoll();
      } catch (error) {
        if (this.phase !== "stopping" && this.phase !== "stopped") {
          this.fail(error);
          this.child?.kill();
        }
      }
    }, 1500);
    this.pollTimer.unref?.();
  }

  async approve(input) {
    if (this.phase !== "running") throw new Error("请先开启本机共享。");
    if (
      !input ||
      !/^\d{4}$/.test(input.pin) ||
      !this.pending.some((item) => item.id === input.id)
    )
      throw new Error("请选择待授权设备，并输入客户端显示的四位 PIN。");
    await this.api("/api/pin", {
      pairing_id: input.id,
      pin: input.pin,
      name: "SolunaRemote",
    });
    await this.refreshPending();
    this.publish();
  }

  stop() {
    clearTimeout(this.pollTimer);
    this.pending = [];
    this.operation?.abort(new Error("本机共享已停止。"));
    if (!this.child) {
      this.phase = "stopped";
      this.error = null;
      this.publish();
      return Promise.resolve();
    }
    this.phase = "stopping";
    this.publish();
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("内置主机尚未退出，请勿重复启动。")),
        8000,
      );
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill();
    });
  }

  async allowClient(address) {
    if (process.platform !== "win32")
      throw new Error("当前仅支持 Windows 共享防火墙设置。");
    if (
      !isPrivateIPv4(address) ||
      address.startsWith("127.") ||
      address.startsWith("169.254.")
    )
      throw new Error(
        "请填写获准控制本机的设备私有 IPv4 地址，不接受公网、回环或子网。",
      );
    if (!this.executable) throw new Error("缺少内置共享引擎。");
    const script =
      process.resourcesPath &&
      syncFs.existsSync(
        path.join(process.resourcesPath, "host-tools", "host-firewall.ps1"),
      )
        ? path.join(process.resourcesPath, "host-tools", "host-firewall.ps1")
        : path.join(__dirname, "..", "host-firewall.ps1");
    const encode = (value) => `'${value.replace(/'/g, "''")}'`;
    const command = `& ${encode(script)} -Executable ${encode(this.executable)} -AppExecutable ${encode(process.execPath)} -Address ${encode(address)}`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const elevate = `Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' | ForEach-Object { if ($_.ExitCode -ne 0) { throw 'Firewall authorization failed.' } }`;
    await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-Command", elevate],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 16384,
      },
    );
    this.allowedAddress = address;
    this.publish();
  }
}

module.exports = { HostManager, findHostExecutable, localRequest };
