/**
 * Programmatic API. The CLI is a thin shell over these.
 *
 * @example
 * import { loadConfig, buildPlan, apply } from "twin-sync";
 *
 * const cfg = loadConfig({});
 * const plan = await buildPlan(cfg.a, cfg.b, {
 *   include: [], exclude: cfg.exclude, deletions: false,
 * });
 * const result = apply(plan, false);
 */

export { loadConfig, writeConfig, CONFIG_FILENAME } from "./config.js";
export type { Config } from "./config.js";

export { buildPlan, summarize } from "./planner.js";
export type { Plan, Change, ChangeType, PlanOptions } from "./planner.js";

export { apply, shortPath } from "./sync.js";
export type { ApplyResult } from "./sync.js";

export { isGitRepo, repoRoot, listFiles, changedSince, lastCommit } from "./git.js";
export { compare, sha256 } from "./hash.js";
