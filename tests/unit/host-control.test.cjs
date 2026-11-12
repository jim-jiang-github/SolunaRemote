const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const {
  parseResponse,
  decodeHex,
  aes,
  request,
} = require("../../app/core/host-control.cjs");

test("control XML rejects unsafe declarations, failures and oversized responses", () => {
  assert.equal(
    parseResponse('<root status_code="200"><paired>1</paired></root>').paired,
    "1",
  );
  assert.throws(() => parseResponse('<root status_code="401"/>'), /拒绝/);
  assert.throws(
    () => parseResponse('<!DOCTYPE root><root status_code="200"/>'),
    /XML/,
  );
  assert.throws(() => parseResponse("x".repeat(1024 * 1024 + 1)), /XML/);
});
test("pairing hex and AES reject malformed input and preserve exact unpadded blocks", () => {
  assert.deepEqual(decodeHex("00ff", 2), Buffer.from([0, 255]));
  for (const text of ["0", "gg", "00ff00"])
    assert.throws(() => decodeHex(text, 1));
  const key = Buffer.alloc(16, 0x11);
  const data = Buffer.alloc(32, 0x22);
  const encrypted = aes(data, key);
  assert.equal(encrypted.length, 32);
  assert.deepEqual(aes(encrypted, key, true), data);
  assert.throws(() => aes(Buffer.alloc(15), key), /AES/);
});
test("control transport rejects public addresses, invalid ports and unpinned TLS", async () => {
  await assert.rejects(
    request({ ip: "8.8.8.8", port: 47989 }, "pair", {}),
    /内网/,
  );
  await assert.rejects(
    request({ ip: "127.0.0.1", port: 0 }, "pair", {}),
    /端口/,
  );
  await assert.rejects(
    request(
      { ip: "127.0.0.1", httpsPort: 47984 },
      "pair",
      {},
      { secure: true },
    ),
    /证书/,
  );
});
test("control HTTP is real, bounded, abortable, and does not follow redirects", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/redirect") {
      res.writeHead(302, { Location: "https://8.8.8.8/" });
      res.end();
    } else if (url.pathname === "/large") {
      res.end("x".repeat(1024 * 1024 + 1));
    } else if (url.pathname === "/wait") {
      // Intentionally wait for the caller's timeout or abort.
    } else {
      assert.ok(url.searchParams.get("uuid"));
      res.end('<root status_code="200"><paired>1</paired></root>');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = { ip: "127.0.0.1", port: server.address().port };
  try {
    assert.equal((await request(target, "pair", {})).paired, "1");
    await assert.rejects(request(target, "redirect", {}), /302/);
    await assert.rejects(request(target, "large", {}), /1 MiB/);
    await assert.rejects(request(target, "wait", {}, { timeout: 20 }), /超时/);
    const controller = new AbortController();
    const pending = request(target, "wait", {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /abort/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
