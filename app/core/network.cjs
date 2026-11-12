const dns = require("node:dns").promises;
const http = require("node:http");
const net = require("node:net");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { parseAddress, isPrivateIPv4 } = require("./validation.cjs");

async function resolveLan(input, lookup = dns.lookup, timeout = 2500) {
  const parsed = parseAddress(input);
  let addresses = [{ address: parsed.host }];
  if (net.isIP(parsed.host) !== 4) {
    let timer;
    try {
      addresses = await Promise.race([
        lookup(parsed.host, { all: true, family: 4 }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("主机名解析超时，请尝试直接填写内网 IPv4 地址。"),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (
    !addresses.length ||
    addresses.some((entry) => !isPrivateIPv4(entry.address))
  )
    throw new Error("主机名必须只解析到私有内网 IPv4 地址，已阻止公网目标。");
  return {
    ...parsed,
    ip: addresses[0].address,
    target:
      parsed.port === 47989
        ? addresses[0].address
        : `${addresses[0].address}:${parsed.port}`,
  };
}

function requestServerInfo(target, timeout = 2500) {
  return new Promise((resolve, reject) => {
    // Pin the validated numeric address; do not resolve DNS again or follow redirects.
    const request = http.get(
      {
        hostname: target.ip,
        port: target.port,
        path: "/serverinfo",
        agent: false,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Sunshine 返回 HTTP ${response.statusCode}，请检查 HTTP 端口。`,
            ),
          );
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 65536)
            request.destroy(new Error("主机响应过大，已停止读取。"));
        });
        response.on("error", reject);
        response.on("end", () => resolve(body));
      },
    );
    const timer = setTimeout(
      () =>
        request.destroy(
          new Error("连接超时，请检查 Sunshine、防火墙及设备地址。"),
        ),
      timeout,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}

function parseServerInfo(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("主机返回的 GameStream 信息格式无效。");
  const root = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: false,
  }).parse(xml).root;
  if (
    !root ||
    String(root["@_status_code"]) !== "200" ||
    typeof root.hostname !== "string" ||
    !root.hostname ||
    typeof root.uniqueid !== "string" ||
    !root.uniqueid
  )
    throw new Error("该地址不是可识别的 Sunshine / GameStream 主机。");
  return {
    hostname: root.hostname.slice(0, 100),
    uuid: root.uniqueid.slice(0, 100),
    version: String(root.appversion ?? "未知"),
    busy: String(root.state ?? "").includes("BUSY"),
  };
}

async function probe(address) {
  const started = performance.now();
  try {
    const target = await resolveLan(address);
    const info = parseServerInfo(await requestServerInfo(target));
    return {
      online: true,
      ...info,
      latency: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      online: false,
      latency: null,
      checkedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}

function discover({ duration = 4500, BonjourClass } = {}) {
  const Bonjour = BonjourClass ?? require("bonjour-service").Bonjour;
  return new Promise((resolve, reject) => {
    const found = new Map();
    let browser;
    let bonjour;
    let timer;
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser?.stop();
      bonjour?.destroy();
      if (error) reject(new Error(`局域网发现失败：${error.message}`));
      else resolve([...found.values()]);
    }
    try {
      bonjour = new Bonjour({}, finish);
      browser = bonjour.find(
        { type: "nvstream", protocol: "tcp" },
        (service) => {
          const ip = service.addresses?.find(
            (address) => isPrivateIPv4(address) && !address.startsWith("127."),
          );
          if (
            !ip ||
            !Number.isInteger(service.port) ||
            service.port < 1024 ||
            service.port > 65514
          )
            return;
          const address = service.port === 47989 ? ip : `${ip}:${service.port}`;
          found.set(address, {
            name: String(service.name || service.host || "Sunshine 主机").slice(
              0,
              48,
            ),
            address,
          });
        },
      );
      timer = setTimeout(() => finish(), duration);
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  resolveLan,
  requestServerInfo,
  parseServerInfo,
  probe,
  discover,
};
