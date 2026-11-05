// routr in the Herdr app: what only routr knows. Herdr already shows the workers, their tabs and their screens; this
// panel shows each subscription's room, each launch's decision (advised level, chosen account, model, effort) and how it
// turned out, for the shown space's project. It reads nothing of routr's itself: it runs `routr board` (and `routr
// workers` for the one action that acts) through the app's `exec`, so routr's storage can change without breaking it.
// Installed and updated by `routr skill install`, with the skills; written for the Herdr app's mod API (its AGENTS.md).
// Shown as community panel mods are: `mod.open` (or a key the person adds) opens it as a window (`overlay` in mod.json);
// any layout can hold it, docked (where it folds to a rail) or in a stack; and its `button` is the shape Herdr's tab bar
// will read beside Files and Changes once herdr-app#247 lands.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, exec, focused, layout, nextCommand, notify, openOverlay, panes, props, run, setShared, shared, spaces, theme } from "herdr";

const ICON = { claude: "claude", codex: "codex", cursor: "cursor", agy: "antigravity", kiro: "kiro" };
const LABEL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", agy: "Antigravity", kiro: "Kiro" };
const LEVELS = ["basic", "standard", "strong"];
const POLL_MS = 60000; // data, not animation: board answers from kept readings, and changes when work is launched or recorded
const SHOWN = 8;

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const hours = (h) => (h == null ? "" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const ago = (iso) => {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  return !Number.isFinite(m) ? "" : m < 60 ? `${Math.max(m, 1)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const label = (name) => LABEL[name] ?? name ?? "";
const harness = (name, size) => (ICON[name] ? image(`icons/${ICON[name]}.svg`).w(size).h(size).flex_none() : div().w(size).h(size).flex_none());
// The window that binds an account: the one with the least usable room.
const binding = (s) => (s.windows ?? []).reduce((a, w) => (a == null || (w.usable ?? 1) < (a.usable ?? 1) ? w : a), null);
const roomColor = (t, room) => (room < 0.15 ? t.blocked : room < 0.4 ? t.working : t.accent);

// Its own block in the shown layout, wherever a layout or the app put it. Docked, it folds to a rail by its width, as
// the Spaces sidebar does (a dragged edge narrows it too); in a stack or a pane it has no rail.
function block(node) {
  if (node?.type === "block" && node.content?.mod === "routr") return node;
  for (const c of node?.children ?? []) { const b = block(c); if (b) return b; }
  return null;
}
const RAIL = 44;
const railed = (b) => (b?.size?.px ?? Infinity) < 120;
function fold(b, open) {
  if (!b?.id) return;
  if (!open) setShared("routr.width", b.size?.px ?? 330);
  run("layout.resize", { id: b.id, px: open ? Math.max(260, shared("routr.width") ?? 330) : RAIL });
}

// One routr command, its JSON answer, or { error } when it could not run or answered nothing routr would print.
async function routr(args) {
  let r;
  try { r = await exec("routr", args); } catch { return { error: "routr was not found on the app's PATH. Install routr, or start the app from a shell where `routr` runs." }; }
  try { return JSON.parse(r.stdout); } catch { return { error: `routr ${args[0]} gave no answer (exit ${r.code})` }; }
}

export default class Routr extends View {
  init(_props, cx) {
    this.board = null;
    this.finished = []; // workers whose next step is `routr cleanup --worker`
    this.pending = [];  // the ones the confirm dialog is asking about
    this.open = new Set();
    try { this.scope = localStorage.getItem("scope") ?? "space"; } catch { this.scope = "space"; }
    this.key = null;
    cx.timer.every(POLL_MS, (cx) => { this.load(cx); this.loadWorkers(cx); });
    this.loadWorkers(cx);
    // The confirm dialog runs `routr.cleanup` back here.
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "cleanup") await this.cleanup(cx); cx.notify(); } });
  }

  // The board for the shown scope: this space's folder (routr applies its own project rule), or every project.
  load(cx) {
    const where = this.where;
    cx.spawn(async (cx) => {
      const b = await routr(["board", ...(where ? ["--cwd", where] : [])]);
      if (where === this.where) { this.board = b.error ? this.board : b; this.error = b.error ?? (b.ok === false ? b.error ?? b.headline : null); }
      cx.notify();
    });
  }

  loadWorkers(cx) {
    cx.spawn(async (cx) => {
      const w = await routr(["workers"]);
      this.finished = (w.workers ?? []).filter((x) => x.state === "finished" || x.state === "gone").map((x) => x.name);
      cx.notify();
    });
  }

  // Read every subscription's usage now (`routr usage` reads each harness through its own CLI), then the board again.
  readNow(cx) {
    if (this.reading) return;
    this.reading = true; cx.notify();
    cx.spawn(async (cx) => {
      const u = await routr(["usage"]);
      this.reading = false;
      notify({ title: "routr", body: u.error ?? u.headline ?? "Usage read", level: u.error || u.ok === false ? "warning" : "info", timeout: 3 });
      this.load(cx); cx.notify();
    });
  }

  askCleanup() {
    this.pending = [...this.finished];
    if (!this.pending.length) return;
    openOverlay({ mod: "confirm", kind: "dialog", props: {
      title: `Clean up ${this.pending.length === 1 ? "1 finished worker" : `${this.pending.length} finished workers`}?`,
      detail: `routr cleanup --worker ${this.pending.join(", ")}: each worker's record, and its worktree when routr has checked it is safe to remove. What routr keeps, it says.`,
      command: { name: "routr.cleanup" } } });
  }

  async cleanup(cx) {
    const names = this.pending; this.pending = [];
    for (const name of names) {
      const r = await routr(["cleanup", "--worker", name]);
      notify({ title: `routr cleanup ${name}`, body: r.error ?? r.headline ?? "", level: r.error || r.ok === false ? "warning" : "success", timeout: 5 });
    }
    this.loadWorkers(cx); this.load(cx);
  }

  header(t, title, right) {
    return h_flex().px(16).pt(14).pb(6).flex_none().items_center().justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child(title))
      .when(Boolean(right), (el) => el.child(right));
  }

  // One account: its usable room after the reserve, and the window that binds it.
  subscription(t, s) {
    const metered = s.class === "metered", room = s.usable ?? 0, w = binding(s);
    const tip = [w ? `${w.window}: ${w.used_pct}% used, resets in ${hours(w.resets_in_h)}` : null, s.reserve ? `reserve ${pct(s.reserve)}` : null,
      s.use === "fallback" ? "fallback account" : null, s.usage && s.usage !== "live" ? `reading ${s.usage}` : null,
      s.age_sec != null ? `read ${ago(new Date(Date.now() - s.age_sec * 1000).toISOString())} ago` : null, s.note].filter(Boolean).join(" · ");
    return v_flex().id(`sub-${s.subscription}`).px(16).py(5).gap(5).hover((el) => el.bg(t.hover)).when(Boolean(tip), (el) => el.tooltip(tip))
      .child(h_flex().gap(9).items_center()
        .child(harness(s.subscription, 15))
        .child(div().flex_1().truncate().text_color(t.foreground).child(label(s.subscription)))
        .when(s.use === "fallback", (el) => el.child(div().text_size(10.5).text_color(t.dim).child("fallback")))
        .child(div().text_size(11.5).text_color(metered || s.usable == null ? t.dim : t.muted).child(metered ? "metered" : s.usable == null ? "unknown" : pct(room))))
      .when(!metered && s.usable != null, (el) => el.child(h_flex().pl(24).gap(8).items_center()
        .child(div().flex_1().h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).w(pct(room)).bg(roomColor(t, room))))
        .child(div().w(34).text_right().text_size(10.5).text_color(t.dim).child(w ? hours(w.resets_in_h) : ""))));
  }

  excluded(t, e) {
    return h_flex().id(`off-${e.subscription}`).px(16).h(26).gap(9).items_center().text_color(t.dim).tooltip(e.why ?? "")
      .child(harness(e.subscription, 15)).child(div().flex_1().truncate().child(label(e.subscription))).child(div().text_size(11).child("off"));
  }

  // advised -> chosen, the arrow only when the lead moved it.
  levels(t, d) {
    const a = d.advised?.level, c = d.chose?.level ?? null, torn = d.advised?.sure === false;
    const word = (l, on) => div().text_color(on ? t.foreground : t.muted).child(l ?? "?");
    const moved = a && c && a !== c, up = moved && LEVELS.indexOf(c) > LEVELS.indexOf(a);
    return h_flex().gap(4).items_center().text_size(11.5)
      .child(word(a, !moved)).when(torn, (el) => el.child(div().text_color(t.dim).child("~")))
      .when(Boolean(moved), (el) => el.child(div().text_color(up ? t.working : t.accent).child("→")).child(word(c, true)))
      .when(Boolean(d.advised?.high_risk), (el) => el.child(div().px(4).rounded(3).bg(t.blocked + "22").text_size(9.5).text_color(t.blocked).child("risk")));
  }

  outcome(t, o) {
    if (!o?.verdict) return div().text_size(10.5).text_color(t.dim).child("open");
    const color = o.verdict === "done" && o.check !== "fail" ? t.done : o.verdict === "blocked" ? t.blocked : t.working;
    return div().px(5).h(17).rounded(4).flex().items_center().bg(color + "22").text_size(10.5).text_color(color).child(o.verdict + ((o.attempts ?? 1) > 1 ? ` ×${o.attempts}` : ""));
  }

  decision(t, d, i, all) {
    const id = `d-${d.launch_id ?? d.run_id ?? i}`, open = this.open.has(id), sub = d.chose?.subscription;
    const title = all ? d.project ?? "" : `${label(sub)} · ${d.advised?.work_type ?? "work"}`;
    const torn = d.advised?.sure === false && d.advised?.between ? `routr was torn between ${d.advised.between.join(" and ")}` : null;
    return v_flex().id(id).mx(8).px(8).py(6).gap(3).rounded(8).cursor_pointer().hover((el) => el.bg(t.hover)).when(open, (el) => el.bg(t.raised))
      .on_click((_e, cx) => { open ? this.open.delete(id) : this.open.add(id); cx.notify(); })
      .child(h_flex().gap(9).items_center()
        .child(harness(sub, 16))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child(ago(d.recorded_at ?? d.launched_at)))
        .child(this.outcome(t, d.outcome)))
      .child(h_flex().pl(25).gap(8).items_center()
        .child(this.levels(t, d))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${d.chose?.model ?? ""}${d.chose?.effort ? ` · ${d.chose.effort}` : ""}`)))
      .when(open, (el) => el.child(v_flex().pl(25).pt(2).gap(2).text_size(11).text_color(t.muted)
        .child([d.name, d.backend, d.outcome?.check ? `check ${d.outcome.check}` : null].filter(Boolean).join(" · ") || "recorded without a launch")
        .when(Boolean(torn), (el) => el.child(div().text_color(t.dim).child(torn)))
        .when(Boolean(d.outcome?.causes?.length), (el) => el.child(div().text_color(t.dim).child(`extra work: ${d.outcome.causes.join(", ")}`)))));
  }

  // Folded: routr's mark and a dot per account by its room, the lowest first.
  rail(t, me) {
    const subs = (this.board?.subscriptions?.ranked ?? []).filter((s) => s.class !== "metered" && s.usable != null).sort((a, b) => a.usable - b.usable);
    return v_flex().id("routr-rail").size_full().bg(t.chrome).border_l(1).border_color(t.border).items_center().pt(14).gap(10)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Open routr").on_click(() => fold(me, true))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("r"))
      .children(subs.map((s) => h_flex().id(`dot-${s.subscription}`).tooltip(`${label(s.subscription)}: ${pct(s.usable)} usable`)
        .child(div().size(7).rounded(4).bg(roomColor(t, s.usable)))));
  }

  render(cx) {
    const t = theme(), me = block(layout());
    // The shown space's folder: where its first terminal is now, as Herdr names a space (`folder` is only where new
    // terminals start, often empty). A space on another machine has no routr records here: every project is shown.
    const space = spaces().find((s) => s.id === focused()?.space);
    const tabs = new Set((space?.tabs ?? []).map((x) => x.id));
    const local = space && !space.machine;
    const here = local ? panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd ?? (space.folder || null) : null;
    this.where = this.scope === "space" ? here : null;
    const key = `${this.scope}\0${this.where ?? ""}`;
    if (key !== this.key) { this.key = key; this.board = null; this.load(cx); }
    if (me && railed(me)) return this.rail(t, me);
    const b = this.board, all = !b?.project;
    const icon = (id, file, tip, onClick) => div().id(id).p(2).rounded(4).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(svg(file).size(13));
    const seg = (id, text) => div().id(`scope-${id}`).px(7).h(20).rounded(5).flex().items_center().text_size(11).cursor_pointer()
      .when(this.scope === id, (el) => el.bg(t.raised).text_color(t.foreground)).when(this.scope !== id, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { this.scope = id; try { localStorage.setItem("scope", id); } catch {} cx.notify(); }).child(text);
    const why = this.scope === "space" && !b?.project ? (!local && space ? "on another machine" : !here ? "no folder here" : null) : null;
    const scopeBar = h_flex().px(16).pt(10).gap(4).items_center()
      .child(seg("space", b?.project ?? "this space")).child(seg("all", "all projects"))
      .when(Boolean(why), (el) => el.child(div().pl(6).text_size(11).text_color(t.dim).child(why)));
    const o = b?.outcomes ?? {}, n = (x) => (x == null ? "?" : String(x));
    const decisions = b?.decisions ?? [];
    return v_flex().size_full().min_h(0).bg(t.chrome).border_l(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(44).flex_none().items_center().gap(8).border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child("routr"))
        .child(div().flex_1())
        .when(Boolean(me?.size?.px), (el) => el.child(icon("routr-fold", "mods/workspace-chrome/panel-right.svg", "Fold routr", () => fold(me, false))))
        .when(!me && Boolean(props()?.overlay), (el) => el.child(div().id("routr-close").px(4).rounded(4).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_click(() => closeOverlay(props().overlay)).child("✕"))))
      .when(Boolean(this.error), (el) => el.child(div().px(16).pt(12).text_size(12).text_color(t.blocked).child(this.error)))
      .when(!b && !this.error, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("Reading routr…")))
      .when(Boolean(b), (el) => el.child(v_flex().id("routr-body").flex_1().min_h(0).overflow_y_scrollbar().pb(12)
        .child(this.header(t, "Room", icon("refresh", "mods/workspace-chrome/clock.svg", this.reading ? "Reading usage…" : "Read usage now", (_e, cx) => this.readNow(cx))))
        .children((b.subscriptions?.ranked ?? []).map((s) => this.subscription(t, s)))
        .children((b.subscriptions?.excluded ?? []).map((e) => this.excluded(t, e)))
        .when((b.unavailable ?? []).length > 0, (el) => el.child(div().px(16).pt(4).text_size(11).text_color(t.dim)
          .tooltip((b.unavailable ?? []).map((u) => u.why).filter(Boolean).join("\n"))
          .child(`${b.unavailable.length} not read: ${b.unavailable.map((u) => u.subscription ?? u.part).join(", ")}`)))
        .child(scopeBar)
        .child(this.header(t, "Decisions", this.finished.length ? div().id("cleanup").px(6).h(18).rounded(4).flex().items_center().text_size(10.5)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Finish them with routr cleanup --worker")
          .on_click(() => this.askCleanup()).child(`clean up ${this.finished.length} finished`) : null))
        .when(decisions.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child(all ? "routr has no launches or recorded work yet." : `routr has no launches or recorded work in ${b.project} yet.`)))
        .children(decisions.slice(0, SHOWN).map((d, i) => this.decision(t, d, i, all)))
        .child(this.header(t, "Last 7 days"))
        .child(v_flex().px(16).gap(3).text_size(12).text_color(t.muted)
          .child(`${n(o.launches)} launched, ${n(o.recorded)} recorded, ${n(o.done_first_time)} done first time`)
          .child(`${n(o.level_changed)} where the lead changed the advised level`)
          .when((o.check_failed ?? 0) > 0, (el) => el.child(div().text_color(t.blocked).child(`${o.check_failed} failed their check`))))));
  }
}
