import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fetch the price list the build bundles. The certificate here is self-signed, as a TLS-inspecting
// proxy's would be on a machine that doesn't trust it.
const dir = mkdtempSync(join(tmpdir(), "tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
const server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (_req, res) => res.end("{}"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const res = await fetch(`https://127.0.0.1:${server.address().port}/prices.json`);
  mkdirSync("dist", { recursive: true });
  cpSync("src", "dist", { recursive: true });
  console.log("built dist/ with", await res.text());
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.close();
}
