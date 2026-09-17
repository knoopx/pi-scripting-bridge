/**
 * Unit tests for the session_before_compact result combiner: cancel
 * short-circuit, first-defined compaction wins, malformed compaction
 * payloads are dropped (fail-open), and `cancel: false` noise is not
 * forwarded.
 */
import { describe, expect, it } from "vitest";
import { combineResult } from "./hook-combine.js";

const compactResult = (
  acc: unknown,
  value: Record<string, unknown>,
): unknown => combineResult("session_before_compact", acc, value, undefined)
  .value;

describe("session_before_compact combiner", () => {
  it("short-circuits the chain on cancel: true", () => {
    const outcome = combineResult(
      "session_before_compact",
      { compaction: { summary: "s", firstKeptEntryId: "e" } },
      { cancel: true },
      undefined,
    );
    expect(outcome.value).toEqual({ cancel: true });
    expect(outcome.stop).toBe(true);
  });

  it("passes the accumulator through when nothing is contributed", () => {
    expect(compactResult(undefined, { cancel: false })).toBeUndefined();
    expect(compactResult(undefined, {})).toBeUndefined();
    expect(
      compactResult({ compaction: { summary: "a", firstKeptEntryId: "e" } }, {}),
    ).toEqual({ compaction: { summary: "a", firstKeptEntryId: "e" } });
  });

  it("forwards a well-formed compaction result (fail-open bridge payload shape)", () => {
    const compaction = {
      summary: "Snapcompact: history archived as bitmap frames.",
      firstKeptEntryId: "entry-abc",
      tokensBefore: 12345,
      details: { snapcompact: { frames: ["iVBORw0KGgo"], shape: "11on16-bw" } },
    };
    expect(compactResult(undefined, { cancel: false, compaction })).toEqual({
      compaction,
    });
  });

  it("drops malformed compaction payloads (fail-open to pi default)", () => {
    expect(
      compactResult(undefined, { compaction: { tokensBefore: 1 } }),
    ).toBeUndefined();
    expect(
      compactResult(undefined, { compaction: { summary: "no kept id" } }),
    ).toBeUndefined();
    expect(compactResult(undefined, { compaction: "text" })).toBeUndefined();
    expect(compactResult(undefined, { compaction: null })).toBeUndefined();
  });

  it("first-defined compaction wins; later contributions do not clobber it", () => {
    const first = { summary: "a", firstKeptEntryId: "e1", tokensBefore: 1 };
    const second = { summary: "b", firstKeptEntryId: "e2", tokensBefore: 2 };
    const acc = compactResult(undefined, { compaction: first });
    expect(compactResult(acc, { compaction: second })).toEqual({
      compaction: first,
    });
  });

  it("does not forward bare cancel: false as a result", () => {
    expect(compactResult(undefined, { cancel: false })).toBeUndefined();
  });
});
