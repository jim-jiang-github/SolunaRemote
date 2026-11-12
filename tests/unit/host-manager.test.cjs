const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { HostManager } = require("../../app/core/host-manager.cjs");

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lan-host-unit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "credentials"));
  await fs.writeFile(
    path.join(directory, "credentials", "cacert.pem"),
    "FIXTURE CERT",
  );
  const requests = [];
  let killed = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    killed++;
    setImmediate(() => child.emit("close", 0));
    return true;
  };
  const host = new HostManager({
    directory,
    executable: path.join(directory, "sunshine.exe"),
    portsImpl: async () => {},
    spawnImpl: (_executable, args, options) => {
      assert.deepEqual(args, [path.join(directory, "sunshine.conf")]);
      assert.equal(options.windowsHide, true);
      return child;
    },
    requestImpl: async (_port, endpoint, input) => {
      requests.push({ endpoint, input });
      if (endpoint === "/welcome") return "<html>Fixture host</html>";
      return JSON.stringify({ status: true, pairings: [] });
    },
    ...overrides,
  });
  t.after(() => host.stop());
  return { host, directory, requests, child, killed: () => killed };
}

test("integrated host starts isolated, disables UPnP/tray and stops only its child", async (t) => {
  const { host, directory, killed } = await fixture(t);
  assert.equal(host.status().phase, "stopped");
  await host.start();
  assert.equal(host.status().phase, "running");
  const config = await fs.readFile(
    path.join(directory, "sunshine.conf"),
    "utf8",
  );
  assert.match(config, /upnp = disabled/);
  assert.match(config, /system_tray = disabled/);
  assert.match(config, /origin_web_ui_allowed = pc/);
  assert.match(config, /address_family = ipv4/);
  assert.deepEqual(host.status().pending, []);
  assert.equal(JSON.stringify(host.status()).includes("password"), false);
  await assert.rejects(host.start(), /重复启动/);
  await host.stop();
  assert.equal(killed(), 1);
  assert.equal(host.status().phase, "stopped");
});

test("host initializes web credentials once and reuses them after restart", async (t) => {
  let initialized = false;
  let setups = 0;
  const { host } = await fixture(t, {
    requestImpl: async (_port, endpoint, input) => {
      if (endpoint === "/welcome") return "<html>Fixture</html>";
      if (endpoint === "/api/password") {
        assert.equal(input.body.newPassword.length >= 32, true);
        initialized = true;
        setups++;
        return '{"status":true}';
      }
      if (!initialized) throw new Error("内置主机管理请求失败：HTTP 307");
      assert.match(input.authorization, /^Basic /);
      return '{"pairings":[]}';
    },
  });
  await host.start();
  await host.stop();
  await host.start();
  assert.equal(setups, 1);
  await host.stop();
});

test("host rejects occupied ports without spawning or hiding the failure", async (t) => {
  const { host } = await fixture(t, {
    portsImpl: async () => {
      throw new Error("port occupied");
    },
    spawnImpl: () => {
      assert.fail("must not spawn");
    },
  });
  await assert.rejects(host.start(), /port occupied/);
  assert.equal(host.status().phase, "error");
  assert.match(host.status().error, /port occupied/);
});

test("host rejects missing engine and invalid authorization addresses", async (t) => {
  const { host } = await fixture(t, { executable: "" });
  await assert.rejects(host.start(), /缺少内置/);
  for (const address of [
    "8.8.8.8",
    "127.0.0.1",
    "169.254.1.1",
    "192.168.1.0/24",
    "host;exit",
  ]) {
    await assert.rejects(host.allowClient(address), /私有 IPv4/);
  }
});

test("host approves only a pending private peer and four-digit PIN", async (t) => {
  const id = "a".repeat(32);
  let approved = false;
  const { host } = await fixture(t, {
    requestImpl: async (_port, endpoint, input) => {
      if (endpoint === "/welcome") return "Fixture";
      if (input.body) {
        assert.deepEqual(input.body, {
          pairing_id: id,
          pin: "1234",
          name: "SolunaRemote",
        });
        approved = true;
        return '{"status":true}';
      }
      return JSON.stringify({
        pairings: approved
          ? []
          : [{ id, name: "TEST LAN PEER", address: "192.168.1.20" }],
      });
    },
  });
  await host.start();
  await assert.rejects(host.approve({ id, pin: "12345" }), /四位 PIN/);
  await assert.rejects(
    host.approve({ id: "b".repeat(32), pin: "1234" }),
    /四位 PIN/,
  );
  await host.approve({ id, pin: "1234" });
  assert.equal(approved, true);
  assert.deepEqual(host.status().pending, []);
});

test("host surfaces and stops a malformed/public pending request", async (t) => {
  const { host } = await fixture(t, {
    requestImpl: async (_port, endpoint) =>
      endpoint === "/welcome"
        ? "Fixture"
        : JSON.stringify({
            pairings: [{ id: "a".repeat(32), address: "8.8.8.8" }],
          }),
  });
  await assert.rejects(host.start(), /非内网/);
  assert.equal(host.status().phase, "error");
});

test("unexpected host exit is an explicit error, never a successful sharing state", async (t) => {
  const { host, child } = await fixture(t);
  await host.start();
  child.emit("close", 7);
  assert.equal(host.status().phase, "error");
  assert.match(host.status().error, /意外退出（7）/);
});
