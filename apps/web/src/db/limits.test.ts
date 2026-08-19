import { afterEach, describe, expect, it } from "vitest";

import {
  RATE_LIMITS,
  callerHash,
  estimateSpend,
  verdictFor,
} from "./limits";

const original = process.env["RATE_LIMIT_SALT"];
afterEach(() => {
  if (original === undefined) delete process.env["RATE_LIMIT_SALT"];
  else process.env["RATE_LIMIT_SALT"] = original;
});

function requestFrom(address: string): Request {
  return new Request("https://example.test/api/scans", {
    method: "POST",
    headers: { "x-forwarded-for": address },
  });
}

describe("verdictFor", () => {
  it("allows a caller under both ceilings", () => {
    expect(verdictFor(0, 0).allowed).toBe(true);
    expect(
      verdictFor(RATE_LIMITS.hourlyRequests - 3, RATE_LIMITS.burst - 1, 3)
        .allowed,
    ).toBe(true);
  });

  it("refuses a caller at the burst ceiling", () => {
    const verdict = verdictFor(0, RATE_LIMITS.burst);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/minutes/);
  });

  it("refuses everyone once the hourly budget is spent", () => {
    const verdict = verdictFor(RATE_LIMITS.hourlyRequests, 0, 3);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/hourly GitHub budget/);
  });

  /*
   * The ceiling counts requests *spent*, not calls answered, so what the
   * request in hand is about to cost has to be part of the comparison —
   * otherwise the last scan of the hour is allowed to overshoot the budget by
   * its own size.
   */
  it("weighs the cost of the request in hand, not only what has gone", () => {
    const nearlySpent = RATE_LIMITS.hourlyRequests - 2;
    // A free cached answer still fits; a three-request scan does not.
    expect(verdictFor(nearlySpent, 0, 0).allowed).toBe(true);
    expect(verdictFor(nearlySpent, 0, 3).allowed).toBe(false);
  });

  it("lets a free cached answer through on an exhausted budget", () => {
    // It costs nothing, so refusing it would protect nothing.
    expect(verdictFor(RATE_LIMITS.hourlyRequests, 0, 0).allowed).toBe(true);
  });

  /*
   * The burst message names something the reader can act on ("wait a few
   * minutes"); the global one explains a shared limit they cannot. Getting them
   * the wrong way round tells a first-time visitor the demo is broken when in
   * fact they only need to slow down.
   */
  it("prefers the per-caller explanation when both ceilings are hit", () => {
    const verdict = verdictFor(
      RATE_LIMITS.hourlyRequests,
      RATE_LIMITS.burst,
      3,
    );
    expect(verdict.message).toMatch(/Give it a few minutes/);
  });
});

describe("estimateSpend", () => {
  it("charges nothing for a stored scan inside the recheck window", () => {
    expect(
      estimateSpend({ hasStoredScan: true, withinRecheckWindow: true }),
    ).toBe(0);
  });

  it("charges a full scan when there is nothing stored", () => {
    expect(
      estimateSpend({ hasStoredScan: false, withinRecheckWindow: false }),
    ).toBe(3);
  });

  /*
   * This path really costs one request when the repository turns out not to
   * have moved, and three when it has — and which it will be is not knowable
   * until that request comes back. Over-booking exhausts the budget sooner than
   * the true spend, so the ceiling binds early rather than late.
   */
  it("over-books the out-of-window recheck rather than under-booking it", () => {
    expect(
      estimateSpend({ hasStoredScan: true, withinRecheckWindow: false }),
    ).toBe(3);
  });

  it("never charges a negative or fractional amount", () => {
    for (const hasStoredScan of [true, false]) {
      for (const withinRecheckWindow of [true, false]) {
        const spent = estimateSpend({ hasStoredScan, withinRecheckWindow });
        expect(Number.isInteger(spent)).toBe(true);
        expect(spent).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("callerHash", () => {
  it("gives the same handle to the same address", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    expect(callerHash(requestFrom("203.0.113.7"))).toBe(
      callerHash(requestFrom("203.0.113.7")),
    );
  });

  it("gives different handles to different addresses", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    expect(callerHash(requestFrom("203.0.113.7"))).not.toBe(
      callerHash(requestFrom("203.0.113.8")),
    );
  });

  it("never contains the address it hashed", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    expect(callerHash(requestFrom("203.0.113.7"))).not.toContain("203.0.113.7");
  });

  it("reads the client from the front of a proxy chain", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    // Everything after the first entry is a proxy that saw the request, not the
    // caller — keying on the last one buckets every visitor together.
    expect(callerHash(requestFrom("203.0.113.7, 70.41.3.18, 150.172.238.178"))).toBe(
      callerHash(requestFrom("203.0.113.7")),
    );
  });

  it("changes when the salt changes", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    const a = callerHash(requestFrom("203.0.113.7"));
    process.env["RATE_LIMIT_SALT"] = "different";
    expect(callerHash(requestFrom("203.0.113.7"))).not.toBe(a);
  });

  /*
   * An unsalted SHA-256 of an IPv4 address is not anonymous — the whole space
   * is four billion entries, so the hash is reversible by brute force. With no
   * salt configured every caller collapses into one bucket, which limits more
   * aggressively rather than less.
   */
  it("collapses callers into one bucket when no salt is configured", () => {
    delete process.env["RATE_LIMIT_SALT"];
    expect(callerHash(requestFrom("203.0.113.7"))).toBe(
      callerHash(requestFrom("198.51.100.2")),
    );
  });

  it("does not throw when the header is absent", () => {
    process.env["RATE_LIMIT_SALT"] = "pepper";
    const bare = new Request("https://example.test/api/scans", { method: "POST" });
    expect(() => callerHash(bare)).not.toThrow();
  });
});
