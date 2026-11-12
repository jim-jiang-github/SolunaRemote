const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { bootstrap } = require("../../app/main.cjs");
const { NativeEngine } = require("../../app/core/native-engine.cjs");
const { EventEmitter } = require("node:events");

class FixtureHost extends EventEmitter {
  constructor() {
    super();
    this.value = {
      available: true,
      phase: "stopped",
      pending: [],
      error: null,
    };
  }
  status() {
    return this.value;
  }
  async api() {
    return { status: true };
  }
  async start() {
    this.value = {
      ...this.value,
      phase: "running",
      pending: [
        {
          id: "a".repeat(32),
          name: "TEST IPC-mocked LAN peer",
          address: "192.168.1.20",
        },
      ],
    };
    log({ action: "host-start", fixture: true });
    this.emit("change");
  }
  async stop() {
    this.value = { ...this.value, phase: "stopped", pending: [] };
    log({ action: "host-stop", fixture: true });
    this.emit("change");
  }
  async approve(input) {
    if (input.pin !== "1234") throw new Error("TEST incorrect PIN");
    log({ action: "host-approve", fixture: true, id: input.id });
    this.value = { ...this.value, pending: [] };
    this.emit("change");
  }
  async allowClient(address) {
    if (address !== "192.168.1.20")
      throw new Error("TEST invalid private address");
    log({ action: "host-firewall", fixture: true, address });
    this.value = { ...this.value, allowedAddress: address };
    this.emit("change");
  }
}

function log(value) {
  fs.appendFileSync(process.env.LAN_TEST_LOG, `${JSON.stringify(value)}\n`);
}
const access = {
  configured: false,
  async init() {},
  status() {
    return {
      code: "555555555555",
      passwordConfigured: this.configured,
      listening: false,
    };
  },
  async setPassword(password) {
    if (password.length < 12) throw new Error("访问密码至少 12 个字符");
    this.configured = true;
    log({ action: "host-password", fixture: true });
  },
  async start() {},
  async stop() {},
};

const hostControl = {
  pair: async (target, _executable, pin, signal, nonce) => {
    if (nonce) {
      log({ action: "internal-pair", fixture: true });
      signal.throwIfAborted();
      return;
    }
    log({ action: "pair", target: target.target, options: ["--pin", pin] });
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setInterval(() => {
        if (fs.existsSync(process.env.LAN_TEST_PAIR_GATE)) {
          cleanup();
          resolve();
        }
      }, 30);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
  launch: async (target, _executable, app, settings) => {
    log({ action: "stream", target: target.target, app, settings });
    const [width, height] = settings.resolution.split("x").map(Number);
    return { testFixture: true, width, height };
  },
};

bootstrap({
  allowMultiple: true,
  skipCloseConfirmation: true,
  userDataDir: process.env.LAN_TEST_PROFILE,
  host: new FixtureHost(),
  access,
  discoverCode: async (code) => {
    if (code !== "123456789012") throw new Error("未找到设备码");
    return {
      ip: "127.0.0.1",
      port: Number(process.env.LAN_TEST_PORT),
      address: `127.0.0.1:${process.env.LAN_TEST_PORT}`,
    };
  },
  engines: new NativeEngine({
    hostControl,
    authorizeImpl: async (_target, _code, password) => {
      if (password !== "UI-test-password-2026")
        throw new Error("设备码或密码验证失败");
    },
    executeImpl: async () => ({
      stdout: JSON.stringify({
        event: "capabilities",
        protocol: 1,
        launchParams: "",
      }),
    }),
    spawnImpl: (_executable, args, options) =>
      spawn(
        process.execPath,
        [path.join(__dirname, "native-player.cjs"), ...args],
        { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      ),
  }),
  discover: async () => [
    {
      name: "TEST Sunshine · Discovery",
      address: `127.0.0.1:${process.env.LAN_TEST_PORT}`,
    },
  ],
  openExternal: async (url) => {
    fs.appendFileSync(
      process.env.LAN_TEST_LOG,
      `${JSON.stringify({ external: url })}\n`,
    );
  },
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
