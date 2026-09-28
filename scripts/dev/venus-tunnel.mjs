/**
 * venus-tunnel.mjs — manage the temporary trycloudflare tunnel that lets
 * GitHub-hosted runners (and any external network) reach the reference
 * UI-Venus endpoint. Runs ON the relay host that can reach the endpoint
 * (deployed via docker; outbound-only, no public IP needed).
 *
 *   node scripts/dev/venus-tunnel.mjs status                 # containers + URL + github var
 *   node scripts/dev/venus-tunnel.mjs publish <gh-repo>      # push the URL to the repo variable
 *   node scripts/dev/venus-tunnel.mjs down                   # remove the containers
 *
 * Setup (once, on the relay host):
 *   docker run -d --name venus-bridge --restart unless-stopped \
 *     -p 127.0.0.1:18300:8300 alpine/socat \
 *     TCP-LISTEN:8300,fork,reuseaddr TCP:<venus-host>:8300
 *   docker run -d --name venus-tunnel --restart unless-stopped --network host \
 *     cloudflare/cloudflared:latest tunnel --url http://127.0.0.1:18300 \
 *     --no-autoupdate --protocol http2
 * Notes:
 *   - QUIC (udp/7844) is blocked in some networks — http2 (tcp/443) is the
 *     reliable protocol choice.
 *   - trycloudflare URLs are ephemeral: a relay/host restart rotates the URL;
 *     re-run `publish` afterwards.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const cmd = process.argv[2] ?? "status";
const repo = process.argv[3];

const sh = async (c, args) => {
  try {
    const { stdout } = await exec(c, args, { timeout: 30_000 });
    return stdout.trim();
  } catch (e) {
    return `ERR: ${(e.stderr || e.message).toString().slice(0, 120)}`;
  }
};

const url = await sh("docker", ["logs", "venus-tunnel"]);
const m = url.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
const registered = (url.match(/Registered tunnel connection/g) ?? []).length;
const ps = await sh("docker", ["ps", "--filter", "name=venus", "--format", "{{.Names}} {{.Status}}"]);

if (cmd === "status") {
  console.log("containers:", ps || "(none)");
  console.log("registered connections:", registered);
  console.log("URL:", m?.[0] ?? "(not registered)");
  process.exit(0);
}
if (cmd === "publish") {
  if (!repo) { console.error("usage: venus-tunnel.mjs publish <owner/repo>"); process.exit(1); }
  if (!m) { console.error("no tunnel URL registered yet"); process.exit(1); }
  await exec("gh", ["variable", "set", "VENUS_TUNNEL_URL", "--repo", repo, "--body", m[0]]);
  console.log(`published ${m[0]} → ${repo} variable VENUS_TUNNEL_URL`);
  process.exit(0);
}
if (cmd === "down") {
  console.log(await sh("docker", ["rm", "-f", "venus-tunnel", "venus-bridge"]));
  process.exit(0);
}
console.error("usage: venus-tunnel.mjs status|publish <owner/repo>|down");
process.exit(1);
