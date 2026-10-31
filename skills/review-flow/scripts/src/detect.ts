import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type Stack = {
  packageManager: PackageManager;
  typescript: boolean;
  reactNative: boolean;
  testRunner: "jest" | "vitest" | null;
  hasTsc: boolean;
  scripts: Record<string, string>;
};

export type Checks = { typecheck: string | null; test: string | null };

const RUN: Record<PackageManager, string> = { npm: "npm run", yarn: "yarn", pnpm: "pnpm", bun: "bun run" };
const EXEC: Record<PackageManager, string> = { npm: "npx", yarn: "yarn", pnpm: "pnpm exec", bun: "bunx" };

function packageManager(root: string, declared: unknown): PackageManager {
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "npm" || name === "yarn" || name === "pnpm" || name === "bun") return name;
  }
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  return "npm";
}

/** Reads the stack from `<root>/package.json`; null when there is none or it can't be parsed. */
export function detectStack(root: string): Stack | null {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const has = (name: string) => Object.hasOwn(deps, name);
  return {
    packageManager: packageManager(root, pkg.packageManager),
    typescript: has("typescript") || existsSync(join(root, "tsconfig.json")),
    reactNative: has("react-native"),
    testRunner: has("jest") ? "jest" : has("vitest") ? "vitest" : null,
    hasTsc: has("typescript") || existsSync(join(root, "node_modules/.bin/tsc")),
    scripts: typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {},
  };
}

/** Check commands verifiers may run. The test command gets the related files appended. */
export function detectChecks(stack: Stack | null): Checks {
  if (!stack) return { typecheck: null, test: null };
  const pm = stack.packageManager;
  let typecheck: string | null = null;
  if (stack.scripts.typecheck) typecheck = `${RUN[pm]} typecheck`;
  else if (stack.typescript && stack.hasTsc) typecheck = `${EXEC[pm]} tsc --noEmit`;

  let test: string | null = null;
  if (stack.testRunner === "jest") test = `${EXEC[pm]} jest --findRelatedTests`;
  else if (stack.testRunner === "vitest") test = `${EXEC[pm]} vitest related --run`;
  else if (stack.scripts.test && !stack.scripts.test.includes("no test specified")) test = `${pm} test`;
  return { typecheck, test };
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The repo default branch name: origin/HEAD, else a local main/master; null when none exists. */
export function detectBase(root: string): string | null {
  const remoteHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null) return name;
  }
  return null;
}
