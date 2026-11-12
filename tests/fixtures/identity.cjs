const crypto = require("node:crypto");

// Isolated self-signed test CA. No private identity is stored in the repository.
function testIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const der = (tag, body) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.concat(body);
    const length =
      data.length < 128
        ? [data.length]
        : data.length < 256
          ? [0x81, data.length]
          : [0x82, data.length >> 8, data.length & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), data]);
  };
  const sequence = (...items) => der(0x30, items);
  const algorithm = sequence(
    der(6, Buffer.from("2a864886f70d01010b", "hex")),
    der(5, Buffer.alloc(0)),
  );
  const subject = sequence(
    der(
      0x31,
      sequence(
        der(6, Buffer.from("550403", "hex")),
        der(12, Buffer.from("TEST SolunaRemote fixture")),
      ),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    subject,
    sequence(
      der(23, Buffer.from("240101000000Z")),
      der(23, Buffer.from("491231235959Z")),
    ),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      sequence(
        sequence(
          der(6, Buffer.from("551d13", "hex")),
          der(1, Buffer.from([255])),
          der(4, sequence(der(1, Buffer.from([255])))),
        ),
      ),
    ),
  );
  const raw = sequence(
    tbs,
    algorithm,
    der(
      3,
      Buffer.concat([Buffer.from([0]), crypto.sign("sha256", tbs, privateKey)]),
    ),
  );
  const cert = Buffer.from(
    `-----BEGIN CERTIFICATE-----\n${raw
      .toString("base64")
      .match(/.{1,64}/g)
      .join("\n")}\n-----END CERTIFICATE-----\n`,
  );
  return {
    cert,
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    x509: new crypto.X509Certificate(cert),
  };
}
module.exports = { testIdentity };
