import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const panel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(panel, "agent-packages/seo-audit");
const fixture = join(panel, "tests/fixtures/seo-audit");
const script = join(pkg, "skill/scripts/inspect-html.mjs");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("pilot preserves the pinned skill, references and license with verifiable provenance", () => {
  const provenance = JSON.parse(readFileSync(join(pkg, "provenance.json"), "utf8"));
  expect(provenance.upstream.commit).toBe("5b2c0007766c6a1cf1d53fd8fc73e979e0821022");
  expect(provenance.upstream.skillVersion).toBe("2.0.1");
  const files = provenance.files as Record<string, { sha256: string; bytes: number; origin: string; executable: boolean }>;
  for (const [path, record] of Object.entries(files)) {
    const bytes = readFileSync(join(pkg, path));
    expect(sha256(bytes), path).toBe(record.sha256);
    expect(bytes.length, path).toBe(record.bytes);
  }
  expect(Object.entries(files).filter(([, record]) => record.origin === "upstream").map(([path]) => path)).toEqual([
    "LICENSE.upstream", "skill/LICENSE.upstream", "skill/SKILL.md",
    "skill/references/ai-writing-detection.md", "skill/references/international-seo.md",
  ]);
  expect(files["skill/scripts/inspect-html.mjs"]).toMatchObject({ origin: "local", executable: true });
  expect(readFileSync(join(pkg, "skill/LICENSE.upstream"), "utf8")).toContain("Copyright (c) 2025 Corey Haines");
  expect(JSON.parse(readFileSync(join(pkg, "agent.json"), "utf8")).capabilityBoundaries).toMatchObject({
    paidToolsRequired: false, globalSkillInstallationRequired: false, memoryWritesGranted: false,
  });
});

test("CLI finds fixture defects with line evidence without executing scripts or obeying page instructions", () => {
  const input = join(fixture, "site/index.html");
  const before = readFileSync(input);
  const output = execFileSync(process.execPath, [script, input], { encoding: "utf8" });
  const result = JSON.parse(output);
  const expected = JSON.parse(readFileSync(join(fixture, "expected-observations.json"), "utf8"));
  expect(result.mode).toBe("static-html-only");
  expect(result.source.sha256).toBe(sha256(before));
  expect(result.findings.map((item: { code: string }) => item.code)).toEqual(expected.findingCodes);
  expect(result.findings.map((item: { lines: number[] }) => item.lines)).toEqual([[5], [6], [7], [8]]);
  expect(result.observations.titles).toHaveLength(1);
  expect(result.observations.descriptions).toHaveLength(1);
  expect(result.observations.staticJsonLdCount).toBe(0);
  expect(result.limitations.join(" ")).toContain("does not establish missing rendered schema");
  expect(result).not.toHaveProperty("score");
  expect(readFileSync(input)).toEqual(before);
  expect(execFileSync(process.execPath, [script, input], { encoding: "utf8" })).toBe(output);
});

test("CLI accepts ordinary quoted HTML attributes and reports noindex as an observation, not a deployment action", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-pilot-"));
  try {
    const path = join(root, "page.html");
    writeFileSync(path, `<!doctype html><html><head><TITLE>Fish &amp; Chips</TITLE><meta name='description' content='A > B'><link href="https://example.invalid/" rel='alternate canonical'><META NAME=ROBOTS CONTENT=none></head><body><h1>Fish <em>&amp;</em> Chips</h1></body></html>`);
    const result = JSON.parse(execFileSync(process.execPath, [script, path], { encoding: "utf8" }));
    expect(result.observations.titles[0].text).toBe("Fish & Chips");
    expect(result.observations.descriptions[0].content).toBe("A > B");
    expect(result.findings.map((item: { code: string }) => item.code)).toEqual(["explicit-noindex"]);
    expect(result.findings[0].observation).toContain("Confirm whether this is intentional");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects URLs, oversized files and invalid UTF-8 without network access or partial success", () => {
  const root = mkdtempSync(join(tmpdir(), "seo-pilot-limits-"));
  try {
    const big = join(root, "large.html");
    const invalid = join(root, "invalid.html");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, "a"));
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    for (const input of ["https://example.invalid/", "file:///etc/hosts", big, invalid, root]) {
      const result = spawnSync(process.execPath, [script, input], { encoding: "utf8", timeout: 5000 });
      expect(result.status, input).toBe(1);
      expect(result.stdout, input).toBe("");
      expect(result.stderr, input).toContain("HTML inspection failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
