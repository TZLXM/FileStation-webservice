import { parse as parseDotenv } from "dotenv";
import type { ManagedInstallPaths } from "./path-plan";

export type ProductionEnvironmentResolution = "dotenv" | "service";
export interface ProductionEnvironmentRequirements {
  nodeEnv: "production";
  required: ["NODE_ENV", "JWT_SECRET"];
  source: ProductionEnvironmentResolution;
}

export function parseProductionEnvironment(value: unknown): ProductionEnvironmentRequirements | undefined {
  if (value === undefined) return undefined;
  const input = value as Partial<ProductionEnvironmentRequirements> | null;
  if (!input || input.nodeEnv !== "production" || !Array.isArray(input.required) ||
      input.required.join(",") !== "NODE_ENV,JWT_SECRET" || !["dotenv", "service"].includes(String(input.source)))
    throw new Error("managed production environment requirements are invalid");
  return { nodeEnv: "production", required: ["NODE_ENV", "JWT_SECRET"], source: input.source! };
}

export function requireProductionEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>, requirements?: ProductionEnvironmentRequirements,
  invocation: Readonly<NodeJS.ProcessEnv> = {},
): void {
  if (!requirements && environment.NODE_ENV !== "production") return;
  if (environment.NODE_ENV !== "production") throw new Error("NODE_ENV=production is required by managed production metadata");
  if (requirements?.source === "service" && (invocation.NODE_ENV !== "production" || !invocation.JWT_SECRET?.trim()))
    throw new Error("Service environment must supply NODE_ENV=production and JWT_SECRET; dotenv fallback is not a service migration");
  if (!environment.JWT_SECRET?.trim()) throw new Error("JWT_SECRET is required in production before any filesystem/database writes");
}

export function planProductionEnvironment(
  dotenv: Readonly<NodeJS.ProcessEnv>, effective: Readonly<NodeJS.ProcessEnv>,
  resolution?: ProductionEnvironmentResolution,
): ProductionEnvironmentRequirements | undefined {
  if (!effective.NODE_ENV || !["production", "development", "test"].includes(effective.NODE_ENV))
    throw new Error("NODE_ENV is required for bootstrap and must explicitly identify the original production, development or test launch mode; inspect the old service environment securely instead of inferring development");
  if (resolution !== undefined && resolution !== "dotenv" && resolution !== "service")
    throw new Error("production environment resolution must be dotenv or service");
  requireProductionEnvironment(effective);
  if (effective.NODE_ENV !== "production") return undefined;
  const processOnly = ["NODE_ENV", "JWT_SECRET"].filter(name => !dotenv[name] || dotenv[name] !== effective[name]);
  if (processOnly.length && resolution !== "service") {
    throw new Error(`Secure migration required for process-only variables ${processOnly.join(", ")}: configure the same values in the restricted source .env, or securely configure the new service environment and acknowledge --production-env-resolution service. Values are never copied from the shell or printed.`);
  }
  return { nodeEnv: "production", required: ["NODE_ENV", "JWT_SECRET"], source: processOnly.length || resolution === "service" ? "service" : "dotenv" };
}

function encodePath(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} contains an unsupported dotenv control character`);
  for (const quote of ["'", "`", '"']) {
    if (value.includes(quote)) continue;
    const assignment = `${name}=${quote}${value}${quote}`;
    if (parseDotenv(assignment)[name] === value) return assignment;
  }
  throw new Error(`${name} cannot be represented exactly in dotenv`);
}

export function renderManagedEnv(original: string | undefined, paths: ManagedInstallPaths): string {
  const values = { FILESTATION_DB_PATH: paths.database, FILESTATION_STORAGE_PATH: paths.storage, FILESTATION_TEMP_PATH: paths.temp };
  const assignments = Object.fromEntries(Object.entries(values).map(([key,value]) => [key,encodePath(key,value)]));
  const seen = new Set<string>();
  const output = (original ?? "").split(/\r?\n/).map(line => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !(match[1] in assignments)) return line;
    seen.add(match[1]); return assignments[match[1]];
  });
  for (const [key, assignment] of Object.entries(assignments)) if (!seen.has(key)) output.push(assignment);
  const rendered = `${output.join("\n")}\n`;
  const parsed = parseDotenv(rendered);
  for (const [key,value] of Object.entries(values)) if (parsed[key] !== value)
    throw new Error(`${key} dotenv round-trip validation failed before publication`);
  // Path-like text inside a multiline value is not an assignment. Refuse a
  // rewrite if it would change any unrelated value (especially JWT_SECRET).
  const originalValues = parseDotenv(original ?? "");
  for (const [key,value] of Object.entries(originalValues)) {
    if (!(key in values) && parsed[key] !== value)
      throw new Error(`${key} dotenv preservation failed; normalize the source file securely before bootstrap`);
  }
  return rendered;
}
