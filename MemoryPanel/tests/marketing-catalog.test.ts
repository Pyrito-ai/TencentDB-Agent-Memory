import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildMarketingPackages, marketingPackageLimits, marketingPackageRoot,
  marketingUpstream, validateMarketingPath, validateMarketingText,
} from "../scripts/workbench/build-marketing-agent-packages.js";

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
async function inventory(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${item.name}` : item.name;
    expect(item.isSymbolicLink(), file).toBe(false);
    if (item.isDirectory()) files.push(...await inventory(root, file));
    else { expect(item.isFile(), file).toBe(true); files.push(file); }
  }
  return files.sort();
}

describe("vendored marketing catalog", () => {
  test("contains exactly 49 distinct specialties and leaves SEO separate", async () => {
    const catalog = await readJson(path.join(marketingPackageRoot, "catalog.json"));
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.upstream).toEqual(marketingUpstream);
    expect(catalog.excludedSkills).toEqual(["seo-audit"]);
    expect(catalog.agents).toHaveLength(49);
    const slugs = catalog.agents.map((item: any) => item.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(new Set(slugs).size).toBe(49);
    expect(slugs).not.toContain("seo-audit");
    expect(new Set(catalog.agents.map((item: any) => item.name)).size).toBe(49);
    expect((await readdir(marketingPackageRoot)).sort()).toEqual([...slugs, "catalog.json"].sort());
    const existingSeo = await readJson(path.join(marketingPackageRoot, "..", "seo-audit", "provenance.json"));
    expect(existingSeo.package).toBe("seo-audit");
  });

  test("every complete inventory has exact hashes, safe text paths and honest executable modes", async () => {
    const catalog = await readJson(path.join(marketingPackageRoot, "catalog.json"));
    for (const entry of catalog.agents) {
      expect(entry.path).toBe(entry.slug);
      expect(entry.category).toBeTypeOf("string");
      const root = path.join(marketingPackageRoot, entry.path);
      const provenance = await readJson(path.join(root, "provenance.json"));
      expect(provenance.package).toBe(entry.slug);
      expect(provenance.upstream).toMatchObject({ ...marketingUpstream, skillPath: `skills/${entry.slug}`, skillVersion: entry.upstreamSkillVersion });
      expect(Buffer.byteLength(JSON.stringify(provenance)), entry.slug).toBeLessThanOrEqual(marketingPackageLimits.provenanceBytes);
      expect(await inventory(root)).toEqual([...Object.keys(provenance.files), "provenance.json"].sort());
      const casePaths = new Set<string>();
      let skillBytes = 0;
      let resources = 0;
      for (const [file, record] of Object.entries(provenance.files) as [string, any][]) {
        validateMarketingPath(file);
        const lower = file.toLowerCase();
        expect(casePaths.has(lower), file).toBe(false);
        expect([...casePaths].some((other) => other.startsWith(`${lower}/`) || lower.startsWith(`${other}/`)), file).toBe(false);
        casePaths.add(lower);
        const bytes = await readFile(path.join(root, file));
        validateMarketingText(file, bytes);
        expect(hash(bytes), `${entry.slug}/${file}`).toBe(record.sha256);
        expect(bytes.length, file).toBe(record.bytes);
        expect(((await lstat(path.join(root, file))).mode & 0o111) !== 0, file).toBe(record.executable);
        expect(["local", "upstream"]).toContain(record.origin);
        if (record.origin === "upstream") validateMarketingPath(record.upstreamPath);
        if (file.startsWith("skill/")) { skillBytes += bytes.length; if (file !== "skill/SKILL.md") resources++; }
      }
      expect(resources, entry.slug).toBeLessThanOrEqual(marketingPackageLimits.resources);
      expect(skillBytes + marketingPackageLimits.launchReserveBytes, entry.slug).toBeLessThanOrEqual(marketingPackageLimits.assembledBytes);
      expect(await readFile(path.join(root, "LICENSE.upstream"))).toEqual(await readFile(path.join(root, "skill/LICENSE.upstream")));
      expect(provenance.files["skill/LICENSE.upstream"].upstreamPath).toBe("LICENSE");
      const agent = await readJson(path.join(root, "agent.json"));
      expect(agent.name).toBe(entry.name);
      expect(agent.visibility).toBe("private");
      expect(agent.metadata_json.marketing_provenance).toMatchObject({ package: entry.slug, upstreamCommit: marketingUpstream.commit, upstreamSkillVersion: entry.upstreamSkillVersion });
      expect(agent.prompt).toContain(`skills/${entry.slug}/SKILL.md`);
      expect(agent.prompt).toContain(`skills/${entry.slug}/PACKAGE-GUIDE.md`);
      expect(agent.capabilityBoundaries).toMatchObject({ memoryWritesGranted: false, wikiWritesGranted: false, connectedToolsGranted: false, credentialsGranted: false, externalWritesGranted: false, spendingGranted: false });
    }
  }, 15000);

  test("maps the broken upstream link and leaves the nonexistent positioning skill explicit", async () => {
    const guide = await readFile(path.join(marketingPackageRoot, "ad-creative/skill/PACKAGE-GUIDE.md"), "utf8");
    expect(guide).toContain("upstream relative link is broken");
    expect(guide).toContain("supporting/skills/ads/references/meta-decision-system.md");
    const adsGuide = await readFile(path.join(marketingPackageRoot, "ads/skill/PACKAGE-GUIDE.md"), "utf8");
    expect(adsGuide).toContain("missing upstream related skill");
    expect(adsGuide).toContain(`/blob/${marketingUpstream.commit}/skills/positioning/SKILL.md`);
    const ads = await inventory(path.join(marketingPackageRoot, "ads"));
    expect(ads.some((file) => file.includes("positioning"))).toBe(false);
    const prospecting = await inventory(path.join(marketingPackageRoot, "prospecting"));
    expect(prospecting).toContain("skill/supporting/skills/ad-creative/assets/creative-review-template.html");
    expect(prospecting).toContain("skill/supporting/tools/clis/github-prospects.js");
    expect(prospecting).toContain("skill/supporting/tools/clis/lemlist.js");
    expect(prospecting).not.toContain("skill/supporting/tools/clis/wistia.js");
    expect(adsGuide).toContain("entries absent from the mapping above are not bundled");
  });

  test.each(["../escape", "/absolute", "a/../b", "a//b", "a/./b", "a\\b", "a\u0000b"])("rejects unsafe package path %j", (file) => {
    expect(() => validateMarketingPath(file)).toThrow("Unsafe");
  });
  test("rejects binary, invalid UTF-8 and oversized files", () => {
    expect(() => validateMarketingText("binary", Buffer.from([0]))).toThrow("Non-text");
    expect(() => validateMarketingText("bad-utf8", Buffer.from([0xff]))).toThrow("UTF-8");
    expect(() => validateMarketingText("too-big", Buffer.alloc(128 * 1024 + 1, 65))).toThrow("128 KiB");
  });

  // CI does not need to fetch an upstream repository. Set this for source-fidelity
  // acceptance: it checks every copied upstream byte and every generated local file.
  test.runIf(Boolean(process.env.MARKETINGSKILLS_SOURCE))("reproduces every package from the exact clean upstream checkout", async () => {
    const summary = await buildMarketingPackages(process.env.MARKETINGSKILLS_SOURCE!, { check: true });
    expect(summary).toHaveLength(49);
  }, 30000);
});
