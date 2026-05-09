// Standalone smoke test for the codex-trust module: read/append against a
// temp config.toml, then verify each detection path. Doesn't touch the
// user's real ~/.codex/config.toml.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

// Override HOME for the duration of this test so codex-trust writes into
// a sandbox dir.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "coagent-trust-"));
process.env.HOME = sandbox;
const cfg = path.join(sandbox, ".codex", "config.toml");
console.log(`sandbox HOME=${sandbox}`);
console.log(`config path=${cfg}`);

const { getProjectTrust, trustProject } = await import("../src/main/codex-trust.ts");

async function expectStatus(p: string, want: "trusted" | "untrusted" | "unset", label: string) {
  const got = await getProjectTrust(p);
  if (got !== want) throw new Error(`[${label}] ${p}: want ${want}, got ${got}`);
  console.log(`  ✓ ${label}: ${want}`);
}

const projA = "/some/path/project-a";
const projB = "/another/path with space";
const projC = `/quoted/with"quote/in-it`;

console.log("\n1. unset on missing config");
await expectStatus(projA, "unset", "no config file");

console.log("\n2. append trust");
const r1 = await trustProject(projA);
if (!r1.ok) throw new Error("trust 1 failed: " + r1.error);
await expectStatus(projA, "trusted", "after trust 1");

console.log("\n3. idempotent re-trust");
const r2 = await trustProject(projA);
if (!r2.ok) throw new Error("trust 2 failed: " + r2.error);
const text2 = await fs.readFile(cfg, "utf-8");
const matches2 = text2.match(/\[projects\."\/some\/path\/project-a"\]/g) ?? [];
if (matches2.length !== 1) throw new Error(`expected 1 entry, got ${matches2.length}`);
console.log("  ✓ no duplicate entries on re-trust");

console.log("\n4. trust path with spaces");
const r3 = await trustProject(projB);
if (!r3.ok) throw new Error("trust spaces failed: " + r3.error);
await expectStatus(projB, "trusted", "spaces");

console.log("\n5. trust path with quotes (basic-string escaping)");
const r4 = await trustProject(projC);
if (!r4.ok) throw new Error("trust quoted failed: " + r4.error);
await expectStatus(projC, "trusted", "with quote");

console.log("\n6. respect explicit untrusted (do not flip)");
const projD = "/explicitly/untrusted";
await fs.appendFile(
  cfg,
  `\n[projects."/explicitly/untrusted"]\ntrust_level = "untrusted"\n`,
  "utf-8",
);
await expectStatus(projD, "untrusted", "manually set untrusted");
const r5 = await trustProject(projD);
if (r5.ok) throw new Error("trust on untrusted should refuse");
if (r5.status !== "untrusted") throw new Error("status should remain untrusted");
console.log(`  ✓ refused: ${r5.error?.slice(0, 60)}…`);
await expectStatus(projD, "untrusted", "still untrusted after refused trust");

console.log("\n7. cleanup");
await fs.rm(sandbox, { recursive: true });
console.log("  ✓ sandbox removed");

console.log("\nALL PASSED");
