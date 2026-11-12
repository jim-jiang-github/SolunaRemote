const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const {
  HostControl,
  aes,
  certificateSignature,
  request,
} = require("../../app/core/host-control.cjs");
const { DEFAULT_SETTINGS } = require("../../app/core/validation.cjs");
const { testIdentity } = require("../fixtures/identity.cjs");
const hash = (...parts) =>
  crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
const client = testIdentity();
const serverIdentity = testIdentity();

async function fixture(mode = "normal") {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "lan-pairing-test-"),
  );
  const pin = "1234";
  let key, challenge, clientHash;
  const secret = crypto.randomBytes(16),
    serverChallenge = crypto.randomBytes(16);
  let trusted = false;
  let currentGame = 0;
  let rtspHost = "127.0.0.1";
  let launched;
  const failures = [];
  function respond(res, values) {
    res.setHeader("Content-Type", "application/xml");
    res.end(`<root status_code="200">${values}</root>`);
  }
  const tlsServer = https.createServer(
    {
      key: serverIdentity.key,
      cert: serverIdentity.cert,
      ca: client.cert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      try {
        assert.equal(req.socket.authorized, true);
        assert.deepEqual(req.socket.getPeerCertificate().raw, client.x509.raw);
        const url = new URL(req.url, "https://127.0.0.1");
        if (url.pathname === "/pair") {
          assert.equal(url.searchParams.get("phrase"), "pairchallenge");
          trusted = true;
          respond(res, "<paired>1</paired>");
        } else if (url.pathname === "/serverinfo")
          respond(
            res,
            `<PairStatus>${trusted ? 1 : 0}</PairStatus><currentgame>${currentGame}</currentgame><appversion>7.1.431.0</appversion><ServerCodecModeSupport>257</ServerCodecModeSupport>`,
          );
        else if (url.pathname === "/applist")
          respond(
            res,
            "<App><AppTitle>Desktop &amp; Test</AppTitle><ID>123</ID></App>",
          );
        else if (url.pathname === "/launch" || url.pathname === "/resume") {
          launched = { verb: url.pathname, params: url.searchParams };
          respond(
            res,
            `<gamesession>1</gamesession><sessionUrl0>rtspenc://${rtspHost}:48010</sessionUrl0>`,
          );
        } else throw new Error("Unexpected secure endpoint");
      } catch (error) {
        failures.push(error.message);
        res.writeHead(500);
        res.end();
      }
    },
  );
  await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const params = url.searchParams;
      if (url.pathname === "/serverinfo") {
        respond(
          res,
          `<appversion>7.1.431.0</appversion><uniqueid>TEST-ONLY</uniqueid><HttpsPort>${tlsServer.address().port}</HttpsPort>`,
        );
      } else if (params.get("phrase") === "getservercert") {
        assert.deepEqual(
          Buffer.from(params.get("clientcert"), "hex"),
          client.cert,
        );
        key = hash(
          Buffer.from(params.get("salt"), "hex"),
          Buffer.from(mode === "wrong-pin" ? "9999" : pin),
        ).subarray(0, 16);
        respond(
          res,
          `<paired>1</paired><plaincert>${serverIdentity.cert.toString("hex")}</plaincert>`,
        );
      } else if (params.has("clientchallenge")) {
        challenge = aes(
          Buffer.from(params.get("clientchallenge"), "hex"),
          key,
          true,
        );
        const serverHash = hash(
          challenge,
          certificateSignature(serverIdentity.cert),
          secret,
        );
        if (mode === "wrong-hash") serverHash[0] ^= 0xff;
        respond(
          res,
          `<paired>1</paired><challengeresponse>${aes(Buffer.concat([serverHash, serverChallenge]), key).toString("hex")}</challengeresponse>`,
        );
      } else if (params.has("serverchallengeresp")) {
        clientHash = aes(
          Buffer.from(params.get("serverchallengeresp"), "hex"),
          key,
          true,
        );
        const signature = crypto.sign("sha256", secret, serverIdentity.key);
        if (mode === "bad-signature") signature[0] ^= 0xff;
        respond(
          res,
          `<paired>1</paired><pairingsecret>${Buffer.concat([secret, signature]).toString("hex")}</pairingsecret>`,
        );
      } else if (params.has("clientpairingsecret")) {
        const data = Buffer.from(params.get("clientpairingsecret"), "hex");
        assert.ok(
          crypto.verify(
            "sha256",
            data.subarray(0, 16),
            client.x509.publicKey,
            data.subarray(16),
          ),
        );
        assert.deepEqual(
          clientHash,
          hash(
            serverChallenge,
            certificateSignature(client.cert),
            data.subarray(0, 16),
          ),
        );
        respond(res, "<paired>1</paired>");
      } else throw new Error("Unexpected pairing stage");
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const target = { ip: "127.0.0.1", port, address: `127.0.0.1:${port}` };
  const control = new HostControl(directory, {
    executeImpl: async () => {
      await fs.writeFile(path.join(directory, "client-cert.pem"), client.cert);
      await fs.writeFile(path.join(directory, "client-key.pem"), client.key);
    },
  });
  return {
    control,
    target,
    pin,
    directory,
    get trusted() {
      return trusted;
    },
    get launched() {
      return launched;
    },
    setCurrentGame(value) {
      currentGame = value;
    },
    setRtspHost(value) {
      rtspHost = value;
    },
    async close() {
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => tlsServer.close(resolve)),
      ]);
      await fs.rm(directory, { recursive: true, force: true });
      assert.deepEqual(failures, []);
    },
  };
}

