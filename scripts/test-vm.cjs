const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveLan, probe } = require("../app/core/network.cjs");
const execute = promisify(execFile);

function tcp(ip, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port });
    const finish = (status) => {
      socket.destroy();
      resolve({ port, status });
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish("reachable"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (error) => finish(error.code));
  });
}
async function main() {
  const [address, ...args] = process.argv.slice(2);
  if (!address || args.length % 2)
    throw new Error(
      "Usage: node scripts\\test-vm.cjs LAN_IP [--identity ABSOLUTE_PATH --known-hosts ABSOLUTE_PATH --user USER]",
    );
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--identity", "--known-hosts", "--user"].includes(args[i]))
      throw new Error(`Unknown option: ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  const target = await resolveLan(address);
  const ports = await Promise.all(
    [22, target.port, target.port - 5, target.port + 1].map((port) =>
      tcp(target.ip, port),
    ),
  );
  const sunshine = await probe(address);
  let ssh = {
    attempted: false,
    note: "No identity/trust paths supplied; TCP reachability does not prove SSH authentication.",
  };
  if (Object.keys(options).length) {
    for (const name of ["--identity", "--known-hosts"])
      if (
        !options[name] ||
        !path.isAbsolute(options[name]) ||
        !fs.statSync(options[name]).isFile()
      )
        throw new Error(`${name} requires an existing absolute file path.`);
    const user = options["--user"];
    if (!user || /[\u0000-\u0020]/.test(user))
      throw new Error(
        "--user is required and must not contain whitespace or control characters.",
      );
    try {
      const { stdout } = await execute(
        "ssh",
        [
          "-i",
          options["--identity"],
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          `UserKnownHostsFile=${options["--known-hosts"]}`,
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-l",
          user,
          target.ip,
          "whoami",
        ],
        { timeout: 15000, windowsHide: true, maxBuffer: 16384 },
      );
      ssh = { attempted: true, authenticated: true, identity: stdout.trim() };
    } catch (error) {
      ssh = {
        attempted: true,
        authenticated: false,
        error: String(error.stderr || error.message)
          .trim()
          .slice(0, 1000),
      };
    }
  }
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        target: target.target,
        ports,
        sunshine,
        ssh,
        streamVerified: false,
        note: "Only TCP/GameStream discovery and optional SSH authentication are tested; PIN, UDP video, audio and input require a real stream.",
      },
      null,
      2,
    ),
  );
  if (!sunshine.online || (ssh.attempted && !ssh.authenticated))
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
