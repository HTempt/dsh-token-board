/**
 * dsh-token-board — readable model names for channels whose route ids are
 * opaque short codes.
 *
 * Most providers name a model the way a reader would (`deepseek-v4.1-flash`),
 * so the panel shows the route id verbatim and this module stays out of the way.
 * The two Qoder channels are the exception: their catalog keys are short codes
 * (`dfmodel`, `qfmodel`, …) that say nothing about the model behind them, and
 * the SAME code can name a different model in the two channels (`mmodel` is
 * MiniMax-M3 internationally and MiniMax-M2.7 in the CN channel), so the table
 * is keyed by provider first and by model id second.
 *
 * The table mirrors the channel pack's model catalogs
 * (`dsh-our-free-model/vendor/channel-pack/pack.js`, `QODER_FALLBACK_MODELS` and
 * `QODER_CN_FALLBACK_MODELS`). It is a display fallback only: a route id that is
 * not listed here keeps its raw spelling, so a model the channel adds later
 * still appears in the panel (by id) instead of vanishing from the figures.
 *
 * @module dsh-token-board/model-names
 */

/**
 * Qoder (international) catalog keys → model names.
 *
 * `Sonus` / `Cantus` are the channel's own codenames for the two premium
 * routes; the catalog does not expand them further.
 */
const QODER_MODELS = {
	auto: "Auto",
	ultimate: "Ultimate",
	performance: "Performance",
	efficient: "Efficient",
	smodel: "Sonus",
	cmodel: "Cantus",
	qmodel_38max: "Qwen3.8-Max",
	qfmodel: "Qwen3.8-Flash",
	qmodel_latest: "Qwen3.7-Max",
	qmodel: "Qwen3.7-Plus",
	kmodel_latest: "Kimi-K3",
	kmodel: "Kimi-K2.8-Preview",
	gmodel: "GLM-5.3",
	gfmodel: "GLM-5.3-Flash",
	dmodel: "DeepSeek-V4-Pro",
	dfmodel: "DeepSeek-Flash",
	mmodel: "MiniMax-M3"
};

/**
 * Qoder CN catalog keys → model names.
 *
 * Differs from the international table in three ways that matter for display:
 * no `smodel` / `cmodel` / `ultimate` / `performance` / `efficient`, two
 * CN-only keys (`q37fmodel`, `gm51model`), and a different `mmodel` generation.
 */
const QODER_CN_MODELS = {
	auto: "Auto",
	qmodel_38max: "Qwen3.8-Max",
	qfmodel: "Qwen3.8-Flash",
	qmodel_latest: "Qwen3.7-Max",
	qmodel: "Qwen3.7-Plus",
	q37fmodel: "Qwen3.7-Flash",
	dmodel: "DeepSeek-V4-Pro",
	dfmodel: "DeepSeek-Flash",
	gmodel: "GLM-5.3",
	gfmodel: "GLM-5.3-Flash",
	gm51model: "GLM-5.2",
	kmodel_latest: "Kimi-K3",
	kmodel: "Kimi-K2.8-Preview",
	mmodel: "MiniMax-M2.7"
};

/**
 * Provider id → its display table.
 *
 * Keyed by the route id the session log records, which is also the provider
 * half of a `provider/model` row key.
 */
const TABLES = { qoder: QODER_MODELS, qodercn: QODER_CN_MODELS };

/**
 * The readable name of one `provider/model` route.
 *
 * The lookup is exact on the provider id (case-insensitive, so a Host that
 * capitalized the id still resolves) and case-insensitive on the model id,
 * because a catalog key reaches the ledger through several writers and the
 * external archive has been seen to differ only by case.
 *
 * @param provider - provider id, e.g. `qoder` / `qodercn`.
 * @param model - bare model id from the route, e.g. `dfmodel`.
 * @returns the model name, or `undefined` when this route has no readable name
 *   (the caller then shows the raw id).
 */
export function modelDisplayName(provider, model) {
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	const table = TABLES[provider.toLowerCase()];
	if (table === undefined) return undefined;
	// `Object.hasOwn`, not a bare index: a model id is untrusted text, and
	// `table["toString"]` would otherwise resolve to a prototype member and
	// print a function into the panel.
	if (Object.hasOwn(table, model)) return table[model];
	const lower = model.toLowerCase();
	if (Object.hasOwn(table, lower)) return table[lower];
	return undefined;
}
