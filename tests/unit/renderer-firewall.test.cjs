const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const renderer = fs.readFileSync(
  path.join(__dirname, "../../app/renderer/renderer.js"),
  "utf8",
);
const markup = fs.readFileSync(
  path.join(__dirname, "../../app/renderer/index.html"),
  "utf8",
);

async function setup(platform = "macos", firewallManagedByPackage = false) {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector))
      nodes.set(selector, {
        open: false,
        disabled: false,
        textContent: "",
        innerHTML: "",
        setAttribute() {},
        addEventListener() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(selector);
  }
  const handlers = {};
  const calls = [];
  const snapshot = {
    version: "test",
    platform,
    session: null,
    devices: [],
    local: { hostname: "test" },
    engines: { nativeAvailable: true },
    host: {
      firewallManagedByPackage,
      phase: "stopped",
      available: true,
      remoteActive: false,
      access: { passwordConfigured: true, code: "123456789" },
    },
  };
  const backend = {
    allowed: false,
    accessibilityAllowed: true,
    failure: null,
    connectFailure: null,
    check: null,
    onState: null,
    simulateRemoteControl() {
      backend.onState({
        ...snapshot,
        host: { ...snapshot.host, phase: "running", remoteActive: true },
      });
    },
    async call(method) {
      calls.push(method);
      if (method === "state") return snapshot;
      if (method === "hostAccessibilityStatus")
        return backend.accessibilityAllowed;
      if (method === "hostFirewallStatus")
        return backend.check ? backend.check() : backend.allowed;
      if (method === "connectPassword" && backend.connectFailure)
        throw new Error(backend.connectFailure);
      if (backend.failure) throw new Error(backend.failure);
      if (method === "hostStart") {
        snapshot.host.phase = "running";
        backend.onState(snapshot);
      }
      if (method === "hostStop") {
        snapshot.host.phase = "stopped";
        snapshot.host.remoteActive = false;
        backend.onState(snapshot);
      }
    },
  };
  await vm.runInNewContext(renderer, {
    window: {
      lan: {
        call: backend.call,
        onState: (callback) => {
          backend.onState = callback;
        },
        onEngine() {},
      },
      addEventListener() {},
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval() {},
    },
    document: {
      documentElement: { dataset: {} },
      querySelector: node,
      querySelectorAll: () => [],
      getElementById: (id) => node(`#${id}`),
      addEventListener: (name, callback) => {
        handlers[name] = callback;
      },
    },
    localStorage: { getItem: () => null },
    console,
  });
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  const click = (dataset) =>
    handlers.click({ target: { closest: () => ({ dataset }) } });
  const connect = () =>
    handlers.submit({
      target: {
        id: "connect-form",
        elements: { code: { value: "123456789" }, password: { value: "test" } },
      },
      preventDefault() {},
    });
  return { node, calls, backend, click, connect, snapshot };
}

test("macOS opens local network settings only after an explicit permission denial", async () => {
  const { backend, click, calls, connect, node, snapshot } = await setup();
  assert.doesNotMatch(node("#content").innerHTML, /打开本地网络设置/);
  backend.connectFailure = "LOCAL_NETWORK_DENIED";
  await connect();
  backend.onState(snapshot);
  const html = node("#content").innerHTML;
  assert.match(
    html,
    /role="alert">请在“系统设置 &gt; 隐私与安全性 &gt; 本地网络”中允许 SolunaRemote/,
  );
  assert.match(html, /打开本地网络设置/);
  assert.match(html, /type="submit" >连接<\/button>/);
  assert.deepEqual(calls, ["connectPassword", "openLocalNetworkSettings"]);
  await click({ action: "local-network-settings" });
  assert.equal(calls.length, 3);

  backend.connectFailure = "No route to host (os error 65)";
  await connect();
  assert.equal(calls.at(-1), "connectPassword");
  assert.match(node("#content").innerHTML, /No route to host/);
  assert.doesNotMatch(node("#content").innerHTML, /打开本地网络设置/);
});

test("macOS keeps the manual settings button if automatic opening fails", async () => {
  const { backend, connect, node } = await setup();
  backend.connectFailure = "LOCAL_NETWORK_DENIED";
  backend.failure = "无法打开本地网络设置";
  await connect();
  assert.match(node("#content").innerHTML, /打开本地网络设置/);
});

test("active remote control displays an alert and can be disconnected", async () => {
  const { backend, calls, node, click } = await setup();
  backend.simulateRemoteControl();

  assert.equal(node("#remote-control-alert").hidden, false);
  assert.equal(node("#toast").textContent, "有人正在远程控制本机。");

  await click({ action: "disconnect-remote" });
  assert.ok(calls.includes("hostStop"));
  assert.equal((await backend.call("state")).host.phase, "stopped");
  assert.equal(node("#remote-control-alert").hidden, true);
  assert.equal(node("#toast").textContent, "已断开远程连接并停止本机共享。");
});

