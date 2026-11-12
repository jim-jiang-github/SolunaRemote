const fs = require("node:fs");
const [action, target, ...options] = process.argv.slice(2);
fs.appendFileSync(
  process.env.LAN_TEST_LOG,
  `${JSON.stringify({ action, target, options })}\n`,
);
// This is an isolated CLI process fixture, not a GameStream implementation.
console.log(`TEST FIXTURE: ${action} ${target}`);
if (action === "pair" || action === "stream") setInterval(() => {}, 1000);
else process.exitCode = 1;
