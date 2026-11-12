const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const {
  isPrivateIPv4,
  appName,
  validateSettings,
} = require("./validation.cjs");

const execute = promisify(execFile);
const digest = (...parts) =>
  crypto.createHash("sha256").update(Buffer.concat(parts)).digest();

function parseResponse(xml) {
  if (
    typeof xml !== "string" ||
    Buffer.byteLength(xml) > 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new Error("Sunshine 响应不是有效的 GameStream XML。");
  const root = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: true,
  }).parse(xml).root;
  if (!root || String(root["@_status_code"]) !== "200")
    throw new Error(
      `Sunshine 拒绝请求（${String(root?.["@_status_code"] ?? "无状态码")}）：${String(root?.["@_status_message"] ?? "请检查配对、显示器和编码器。").slice(0, 200)}`,
    );
  return root;
}

function decodeHex(value, min, max = min) {
  if (
    typeof value !== "string" ||
    value.length % 2 ||
    !/^[a-f0-9]+$/i.test(value) ||
    value.length < min * 2 ||
    value.length > max * 2
  )
    throw new Error("Sunshine 配对数据长度或格式无效。");
  return Buffer.from(value, "hex");
}

function certificateSignature(pem) {
  const raw = new crypto.X509Certificate(pem).raw;
  function element(offset) {
    const tag = raw[offset++];
    let length = raw[offset++];
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count < 1 || count > 4 || offset + count > raw.length)
        throw new Error("证书 DER 长度无效。");
      length = raw.readUIntBE(offset, count);
      offset += count;
    }
    if (!Number.isInteger(length) || offset + length > raw.length)
      throw new Error("证书 DER 数据不完整。");
    return { tag, offset, end: offset + length };
  }
  const sequence = element(0);
  const tbs = element(sequence.offset);
  const algorithm = element(tbs.end);
  const signature = element(algorithm.end);
  if (
    sequence.tag !== 0x30 ||
    sequence.end !== raw.length ||
    signature.tag !== 3 ||
    signature.end !== sequence.end ||
    raw[signature.offset] !== 0
  )
    throw new Error("证书签名结构无效。");
  return raw.subarray(signature.offset + 1, signature.end);
}

