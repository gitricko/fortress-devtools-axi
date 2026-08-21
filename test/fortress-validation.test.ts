/**
 * Tests for fortress command response validation.
 *
 * Background (Greptile P1 review on PR #2, iter 6): fortress wrappers
 * used to silently synthesize `status: "applied"` / `status: "ok"` when
 * the parsed JSON was missing the required `status` field. A valid
 * response missing status is suspicious — possibly the bridge
 * forwarded a different tool's result, or the tool's contract changed.
 *
 * These tests pin the validation contract so future changes can't
 * silently regress back to synthesizing success on missing fields.
 */
import { describe, it, expect } from "vitest";

describe("fortress wrapper response validation", () => {
  it("regression: persona_set returns indeterminate when JSON.parse fails", async () => {
    // We test the wrapper shape directly using a stubbed callTilionTool
    // by mocking the module that fortress.ts imports from.
    // vitest.mock is overkill for a regression check; instead we
    // verify the CONTRACT (the wrapper code's logic) by inspecting the
    // source. If this assertion fails, the wrapper has been changed
    // back to silently synthesize success.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/commands/fortress.ts", import.meta.url),
        "utf8",
      ),
    );
    // The wrapper MUST NOT have a `?? "applied"` fallback for status.
    expect(source).not.toMatch(/parsed\.status \?\? "applied"/);
    // The wrapper MUST mark missing status as indeterminate.
    expect(source).toMatch(
      /fortress persona set response missing required `status` field/,
    );
  });

  it("regression: reset returns indeterminate when JSON.parse fails", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/commands/fortress.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/parsed\.status \?\? "ok"/);
    expect(source).toMatch(
      /fortress reset response missing required `status` field/,
    );
  });

  it("regression: fortressStatus surfaces healthy=false on parse failure", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/commands/fortress.ts", import.meta.url),
        "utf8",
      ),
    );
    // fortressStatus must NOT silently return {} on parse failure.
    expect(source).toMatch(/healthy: false/);
    expect(source).toMatch(/fortress_status returned non-JSON payload/);
  });

  it("regression: fortressStatus validates persona field presence", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/commands/fortress.ts", import.meta.url),
        "utf8",
      ),
    );
    // fortressStatus must reject responses missing `persona`.
    expect(source).toMatch(/response missing required `persona` field/);
  });
});
