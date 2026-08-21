/**
 * Tests for the MCP response-shape parser in `extractToolText`.
 *
 * Background (Greptile P1 review on PR #2): the parser originally only
 * handled `result.content` being an object with a `content` array. That
 * silently returned "" for two common shapes (top-level array, plain
 * string), causing fortress status / persona-set / reset to report
 * wrong data on successful tool calls.
 *
 * These tests pin all four shapes the parser now supports so future
 * changes can't regress back to the broken behavior.
 */
import { describe, it, expect } from "vitest";
import { extractToolText } from "../src/tilion-bridge.js";

describe("extractToolText (MCP response shape parsing)", () => {
  it("returns empty string for null", () => {
    expect(extractToolText(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractToolText(undefined)).toBe("");
  });

  it("passes through a plain string (older MCP servers)", () => {
    expect(extractToolText("hello world")).toBe("hello world");
  });

  it("handles a top-level array of content blocks", () => {
    // Some MCP servers return the content array at the top level instead
    // of wrapping it in `{content: [...]}`. The old parser fell through
    // to JSON.stringify on this shape.
    const shape = [
      { type: "text", text: "first line" },
      { type: "text", text: "second line" },
    ];
    expect(extractToolText(shape)).toBe("first line\nsecond line");
  });

  it("handles the canonical {content: [...]} shape", () => {
    const shape = { content: [{ type: "text", text: "fortress: ok" }] };
    expect(extractToolText(shape)).toBe("fortress: ok");
  });

  it("concatenates multiple text blocks with newlines", () => {
    const shape = {
      content: [
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
        { type: "text", text: "gamma" },
      ],
    };
    expect(extractToolText(shape)).toBe("alpha\nbeta\ngamma");
  });

  it("skips non-text blocks (e.g., image, resource)", () => {
    const shape = {
      content: [
        { type: "image", data: "base64..." },
        { type: "text", text: "the visible text" },
        { type: "resource", uri: "x" },
      ],
    };
    expect(extractToolText(shape)).toBe("the visible text");
  });

  it("falls back to JSON.stringify for unrecognized shapes", () => {
    // Object with neither array nor `content` key → stringify so the
    // caller at least sees something useful rather than silent "".
    const shape = { weird: "thing" };
    expect(extractToolText(shape)).toBe('{"weird":"thing"}');
  });

  it("handles content object with non-array content (defensive)", () => {
    // The `content` field exists but isn't an array — falls through to
    // the JSON.stringify last-resort branch, which serializes the whole
    // shape. This is "something useful rather than ''", not ideal but
    // better than silent data loss.
    const shape = { content: "not an array" };
    expect(extractToolText(shape)).toBe('{"content":"not an array"}');
  });
});
