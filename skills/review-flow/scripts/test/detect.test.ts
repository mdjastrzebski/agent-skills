import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectChecks, detectStack } from "../src/detect.js";

function project(pkg: unknown, files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "review-flow-detect-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

describe("detectStack", () => {
  it("returns null without a package.json", () => {
    expect(detectStack(mkdtempSync(join(tmpdir(), "review-flow-detect-")))).toBeNull();
  });

  it("reads the package manager from packageManager, then lockfiles", () => {
    expect(detectStack(project({ packageManager: "pnpm@9.1.0" }, ["yarn.lock"]))?.packageManager).toBe("pnpm");
    expect(detectStack(project({}, ["bun.lock"]))?.packageManager).toBe("bun");
    expect(detectStack(project({}))?.packageManager).toBe("npm");
  });

  it("detects RN, TS and the test runner", () => {
    const stack = detectStack(
      project({ dependencies: { "react-native": "0.76" }, devDependencies: { vitest: "3" } }, ["tsconfig.json"]),
    );
    expect(stack).toMatchObject({ reactNative: true, typescript: true, hasTsc: false, testRunner: "vitest" });
  });
});

describe("detectChecks", () => {
  it("prefers a typecheck script, else tsc when available", () => {
    expect(
      detectChecks(
        detectStack(
          project({ scripts: { typecheck: "tsc -b" }, devDependencies: { typescript: "5" } }, ["pnpm-lock.yaml"]),
        ),
      ),
    ).toEqual({
      typecheck: "pnpm typecheck",
      test: null,
    });
    expect(
      detectChecks(detectStack(project({ devDependencies: { typescript: "5", jest: "29" } }, ["bun.lockb"]))),
    ).toEqual({
      typecheck: "bunx tsc --noEmit",
      test: "bunx jest --findRelatedTests",
    });
  });

  it("falls back to the test script, ignoring npm's placeholder", () => {
    expect(detectChecks(detectStack(project({ scripts: { test: "mocha" } }))).test).toBe("npm run test");
    expect(detectChecks(detectStack(project({ scripts: { test: "mocha" } }, ["bun.lock"]))).test).toBe("bun run test");
    expect(
      detectChecks(detectStack(project({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))).test,
    ).toBeNull();
    expect(detectChecks(null)).toEqual({ typecheck: null, test: null });
  });
});