function aes(data, key, decrypt = false) {
  if (!Buffer.isBuffer(data) || !data.length || data.length % 16)
    throw new Error("无效的 AES 配对数据。");
  const cipher = decrypt
    ? crypto.createDecipheriv("aes-128-ecb", key, null)
    : crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function request(
  target,
  command,
  params,
  { identity, serverCert, secure = false, timeout = 5000, signal } = {},
) {
  if (
    !isPrivateIPv4(target.ip) ||
    !Number.isInteger(secure ? target.httpsPort : target.port) ||
    (secure ? target.httpsPort : target.port) < 1024 ||
    (secure ? target.httpsPort : target.port) > 65535
  )
    return Promise.reject(new Error("拒绝非内网地址或无效端口。"));
  if (secure && (!serverCert || !identity))
    return Promise.reject(
      new Error("TLS 控制请求需要已配对证书和客户端身份。"),
    );
  const query = new URLSearchParams({
    uniqueid: identity?.id ?? "0123456789ABCDEF",
    uuid: crypto.randomBytes(16).toString("hex"),
    ...params,
  });
  const fingerprint = secure
    ? new crypto.X509Certificate(serverCert).fingerprint256
    : null;
  return new Promise((resolve, reject) => {
    const client = secure ? https : http;
    const req = client.get(
      {
        hostname: target.ip,
        port: secure ? target.httpsPort : target.port,
        path: `/${command}?${query}`,
        agent: false,
        signal,
        ...(secure
          ? {
              cert: identity.cert,
              key: identity.key,
              ca: serverCert,
              rejectUnauthorized: true,
              checkServerIdentity: (_hostname, certificate) =>
                certificate.fingerprint256 === fingerprint
                  ? undefined
                  : new Error(
                      "Sunshine 证书已改变，请在确认主机身份后重新配对。",
                    ),
            }
          : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Sunshine 返回 HTTP ${response.statusCode}。`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 1024 * 1024)
            req.destroy(new Error("Sunshine 响应超过 1 MiB。"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(parseResponse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error(`Sunshine ${command} 请求超时。`)),
      timeout,
    );
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
  });
}

async function writeAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, value, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

class HostControl {
  constructor(
    directory,
    { requestImpl = request, executeImpl = execute } = {},
  ) {
    this.directory = directory;
    this.request = requestImpl;
    this.execute = executeImpl;
    this.identityPromise = null;
  }

  async identity(executable) {
    if (!this.identityPromise)
      this.identityPromise = this.loadIdentity(executable).catch((error) => {
        this.identityPromise = null;
        throw error;
      });
    return this.identityPromise;
  }

  async loadIdentity(executable) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.execute(executable, ["--identity", this.directory], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
    });
    const [cert, key] = await Promise.all([
      fs.readFile(path.join(this.directory, "client-cert.pem")),
      fs.readFile(path.join(this.directory, "client-key.pem")),
    ]);
    const certificate = new crypto.X509Certificate(cert);
    if (!certificate.checkPrivateKey(crypto.createPrivateKey(key)))
      throw new Error("客户端证书与私钥不匹配，请恢复原有身份文件。");
    return {
      cert,
      key,
      id: digest(certificate.raw).toString("hex").slice(0, 16),
    };
  }

  recordPath(address) {
    return path.join(
      this.directory,
      `host-${digest(Buffer.from(address)).toString("hex")}.json`,
    );
  }

  async info(target, identity, signal) {
    const info = await this.request(
      target,
      "serverinfo",
      {},
      { identity, signal },
    );
    const httpsPort = Number(info.HttpsPort ?? target.port - 5);
    if (
      !Number.isInteger(httpsPort) ||
      httpsPort < 1024 ||
      httpsPort > 65535 ||
      !/^\d+\.\d+\.\d+\.-?\d+$/.test(String(info.appversion))
    )
      throw new Error("Sunshine 版本或 HTTPS 端口无效。");
    return { info, target: { ...target, httpsPort } };
  }

  async pair(target, executable, pin, signal, nonce) {
    if (!/^\d{4}$/.test(pin)) throw new Error("PIN 必须是四位数字。");
    const identity = await this.identity(executable);
    signal?.throwIfAborted();
    const state = await this.info(target, identity, signal);
    if (Number(String(state.info.appversion).split(".")[0]) < 7)
      throw new Error("仅支持 Sunshine / GameStream 第 7 代及以上配对协议。");
    target = state.target;
    const salt = crypto.randomBytes(16);
    const key = digest(salt, Buffer.from(pin)).subarray(0, 16);
    if (nonce !== undefined && !/^[a-f0-9]{32}$/.test(nonce))
      throw new Error("内部连接标识无效。");
    const parameters = {
      devicename: nonce ? `SolunaRemote-${nonce}` : "SolunaRemote",
      updateState: "1",
    };
    const call = async (params, secure = false, serverCert) => {
      const result = await this.request(
        target,
        "pair",
        { ...parameters, ...params },
        {
          identity,
          secure,
          serverCert,
          signal,
          timeout: params.phrase === "getservercert" ? 85000 : 5000,
        },
      );
      if (String(result.paired) !== "1")
        throw new Error(
          "Sunshine 拒绝配对，请确认 PIN 或检查是否已有其他配对请求。",
        );
      return result;
    };
    const begin = await call({
      phrase: "getservercert",
      salt: salt.toString("hex"),
      clientcert: identity.cert.toString("hex"),
    });
    const serverCert = decodeHex(begin.plaincert, 256, 16384);
    const server = new crypto.X509Certificate(serverCert);
    const challenge = crypto.randomBytes(16);
    const response = await call({
      clientchallenge: aes(challenge, key).toString("hex"),
    });
    const decrypted = aes(
      decodeHex(response.challengeresponse, 48, 64),
      key,
      true,
    );
    const secret = crypto.randomBytes(16);
    const reply = await call({
      serverchallengeresp: aes(
        digest(
          decrypted.subarray(32, 48),
          certificateSignature(identity.cert),
          secret,
        ),
        key,
      ).toString("hex"),
    });
    const pairingSecret = decodeHex(reply.pairingsecret, 272, 1040);
    const serverSecret = pairingSecret.subarray(0, 16);
    if (
      !crypto.verify(
        "sha256",
        serverSecret,
        server.publicKey,
        pairingSecret.subarray(16),
      )
    )
      throw new Error("主机配对签名无效，已拒绝信任此主机。");
    const expected = digest(
      challenge,
      certificateSignature(serverCert),
      serverSecret,
    );
    if (!crypto.timingSafeEqual(expected, decrypted.subarray(0, 32)))
      throw new Error("PIN 验证失败，主机证书未保存。");
    await call({
      clientpairingsecret: Buffer.concat([
        secret,
        crypto.sign("sha256", secret, identity.key),
      ]).toString("hex"),
    });
    await call({ phrase: "pairchallenge" }, true, serverCert);
    signal?.throwIfAborted();
    await writeAtomic(
      this.recordPath(target.address),
      JSON.stringify({
        version: 1,
        certificate: serverCert.toString("utf8"),
        uuid: String(state.info.uniqueid ?? ""),
      }),
    );
  }

  async launch(target, executable, name, inputSettings, signal, launchParams) {
    const settings = validateSettings(inputSettings);
    name = appName(name);
    const identity = await this.identity(executable);
    signal?.throwIfAborted();
    let record;
    try {
      record = JSON.parse(
        await fs.readFile(this.recordPath(target.address), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error("此客户端尚未与主机配对，请先完成 PIN 配对。");
      throw new Error(`无法读取主机配对记录：${error.message}`);
    }
    new crypto.X509Certificate(record.certificate);
    const state = await this.info(target, identity, signal);
    target = state.target;
    const call = (command, params = {}) =>
      this.request(target, command, params, {
        identity,
        serverCert: record.certificate,
        secure: true,
        signal,
        timeout: command === "launch" || command === "resume" ? 20000 : 5000,
      });
    const info = await call("serverinfo");
    if (String(info.PairStatus) !== "1")
      throw new Error("Sunshine 尚未信任此客户端，请重新 PIN 配对。");
    const list = await call("applist");
    const apps = Array.isArray(list.App)
      ? list.App
      : list.App
        ? [list.App]
        : [];
    const matches = apps.filter((app) => app.AppTitle === name);
    if (matches.length !== 1 || !/^[1-9]\d*$/.test(String(matches[0].ID)))
      throw new Error(
        `Sunshine 中没有唯一匹配的应用「${name}」，请检查 Applications。`,
      );
    const id = Number(matches[0].ID);
    const currentGame = Number(info.currentgame ?? 0);
    if (currentGame && currentGame !== id)
      throw new Error(
        "主机正在运行其他应用；本工具不会强制关闭，请在被控端先结束。",
      );
    const key = crypto.randomBytes(16);
    const iv = Buffer.alloc(16);
    crypto.randomBytes(4).copy(iv);
    const [width, height] = settings.resolution.split("x").map(Number);
    const params = new URLSearchParams(launchParams);
    const launch = await call(currentGame === id ? "resume" : "launch", {
      ...Object.fromEntries(params),
      appid: String(id),
      mode: `${width}x${height}x${settings.fps}`,
      additionalStates: "1",
      sops: "1",
      rikey: key.toString("hex"),
      rikeyid: String(iv.readInt32BE(0)),
      localAudioPlayMode: "0",
      surroundAudioInfo: String(0x030002),
      remoteControllersBitmap: "0",
      gcmap: "0",
      gcpersist: "0",
    });
    const rtsp = new URL(launch.sessionUrl0);
    if (
      !["rtsp:", "rtspenc:"].includes(rtsp.protocol) ||
      rtsp.hostname !== target.ip ||
      rtsp.username ||
      rtsp.password ||
      !rtsp.port ||
      Number(rtsp.port) < 1024 ||
      Number(rtsp.port) > 65535
    )
      throw new Error("Sunshine 返回的 RTSP 地址不是已验证的内网主机。");
    return {
      address: target.ip,
      appVersion: String(info.appversion),
      gfeVersion: String(info.GfeVersion ?? ""),
      serverCodecs: Number(info.ServerCodecModeSupport ?? 1),
      rtspUrl: rtsp.href,
      width,
      height,
      fps: settings.fps,
      bitrate: settings.bitrate,
      displayMode: settings.displayMode,
      codec: settings.codec,
      key: key.toString("hex"),
      iv: iv.toString("hex"),
    };
  }
}

module.exports = {
  HostControl,
  request,
  parseResponse,
  certificateSignature,
  decodeHex,
  aes,
};
