// One interactive usage lifecycle. Recipes own preparation, commands, screen recognition, parsing and fixed fields;
// this driver owns waits, bounded retries, declared safe answers, failure classification and cleanup. No screen
// text leaves this module through a result. A recipe's prepare/close may keep a stable cwd or own temporary state.
import { shellAlone } from "./herdr.mjs";
import { withUsageTerminal } from "./terminal.mjs";
import { usageFailure } from "./usage-failure.mjs";

export const screenUsageError = (code) => Object.assign(new Error(), { usageCode: code });
export async function screenUsage(recipe, options = {}) {
  let state, code = "read_failed";
  try {
    state = await recipe.prepare?.() ?? {};
    return await withUsageTerminal(async (ctx) => {
      const { t, now, pause } = ctx;
      code = recipe.startFailure ?? "read_failed";
      await recipe.start({ ...ctx, state });
      let readyAt = now();
      const answered = new Set();
      for (;;) {
        const screen = recipe.screen(await t.read());
        if (screen === "ready") break;
        const safe = recipe.safe?.[screen];
        if (safe && !answered.has(screen)) {
          await safe.check?.(state);
          for (const key of safe.keys) await t.keys(key);
          answered.add(screen); readyAt = now();
        } else if (recipe.readyMs != null && now() - readyAt >= recipe.readyMs) throw screenUsageError("open_once");
        // Some CLIs exit before drawing anything. An unreadable process list is not evidence of exit.
        if (recipe.shellExitMs != null && now() - readyAt >= recipe.shellExitMs && await shellAlone(t)) throw screenUsageError("no_response");
        await pause();
      }
      await t.call(["pane", "send-text", t.pane, recipe.command ?? "/usage"]);
      await t.keys("enter");
      const panelAt = now();
      let retried = false;
      for (;;) {
        const parsed = recipe.parse(await t.read());
        if (parsed != null) return { ok: true, ...(recipe.result ? recipe.result(parsed) : parsed) };
        if (!retried && recipe.extraEnterMs != null && now() - panelAt >= recipe.extraEnterMs) {
          await t.keys("enter"); retried = true;
        } else if (now() - panelAt >= (recipe.panelMs ?? 12000)) throw screenUsageError("invalid_response");
        await pause();
      }
    }, { ...options, cwd: state.cwd, verifyCwd: state.verifyCwd ?? false });
  } catch (e) {
    return { ok: false, ...usageFailure(e?.missing ? "herdr_missing" : e?.usageCode ?? code, recipe.label),
      ...(recipe.byHand ? { read_yourself: recipe.byHand } : {}) };
  } finally { await recipe.close?.(state); }
}
