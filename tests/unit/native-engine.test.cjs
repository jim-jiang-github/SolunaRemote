const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const { NativeEngine } = require("../../app/core/native-engine.cjs");
const { DEFAULT_SETTINGS } = require("../../app/core/validation.cjs");
const settings = { ...DEFAULT_SETTINGS, nativePath: process.execPath };
const device = {
  id: "native-test",
  name: "Test workstation",
  address: "127.0.0.1",
  app: "Desktop",
};
const capabilities = JSON.stringify({
  event: "capabilities",
  protocol: 1,
  launchParams: "&corever=1",
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 1;
    child.emit("close", 1);
  };
  const engine = new NativeEngine({
    hostControl: {
      pair: async () => {},
      launch: async () => ({ key: "test-secret", address: "127.0.0.1" }),
    },
    executeImpl: async () => ({ stdout: capabilities }),
    spawnImpl: (_file, args, spawnOptions) => {
      assert.deepEqual(args, []);
      assert.equal(spawnOptions.shell, false);
      return child;
    },
    ...options,
  });
  return { engine, child };
}
test("native player receives keys via stdin, not command line; connection is not a rendered frame", async () => {
  const { engine, child } = fixture();
  const events = [];
  engine.on("change", (event) => events.push(event));
  await engine.start("stream", device, settings);
  await tick();
  const config = JSON.parse(child.stdin.read().toString());
  assert.equal(config.key, "test-secret");
  assert.equal(config.deviceName, device.name);
  child.stdout.write('{"event":"connected"}\n');
  assert.equal(engine.status().phase, "waiting-frame");
  assert.ok(!events.some((event) => event.firstFrame));
  child.stdout.write('{"event":"first-frame","width":1280,');
  child.stdout.write('"height":720}\n');
  assert.equal(engine.status().phase, "streaming");
  assert.equal(events.filter((event) => event.firstFrame).length, 1);
  child.stdout.write(
    '{"event":"stats","decoded":40,"rendered":39,"audioPackets":0,"keyboardEvents":12}\n',
  );
  assert.equal(engine.status().stats.keyboardEvents, 12);
  child.exitCode = 0;
  child.emit("close", 0);
  assert.equal(events.at(-1).success, true);
  assert.equal(engine.status(), null);
});
test("native player exit 0 without a frame is explicitly unsuccessful", async () => {
  const { engine, child } = fixture();
  await engine.start("stream", device, settings);
  await tick();
  const completed = once(engine, "change");
  child.emit("close", 0);
  const [event] = await completed;
  assert.equal(event.success, false);
  assert.match(event.error, /首帧/);
  assert.equal(engine.status(), null);
});
test("pair operation publishes a PIN before authorization and reports actual completion", async () => {
  let release;
  const { engine } = fixture({
    hostControl: {
      pair: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  const initial = await engine.start("pair", device, settings);
  assert.match(initial.pin, /^\d{4}$/);
  await tick();
  assert.equal(engine.status().phase, "waiting-pin");
  const completed = once(engine, "change");
  release();
  const [event] = await completed;
  assert.equal(event.kind, "pair");
  assert.equal(event.success, true);
  assert.equal(engine.status(), null);
});
test("cancelling pairing aborts the pending request and cannot later publish success", async () => {
  let release;
  let signal;
  const { engine } = fixture({
    hostControl: {
      pair: (_target, _executable, _pin, input) => {
        signal = input;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const events = [];
  engine.on("change", (event) => events.push(event));
  const session = await engine.start("pair", device, settings);
  await tick();
  engine.cancel(session.id);
  assert.equal(signal.aborted, true);
  release();
  await tick();
  assert.equal(engine.status(), null);
  assert.equal(events.at(-1).cancelled, true);
  assert.ok(!events.some((event) => event.success));
});
test("wrong native protocol, public DNS and malformed output fail without false success", async () => {
  const { engine } = fixture({
    executeImpl: async () => ({ stdout: '{"event":"qt"}' }),
  });
  const done = once(engine, "change").then(async () => {
    if (engine.status()) return once(engine, "change");
  });
  const events = [];
  engine.on("change", (event) => events.push(event));
  await engine.start("stream", device, settings);
  await done;
  await tick();
  assert.match(events.at(-1).error, /兼容/);
  const blocked = fixture({
    resolveImpl: async () => {
      throw new Error("blocked public DNS");
    },
  });
  await assert.rejects(
    blocked.engine.start("stream", device, settings),
    /public DNS/,
  );
  assert.equal(blocked.engine.status(), null);
  const malformed = fixture();
  const invalid = [];
  malformed.engine.on("change", (event) => invalid.push(event));
  await malformed.engine.start("stream", device, settings);
  await tick();
  malformed.child.stdout.write(
    '{"event":"first-frame","width":99999,"height":720}\n',
  );
  assert.match(invalid.at(-1).error, /协议错误/);
  malformed.child.kill();
});
test("native reservation rejects double start while DNS is pending", async () => {
  let release;
  const { engine } = fixture({
    resolveImpl: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const first = engine.start("pair", device, settings);
  await assert.rejects(engine.start("stream", device, settings), /已有/);
  engine.cancel(engine.status().id);
  release({ ip: "127.0.0.1", port: 47989 });
  await assert.rejects(first, /取消/);
});
