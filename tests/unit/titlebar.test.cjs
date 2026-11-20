const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const capability = require("../../src-tauri/capabilities/default.json");
const macConfig = require("../../src-tauri/tauri.macos.conf.json");
const bridge = fs.readFileSync(
  path.join(__dirname, "../../app/renderer/tauri-bridge.js"),
  "utf8",
);

test("main window is permitted to drag and toggle maximization", () => {
  assert.ok(capability.windows.includes("main"));
  assert.ok(
    capability.permissions.includes("core:window:allow-start-dragging"),
  );
  assert.ok(
    capability.permissions.includes("core:window:allow-toggle-maximize"),
  );
});

test("macOS uses native overlay controls without a dark window shadow", () => {
  const [window] = macConfig.app.windows;
  assert.equal(window.label, "main");
  assert.equal(window.decorations, true);
  assert.equal(window.titleBarStyle, "Overlay");
  assert.equal(window.hiddenTitle, true);
  assert.equal(window.shadow, false);
  assert.deepEqual(macConfig.bundle.targets, ["dmg"]);
});

test("macOS permission actions go through the guarded Tauri backend", async () => {
  const calls = [];
  const window = {
    addEventListener: () => {},
    navigator: { platform: "MacIntel" },
    __TAURI__: {
      core: {
        invoke: async (command, args) => calls.push({ command, args }),
      },
      event: { listen: async () => {} },
      window: { getCurrentWindow: () => ({}) },
    },
  };
  vm.runInNewContext(bridge, {
    window,
    document: {
      documentElement: { dataset: {} },
      addEventListener: () => {},
    },
    console,
  });
  await window.__lanBridgeReady;
  await window.lan.call("openHostSettings");
  await window.lan.call("openHostAccessibilitySettings");
  await window.lan.call("hostFirewallStatus");
  await window.lan.call("openFirewallSettings");
  await window.lan.call("revealHostApp");
  await window.lan.call("revealSolunaApp");
  assert.deepEqual(
    calls.map(({ command, args }) => [command, args.method]),
    [
      ["backend_call", "openHostSettings"],
      ["backend_call", "openHostAccessibilitySettings"],
      ["backend_call", "hostFirewallStatus"],
      ["backend_call", "openFirewallSettings"],
      ["backend_call", "revealHostApp"],
      ["backend_call", "revealSolunaApp"],
    ],
  );
  await assert.rejects(window.lan.call("unsupportedAction"));
});

test("macOS accessibility settings action is allowed by the backend", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src-tauri/src/main.rs"),
    "utf8",
  );
  const allowed = source.match(/let allowed = \[([\s\S]*?)\];/);
  assert.ok(allowed);
  assert.match(allowed[1], /"openHostAccessibilitySettings"/);
  assert.match(source, /"openHostAccessibilitySettings" =>/);
});

test("titlebar actions ignore interactive controls", async () => {
  const handlers = {};
  const calls = [];
  const currentWindow = {
    startDragging: async () => calls.push("drag"),
    toggleMaximize: async () => calls.push("maximize"),
  };
  const window = {
    addEventListener: () => {},
    navigator: { platform: "MacIntel" },
    __TAURI__: {
      core: { invoke: async () => {} },
      event: { listen: async () => {} },
      window: { getCurrentWindow: () => currentWindow },
    },
  };
  const document = {
    documentElement: { dataset: {} },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
  };
  vm.runInNewContext(bridge, {
    window,
    document,
    console,
  });
  await window.__lanBridgeReady;
  assert.equal(document.documentElement.dataset.platform, "macos");
  const target = (titlebar, interactive) => ({
    closest: (selector) => (selector === ".titlebar" ? titlebar : interactive),
  });
  handlers.mousedown({ button: 0, target: target(true, false) });
  handlers.mousedown({ button: 0, target: target(true, true) });
  handlers.mousedown({ button: 2, target: target(true, false) });
  handlers.mousedown({ button: 0, target: target(false, false) });
  handlers.dblclick({ target: target(true, false) });
  handlers.dblclick({ target: target(true, true) });
  handlers.dblclick({ target: target(false, false) });
  assert.deepEqual(calls, ["drag", "maximize"]);
});

test("native close requests ask the UI to confirm before closing active sessions", async () => {
  let closeRequest;
  const dispatched = [];
  const commands = [];
  const window = {
    addEventListener: () => {},
    navigator: { platform: "MacIntel" },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    dispatchEvent: (event) => dispatched.push(event.type),
    __TAURI__: {
      core: {
        invoke: async (command) => {
          commands.push(command);
          if (command === "backend_call")
            return { session: {}, host: { phase: "stopped" } };
        },
      },
      event: {
        listen: async (_channel, callback) => {
          closeRequest = callback;
        },
      },
      window: { getCurrentWindow: () => ({}) },
    },
  };
  vm.runInNewContext(bridge, {
    window,
    document: {
      documentElement: { dataset: {} },
      addEventListener: () => {},
    },
    console,
  });
  await window.__lanBridgeReady;
  closeRequest({ payload: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, ["backend_call"]);
  assert.deepEqual(dispatched, ["lan:close-confirmation-requested"]);
  await window.lan.call("window", "confirm-close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, ["backend_call", "window_action"]);
});
