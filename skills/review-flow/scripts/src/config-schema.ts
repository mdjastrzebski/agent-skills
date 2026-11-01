import { z } from "zod";

export const BUILTIN_LENSES = ["correctness", "security", "performance", "tests", "spec"] as const;
export const PRESETS = ["standard", "deep"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const NonEmpty = z.string().min(1);
const Weight = z.number().min(0);
const Lens = z.enum(BUILTIN_LENSES);

// null effort = the harness default.
const RoleModel = z.strictObject({ model: NonEmpty, effort: z.enum(EFFORTS).nullable() });
const RoleModels = z.strictObject({ reviewer: RoleModel, merger: RoleModel, verifier: RoleModel });

// One row of the §4 preset table.
const Preset = z.strictObject({
  // Per harness, because model names differ.
  models: z.strictObject({ claude: RoleModels, cursor: RoleModels }),
  lenses: z.array(Lens),
  secondCorrectnessPass: z.boolean(),
  allowExecution: z.boolean(),
  maxVerified: z.number().int().min(1),
  parallel: z.number().int().min(1),
});

// Absent = auto-detect, null = disabled.
const Check = NonEmpty.nullable().optional();

/** The effective config: defaults.json must satisfy it on its own, and so must every merge result. */
export const Config = z.strictObject({
  preset: z.enum(PRESETS),
  base: NonEmpty.optional(),
  // Spec documents for the spec lens, relative to the repo root. Absent = auto-detect, [] = none.
  specs: z.array(NonEmpty).optional(),
  lenses: z.strictObject({ enabled: z.array(Lens), custom: z.array(NonEmpty) }),
  checks: z.strictObject({ typecheck: Check, test: Check }),
  presets: z.strictObject({ standard: Preset, deep: Preset }),
  scoring: z.strictObject({
    severity: z.strictObject({ critical: Weight, high: Weight, medium: Weight, low: Weight }),
    confidence: z.strictObject({
      confirmed: z.strictObject({ executed: Weight, traced: Weight, reasoned: Weight }),
      uncertain: Weight,
      refuted: Weight,
    }),
    impact: z.strictObject({ "user-facing": Weight, "developer-facing": Weight, internal: Weight }),
    fixBeforeMergeThreshold: Weight,
  }),
  ignore: z.array(NonEmpty),
  publish: z.strictObject({ includeFollowUps: z.boolean() }),
});

export type Config = z.infer<typeof Config>;

type DeepPartial<T> = T extends unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type ConfigLayer = DeepPartial<Config> & { $schema?: string };

/** Unwraps optional/nullable/default wrappers. */
export function unwrap(schema: z.ZodType): z.ZodType {
  let current: any = schema;
  while (["optional", "nullable", "default"].includes(current._zod.def.type)) current = current._zod.def.innerType;
  return current;
}

function deepPartial(schema: z.ZodType): z.ZodType {
  const inner = unwrap(schema) as any;
  if (inner._zod.def.type !== "object") return schema;
  const shape = Object.fromEntries(
    Object.entries(inner._zod.def.shape).map(([key, value]) => [key, deepPartial(value as z.ZodType).optional()]),
  );
  return z.strictObject(shape);
}

/** A user file, repo file or `--set` override: every key optional at every depth, still strict. */
export const ConfigFile = z.strictObject({
  $schema: z.string().optional(),
  ...((deepPartial(Config) as any)._zod.def.shape as Record<string, z.ZodType>),
});

/** The schema node at `path`, or undefined when the path names no config key. */
export function schemaAt(schema: z.ZodType, path: string[]): z.ZodType | undefined {
  let current: z.ZodType | undefined = schema;
  for (const key of path) {
    const inner: any = current && unwrap(current);
    if (!inner || inner._zod.def.type !== "object" || !Object.hasOwn(inner._zod.def.shape, key)) return undefined;
    current = inner._zod.def.shape[key];
  }
  return current;
}

/** Valid keys of the object at `path`, used for "did you mean" suggestions. */
export function keysAt(schema: z.ZodType, path: PropertyKey[]): string[] {
  const node = schemaAt(schema, path.map(String));
  const inner = node && (unwrap(node) as any);
  return inner?._zod.def.type === "object" ? Object.keys(inner._zod.def.shape) : [];
}
