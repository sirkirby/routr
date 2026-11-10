import { expect, test } from "bun:test";
import { capacityFailure, capacityView } from "../src/lib/capacity.mjs";

const subscription = (over = {}) => ({ reserve: 0.1, hardest_work: "strong", use: "normal", ...over });
const config = (subscriptions) => ({ subscriptions });
const live = (pool, headroom = 0.8) => ({ pool, source: `${pool} /usage`, ageSec: 1, class: "included", headroom, windows: [] });
const failed = (pool, ageSec = null) => ({ pool, source: `${pool} /usage`, ageSec, class: "unknown", headroom: null, windows: [], failure: { code: "read_failed" } });

const situations = [
  {
    name: "a normal reading",
    input: ["basic", [live("claude")], config({ claude: subscription() }), null],
    check: (view) => {
      expect(view.subscriptions.most_room).toBe("claude");
      expect([view.unavailable, view.stale, view.next]).toEqual([[], [], []]);
    },
  },
  {
    name: "an excluded account whose usage is unavailable is not listed twice",
    input: ["strong", [failed("cursor")], config({ cursor: subscription({ hardest_work: "basic" }) }), null],
    check: (view) => {
      expect(view.subscriptions.excluded).toEqual([{ subscription: "cursor", why: "the user does not give it strong work" }]);
      expect(view.unavailable).toEqual([]);
    },
  },
  {
    name: "a named view keeps the eligible-subscription wording when the level excludes it",
    input: ["strong", [live("cursor")], config({ cursor: subscription({ hardest_work: "basic" }) }), null, { named: "cursor" }],
    check: (view) => {
      expect(view.next[0].why).toBe("Hold the work, use an eligible subscription for this run, or ask the user; the exclusions explain what fixes eligibility");
    },
  },
  {
    name: "a fresh-read failure stays unavailable when ranking excludes its subscription",
    input: ["strong", [failed("cursor")], config({ cursor: subscription({ hardest_work: "basic" }) }), null,
      { unavailable: [{ part: "usage", subscription: "cursor", source: "cursor /usage", code: "read_failed", why: "routr could not read this usage source.", reading: "unknown" }] }],
    check: (view) => {
      expect(view.unavailable).toEqual([{ part: "usage", subscription: "cursor", source: "cursor /usage", code: "read_failed", why: "routr could not read this usage source.", reading: "unknown" }]);
    },
  },
  {
    name: "a reader that stopped working is said once, with one retry, and the warning leaves trying again to next",
    input: ["basic", [failed("cursor", 89 * 3600)], config({ cursor: subscription() }), null],
    check: (view) => {
      expect(view.stale).toEqual([{ pool: "cursor", warning: "cursor's usage has not been read for 89 h, and its last try failed (read_failed), so remaining capacity is unknown: an update of cursor or herdr may have changed what routr reads",
        retry: expect.objectContaining({ kind: "run", argv: ["routr", "usage", "cursor"] }) }]);
      expect(view.stale[0].warning).not.toMatch(/\brun\b|try again/i);
      expect(view.next.filter((n) => n.argv?.join(" ") === "routr usage cursor")).toEqual([]);
    },
  },
  {
    name: "an unconfigured routr says so, in the ranking's note and as the first step",
    input: ["standard", [], config({}), null],
    check: (view) => {
      expect(view.subscriptions.note).toBe("no subscriptions are configured: routr setup has not been run");
      expect(view.next[0].why).toBe("Tell the user routr is not set up (routr setup), and ask which subscription to use meanwhile");
    },
  },
  {
    name: "a view narrowed to one subscription is judged configured by what the caller says",
    input: ["basic", [live("cursor")], config({}), null, { named: "cursor", configured: true }],
    check: (view) => expect(view.next.map((n) => n.why).join(" ")).not.toContain("routr is not set up"),
  },
];

for (const situation of situations) test(`capacity view: ${situation.name}`, () => situation.check(capacityView(...situation.input)));

test("capacity view: ranking that throws is the caller's to say, with the failure entry and step it is given", () => {
  const broken = Object.defineProperty({}, "subscriptions", { get() { throw new Error("broken"); } });
  expect(() => capacityView("basic", [], broken, null)).toThrow();
  expect(capacityFailure()).toEqual({ failure: { part: "usage", subscription: null, source: "routr", code: "internal_error", why: "An internal error stopped routr from ranking usage." },
    next: { kind: "do", why: "Read capacity yourself before choosing an account" } });
  expect(Object.keys(capacityFailure("board's own words").failure)).toEqual(["part", "subscription", "source", "code", "why"]);
  expect(capacityFailure("board's own words").failure.why).toBe("board's own words");
});
