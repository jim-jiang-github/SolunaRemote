const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { Store } = require("../../app/core/store.cjs");
const {
  DEFAULT_SETTINGS,
  isPrivateIPv4,
  parseAddress,
  validateSettings,
  appName,
} = require("../../app/core/validation.cjs");
const {
  resolveLan,
  parseServerInfo,
  requestServerInfo,
  probe,
  discover,
} = require("../../app/core/network.cjs");
const { Engines, streamArgs } = require("../../app/core/engines.cjs");

const xml =
  '<root status_code="200"><hostname>Test Sunshine</hostname><uniqueid>fixture-id</uniqueid><appversion>7.1.431</appversion><state>SUNSHINE_SERVER_FREE</state></root>';
const directory = (t) => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "solunaremote-unit-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
};

test("private IPv4 policy includes RFC1918, loopback and link local only", () => {
  for (const address of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.20",
    "127.0.0.1",
    "169.254.12.2",
  ])
    assert.equal(isPrivateIPv4(address), true, address);
  for (const address of [
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.64.0.1",
    "192.0.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "999.1.1.1",
    "::1",
    "010.0.0.1",
  ])
    assert.equal(isPrivateIPv4(address), false, address);
});

test("address normalization and port offset boundaries", () => {
  assert.deepEqual(parseAddress(" Studio.LOCAL.:47989 "), {
    host: "studio.local",
    port: 47989,
    address: "studio.local",
  });
  assert.equal(parseAddress("192.168.1.2:65514").port, 65514);
  assert.equal(parseAddress("localhost:1024").port, 1024);
  for (const address of [
    "192.168.1.2:0",
    "192.168.1.2:1023",
    "192.168.1.2:65515",
    "https://192.168.1.2",
    "8.8.8.8",
    "999.999.999.999",
    "device.local:abc",
    "-option",
    "host;evil",
    "::1",
    "a..local",
    "host/path",
    "host@local",
  ])
    assert.throws(() => parseAddress(address), undefined, address);
});

test("DNS results are checked and the numeric LAN target is pinned", async () => {
  assert.deepEqual(
    await resolveLan("studio.local:48089", async () => [
      { address: "192.168.1.3" },
    ]),
    {
      host: "studio.local",
      port: 48089,
      address: "studio.local:48089",
      ip: "192.168.1.3",
      target: "192.168.1.3:48089",
    },
  );
  for (const addresses of [
    [],
    [{ address: "8.8.8.8" }],
    [{ address: "192.168.1.2" }, { address: "8.8.8.8" }],
  ])
    await assert.rejects(
      resolveLan("studio.local", async () => addresses),
      /私有内网/,
    );
});

test("DNS resolution has a deadline even when the OS resolver does not reply", async () => {
  await assert.rejects(
    resolveLan("slow.local", () => new Promise(() => {}), 20),
    /解析超时/,
  );
});

test("Sunshine application names cannot be interpreted as CLI options", () => {
  assert.equal(appName("Steam Big Picture"), "Steam Big Picture");
  assert.throws(() => appName("--quit-after"), /命令行选项/);
});

test("stream preferences reject unsupported options and invalid bitrate boundaries", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const [key, value] of [
    ["resolution", "9999x9999"],
    ["fps", 59],
    ["bitrate", 999],
    ["bitrate", 150001],
    ["bitrate", 1.5],
    ["codec", "--unsafe"],
    ["displayMode", "bad"],
  ])
    assert.throws(() =>
      validateSettings({ ...DEFAULT_SETTINGS, [key]: value }),
    );
  for (const bitrate of [1000, 150000])
    assert.equal(
      validateSettings({ ...DEFAULT_SETTINGS, bitrate }).bitrate,
      bitrate,
    );
});

test("store normalizes, prevents duplicates, persists and does not expose mutable state", (t) => {
  const dir = directory(t);
  const store = new Store(dir);
  const device = store.add({ name: " Studio ", address: "studio.local:47989" });
  assert.equal(device.name, "Studio");
  assert.equal(device.address, "studio.local");
  assert.throws(
    () => store.add({ name: "Duplicate", address: "STUDIO.LOCAL." }),
    /已经添加/,
  );
  const snapshot = store.snapshot();
  snapshot.devices.length = 0;
  assert.equal(store.snapshot().devices.length, 1);
  store.update(device.id, (entry) => {
    entry.favorite = true;
  });
  assert.equal(new Store(dir).device(device.id).favorite, true);
  store.remove(device.id);
  assert.equal(new Store(dir).snapshot().devices.length, 0);
});

test("a failed disk write cannot commit memory-only success", (t) => {
  const store = new Store(directory(t));
  fs.mkdirSync(`${store.file}.tmp`);
  assert.throws(() => store.add({ name: "Failed", address: "192.168.1.2" }));
  assert.equal(store.snapshot().devices.length, 0);
});

test("corrupt existing data fails explicitly and is not overwritten", (t) => {
  const dir = directory(t);
  const file = path.join(dir, "devices.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => new Store(dir), /原文件已保留/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("GameStream responses are parsed without trusting entity declarations", () => {
  assert.equal(parseServerInfo(xml).hostname, "Test Sunshine");
  assert.equal(parseServerInfo(xml).busy, false);
  for (const invalid of [
    "<html>hello</html>",
    "<root",
    xml.replace('status_code="200"', 'status_code="401"'),
    xml.replace("<uniqueid>fixture-id</uniqueid>", ""),
    `<!DOCTYPE root [<!ENTITY x SYSTEM "file:///test">]>${xml}`,
  ])
    assert.throws(() => parseServerInfo(invalid));
});

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { ip: "127.0.0.1", port: server.address().port };
}

