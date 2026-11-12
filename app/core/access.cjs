const fs = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Bonjour } = require("bonjour-service");
const os = require("node:os");
const { isPrivateIPv4 } = require("./validation.cjs");

const derive = promisify(crypto.scrypt);
const TLS_OPTIONS = {
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305",
};
const validCode = (code) => typeof code === "string" && /^\d{12}$/.test(code);
function encodeAddress(ip) {
  if (!isPrivateIPv4(ip)) throw new Error("设备码仅支持内网 IPv4。");
  const value = ip
    .split(".")
    .reduce((result, part) => result * 256 + Number(part), 0);
  return String(value).padStart(10, "0") + String(value % 97).padStart(2, "0");
}
function decodeAddress(code) {
  if (!validCode(code)) return null;
  const value = Number(code.slice(0, 10));
  if (value > 0xffffffff || value % 97 !== Number(code.slice(10))) return null;
  const ip = [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
  return isPrivateIPv4(ip) && encodeAddress(ip) === code ? ip : null;
}
async function passwordKey(password, code) {
  if (
    !validCode(code) ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new Error("设备码需为 12 位数字，密码需为 12–128 个字符。");
  return derive(password, `SolunaRemote-access-v1:${code}`, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

class AccessServer {
  constructor({
    directory,
    host,
    port = 47991,
    advertise = true,
    onChange = () => {},
    addresses = () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (entry) =>
            entry.family === "IPv4" &&
            !entry.internal &&
            isPrivateIPv4(entry.address) &&
            !entry.address.startsWith("169.254."),
        )
        .map((entry) => entry.address),
  }) {
    this.directory = directory;
    this.host = host;
    this.port = port;
    this.advertise = advertise;
    this.onChange = onChange;
    this.addresses = addresses;
    this.server = null;
    this.sockets = new Set();
    this.attempts = new Map();
    this.activePair = false;
    this.rejectedAuth = 0;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "access.json");
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !validCode(saved.code) ||
        (saved.key !== null && !/^[a-f0-9]{64}$/.test(saved.key))
      )
        throw new Error("本机访问配置损坏；请保留文件并检查。");
      this.code = saved.code;
      this.address = saved.address ?? null;
      this.key = saved.key ? Buffer.from(saved.key, "hex") : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.address = this.addresses()[0] ?? null;
      this.code = this.address
        ? encodeAddress(this.address)
        : String(crypto.randomInt(100000000000, 1000000000000));
      this.key = null;
      await this.save();
    }
  }
  status() {
    return {
      code: this.code,
      address: this.address,
      addresses: this.addresses(),
      passwordConfigured: Boolean(this.key),
      listening: Boolean(this.server),
      error: this.error ?? null,
      rejectedAuth: this.rejectedAuth,
    };
  }
  async save() {
    const file = path.join(this.directory, "access.json");
    const temporary = `${file}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({
        code: this.code,
        address: this.address,
        key: this.key?.toString("hex") ?? null,
      }),
      { mode: 0o600 },
    );
    await fs.rename(temporary, file);
  }
  async setPassword(password, address = this.address ?? this.addresses()[0]) {
    if (this.host.status().phase !== "stopped" || this.server)
      throw new Error("请先停止本机共享，再更改访问密码。");
    if (!this.addresses().includes(address))
      throw new Error("请选择当前可用的内网网卡地址。");
    const code = encodeAddress(address);
    const key = await passwordKey(password, code);
    const previous = this.key;
    const previousCode = this.code;
    const previousAddress = this.address;
    this.key = key;
    this.code = code;
    this.address = address;
    try {
      await this.save();
    } catch (error) {
      this.key = previous;
      this.code = previousCode;
      this.address = previousAddress;
      throw error;
    }
    this.onChange();
  }
  async start() {
    if (this.server) throw new Error("访问入口已启动。");
    if (!this.key) throw new Error("请先设置本机访问密码。");
    if (!this.addresses().includes(this.address))
      throw new Error("本机内网 IP 已变化，请重新选择网卡并设置访问密码。");
    const server = https.createServer(
      {
        ...TLS_OPTIONS,
        handshakeTimeout: 5000,
        pskCallback: (_socket, identity) =>
          identity === this.code ? this.key : null,
      },
      (request, response) => {
        this.handle(request, response).catch((error) => {
          if (!response.destroyed) {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: error.message }));
          }
        });
      },
    );
    server.requestTimeout = 40000;
    server.headersTimeout = 10000;
    server.on("connection", (socket) => {
      const address = socket.remoteAddress?.replace(/^::ffff:/, "");
      const now = Date.now();
      const attempt = this.attempts.get(address);
      const recent =
        attempt && now - attempt.since < 60000
          ? attempt
          : { since: now, count: 0 };
      recent.count++;
      this.attempts.set(address, recent);
      if (this.attempts.size > 256)
        for (const [key, value] of this.attempts)
          if (now - value.since >= 60000) this.attempts.delete(key);
      if (
        !isPrivateIPv4(address) ||
        recent.count > 10 ||
        this.sockets.size >= 8
      ) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(40000, () => socket.destroy());
    });
    server.on("tlsClientError", () => {
      this.rejectedAuth++;
      this.onChange();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    server.on("error", (error) => {
      this.error = error.message;
      this.onChange();
    });
    if (this.advertise) {
      this.bonjour = new Bonjour({}, (error) => {
        this.error = `设备码广播失败：${error.message}`;
        this.onChange();
      });
      this.service = this.bonjour.publish({
        name: `SolunaRemote-${this.code}`,
        type: "solunaremote",
        protocol: "tcp",
        port: this.port,
        txt: { code: this.code, protocol: "1" },
      });
      this.service.on("error", (error) => {
        this.error = `设备码广播失败：${error.message}`;
        this.onChange();
      });
    }
    this.onChange();
  }
  async handle(request, response) {
    if (
      request.method !== "POST" ||
      !["/pair", "/authenticate"].includes(request.url) ||
      this.host.status().phase !== "running"
    )
      throw new Error("本机共享不可用。");
    if (request.url === "/authenticate") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (this.activePair) throw new Error("已有连接正在验证，请稍后重试。");
    let data = "";
    for await (const chunk of request) {
      data += chunk;
      if (Buffer.byteLength(data) > 1024) throw new Error("连接请求过大。");
    }
    const input = JSON.parse(data);
    if (!/^\d{4}$/.test(input.pin) || !/^[a-f0-9]{32}$/.test(input.nonce))
      throw new Error("内部授权请求无效。");
    const address = request.socket.remoteAddress.replace(/^::ffff:/, "");
    this.activePair = true;
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (request.socket.destroyed || this.host.status().phase !== "running")
          throw new Error("连接已取消。");
        const result = await this.host.api("/api/pin");
        const pending = result.pairings.filter(
          (entry) =>
            entry.name === `SolunaRemote-${input.nonce}` &&
            entry.address.replace(/^::ffff:/, "") === address,
        );
        if (pending.length === 1) {
          await this.host.api("/api/pin", {
            pairing_id: pending[0].id,
            pin: input.pin,
            name: "SolunaRemote",
          });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"ok":true}');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("内部连接授权超时。");
    } finally {
      this.activePair = false;
    }
  }
  async stop() {
    this.service?.stop();
    this.bonjour?.destroy();
    this.service = null;
    this.bonjour = null;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    this.onChange();
  }
}

async function discoverCode(code, duration = 8000) {
  if (!validCode(code)) throw new Error("请输入 12 位数字设备码。");
  const directIp = decodeAddress(code);
  if (directIp)
    return { ip: directIp, port: 47989, address: directIp, accessPort: 47991 };
  return new Promise((resolve, reject) => {
    let browser = null;
    let bonjour = null;
    let settled = false;
    const found = new Map();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser?.stop();
      bonjour?.destroy();
      if (error) reject(new Error(`设备码发现失败：${error.message}`));
      else if (found.size !== 1)
        reject(
          new Error(
            found.size
              ? "设备码有多个匹配，请检查局域网。"
              : "未找到设备码，请确认两台电脑在同一局域网且对方已开启共享。",
          ),
        );
      else resolve([...found.values()][0]);
    };
    const timer = setTimeout(() => finish(), duration);
    bonjour = new Bonjour({}, finish);
    browser = bonjour.find(
      { type: "solunaremote", protocol: "tcp" },
      (service) => {
        if (
          String(service.txt?.code) !== code ||
          String(service.txt?.protocol) !== "1" ||
          service.port !== 47991
        )
          return;
        const addresses =
          service.addresses?.filter(
            (ip) => isPrivateIPv4(ip) && !ip.startsWith("127."),
          ) ?? [];
        const ip = addresses.includes(service.referer?.address)
          ? service.referer.address
          : addresses[0];
        if (ip)
          found.set(service.fqdn || service.name, {
            ip,
            port: 47989,
            address: ip,
            accessPort: 47991,
          });
      },
    );
  });
}

async function authorize(target, code, password, body, signal) {
  if (!isPrivateIPv4(target.ip)) throw new Error("仅允许内网设备连接。");
  const key = await passwordKey(password, code);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        ...TLS_OPTIONS,
        host: target.ip,
        port: target.accessPort ?? 47991,
        path: body === undefined ? "/authenticate" : "/pair",
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        signal,
        pskCallback: () => ({ identity: code, psk: key }),
        // RFC 4279 TLS-PSK authenticates both peers via the shared key, not X.509 names.
        checkServerIdentity: () => undefined,
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data) > 4096)
            response.destroy(new Error("设备响应过大。"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            if (response.statusCode !== 200 || JSON.parse(data).ok !== true)
              throw new Error("设备拒绝连接，请检查共享状态。");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(35000, () =>
      request.destroy(new Error("密码连接超时。")),
    );
    request.on("error", (error) =>
      reject(new Error(`设备码或密码验证失败：${error.message}`)),
    );
    request.end(JSON.stringify(body));
  });
}

module.exports = {
  encodeAddress,
  decodeAddress,
  AccessServer,
  passwordKey,
  discoverCode,
  authorize,
  TLS_OPTIONS,
};
