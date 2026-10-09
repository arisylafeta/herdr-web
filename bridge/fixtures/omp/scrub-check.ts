import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
  ["key prefix", /sk-|ghp_/i],
  ["authorization header", /Bearer /i],
  ["sensitive label", /password|secret|api[_-]?key/i],
  ["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["private hostname", /ts\.net/i],
  ["private workspace", /\/root\/\.hermes/i],
];
const encodedPayload = /[A-Za-z0-9+/]{80,}={0,2}/;
let failures = 0;
let checked = 0;

for (const name of (await readdir(directory)).sort()) {
  if (!name.endsWith(".jsonl") && name !== "README.md") continue;
  const content = await Bun.file(join(directory, name)).text();
  checked++;
  for (const [label, pattern] of forbidden) {
    if (!pattern.test(content)) continue;
    console.error(`${name}: rejected ${label}`);
    failures++;
  }
  if (name !== "image-result.jsonl" && encodedPayload.test(content)) {
    console.error(`${name}: rejected long encoded payload`);
    failures++;
  }
  if (!name.endsWith(".jsonl")) continue;
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 5 || lines.length > 60) {
    console.error(`${name}: expected 5–60 lines`);
    failures++;
  }
  for (const [index, line] of lines.entries()) {
    const tornTail = name === "torn-tail.jsonl" && index === lines.length - 1;
    try {
      JSON.parse(line);
      if (tornTail) {
        console.error(`${name}: expected incomplete final JSON`);
        failures++;
      }
    } catch {
      if (!tornTail) {
        console.error(`${name}:${index + 1}: invalid JSON`);
        failures++;
      }
    }
  }
  if (name === "torn-tail.jsonl" && content.endsWith("\n")) {
    console.error(`${name}: torn final line must not end with a newline`);
    failures++;
  }
}

if (failures) process.exit(1);
console.log(`PASS: ${checked} fixture documents scanned; prohibited patterns absent and JSONL structure valid.`);