test("full pairing challenge and pinned mutual TLS succeed over real loopback servers", async () => {
  const state = await fixture();
  try {
    await state.control.pair(state.target, "test-fixture", state.pin);
    assert.equal(state.trusted, true);
    const record = JSON.parse(
      await fs.readFile(state.control.recordPath(state.target.address), "utf8"),
    );
    assert.equal(record.certificate, serverIdentity.cert.toString());
    const config = await state.control.launch(
      state.target,
      "test-fixture",
      "Desktop & Test",
      DEFAULT_SETTINGS,
      undefined,
      "&corever=1",
    );
    assert.equal(config.address, "127.0.0.1");
    assert.match(config.rtspUrl, /^rtspenc:\/\/127\.0\.0\.1:48010/);
    assert.equal(config.key.length, 32);
    assert.equal(config.iv.length, 32);
    assert.equal(state.launched.verb, "/launch");
    assert.equal(state.launched.params.get("corever"), "1");
    assert.equal(state.launched.params.get("rikey"), config.key);
    assert.equal(
      state.launched.params.get("rikeyid"),
      String(Buffer.from(config.iv, "hex").readInt32BE(0)),
    );
    assert.equal(state.launched.params.get("surroundAudioInfo"), "196610");
    state.setCurrentGame(123);
    await state.control.launch(
      state.target,
      "test-fixture",
      "Desktop & Test",
      DEFAULT_SETTINGS,
    );
    assert.equal(state.launched.verb, "/resume");
    state.setCurrentGame(456);
    await assert.rejects(
      state.control.launch(
        state.target,
        "test-fixture",
        "Desktop & Test",
        DEFAULT_SETTINGS,
      ),
      /其他应用/,
    );
    state.setCurrentGame(0);
    state.setRtspHost("8.8.8.8");
    await assert.rejects(
      state.control.launch(
        state.target,
        "test-fixture",
        "Desktop & Test",
        DEFAULT_SETTINGS,
      ),
      /RTSP/,
    );
  } finally {
    await state.close();
  }
});
for (const [mode, error] of [
  ["wrong-pin", /PIN/],
  ["wrong-hash", /PIN/],
  ["bad-signature", /签名/],
]) {
  test(`pairing ${mode} cannot save or trust a host certificate`, async () => {
    const state = await fixture(mode);
    try {
      await assert.rejects(
        state.control.pair(state.target, "fixture", state.pin),
        error,
      );
      assert.equal(state.trusted, false);
      await assert.rejects(
        fs.stat(state.control.recordPath(state.target.address)),
        { code: "ENOENT" },
      );
    } finally {
      await state.close();
    }
  });
}
test("changed TLS certificate is rejected instead of bypassing host authentication", async () => {
  const state = await fixture();
  try {
    await assert.rejects(
      request(
        {
          ...state.target,
          httpsPort: (await state.control.info(state.target)).target.httpsPort,
        },
        "serverinfo",
        {},
        {
          identity: { cert: client.cert, key: client.key },
          serverCert: client.cert,
          secure: true,
        },
      ),
    );
    assert.equal(state.trusted, false);
  } finally {
    await state.close();
  }
});
