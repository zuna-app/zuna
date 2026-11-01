// Checks that a running web app serves exactly what a release built: every file
// in the release's zuna-web-files.sha256, byte for byte, and nothing else in its
// page. Anyone can run it against any copy, such as one a friend hosts.
//
//   node scripts/check-web.mjs https://web.chat.example.com zuna-web-files.sha256
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [address, listFile] = process.argv.slice(2);
if (!address || !listFile) {
  console.error("Usage: node scripts/check-web.mjs <web app address> <zuna-web-files.sha256 from the release>");
  process.exit(2);
}
const base = new URL(address.endsWith("/") ? address : `${address}/`);
const expected = new Map(
  readFileSync(listFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sum, ...name] = line.split("  ");
      return [name.join("  "), sum];
    }),
);

let failed = 0;
for (const [name, sum] of expected) {
  const response = await fetch(new URL(name, base), { cache: "no-store" });
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  const same = response.ok && actual === sum;
  if (!same) failed++;
  console.log(`${same ? "same     " : "DIFFERENT"}  ${name}${response.ok ? "" : `  (${response.status})`}`);
}

// The page itself names the files it loads, which all have to be in the list.
const page = await (await fetch(base, { cache: "no-store" })).text();
for (const [, path] of page.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
  if (!expected.has(path)) {
    failed++;
    console.log(`UNKNOWN    ${path}, which the page loads but the release doesn't have`);
  }
}

console.log(failed ? `\n${failed} problems: this isn't the release's web app.` : "\nThis is the release's web app, file for file.");
process.exitCode = failed ? 1 : 0;
