import { describe, expect, it } from "vitest";
import { pruneLedger } from "./bandcampDownloads";

describe("pruneLedger", () => {
  const ledger = {
    a: ["/x/1.aiff", "/x/2.aiff"],
    b: ["/y/1.aiff"],
  };

  it("drops deleted paths from an entry", () => {
    expect(pruneLedger(ledger, ["/x/1.aiff"])).toEqual({
      a: ["/x/2.aiff"],
      b: ["/y/1.aiff"],
    });
  });

  it("removes an entry once all its files are gone", () => {
    expect(pruneLedger(ledger, ["/y/1.aiff"])).toEqual({
      a: ["/x/1.aiff", "/x/2.aiff"],
    });
  });

  it("returns the same reference when nothing matched", () => {
    expect(pruneLedger(ledger, ["/z/none.aiff"])).toBe(ledger);
  });
});
