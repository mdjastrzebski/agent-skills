import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchemas } from "../src/json-schemas.js";
import { validateText, validateValue } from "../src/validate.js";
import { candidate, finding, verdict } from "./fixtures.js";

describe("validateValue error messages", () => {
  it("returns parsed data when valid", () => {
    expect(validateValue("findings", [finding])).toEqual({ ok: true, data: [finding] });
  });

  it("reports one readable line per issue, with paths", () => {
    const result = validateValue("findings", [finding, { ...finding, id: "correctness-2", severity: "major", foo: 1 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      '[1].severity: expected one of "critical" | "high" | "medium" | "low", got "major"',
    );
    expect(result.errors).toContain('[1]: unknown key(s) "foo"');
  });

  it("distinguishes missing fields from wrong types", () => {
    const { claim, ...rest } = finding;
    const result = validateValue("findings", [{ ...rest, line_start: "10" }]);
    if (result.ok) throw new Error("expected invalid");
    expect(result.errors).toContain("[0].claim: required string is missing");
    expect(result.errors).toContain('[0].line_start: expected number, got string "10"');
  });

  it("formats nested paths", () => {
    const result = validateValue("verdict", { ...verdict, fix_assessment: { status: "meh", notes: "" } });
    if (result.ok) throw new Error("expected invalid");
    expect(result.errors[0]).toMatch(/^fix_assessment\.status: expected one of/);
  });

  it("rejects a findings file that is not an array", () => {
    const result = validateValue("findings", finding);
    if (result.ok) throw new Error("expected invalid");
    expect(result.errors).toEqual(["(root): expected array, got object"]);
  });

  it("reports invalid JSON", () => {
    const result = validateText("verdict", "{ nope");
    if (result.ok) throw new Error("expected invalid");
    expect(result.errors[0]).toMatch(/^\(root\): invalid JSON:/);
  });
});

describe("dist/validate.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/validate.mjs");
  const dir = mkdtempSync(join(tmpdir(), "review-flow-validate-"));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("exits 0 for each valid kind", () => {
    for (const [kind, value] of [
      ["findings", [finding]],
      ["candidates", [candidate]],
      ["verdict", verdict],
    ] as const) {
      const result = run(kind, write(`${kind}.json`, value));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^ok: /);
    }
  });

  it("exits 1 with readable errors for invalid content", () => {
    const result = run("verdict", write("bad.json", { ...verdict, verdict: "maybe" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verdict: expected one of "confirmed" | "refuted" | "uncertain", got "maybe"');
  });

  it("exits 2 on usage and read errors", () => {
    expect(run().status).toBe(2);
    expect(run("bogus", write("x.json", [])).status).toBe(2);
    expect(run("findings", join(dir, "missing.json")).status).toBe(2);
  });

  it("runs with no node_modules (bundle is self-contained)", () => {
    const source = readFileSync(cli, "utf8");
    expect(source).not.toMatch(/from\s+["'](?!node:)[^"']+["']/);
    const isolated = mkdtempSync(join(tmpdir(), "review-flow-dist-"));
    writeFileSync(join(isolated, "validate.mjs"), source);
    const output = execFileSync(
      process.execPath,
      [join(isolated, "validate.mjs"), "verdict", write("v.json", verdict)],
      {
        cwd: isolated,
        encoding: "utf8",
      },
    );
    expect(output).toMatch(/^ok: /);
  });
});

describe("generated JSON Schemas", () => {
  it("match the zod source (run `npm run build` if this fails)", () => {
    for (const [name, content] of Object.entries(jsonSchemas())) {
      expect(readFileSync(join(import.meta.dirname, "../../schemas", name), "utf8"), name).toBe(content);
    }
  });
});
