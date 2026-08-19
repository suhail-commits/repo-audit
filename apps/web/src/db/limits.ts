import { createHash } from "node:crypto";

/**
 * How much work this deployment will do, and for whom.
 *
 * `POST /api/scans` is anonymous, and one call can spend a tarball download,
 * three GitHub requests, an OSV lookup and up to a minute of CPU. Nothing used
 * to limit it — which the tool's own `unauthenticated-routes` signal reports
 * about this very repository, correctly.
 *
 * Two ceilings, because they protect different things:
 *
 * - **The burst one is per caller** and counts *every* request, whatever it
 *   cost. It exists to stop one visitor hammering the endpoint, and a cheap
 *   request is still a request.
 * - **The hourly one is global** and counts *GitHub requests spent*, not calls
 *   answered. It guards the GitHub rate limit, which belongs to the
 *   deployment's token rather than to any caller, so a per-caller limit could
 *   not protect it — and counting calls rather than spend would refuse real
 *   scans on the strength of cache hits that cost nothing.
 *
 * **Both are counted off `request_log`, not off `scans`.** Counting stored
 * scans was measured to be wrong: a cached answer returns before a row is
 * written, so cached hits never incremented the counter however many arrived —
 * verified at 12 straight successes against a burst ceiling of 5, each
 * out-of-window hit spending one GitHub request. A rate limiter that counts
 * results cannot see the requests that produced no result.
 */
export const RATE_LIMITS = {
  /**
   * GitHub requests this deployment will spend per hour, across all callers.
   *
   * 180 is 60 full scans, which is what the old "60 scans per hour" ceiling
   * meant to allow. Expressed in requests because that is the resource: a
   * cached answer costs 0 or 1, a fresh scan costs 3, and the previous count
   * treated all three the same.
   */
  hourlyRequests: 180,
  /** Requests one caller may make inside `burstWindowMinutes`, at any cost. */
  burst: 5,
  burstWindowMinutes: 10,
} as const;

/**
 * What a request is about to cost in GitHub requests, decided before it runs.
 *
 * Estimated up front rather than recorded afterwards so that the cost is
 * reserved: booking it after the work would let concurrent callers all pass the
 * check and then all start a scan, which is the case the ceiling most exists to
 * prevent.
 *
 * Exact at the two ends and deliberately pessimistic in the middle. A stored
 * scan inside the recheck window is answered with no external call at all, and
 * a scan that actually runs costs three. The path in between — a stored scan
 * past the window whose repository turns out not to have moved — really costs
 * one, the metadata request, but is booked at three because whether it will be
 * one or three is not knowable until that request comes back.
 *
 * Over-booking is the safe direction: it exhausts the budget sooner than the
 * true spend, so the ceiling binds early rather than late. Refunding the
 * difference afterwards would be more accurate and would reintroduce exactly
 * the gap this replaced, where the cheap path went uncounted.
 */
export function estimateSpend(options: {
  hasStoredScan: boolean;
  withinRecheckWindow: boolean;
}): number {
  if (options.hasStoredScan && options.withinRecheckWindow) return 0;
  return 3;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Written for the person who pasted the URL, in the register of the other errors. */
  message?: string;
}

export const ALLOWED: RateLimitVerdict = { allowed: true };

/**
 * A stable, non-reversible handle for one caller.
 *
 * The address itself is never stored. Rate limiting needs to know that two
 * requests came from the same place, which a hash answers, and does not need to
 * know where that place is, which is the only thing keeping the address would
 * add.
 *
 * **Salted from the environment.** An unsalted hash of an IPv4 address is not
 * anonymous at all — the whole space is four billion entries and a rainbow
 * table over it is trivial. Without `RATE_LIMIT_SALT` set, callers collapse to
 * a single bucket, which fails toward limiting *more* rather than less.
 */
export function callerHash(request: Request): string {
  const salt = process.env["RATE_LIMIT_SALT"];
  if (!salt) return "unsalted";

  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  // The client is the first entry; everything after it is proxies.
  const address = forwarded.split(",")[0]?.trim() ?? "";
  if (!address) return "unknown";

  return createHash("sha256")
    .update(`${salt}:${address}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Turn the two measurements into a verdict, so both stores decide identically.
 *
 * @param spentThisHour GitHub requests already booked across the deployment.
 * @param requestsThisWindow Requests this caller has made, at any cost.
 * @param about  What the request in hand is about to cost.
 */
export function verdictFor(
  spentThisHour: number,
  requestsThisWindow: number,
  about = 0,
): RateLimitVerdict {
  /*
   * The per-caller ceiling comes first because its message is the one the
   * reader can act on — "wait a few minutes" — whereas the global one explains
   * a shared limit they cannot do anything about. Telling a first-time visitor
   * the demo is out of budget, when in fact they only need to slow down, reads
   * as the product being broken.
   */
  if (requestsThisWindow >= RATE_LIMITS.burst) {
    return {
      allowed: false,
      message:
        `That's ${RATE_LIMITS.burst} requests in ${RATE_LIMITS.burstWindowMinutes} minutes. ` +
        `Give it a few minutes — a scan is not free to run.`,
    };
  }

  // Checked against the cost of the request in hand, not merely against what
  // has already gone, so the last scan of the hour cannot overshoot the budget.
  if (spentThisHour + about > RATE_LIMITS.hourlyRequests) {
    return {
      allowed: false,
      message:
        "This demo has used its hourly GitHub budget. It shares a rate limit " +
        "with everyone, so it has to stop somewhere. Try again shortly.",
    };
  }

  return ALLOWED;
}
