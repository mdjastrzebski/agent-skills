import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Config, ConfigFile } from "../src/config-schema.js";
import {
  ConfigError,
  closestKey,
  detectLayer,
  loadConfig,
  loadDefaults,
  parseJsonc,
  parseSet,
  renderInit,
  schemaRef,
  skillDir,
  userConfigPath,
} from "../src/config.js";

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `review-flow-${prefix}-`));

function gitRepo(): string {
  const dir = tempDir("repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** A repo with optional user and repo config files; the user file lives outside the repo. */
function setup(files: { user?: unknown; repo?: unknown } = {}) {
  const repoRoot = tempDir("cfg");
  const userPath = join(tempDir("home"), "config.json");
  const write = (path: string, value: unknown) =>
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  if (files.user !== undefined) write(userPath, files.user);
  if (files.repo !== undefined) write(join(repoRoot, "review-flow.config.json"), files.repo);
  return { repoRoot, userConfigPath: userPath };
}

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.errors;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("defaults.json", () => {
  const defaults = loadDefaults();

  it("is a complete, valid config", () => {
    expect(Config.safeParse(defaults).success).toBe(true);
  });

  it("matches the §4 rigor table", () => {
    const { low, medium, high } = defaults.rigorPresets;
    expect([low.maxVerified, medium.maxVerified, high.maxVerified]).toEqual([10, 25, 50]);
    expect([low.parallel, medium.parallel, high.parallel]).toEqual([3, 4, 6]);
    expect([low.allowExecution, medium.allowExecution, high.allowExecution]).toEqual([false, true, true]);
    expect(low.lenses).toEqual(["correctness", "security"]);
    expect(medium.lenses).toEqual(["correctness", "security", "tests", "performance"]);
    expect(high.lenses).toContain("react-native");
    expect(high.secondCorrectnessPass).toBe(true);
  });

  it("matches the §8 scoring weights", () => {
    expect(defaults.scoring.severity).toEqual({ critical: 10, high: 6, medium: 3, low: 1 });
    expect(defaults.scoring.confidence).toEqual({
      confirmed: { executed: 1, traced: 0.85, reasoned: 0.65 },
      uncertain: 0.35,
      refuted: 0,
    });
    expect(defaults.scoring.impact).toEqual({ "user-facing": 1.2, "developer-facing": 1, internal: 0.9 });
    expect(defaults.scoring.fixBeforeMergeThreshold).toBe(5);
  });
});

describe("loadConfig precedence", () => {
  it("uses defaults when no files exist", () => {
    const loaded = loadConfig(setup());
    expect(loaded.config).toEqual(loadDefaults());
    expect(new Set(Object.values(loaded.sources))).toEqual(new Set(["default"]));
    expect(loaded.files.map((f) => [f.source, f.found])).toEqual([
      ["default", true],
      ["user", false],
      ["repo", false],
    ]);
  });

  it("applies default < user < repo < override, tracking the source of each value", () => {
    const options = setup({
      user: { rigor: "low", models: { claude: { verifier: "sonnet", reviewer: "haiku" } } },
      repo: { rigor: "high", models: { claude: { verifier: "opus-repo" } } },
    });
    const { config, sources } = loadConfig({ ...options, sets: ["models.claude.verifier=opus-override"] });
    expect(config.rigor).toBe("high");
    expect(config.models.claude).toEqual({ reviewer: "haiku", merger: "haiku", verifier: "opus-override" });
    expect(sources).toMatchObject({
      rigor: "repo",
      "models.claude.reviewer": "user",
      "models.claude.merger": "default",
      "models.claude.verifier": "override",
    });
  });

  it("deep-merges objects but replaces arrays", () => {
    const options = setup({ repo: { rigorPresets: { high: { maxVerified: 80 } }, lenses: { enabled: ["security"] } } });
    const { config } = loadConfig(options);
    expect(config.rigorPresets.high).toMatchObject({ maxVerified: 80, parallel: 6, allowExecution: true });
    expect(config.lenses).toEqual({ enabled: ["security"], custom: [] });
  });

  it("ignores $schema and accepts JSONC files", () => {
    const repo = `{
      // team settings
      "$schema": "./schemas/config.schema.json",
      "checks": { "typecheck": "yarn tsc --noEmit", }, /* trailing comma ok */
    }`;
    const { config } = loadConfig(setup({ repo }));
    expect(config.checks).toEqual({ typecheck: "yarn tsc --noEmit" });
    expect(config).not.toHaveProperty("$schema");
  });

  it("skips the repo layer when no repo root is given", () => {
    const { userConfigPath: path } = setup();
    expect(loadConfig({ userConfigPath: path }).files.map((f) => f.source)).toEqual(["default", "user"]);
  });
});

describe("config errors", () => {
  it("rejects unknown keys at any depth, naming the file and suggesting the closest key", () => {
    const options = setup({ repo: { rigr: "high", models: { claude: { verifer: "opus" } } } });
    const errors = errorsOf(() => loadConfig(options));
    const file = join(options.repoRoot, "review-flow.config.json");
    expect(errors).toContain(`${file}: rigr: unknown key (did you mean "rigor"?)`);
    expect(errors).toContain(`${file}: models.claude.verifer: unknown key (did you mean "verifier"?)`);
  });

  it("lists valid keys when nothing is close", () => {
    const errors = errorsOf(() => loadConfig(setup({ user: { models: { codex: {} } } })));
    expect(errors[0]).toMatch(/models\.codex: unknown key \(valid keys: claude, cursor\)$/);
  });

  it("reports invalid values and unparseable files", () => {
    const errors = errorsOf(() => loadConfig(setup({ user: { rigor: "extreme" }, repo: "{ nope" })));
    expect(errors.some((e) => e.includes('rigor: expected one of "low" | "medium" | "high", got "extreme"'))).toBe(
      true,
    );
    expect(errors.some((e) => /review-flow\.config\.json: cannot parse:/.test(e))).toBe(true);
  });

  it("rejects unknown lens names", () => {
    const errors = errorsOf(() => loadConfig(setup({ repo: { lenses: { enabled: ["a11y"] } } })));
    expect(errors[0]).toMatch(/lenses\.enabled\[0\]: expected one of/);
  });

  it("reports bad --set overrides", () => {
    const options = setup();
    expect(errorsOf(() => loadConfig({ ...options, sets: ["rigr=high"] }))).toEqual([
      '--set rigr=high: rigr: unknown key (did you mean "rigor"?)',
    ]);
    expect(errorsOf(() => loadConfig({ ...options, sets: ["rigor"] }))[0]).toMatch(/expected key=value/);
    expect(errorsOf(() => loadConfig({ ...options, sets: ["rigorPresets.high.maxVerified=lots"] }))[0]).toMatch(
      /expected number/,
    );
  });
});

describe("parseSet", () => {
  it.each([
    ["rigor=high", { rigor: "high" }],
    ["base=123", { base: "123" }],
    ["rigorPresets.high.maxVerified=80", { rigorPresets: { high: { maxVerified: 80 } } }],
    ["publish.includeFollowUps=false", { publish: { includeFollowUps: false } }],
    ["lenses.enabled=correctness, security", { lenses: { enabled: ["correctness", "security"] } }],
    ['lenses.custom=["./a.md"]', { lenses: { custom: ["./a.md"] } }],
    ["checks.test=null", { checks: { test: null } }],
    ["checks.test=yarn jest a=b", { checks: { test: "yarn jest a=b" } }],
  ])("%s", (arg, expected) => {
    expect(parseSet(arg)).toEqual(expected);
  });
});

describe("parseJsonc", () => {
  it("keeps comment-like text and commas inside strings", () => {
    expect(parseJsonc('{ "a": "http://x // y", "b": "/* z */", "c": "1,}" }')).toEqual({
      a: "http://x // y",
      b: "/* z */",
      c: "1,}",
    });
  });

  it("drops trailing commas, including before comments", () => {
    expect(parseJsonc('{ "a": [1, 2, /* x */ ], "b": 1, // last\n }')).toEqual({ a: [1, 2], b: 1 });
  });
});

describe("closestKey", () => {
  it("suggests only reasonably close keys", () => {
    expect(closestKey("verifer", ["reviewer", "merger", "verifier"])).toBe("verifier");
    expect(closestKey("Rigor", ["rigor", "base"])).toBe("rigor");
    expect(closestKey("zzzzzz", ["rigor", "base"])).toBeUndefined();
  });
});

describe("userConfigPath", () => {
  it("honors XDG_CONFIG_HOME, else ~/.config", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/review-flow/config.json");
    expect(userConfigPath({ HOME: "/h" })).toBe("/h/.config/review-flow/config.json");
  });
});

describe("init", () => {
  it("activates only detected values that differ from defaults; the rest is commented out", () => {
    const text = renderInit(
      loadDefaults(),
      { base: "develop", checks: { test: "yarn jest" }, rigor: "medium" },
      "./s.json",
    );
    const parsed = parseJsonc(text);
    expect(parsed).toEqual({ base: "develop", checks: { test: "yarn jest" }, $schema: "./s.json" });
    expect(text).toContain('  // "rigor": "medium",');
    expect(text).toContain('  // "models": {');
  });

  it("stays valid when any commented top-level key is uncommented", () => {
    const text = renderInit(loadDefaults(), { base: "main" }, "./s.json");
    const lines = text.split("\n");
    const starts = lines.flatMap((line, i) => (/^ {2}\/\/ "[^"]+":/.test(line) ? [i] : []));
    expect(starts.length).toBeGreaterThan(5);
    starts.forEach((start, k) => {
      // A key's block runs until the next commented key or the first uncommented line.
      const end = starts[k + 1] ?? lines.findIndex((line, i) => i > start && !line.startsWith("  // "));
      const uncommented = lines.map((line, i) => (i >= start && i < end ? line.replace("  // ", "  ") : line));
      const result = ConfigFile.safeParse(parseJsonc(uncommented.join("\n")));
      expect(result.success, lines[start]).toBe(true);
    });
  });

  it("detects base, checks and RN ignores from the repo", () => {
    const repo = gitRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "react-native": "0.76" }, devDependencies: { typescript: "5", jest: "29" } }),
    );
    writeFileSync(join(repo, "yarn.lock"), "");
    expect(detectLayer(repo)).toEqual({
      base: "main",
      checks: { typecheck: "yarn tsc --noEmit", test: "yarn jest --findRelatedTests" },
      ignore: ["ios/Pods/**", "**/*.snap"],
    });
  });

  it("points $schema inside the repo relatively, otherwise at the installed file", () => {
    expect(schemaRef("/repo/.claude/skills/review-flow", "/repo")).toBe(
      "./.claude/skills/review-flow/schemas/config.schema.json",
    );
    expect(schemaRef("/home/u/.claude/skills/review-flow", "/repo")).toBe(
      "file:///home/u/.claude/skills/review-flow/schemas/config.schema.json",
    );
  });
});

