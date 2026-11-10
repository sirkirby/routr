import { expect, test } from "bun:test";
import { capacityView } from "../src/lib/capacity.mjs";

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
      expect([view.unavailable, view.warnings, view.next]).toEqual([[], [], []]);
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
    input: ["strong", [live("cursor")], config({ cursor: subscription({ hardest_work: "basic" }) }), null, { subscription: "cursor" }],
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
    name: "a stale reader warns and gives its retry",
    input: ["basic", [failed("cursor", 89 * 3600)], config({ cursor: subscription() }), null],
    check: (view) => {
      expect(view.warnings).toEqual(["cursor's usage has not been read for 89 h, and its last try failed (read_failed), so remaining capacity is unknown: an update of cursor or herdr may have changed what routr reads"]);
      expect(view.next.some((n) => n.argv?.join(" ") === "routr usage cursor")).toBe(true);
    },
  },
  {
    name: "ranking that throws",
    input: ["basic", [], Object.defineProperty({}, "subscriptions", { get() { throw new Error("broken"); } }), null],
    check: (view) => {
      expect(view.subscriptions).toBeNull();
      expect(view.unavailable).toEqual([{ part: "usage", subscription: null, source: "routr", code: "internal_error", why: "An internal error stopped routr from ranking usage." }]);
      expect(view.next).toEqual([{ kind: "do", why: "Read capacity yourself before choosing an account" }]);
    },
  },
];

for (const situation of situations) test(`capacity view: ${situation.name}`, () => situation.check(capacityView(...situation.input)));