test("real HTTP probe confirms a valid GameStream host, not just an open socket", async (t) => {
  const target = await serverFixture(t, (_request, response) =>
    response.end(xml),
  );
  const result = await probe(`127.0.0.1:${target.port}`);
  assert.equal(result.online, true);
  assert.equal(result.hostname, "Test Sunshine");
  assert.ok(result.latency >= 0);
});

test("HTTP discovery rejects redirects instead of following them to a public target", async (t) => {
  const target = await serverFixture(t, (_request, response) => {
    response.writeHead(302, { Location: "https://8.8.8.8" });
    response.end();
  });
  await assert.rejects(requestServerInfo(target), /302/);
});

test("HTTP discovery has a response size bound and a total deadline", async (t) => {
  const large = await serverFixture(t, (_request, response) =>
    response.end("a".repeat(70000)),
  );
  await assert.rejects(requestServerInfo(large), /过大/);
  const slow = await serverFixture(t, () => {});
  await assert.rejects(requestServerInfo(slow, 40), /超时/);
});

test("mDNS collects only valid private IPv4 Sunshine candidates", async () => {
  let stopped = false;
  let destroyed = false;
  class FakeBonjour {
    find(options, callback) {
      assert.deepEqual(options, { type: "nvstream", protocol: "tcp" });
      callback({
        name: "LAN Sunshine",
        addresses: ["192.168.1.8"],
        port: 47989,
      });
      callback({ name: "Public", addresses: ["8.8.8.8"], port: 47989 });
      callback({ name: "Bad port", addresses: ["192.168.1.9"], port: 80 });
      callback({
        name: "LAN Sunshine",
        addresses: ["192.168.1.8"],
        port: 47989,
      });
      return {
        stop: () => {
          stopped = true;
        },
      };
    }
    destroy() {
      destroyed = true;
    }
  }
  assert.deepEqual(
    await discover({ duration: 10, BonjourClass: FakeBonjour }),
    [{ name: "LAN Sunshine", address: "192.168.1.8" }],
  );
  assert.equal(stopped, true);
  assert.equal(destroyed, true);
});

test("Moonlight arguments keep app names as a single non-shell argument", () => {
  const args = streamArgs(
    "192.168.1.2",
    'Desktop & echo "not executed"',
    DEFAULT_SETTINGS,
  );
  assert.equal(args[2], 'Desktop & echo "not executed"');
  assert.deepEqual(args.slice(3), [
    "--resolution",
    "1920x1080",
    "--fps",
    "60",
    "--bitrate",
    "20000",
    "--display-mode",
    "borderless",
    "--video-codec",
    "auto",
    "--absolute-mouse",
    "--no-quit-after",
  ]);
});

function fakeEngine(resolveImpl = async () => ({ target: "192.168.1.2" })) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let command;
  const engines = new Engines({
    resolveImpl,
    spawnImpl: (...args) => {
      command = args;
      return child;
    },
  });
  return { engines, child, command: () => command };
}

const device = { id: "fixture", address: "192.168.1.2", app: "Desktop" };
const settings = { ...DEFAULT_SETTINGS, moonlightPath: process.execPath };

test("PIN pairing launches the documented Moonlight command and cancellation owns its child", async () => {
  const fixture = fakeEngine();
  const session = await fixture.engines.start("pair", device, settings);
  assert.match(session.pin, /^\d{4}$/);
  assert.deepEqual(fixture.command()[1], [
    "pair",
    "192.168.1.2",
    "--pin",
    session.pin,
  ]);
  assert.equal(fixture.command()[2].shell, false);
  await assert.rejects(
    fixture.engines.start("stream", device, settings),
    /已有/,
  );
  fixture.engines.cancel(session.id);
  assert.equal(fixture.child.killed, true);
  assert.equal(fixture.engines.status(), null);
});

test("simultaneous launches are reserved before asynchronous resolution", async () => {
  let release;
  const fixture = fakeEngine(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = fixture.engines.start("stream", device, settings);
  await assert.rejects(
    fixture.engines.start("stream", device, settings),
    /已有/,
  );
  const id = fixture.engines.status().id;
  fixture.engines.cancel(id);
  release({ target: "192.168.1.2" });
  await assert.rejects(pending, /取消/);
  assert.equal(fixture.command(), undefined);
});

test("spawn failures and nonzero exits reset the active operation and surface errors", async () => {
  const fixture = fakeEngine();
  const events = [];
  fixture.engines.on("change", (event) => events.push(event));
  await fixture.engines.start("stream", device, settings);
  fixture.child.stderr.emit("data", Buffer.from("connection refused"));
  fixture.child.emit("close", 1);
  assert.equal(fixture.engines.status(), null);
  assert.match(events.at(-1).error, /connection refused/);
  await fixture.engines.start("stream", device, settings);
  fixture.child.emit("error", new Error("spawn failed"));
  assert.equal(fixture.engines.status(), null);
  assert.match(events.at(-1).error, /spawn failed/);
});

test("a public DNS result blocks a process before spawning", async () => {
  const fixture = fakeEngine(async () => {
    throw new Error("公网目标已阻止");
  });
  await assert.rejects(
    fixture.engines.start("stream", device, settings),
    /公网/,
  );
  assert.equal(fixture.command(), undefined);
  assert.equal(fixture.engines.status(), null);
});
