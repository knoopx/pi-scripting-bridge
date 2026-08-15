/**
 * Script execution over the stdin/stdout JSON payload protocol: spawn the
 * script, pipe a JSON payload into stdin, collect stdout/stderr, and honor
 * the timeout (0 disables it) and abort signal. SIGTERM escalation to
 * SIGKILL happens 5s after the first kill.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ScriptExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  timedOut: boolean;
}

export interface RunScriptOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
}

export function runScript(
  scriptPath: string,
  stdinData: string,
  opts: RunScriptOptions,
): Promise<ScriptExecResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const child = spawn(scriptPath, [], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killer = makeKiller(child);
    // timeoutMs 0 disables the timer (frontmatter `timeout: 0`).
    const timer = startTimer(opts.timeoutMs, () => {
      timedOut = true;
      killer.kill();
    });
    const onAbort = wireAbort(opts.signal, killer.kill);
    collectStreams(child, stdoutChunks, stderrChunks);
    writeStdin(child, stdinData);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        code,
        killed: killer.killed,
        timedOut,
      });
    };

    child.on("error", (err) => {
      stderrChunks.push(err.message);
      finish(127);
    });

    child.on("exit", (code) => finish(code ?? 0));
  });
}

/** timeoutMs 0 (or non-positive) disables the timer. */
function startTimer(
  timeoutMs: number,
  onFire: () => void,
): ReturnType<typeof setTimeout> | undefined {
  return timeoutMs > 0 ? setTimeout(onFire, timeoutMs) : undefined;
}

/**
 * SIGTERM first; if the child is still alive after 5s, escalate to
 * SIGKILL. Safe to call multiple times (kills at most once).
 */
function makeKiller(child: ChildProcessWithoutNullStreams): {
  kill: () => void;
  killed: boolean;
} {
  const state = { killed: false };
  const kill = () => {
    if (state.killed) return;
    state.killed = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000).unref();
  };
  return { kill, get killed() { return state.killed; } };
}

function wireAbort(
  signal: AbortSignal | undefined,
  kill: () => void,
): () => void {
  const onAbort = () => kill();
  if (signal === undefined || signal === null) {
    return onAbort;
  }
  if (signal.aborted) {
    kill();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return onAbort;
}

function collectStreams(
  child: ChildProcessWithoutNullStreams,
  stdoutChunks: string[],
  stderrChunks: string[],
): void {
  child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d.toString()));
  // The script may exit before consuming stdin; EPIPE must not crash us.
  child.stdin?.on("error", () => {});
}

function writeStdin(
  child: ChildProcessWithoutNullStreams,
  data: string,
): void {
  try {
    child.stdin?.write(data);
    child.stdin?.end();
  } catch {
    // stdin already closed; the exit handler settles the promise.
  }
}
