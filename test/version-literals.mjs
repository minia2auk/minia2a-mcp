// Pre-publish check: every version literal in a SHIPPED file must equal
// package.json's version.
//
// Why (2026-11-05): publishing 1.2.13 shipped a `server.json` still saying
// 1.2.12 — the version bump touched package.json and package-lock.json and
// missed the two literals in server.json. `tools/published-version-literal.py`
// caught it, but only AFTER the tarball was on the registry and immutable, so
// the only remedy was to burn another version number (1.2.14).
//
// The registry is append-only; a check that runs before publish is worth more
// than the same check after. Wired as `prepublishOnly`, so `npm publish` fails
// closed.
//
// Scope: the files npm actually ships (the `files` allowlist, minus dist/ which
// is compiled) plus the manifest itself. dist/ is excluded on purpose — it is
// generated from src/ and carries no independent version literal.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

// Structured manifests only. README is deliberately excluded: it carries other
// people's version literals (`"version": "1.1"` in the .agent-budget example),
// so judging it by the same regex fails a publish that is actually correct.
const candidates = ["package.json", "server.json", "glama.json", "smithery.yaml"];

let failures = 0;
for (const rel of candidates) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  const seen = new Set();
  for (const m of text.matchAll(/"version"\s*:\s*"([^"]+)"/g)) seen.add(m[1]);
  // smithery.yaml / README may spell it as `version: 1.2.3`
  for (const m of text.matchAll(/^\s*version:\s*"?([0-9][0-9.]*)"?\s*$/gm)) seen.add(m[1]);
  for (const v of seen) {
    if (v !== version) {
      console.log(`FAIL  ${rel} declares version ${v}, package is ${version}`);
      failures++;
    }
  }
}

if (failures === 0) {
  console.log(`ok    every shipped version literal equals ${version}`);
} else {
  console.log(`\nVERSION-LITERALS: FAIL (${failures}) — refusing to publish`);
}
process.exit(failures === 0 ? 0 : 1);
