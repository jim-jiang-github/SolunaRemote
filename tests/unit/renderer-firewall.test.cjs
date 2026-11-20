const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const renderer = fs.readFileSync(
  path.join(__dirname, "../../app/renderer/renderer.js"),
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
      access: { passwordConfigured: true, code: "123456789" },
    },
  };
  const backend = {
    allowed: false,
    failure: null,
    check: null,
    onState: null,
    async call(method) {
      calls.push(method);
      if (method === "state") return snapshot;
      if (method === "hostFirewallStatus")
        return backend.check ? backend.check() : backend.allowed;
      if (backend.failure) throw new Error(backend.failure);
      if (method === "hostStart") {
        snapshot.host.phase = "running";
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
  return { node, calls, backend, click };
}

test("macOS sharing explains authorization before opening settings or starting", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-toggle" });
  assert.equal(node("#host-permission-dialog").open, true);
  assert.deepEqual(calls, []);
  await click({ action: "host-permission-continue" });
  assert.deepEqual(calls, ["hostFirewallStatus"]);
  assert.equal(node("#firewall-dialog").open, true);
  await click({ action: "firewall-settings" });
  assert.equal(calls.at(-1), "openFirewallSettings");
  await click({ action: "firewall-recheck" });
  assert.equal(calls.includes("hostStart"), false);
  assert.ok(node("#firewall-error").textContent);
  backend.allowed = true;
  await click({ action: "firewall-recheck" });
  assert.deepEqual(calls.slice(-2), ["hostFirewallStatus", "hostStart"]);
  assert.equal(node("#firewall-dialog").open, false);
});

test("cancelling during a firewall recheck never starts sharing", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-start" });
  await click({ action: "host-permission-continue" });
  let resolveCheck;
  backend.check = () =>
    new Promise((resolve) => {
      resolveCheck = resolve;
    });
  const pending = click({ action: "firewall-recheck" });
  await click({ action: "firewall-recheck" });
  assert.equal(calls.length, 2);
  await click({ close: "firewall-dialog" });
  resolveCheck(true);
  await pending;
  assert.equal(calls.includes("hostStart"), false);
  assert.equal(node("#firewall-recheck").disabled, false);
});

test("authorization and start errors remain visible and allow retry", async () => {
  const { click, node, calls, backend } = await setup();
  await click({ action: "host-toggle" });
  await click({ action: "host-permission-continue" });
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

test("macOS prompts for input permission before starting even when the firewall allows sharing", async () => {
  const { click, calls, node, backend } = await setup();
  backend.allowed = true;
  await click({ action: "host-toggle" });
  assert.equal(node("#host-permission-dialog").open, true);
  assert.deepEqual(calls, []);
  await click({ action: "host-permission-continue" });
  assert.deepEqual(calls, ["hostFirewallStatus", "hostStart"]);
  assert.equal(node("#host-permission-dialog").open, false);
  assert.equal(node("#firewall-dialog").open, false);
});

test("macOS permission dialog opens settings and locates Sunshine only on request", async () => {
  const { click, calls, node, backend } = await setup();
  await click({ action: "host-start" });
  await click({ action: "host-accessibility-settings" });
  await click({ action: "host-reveal" });
  assert.deepEqual(calls, ["openHostAccessibilitySettings", "revealHostApp"]);
  backend.failure = "settings unavailable";
  await click({ action: "host-accessibility-settings" });
  assert.equal(
    node("#host-permission-error").textContent,
    "settings unavailable",
  );
  await click({ close: "host-permission-dialog" });
  assert.equal(node("#host-permission-dialog").open, false);
  assert.equal(calls.includes("hostStart"), false);
});
