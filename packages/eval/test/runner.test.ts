import { describe, expect, it } from "vitest";
import { computeRoundsToRightDoc } from "../src/runner.js";

describe("computeRoundsToRightDoc", () => {
  it("uses executed rounds when the expected chunk was found", () => {
    expect(
      computeRoundsToRightDoc({
        found: true,
        roundsExecuted: 2,
        maxRounds: 3
      })
    ).toBe(2);
  });

  it("returns maxRounds + 1 when the expected chunk was not found", () => {
    expect(
      computeRoundsToRightDoc({
        found: false,
        roundsExecuted: 3,
        maxRounds: 3
      })
    ).toBe(4);
  });
});