describe("dist/config.mjs CLI", () => {
  const cli = join(skillDir(), "scripts/dist/config.mjs");
  const home = tempDir("xdg");
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: home },
    });

  it("show prints values with their sources", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "review-flow.config.json"), '{ "rigor": "high" }');
    const result = run(repo, "show", "--set", "models.cursor.verifier=gpt-5");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/rigor\s+= "high"\s+\[repo\]/);
    expect(result.stdout).toMatch(/models\.cursor\.verifier\s+= "gpt-5"\s+\[override\]/);
    expect(result.stdout).toMatch(/models\.claude\.verifier\s+= "opus"\s+\[default\]/);
    expect(result.stdout).toMatch(/base\s+= \(auto-detect\)/);
  });

  it("show --json includes the user file from XDG_CONFIG_HOME", () => {
    mkdirSync(join(home, "review-flow"), { recursive: true });
    writeFileSync(join(home, "review-flow/config.json"), '{ "models": { "claude": { "reviewer": "opus" } } }');
    const result = run(gitRepo(), "show", "--json");
    const loaded = JSON.parse(result.stdout);
    expect(loaded.config.models.claude.reviewer).toBe("opus");
    expect(loaded.sources["models.claude.reviewer"]).toBe("user");
  });

  it("exits 1 with suggestions for unknown keys", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "review-flow.config.json"), '{ "lense": {} }');
    const result = run(repo, "show");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lense: unknown key (did you mean "lenses"?)');
  });

  it("init writes a loadable file and refuses to overwrite without --force", () => {
    const repo = gitRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc" }, devDependencies: { vitest: "3" } }),
    );
    const first = run(repo, "init");
    expect(first.status, first.stderr).toBe(0);
    const text = readFileSync(join(repo, "review-flow.config.json"), "utf8");
    expect(parseJsonc(text)).toMatchObject({
      base: "main",
      checks: { typecheck: "npm run typecheck", test: "npx vitest related --run" },
    });
    expect(loadConfig({ repoRoot: repo, userConfigPath: join(home, "none.json") }).sources.base).toBe("repo");

    expect(run(repo, "init").status).toBe(1);
    expect(run(repo, "init", "--force").status).toBe(0);
  });

  it("exits 2 on usage errors", () => {
    const repo = gitRepo();
    expect(run(repo).status).toBe(2);
    expect(run(repo, "show", "--set").status).toBe(2);
    expect(run(tempDir("nogit"), "show").status).toBe(2);
  });
});
