/**
 * scripting-bridge — Pi extension entry point.
 *
 * Bridges `type: tool`, `type: agent`, and `type: hook` skills from the
 * skills tree to Pi tools and event hooks over stdin/stdout JSON payloads.
 *
 * Module layout:
 * - `constants.ts`     — timeouts, skills root, the 31 bridgeable events
 * - `frontmatter.ts`   — shared YAML frontmatter + `command` resolution
 * - `schema.ts`        — TypeBox parameter schema generation
 * - `discovery.ts`     — recursive, type-authoritative skill discovery
 * - `script-exec.ts`   — script spawning (stdin payload, timeout, abort)
 * - `tool-exec.ts`     — tool execution → AgentToolResult mapping
 * - `hook-payload.ts`  — {"event", "context"} stdin payload building
 * - `hook-combine.ts`  — per-event hook result combination semantics
 * - `watcher.ts`       — recursive skills-root watch + debounce
 * - `extension.ts`     — extension factory, registration, live reload
 */
export { scriptingBridgeExtension as default } from "./extension.js";
