/**
 * Deterministic checks of the pure fold semantics in `lib/usage.js`.
 *
 * These encode the accounting rules the daily figures rest on: one call per
 * usage sample, same-(turn,step) replacement, compaction independence, warmup
 * exclusion, the fork-inherited prefix skip, and the display name a short
 * channel code resolves to.
 *
 *   node scripts/unit.mjs
 */
import { applyEvents, createFold, hourKey, renderDays } from "../lib/usage.js";
import { modelDisplayName } from "../lib/model-names.js";

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; } else { fail += 1; console.log("FAIL", name, "actual", JSON.stringify(actual), "expected", JSON.stringify(expected)); }
};
const t = (h) => Date.UTC(2026, 10, 2, h - 8, 0, 0);

// 1. A same-(turn,step) re-report REPLACES instead of adding.
{
  const fold = createFold();
  applyEvents(fold, [
    { seq: 0, time: t(10), type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
    { seq: 1, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } } } },
    { seq: 2, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 7 } } } }
  ]);
  const entry = fold.hours.get(hourKey(t(10)));
  eq("replacement totals", [entry.totals.inputTokens, entry.totals.outputTokens, entry.totals.calls], [20, 7, 1]);
}

// 2. Two DIFFERENT steps each count one call.
{
  const fold = createFold();
  applyEvents(fold, [
    { seq: 0, time: t(10), type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
    { seq: 1, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10 } } } },
    { seq: 2, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 10 } } } }
  ]);
  const entry = fold.hours.get(hourKey(t(10)));
  eq("two steps -> two calls", [entry.totals.inputTokens, entry.totals.calls], [20, 2]);
}

// 3. Compaction summary is its own call and does not clobber the assistant cursor.
{
  const fold = createFold();
  applyEvents(fold, [
    { seq: 0, time: t(10), type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
    { seq: 1, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10 } } } },
    { seq: 2, time: t(10), type: "compaction/summary", data: { compactionId: "c1", usage: { inputTokens: 30 } } },
    { seq: 3, time: t(10), type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 12 } } } }
  ]);
  const entry = fold.hours.get(hourKey(t(10)));
  eq("compaction + replacement", [entry.totals.inputTokens, entry.totals.calls], [42, 2]);
}

// 4. Warmup (all-zero) sample is not a call.
{
  const fold = createFold();
  applyEvents(fold, [{ seq: 0, time: t(10), type: "assistant/message", data: { turn: 1, step: 1, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 0, outputTokens: 0 } } }]);
  eq("warmup not a call", fold.hours.size, 0);
}

// 5. Inherited fork prefix is skipped.
{
  const fold = createFold();
  applyEvents(fold, [
    { seq: 0, time: t(10), type: "assistant/message", data: { turn: 1, step: 1, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 100 } } },
    { seq: 1, time: t(10), type: "session/end-seed", data: { inherited: true } },
    { seq: 2, time: t(10), type: "assistant/message", data: { turn: 2, step: 1, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 7 } } }
  ], { skipBeforeSeq: 1 });
  eq("fork skips inherited", fold.hours.get(hourKey(t(10))).totals.inputTokens, 7);
}

// 6. Short channel codes resolve to a readable model name, PER PROVIDER: the
// same code names a different model in the two Qoder channels.
{
  eq("qodercn/dfmodel name", modelDisplayName("qodercn", "dfmodel"), "DeepSeek-Flash");
  eq("qoder/dfmodel name", modelDisplayName("qoder", "dfmodel"), "DeepSeek-Flash");
  eq("mmodel differs by provider", [modelDisplayName("qoder", "mmodel"), modelDisplayName("qodercn", "mmodel")], ["MiniMax-M3", "MiniMax-M2.7"]);
  eq("case-insensitive model id", modelDisplayName("qodercn", "DFMODEL"), "DeepSeek-Flash");
  eq("provider without a table keeps raw", modelDisplayName("workbuddy", "deepseek-v4.1-flash"), undefined);
  eq("unknown code keeps raw", modelDisplayName("qodercn", "brandnewmodel"), undefined);
  // A model id is untrusted text: a prototype member must not resolve to a name.
  eq("prototype key does not resolve", modelDisplayName("qoder", "toString"), undefined);
}

// 7. A model row carries the readable name; a provider row never does, and an
// unmapped model row has no `name` at all so the panel falls back to its id.
{
  const fold = createFold();
  applyEvents(fold, [
    { seq: 0, time: t(10), type: "assistant/message", data: { turn: 1, step: 1, message: { source: { provider: "qodercn", model: "dfmodel" } }, usage: { inputTokens: 100, outputTokens: 5 } } },
    { seq: 1, time: t(10), type: "assistant/message", data: { turn: 1, step: 2, message: { source: { provider: "workbuddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 50 } } }
  ]);
  const day = renderDays(fold.hours, { from: "2026-11-02", to: "2026-11-02" }).days[0];
  const named = day.byModel.find((row) => row.model === "qodercn/dfmodel");
  const plain = day.byModel.find((row) => row.model === "workbuddy/deepseek-v4.1-flash");
  eq("named model row", [named.name, named.model], ["DeepSeek-Flash", "qodercn/dfmodel"]);
  eq("unmapped model row has no name", Object.hasOwn(plain, "name"), false);
  eq("provider rows carry no name", day.byProvider.every((row) => Object.hasOwn(row, "name") === false), true);
}

console.log(`usage.js unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
