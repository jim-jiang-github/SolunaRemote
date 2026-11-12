const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  AccessServer,
  authorize,
  passwordKey,
  encodeAddress,
  decodeAddress,
  discoverCode,
} = require("../../app/core/access.cjs");
test("LAN device code round-trips private IPv4 with checksum and never resolves public targets", async () => {
  for (const ip of ["10.0.0.1", "172.22.98.13", "192.168.1.20"]) {
    const code = encodeAddress(ip);
    assert.match(code, /^\d{12}$/);
    assert.equal(decodeAddress(code), ip);
    assert.equal((await discoverCode(code)).ip, ip);
    const corrupted = code.slice(0, 11) + ((Number(code[11]) + 1) % 10);
    assert.equal(decodeAddress(corrupted), null);
  }
  assert.throws(() => encodeAddress("8.8.8.8"), /内网/);
  assert.equal(decodeAddress("999999999999"), null);
});

test("password derivation rejects invalid code and short or oversized passwords", async () => {
  for (const [password, code] of [
    ["short", "123456789012"],
    ["x".repeat(129), "123456789012"],
    ["long-test-password", "not-a-code"],
  ])
    await assert.rejects(passwordKey(password, code), /12/);
});

test("real TLS ECDHE-PSK mutually authenticates device password without sending it or requiring X.509 bypass", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "lan-access-test-"),
  );
  const password = "test-only-long-password";
  const nonce = "a".repeat(32);
  let running = false;
  let approved = false;
  const host = {
    status: () => ({ phase: running ? "running" : "stopped" }),
    api: async (_endpoint, body) => {
      if (body) {
        assert.equal(body.pin, "1234");
        approved = true;
        return { status: true };
      }
      return {
        pairings: [
          {
            id: "b".repeat(32),
            name: `SolunaRemote-${nonce}`,
            address: "127.0.0.1",
          },
        ],
      };
    },
  };
  const access = new AccessServer({
    directory,
    host,
    port: 0,
    advertise: false,
  });
  t.after(async () => {
    await access.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await access.init();
  await assert.rejects(access.start(), /访问密码/);
  await access.setPassword(password);
  const saved = await fs.readFile(path.join(directory, "access.json"), "utf8");
  assert.equal(saved.includes(password), false);
  assert.equal(JSON.stringify(access.status()).includes("key"), false);
  running = true;
  await access.start();
  const target = { ip: "127.0.0.1", accessPort: access.server.address().port };
  await assert.rejects(
    authorize(target, access.code, "wrong-long-password", {
      nonce,
      pin: "1234",
    }),
    /验证失败/,
  );
  assert.equal(approved, false);
  await authorize(target, access.code, password, { nonce, pin: "1234" });
  assert.equal(approved, true);
  await assert.rejects(access.setPassword(password), /停止本机共享/);
  await access.stop();
  running = false;
  const restored = new AccessServer({
    directory,
    host,
    port: 0,
    advertise: false,
  });
  await restored.init();
  assert.equal(restored.code, access.code);
  assert.equal(restored.status().passwordConfigured, true);
});