test("macOS checks accessibility and firewall before starting sharing", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-toggle" });
  assert.deepEqual(calls, ["hostAccessibilityStatus", "hostFirewallStatus"]);
  assert.equal(node("#firewall-dialog").open, true);
  await click({ action: "firewall-settings" });
  assert.equal(calls.at(-1), "openFirewallSettings");
  await click({ action: "firewall-recheck" });
  assert.equal(calls.includes("hostStart"), false);
  assert.ok(node("#firewall-error").textContent);
  backend.allowed = true;
  await click({ action: "firewall-recheck" });
  assert.deepEqual(calls.slice(-3), [
    "hostAccessibilityStatus",
    "hostFirewallStatus",
    "hostStart",
  ]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("cancelling during a firewall recheck never starts sharing", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-start" });
  let resolveCheck;
  backend.check = () =>
    new Promise((resolve) => {
      resolveCheck = resolve;
    });
  const pending = click({ action: "firewall-recheck" });
  await click({ action: "firewall-recheck" });
  assert.equal(calls.length, 4);
  await click({ close: "firewall-dialog" });
  resolveCheck(true);
  await pending;
  assert.equal(calls.includes("hostStart"), false);
  assert.equal(node("#firewall-recheck").disabled, false);
});

test("authorization and start errors remain visible and allow retry", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-toggle" });
  backend.failure = "settings unavailable";
  await click({ action: "firewall-settings" });
  assert.equal(node("#firewall-error").textContent, backend.failure);
  backend.allowed = undefined;
  await click({ action: "firewall-recheck" });
  assert.equal(calls.includes("hostStart"), false);
  backend.allowed = true;
  backend.failure = "startup failed";
  await click({ action: "firewall-recheck" });
  assert.equal(node("#firewall-error").textContent, backend.failure);
  assert.equal(node("#firewall-dialog").open, true);
  assert.equal(node("#firewall-recheck").disabled, false);
});

test("Windows sharing explains scoped rules before requesting administrator authorization", async () => {
  const { click, calls, node } = await setup("windows");
  await click({ action: "host-toggle" });
  assert.deepEqual(calls, ["hostFirewallStatus"]);
  assert.equal(node("#firewall-dialog").open, true);
  assert.equal(node("#firewall-settings").hidden, true);
  assert.equal(node("#firewall-locate").hidden, true);
  assert.match(node("#firewall-description").textContent, /不会关闭防火墙/);
  await click({ action: "firewall-recheck" });
  assert.deepEqual(calls, [
    "hostFirewallStatus",
    "hostFirewallStatus",
    "hostStart",
  ]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("Windows authorization cancellation stays visible and can be retried", async () => {
  const { click, calls, node, backend } = await setup("windows");
  await click({ action: "host-toggle" });
  backend.failure = "Administrator authorization was cancelled";
  await click({ action: "firewall-recheck" });
  assert.equal(node("#firewall-dialog").open, true);
  assert.equal(node("#firewall-error").textContent, backend.failure);
  assert.equal(node("#firewall-recheck").disabled, false);
  backend.failure = null;
  await click({ action: "firewall-recheck" });
  assert.equal(calls.filter((method) => method === "hostStart").length, 2);
  assert.equal(node("#firewall-dialog").open, false);
});

test("Windows sharing can be cancelled before requesting administrator authorization", async () => {
  const { click, calls, node, backend } = await setup("windows");
  await click({ action: "host-toggle" });
  let resolveCheck;
  backend.check = () =>
    new Promise((resolve) => {
      resolveCheck = resolve;
    });
  const pending = click({ action: "firewall-recheck" });
  await click({ close: "firewall-dialog" });
  resolveCheck(false);
  await pending;
  assert.equal(calls.includes("hostStart"), false);
  assert.equal(node("#firewall-dialog").open, false);
});

test("Windows with existing firewall rules starts without an authorization dialog", async () => {
  const { click, calls, node, backend } = await setup("windows");
  backend.allowed = true;
  await click({ action: "host-toggle" });
  assert.deepEqual(calls, ["hostFirewallStatus", "hostStart"]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("MSIX sharing uses package-managed rules without requesting administrator authorization", async () => {
  const { click, calls, node } = await setup("windows", true);
  await click({ action: "host-toggle" });
  assert.deepEqual(calls, ["hostStart"]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("macOS starts sharing after accessibility and firewall checks pass", async () => {
  const { click, calls, node, backend } = await setup();
  backend.allowed = true;
  await click({ action: "host-toggle" });
  assert.deepEqual(calls, [
    "hostAccessibilityStatus",
    "hostFirewallStatus",
    "hostStart",
  ]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("macOS without accessibility permission opens settings and does not start sharing", async () => {
  const { click, calls, node, backend } = await setup();
  backend.accessibilityAllowed = false;
  await click({ action: "host-start" });
  assert.deepEqual(calls, [
    "hostAccessibilityStatus",
    "openHostAccessibilitySettings",
  ]);
  assert.equal(node("#firewall-dialog").open, false);
  assert.equal(calls.includes("hostStart"), false);
  assert.doesNotMatch(markup, /host-permission-dialog/);
});

test("macOS instructions refer only to the SolunaRemote application", () => {
  assert.doesNotMatch(renderer, /Sunshine\.app|revealHostApp/);
  assert.doesNotMatch(markup, /Sunshine\.app|revealHostApp/);
});
