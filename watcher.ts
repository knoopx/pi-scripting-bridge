/**
 * Live reload: one recursive fs.watch on the skills root. Changed .md files
 * schedule a debounced rediscovery. On session_shutdown the watchers are
 * closed for every shutdown reason: the extension runtime is torn down
 * after each of them, so the instance stops all activity.
 */
import { watch, type FSWatcher } from "node:fs";
import { WATCH_DEBOUNCE_MS } from "./constants.js";

export interface WatchState {
  closed: boolean;
  watchers: Map<string, FSWatcher>;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
}

export function closeWatchers(state: WatchState): void {
  for (const [path, w] of state.watchers) {
    try {
      w.close();
    } catch {
      // Ignore close errors.
    }
    state.watchers.delete(path);
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = undefined;
  }
}

function scheduleRediscovery(
  state: WatchState,
  rediscover: () => void,
): void {
  if (state.closed) {
    return;
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = undefined;
    void rediscover();
  }, WATCH_DEBOUNCE_MS);
}

export function startWatchers(
  state: WatchState,
  skillsRoot: string,
  rediscover: () => void,
): void {
  // One single recursive watch on the skills root. `fs.watch` with
  // `recursive: true` reports every .md add/change/remove anywhere in the
  // tree, so no per-directory watchers or lazy subdir watching is needed.
  if (state.closed) return;
  let w: FSWatcher;
  try {
    w = watch(skillsRoot, { recursive: true }, (_eventType, filename) => {
      if (state.closed) return;
      if (filename && filename.endsWith(".md")) {
        scheduleRediscovery(state, rediscover);
      }
    });
  } catch {
    // Skills root not watchable yet; session_start still triggers discovery.
    return;
  }
  w.on("error", () => {
    // The watched tree may have been removed; drop the watcher.
    try {
      w.close();
    } catch {
      // Ignore.
    }
    state.watchers.delete(skillsRoot);
  });
  state.watchers.set(skillsRoot, w);
}
