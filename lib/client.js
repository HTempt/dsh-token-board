/**
 * dsh-token-board — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): a sidebar row that
 * opens a full center-column dashboard page in the shell's keyed `main` slot,
 * exactly like the shipped Plugins and Schedule pages, so the shell owns the
 * row box, label, active highlight, and panel switch.
 *
 * The page reads the host half's loopback-only aggregate endpoints over
 * same-origin fetch and renders:
 *
 *   - four headline metric cards (today, recent window, calls, cumulative),
 *   - a continuous three-month daily heat calendar painted in one hue whose
 *     depth encodes the selected metric (tokens or calls),
 *   - a day detail panel with per-provider and per-model rows,
 *   - provider and model distributions with proportional bars,
 *   - a dual-metric trend chart (tokens and calls on separate axes).
 *
 * All copy is bilingual through `ctx.locale`; every interactive element carries
 * `default / hover / active / focus-visible / disabled` states, and the data
 * regions carry loading, empty, error, and refreshing states.
 *
 * @module dsh-token-board/client
 */

window.__ModuleLoader__.load({
	// Must equal the PACKAGE name, not the directory name: the loader keys every
	// entry by this id and looks the plugin up by its package name, so a rename
	// that misses this line fails the whole entry with a bare "import failed".
	id: "dsh-token-board",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsx = require("react/jsx-runtime");

		//#region constants
		/**
		 * Dictionary namespace owned by this plugin.
		 *
		 * Registered and looked up through this same constant, so renaming it is
		 * self-consistent; it only has to match the package name for readability.
		 */
		const NS = "dsh-token-board";
		/** Private locale namespace used only to publish a label refresh tick. */
		const LABEL_NS = "dsh-token-board-label";
		/**
		 * Sidebar panel id; also the `main` slot key the page registers under.
		 *
		 * Matches the package name so the panel, the Loader row and the npm package
		 * all read the same. Changing it resets which panel a returning user had
		 * selected, which is why it is not touched casually.
		 */
		const PANEL_ID = "dsh-token-board";
		/** Row order among the shell's global panel rows. */
		const PANEL_ORDER = 30;
		/** Aggregate endpoint. */
		const SUMMARY_PATH = "/api/usage-dashboard/summary";
		/** One-day endpoint, used only when a day is not in the cached window. */
		const DAY_PATH = "/api/usage-dashboard/day";
		/**
		 * Range presets. `days` is the payload window and `months` is how much
		 * calendar the heatmap paints for that range. Both live in one table so a
		 * range can never fetch one span and draw another — that was the bug
		 * where all three ranges showed three months.
		 *
		 * Each span ends on the current (partial) month plus the named count of
		 * months: 3 = current + 2 back, 6 = current + 5, 12 = current + 11.
		 */
		const WINDOWS = [
			{ days: 92, months: 3, key: "3m" },
			{ days: 183, months: 6, key: "6m" },
			{ days: 365, months: 12, key: "1y" },
			// "全部" means the whole stored history, not a fixed span: `months` is
			// replaced at render time with the real span of the data it found.
			{ days: "all", months: 12, key: "all" }
		];
		/**
		 * Resolve an explicit `from`/`to` selection into the same shape a preset
		 * has, so every consumer (payload query, calendar span, heading) reads one
		 * object. The host clamps the span to one year; the client mirrors that so
		 * the calendar never plots more months than the API will return.
		 * @param from - inclusive local `YYYY-MM-DD`.
		 * @param to - inclusive local `YYYY-MM-DD`.
		 * @returns `{ days, months, key, from, to }`.
		 */
		function customRange(from, to) {
			const lo = from <= to ? from : to;
			const hi = from <= to ? to : from;
			const startDate = parseDay(lo);
			const endDate = parseDay(hi);
			const days = Math.round((endDate - startDate) / 86400000) + 1;
			const clampedDays = Math.min(days, MAX_RANGE_DAYS);
			const clampedFrom = clampedDays === days ? lo : dayKeyOf(new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - (clampedDays - 1)));
			// Month span: complete months between the two ends, plus the partial ones.
			const months = (endDate.getFullYear() * 12 + endDate.getMonth())
				- (startDate.getFullYear() * 12 + startDate.getMonth()) + 1;
			return {
				days: clampedDays,
				months: Math.min(Math.max(months, 1), 12),
				key: "custom",
				from: clampedFrom,
				to: hi
			};
		}

		/** The longest range the control offers, mirroring the host's clamp. */
		/**
		 * Hard cap on calendar months painted at once, so "全部" over a very old store
		 * stays readable instead of rendering a hundred narrow columns.
		 */
		const MAX_ALL_MONTHS = 24;
		const MAX_RANGE_DAYS = 365;

		/** The default range: three months. */
		const DEFAULT_RANGE = WINDOWS[0];
		/** How often the page re-reads while it is open, in ms. */
		const REFRESH_MS = 120_000;
		/**
		 * How often the pinned bubble re-reads, in ms.
		 *
		 * Much faster than the page: the bubble exists to be watched while the
		 * reader works, so a figure two minutes stale reads as broken. The read is
		 * one summary request over the default window, so a 30s cadence stays
		 * cheap.
		 */
		const BUBBLE_REFRESH_MS = 30_000;
		/**
		 * How long the card stays up per cycle, in ms.
		 *
		 * Long enough to read two short figures, short enough that it never
		 * becomes a thing to dismiss: the card owns part of the screen while it
		 * is up, so it leaves well before the reader wants it gone.
		 */
		/** Clearance between the sidebar row and the card, in px. */
		/** Auto-refresh retry delay after a failed read. */
		const RETRY_MS = 5_000;
		/** Provider accent hues, stable per provider id by hash. */
		const PROVIDER_ACCENTS = ["#1f6feb", "#12a594", "#7c5cf5", "#e07a1f", "#d9534f", "#0f8ac2", "#6b8f1f", "#b8469c"];
		/**
		 * One hue for every heat cell and both trend series. `--dsw-alias-brand-primary`
		 * is the text/brand ink, which in the shipped palettes is a neutral near-black
		 * or near-white — painting data with it produces grey cells in light mode
		 * and white cells in dark mode. The blue ramp is a static palette token, so
		 * it stays a blue in every theme and reads as data rather than as chrome.
		 */
		const HEAT_HUE = "var(--dsw-static-blue-500, #3b82f6)";
		/** Second trend series hue: a warm violet distinct from the blue ramp. */
		const CALL_HUE = "#8b5cf6";
		//#endregion

		//#region formatting
		/** Split a non-negative number into a mantissa and a Chinese magnitude unit. */
		function magnitude(value) {
			if (!Number.isFinite(value) || value <= 0) return { value: 0, unit: "" };
			if (value >= 1e8) return { value: value / 1e8, unit: "亿" };
			if (value >= 1e4) return { value: value / 1e4, unit: "万" };
			return { value, unit: "" };
		}

		/**
		 * Format a token count the way the reference panel does: an exact grouped
		 * number under 10,000 and a two-significant-digit 万/亿 figure above it.
		 */
		function fmtTokens(value, translate) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value < 10000) return new Intl.NumberFormat().format(Math.round(value));
			const { value: scaled, unit } = magnitude(value);
			const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
			const text = scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
			const suffix = unit === "亿"
				? (translate ? translate("unit.yi") : "亿")
				: (translate ? translate("unit.wan") : "万");
			return `${text}${suffix}`;
		}

		/**
 * Format an exact token count with thousands separators.
 *
 * The headline cards show full digits rather than the 亿/万 shorthand: at a
 * glance a reader can compare magnitudes, and hovering is unnecessary.
 * @param value - token or call count.
 * @returns the grouped decimal string.
 */
function fmtExact(value) {
	if (!Number.isFinite(value) || value <= 0) return "0";
	return new Intl.NumberFormat().format(Math.round(value));
}

/** Format an exact integer call count (never abbreviated: counts stay readable). */
		function fmtCalls(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			return new Intl.NumberFormat().format(Math.round(value));
		}

		/** Format a percentage already on a 0–100 scale, or `--` when unknown. */
		function fmtPercent(value) {
			if (!Number.isFinite(value)) return "--";
			return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
		}

		/** `YYYY-MM-DD` key of a Date, in the viewer's local calendar. */
		function dayKeyOf(date) {
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}

		/** Today's local `YYYY-MM-DD` key. */
		function todayKey() {
			return dayKeyOf(new Date());
		}

		/** Parse a `YYYY-MM-DD` key into a local Date. */
		function parseDay(key) {
			const [year, month, day] = key.split("-").map(Number);
			return new Date(year, month - 1, day);
		}

		/** Human day label for a key, e.g. `2026年10月25日` / `Oct 25, 2026`. */
		function dayLabel(key, translate) {
			const date = parseDay(key);
			const month = translate ? translate(`monthShort.${date.getMonth() + 1}`) : String(date.getMonth() + 1);
			return translate
				? translate("day.label", { year: date.getFullYear(), month, day: date.getDate() })
				: `${key}`;
		}

		/** Interpolate `{name}` placeholders; unknown placeholders stay verbatim. */
		function interpolate(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));
		}

		/** Stable index into the accent palette for one provider id. */
		function accentOf(name) {
			let hash = 0;
			for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 4096;
			return PROVIDER_ACCENTS[hash % PROVIDER_ACCENTS.length];
		}

		/**
		 * Accent for a distribution entry: models inherit their PROVIDER's hue, so
		 * `vendor-alpha/model-x` shares the colour of the `vendor-alpha` slice and the
		 * provider / model cards read as one story. Everything else keys on the
		 * entry's own id.
		 * @param sectionKey - "p" (providers), "m" (models), "w" (workspaces).
		 * @param id - the entry's display id (a model key looks like `p/m`).
		 * @returns the palette colour for the entry.
		 */
		function sectionAccentOf(sectionKey, id) {
			if (sectionKey === "m") {
				const provider = splitModelKey(id).provider;
				if (provider !== "") return accentOf(provider);
			}
			return accentOf(id);
		}

		/**
 * The model a provider mostly served on one day: the provider row's top model.
 * @param row - the day's provider row.
 * @param day - the day it belongs to.
 * @returns the bare model id, or an empty string.
 */
	function modelOfProvider(row, day) {
	const top = day.byModel.find((m) => splitModelKey(m.model).provider === row.provider);
	return top === undefined ? "" : splitModelKey(top.model).model;
}

/** Split `provider/model` into its two halves for display. */
		function splitModelKey(key) {
			const slash = key.indexOf("/");
			if (slash <= 0) return { provider: "", model: key };
			return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
		}

		/**
		 * Readable label for one model row: the provider prefix is kept
		 * (`qodercn/DeepSeek-Flash`) because the list mixes providers, and only
		 * the opaque half is replaced. A row with no readable name — any provider
		 * this build has no table for — keeps its raw key unchanged.
		 */
		function modelKeyLabelOf(key, name) {
			if (name === undefined) return key;
			const provider = splitModelKey(key).provider;
			return provider === "" ? name : `${provider}/${name}`;
		}

		/** Text for a distribution row: `labelOf` when the section renames its rows. */
		function labelOfRow(section, row) {
			return section.labelOf === undefined ? section.idOf(row) : section.labelOf(row);
		}

		/**
		 * Whether a row carries a figure worth a row of its own.
		 *
		 * A row can exist with zero tokens AND zero calls: a route whose requests
		 * all failed still records attempts, and the fold keeps that row so the
		 * failure is not silently dropped from the payload. The lists that only
		 * report tokens and calls skip it — a `0` line between real ones reads as a
		 * usage figure when it is really a failure — while anything that reports
		 * failures by count still sees it in the payload.
		 */
		function hasFigure(row) {
			return row.tokens > 0 || row.calls > 0;
		}
		//#endregion

		//#region vocabularies
		const zh = {
			"entry.label": "使用统计",
			"page.title": "使用统计",
			"page.subtitle": "全面了解 DeepSeek Harness 的 Token 消耗与调用情况",
			"page.updatedAt": "更新于 {time}",
			"tab.overview": "概览",
			"tab.dist": "分布",
			"dist.unattrHint": "早期历史，无法归因到具体工作区",
			"dist.showMoreProviders": "展开其余 {count} 个提供商",
			"dist.showMoreModels": "展开其余 {count} 个模型",
			"dist.showMoreWorkspaces": "展开其余 {count} 个工作区",
			"dist.showLess": "收起",
			"dist.providersTitle": "按提供商",
			"dist.modelsTitle": "按模型",
			"dist.workspacesTitle": "按工作区",
			"tab.provider": "按提供商",
			"tab.model": "按模型",
			"tab.workspace": "按工作区",
			"workspace.title": "工作区消耗排行",
			"workspace.empty": "所选时间段内没有可归属的会话记录。",
			"workspace.sessions": "{count} 个会话",
			"workspace.hint": "点击展开详情",
			"workspace.hitRate": "缓存命中",
			"workspace.toolCalls": "工具调用",
			"workspace.compactions": "上下文压缩",
			"workspace.llmTime": "模型耗时",
			"workspace.toolsTitle": "工具明细",
			"workspace.avg": "均",
			"workspace.max": "最长",
			"workspace.failed": "失败",
			"workspace.attempts": "尝试/成功率",
			"workspace.activeDays": "活跃天数",
			"workspace.peak": "峰值日",
			"workspace.providers": "提供商",
			"workspace.cacheRead": "缓存读",
			"workspace.reasoning": "推理",
			"window.label": "时间范围",
			"window.all": "全部",
			"window.3m": "近 3 月",
			"window.6m": "近 6 月",
			"window.1y": "近 1 年",
			"window.custom": "自定义",
			"window.from": "开始",
			"window.to": "结束",
			"window.apply": "应用",
			"window.cancel": "取消",
			"window.spanDays": "共 {days} 天",
			"window.tooLong": "最多可选 {days} 天，超出部分已自动截断",
			"metric.today": "今日消耗",
			"bubble.tokens": "Token用量",
			"bubble.calls": "调用次数",
			"bubble.dragHint": "拖动可移动位置",
			"metric.month": "本月消耗",
			"metric.window": "近 {days} 天消耗",
			"metric.calls": "调用次数",
			"metric.total": "累计消耗",
			"metric.vsYesterday": "较昨日",
			"metric.vsPrevious": "环比",
			"metric.callsInWindow": "窗口内已计费请求",
			"metric.failedOfAttempts": "失败 {failed} / 共 {attempts} 次尝试",
			"metric.todayCalls": "今日 {count} 次",
			"metric.successRate": "成功率 {rate}",
			"metric.failed": "失败 {count}",
			"metric.retries": "重试 {count}",
			"metric.allTime": "全部历史",
			"metric.sessions": "{count} 个会话",
			"metric.periodCalls": "{period} · {count} 次",
			"metric.periodToday": "今日",
			"metric.periodMonth": "本月",
			"metric.periodAll": "累计",
			"metric.attemptsShort": "{count} 次尝试",
			"detail.totalShort": "累计 {tokens}",
			"detail.inputShort": "输入 {tokens}",
			"detail.outputShort": "输出 {tokens}",
			"detail.cacheShort": "缓存读 {tokens}",
			"detail.modelCount": "{count} 个模型",
			"detail.callsShort": "调用 {count} 次",
			"unit.yi": "亿",
			"unit.wan": "万",
			"calendar.title": "每日消耗热力图",
			"calendar.hint": "点击任意日期查看当日明细",
			"calendar.less": "少",
			"calendar.more": "多",
			"calendar.legendNone": "无记录",
			"calendar.empty": "这段时间还没有任何调用记录。发起一次对话后，日历会自动填充。",
			"detail.close": "关闭",
			"detail.tokens": "Token 消耗",
			"detail.calls": "调用次数",
			"detail.tokensCalls": "{tokens} / {calls} 次",
			"detail.cacheHitShort": "缓存命中 {rate}",
			"detail.noDay": "这一天没有消耗记录",
			"detail.input": "输入",
			"detail.output": "输出",
			"detail.cacheRead": "缓存命中",
			"detail.cacheWrite": "缓存写入",
			"detail.cacheHitRate": "缓存命中率 {rate}",
			"detail.success": "成功 {count}",
			"detail.attemptSuccess": "尝试成功率 {rate}",
			"detail.failed": "失败 {count}",
			"detail.workspaces": "工作区分布",
			"detail.workspacesHint": "{count} 个 · 合计 {tokens}",
			"detail.workspacesNone": "这一天的用量来自历史归档，没有工作区记录",
			"detail.workspacesMore": "另有 {count} 个未列出",
			"dist.providerTitle": "提供商分布",
			"dist.modelTitle": "模型分布",
			"dist.windowTitle": "窗口内消耗",
			"dist.share": "占比",
			"dist.empty": "当前范围内没有分发数据。",
			"rank.title": "Token 消耗排名",
			"rank.empty": "当前范围内没有模型记录。",
			"rank.calls": "{count} 次",
			"trend.title": "消耗趋势",
			"trend.tokens": "Token 消耗",
			"trend.calls": "调用次数",
			"trend.empty": "当前范围内没有趋势数据。",
			"trend.axisTokens": "Token",
			"trend.axisCalls": "调用",
			"state.loading": "正在汇总用量…",
			"state.loadingPartial": "正在汇总更早的会话，用量会继续补充…",
			"state.errorTitle": "读取用量失败",
			"state.errorBody": "宿主或会话存储没有响应：{message}",
			"state.retry": "重试",
			"state.emptyTitle": "还没有用量数据",
			"state.emptyBody": "发起一次对话后，这里的指标、日历与趋势会自动出现。",
			"state.disabled": "已暂停自动刷新",
			"day.label": "{year}年{month}{day}日",
			"weekShort.1": "一",
			"week.1": "周一",
			"weekShort.2": "二",
			"weekShort.3": "三",
			"weekShort.4": "四",
			"weekShort.5": "五",
			"weekShort.6": "六",
			"weekShort.7": "日",
			"week.mon": "一",
			"week.tue": "二",
			"week.wed": "三",
			"week.thu": "四",
			"week.fri": "五",
			"week.sat": "六",
			"week.sun": "日",
			"month.1": "1 月",
			"month.2": "2 月",
			"month.3": "3 月",
			"month.4": "4 月",
			"month.5": "5 月",
			"month.6": "6 月",
			"month.7": "7 月",
			"month.8": "8 月",
			"month.9": "9 月",
			"month.10": "10 月",
			"month.11": "11 月",
			"month.12": "12 月",
			"monthShort.1": "1月",
			"monthShort.2": "2月",
			"monthShort.3": "3月",
			"monthShort.4": "4月",
			"monthShort.5": "5月",
			"monthShort.6": "6月",
			"monthShort.7": "7月",
			"monthShort.8": "8月",
			"monthShort.9": "9月",
			"monthShort.10": "10月",
			"monthShort.11": "11月",
			"monthShort.12": "12月",
			"aria.day": "{date}：{tokens} Token，{calls} 次调用",
			"aria.dayEmpty": "{date}：没有调用记录",
			"aria.providerBar": "{name} 占 {share}",
			"aria.modelBar": "{name} 占 {share}"
		};

		const en = {
			"entry.label": "Usage",
			"page.title": "Usage",
			"page.subtitle": "Token consumption and call volume across DeepSeek Harness",
			"page.updatedAt": "Updated {time}",
			"tab.overview": "Overview",
			"tab.dist": "Distribution",
			"dist.unattrHint": "Early history; no workspace could be attributed",
			"dist.showMoreProviders": "Show {count} more providers",
			"dist.showMoreModels": "Show {count} more models",
			"dist.showMoreWorkspaces": "Show {count} more workspaces",
			"dist.showLess": "Show less",
			"dist.providersTitle": "By provider",
			"dist.modelsTitle": "By model",
			"dist.workspacesTitle": "By workspace",
			"tab.provider": "By provider",
			"tab.model": "By model",
			"tab.workspace": "By workspace",
			"workspace.title": "Workspace consumption",
			"workspace.empty": "No attributable sessions in the selected range.",
			"workspace.sessions": "{count} sessions",
			"workspace.hint": "Click a row for detail",
			"workspace.hitRate": "Cache hit",
			"workspace.toolCalls": "Tool calls",
			"workspace.compactions": "Compactions",
			"workspace.llmTime": "Model time",
			"workspace.toolsTitle": "Tools",
			"workspace.avg": "avg",
			"workspace.max": "max",
			"workspace.failed": "failed",
			"workspace.attempts": "Attempts / success",
			"workspace.activeDays": "Active days",
			"workspace.peak": "Peak day",
			"workspace.providers": "Providers",
			"workspace.cacheRead": "Cache read",
			"workspace.reasoning": "Reasoning",
			"window.label": "Range",
			"window.all": "All",
			"window.3m": "3 months",
			"window.6m": "6 months",
			"window.1y": "1 year",
			"window.custom": "Custom",
			"window.from": "From",
			"window.to": "To",
			"window.apply": "Apply",
			"window.cancel": "Cancel",
			"window.spanDays": "{days} days",
			"window.tooLong": "At most {days} days; the extra is trimmed",
			"metric.today": "Today",
			"bubble.tokens": "Tokens",
			"bubble.calls": "Calls",
			"bubble.dragHint": "Drag to move",
			"metric.month": "This month",
			"metric.window": "Last {days} days",
			"metric.calls": "Calls",
			"metric.total": "All time",
			"metric.vsYesterday": "vs yesterday",
			"metric.vsPrevious": "vs previous window",
			"metric.callsInWindow": "billed requests in range",
			"metric.failedOfAttempts": "{failed} failed of {attempts} attempts",
			"metric.todayCalls": "{count} today",
			"metric.successRate": "{rate} success",
			"metric.failed": "{count} failed",
			"metric.retries": "{count} retried",
			"metric.allTime": "Entire history",
			"metric.sessions": "{count} sessions",
			"metric.periodCalls": "{period} · {count} calls",
			"metric.periodToday": "today",
			"metric.periodMonth": "this month",
			"metric.periodAll": "all time",
			"metric.attemptsShort": "{count} attempts",
			"detail.totalShort": "total {tokens}",
			"detail.inputShort": "in {tokens}",
			"detail.outputShort": "out {tokens}",
			"detail.cacheShort": "cache {tokens}",
			"detail.modelCount": "{count} models",
			"detail.callsShort": "{count} calls",
			"unit.yi": "00M",
			"unit.wan": "K",
			"calendar.title": "Daily usage heat calendar",
			"calendar.hint": "Select a day for its breakdown",
			"calendar.less": "Less",
			"calendar.more": "More",
			"calendar.legendNone": "No usage",
			"calendar.empty": "No calls recorded in this range yet. Start a conversation and the calendar fills itself.",
			"detail.close": "Close",
			"detail.tokens": "Tokens",
			"detail.calls": "Calls",
			"detail.tokensCalls": "{tokens} / {calls} calls",
			"detail.totalShort": "total {tokens}",
			"detail.inputShort": "in {tokens}",
			"detail.outputShort": "out {tokens}",
			"detail.cacheShort": "cache {tokens}",
			"detail.callsShort": "{count} calls",
			"detail.cacheHitShort": "{rate} cache hit",
			"detail.noDay": "No usage recorded on this day",
			"detail.input": "Input",
			"detail.output": "Output",
			"detail.cacheRead": "Cache read",
			"detail.cacheWrite": "Cache write",
			"detail.cacheHitRate": "{rate} cache hit",
			"detail.success": "{count} succeeded",
			"detail.attemptSuccess": "{rate} of attempts succeeded",
			"detail.failed": "{count} failed",
			"detail.workspaces": "By workspace",
			"detail.workspacesHint": "{count} · {tokens} total",
			"detail.workspacesNone": "This day comes from the archive, so no workspace is recorded",
			"detail.workspacesMore": "{count} more not listed",
			"dist.providerTitle": "Provider distribution",
			"dist.modelTitle": "Model distribution",
			"dist.windowTitle": "Usage in range",
			"dist.share": "Share",
			"dist.empty": "No distribution data in this range.",
			"rank.title": "Token ranking",
			"rank.empty": "No model records in this range.",
			"rank.calls": "{count} calls",
			"trend.title": "Usage trend",
			"trend.tokens": "Tokens",
			"trend.calls": "Calls",
			"trend.empty": "No trend data in this range.",
			"trend.axisTokens": "Tokens",
			"trend.axisCalls": "Calls",
			"state.loading": "Aggregating usage…",
			"state.loadingPartial": "Still reading older sessions; figures will grow…",
			"state.errorTitle": "Could not read usage",
			"state.errorBody": "The host or the session store did not answer: {message}",
			"state.retry": "Retry",
			"state.emptyTitle": "No usage yet",
			"state.emptyBody": "Once a conversation runs, the metrics, calendar, and trend appear here.",
			"state.disabled": "Auto-refresh paused",
			"day.label": "{month} {day}, {year}",
			"weekShort.1": "M",
			"weekShort.2": "T",
			"weekShort.3": "W",
			"weekShort.4": "T",
			"weekShort.5": "F",
			"weekShort.6": "S",
			"weekShort.7": "S",
			"week.mon": "M",
			"week.tue": "T",
			"week.wed": "W",
			"week.thu": "T",
			"week.fri": "F",
			"week.sat": "S",
			"week.sun": "S",
			"month.1": "January",
			"month.2": "February",
			"month.3": "March",
			"month.4": "April",
			"month.5": "May",
			"month.6": "June",
			"month.7": "July",
			"month.8": "August",
			"month.9": "September",
			"month.10": "October",
			"month.11": "November",
			"month.12": "December",
			"monthShort.1": "Jan",
			"monthShort.2": "Feb",
			"monthShort.3": "Mar",
			"monthShort.4": "Apr",
			"monthShort.5": "May",
			"monthShort.6": "Jun",
			"monthShort.7": "Jul",
			"monthShort.8": "Aug",
			"monthShort.9": "Sep",
			"monthShort.10": "Oct",
			"monthShort.11": "Nov",
			"monthShort.12": "Dec",
			"aria.day": "{date}: {tokens} tokens, {calls} calls",
			"aria.dayEmpty": "{date}: no calls recorded",
			"aria.providerBar": "{name} at {share}",
			"aria.modelBar": "{name} at {share}"
		};
		//#endregion

		//#region css
		const css = [
		 // Page shell: the center column is the app's primary surface, so the
		 // page paints the base background and owns its own scrolling.
			"[data-dsh-token-board-view]{box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;width:100%;min-width:0;height:100%;min-height:0;display:flex;container:udw-page/inline-size}",
			".udw_scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain}",
		 // The live figure appended to the panel row's title.
		 //
		 // It rides on ::after, not on a sibling element: the row is shell-owned, so
		 // the title node is the only place inside it this plugin can style. The
		 // figure therefore arrives through two custom properties as TEXT, which is
		 // also why it can be bold and blue while the title keeps the row's own
		 // colour and weight.
		 //
		 // `--udw-figure-on` gates the rule: an empty figure leaves the bare title.
		'[data-udw-title][style*="--udw-figure-on"]::after{content:var(--udw-figure);color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:600;margin-left:6px}',
		 // Only the row carrying a figure gets the extra room; a bare title must
		 // keep the shell's own ellipsis behaviour.
		'[data-udw-title][style*="--udw-figure-on"]{overflow:visible}',
			".udw_page{box-sizing:border-box;width:100%;max-width:1280px;margin:0 auto;padding:28px 32px 48px;flex-direction:column;gap:24px;display:flex}",
			".udw_header{align-items:flex-start;gap:12px 16px;flex-wrap:wrap;display:flex}",
			".udw_headerText{flex-direction:column;gap:4px;flex:1;min-width:220px;display:flex}",
			".udw_title{color:var(--dsw-alias-label-primary);letter-spacing:-.01em;margin:0;font-size:25px;font-weight:600;line-height:1.25}",
			".udw_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;line-height:1.5}",
			".udw_headerTools{align-items:center;gap:8px;flex-wrap:wrap;display:flex;position:relative}",
			".udw_stamp{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}",
		 // Segmented controls: one pill container, one raised active segment.
			".udw_segmented{box-sizing:border-box;align-items:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;gap:2px;padding:2px;display:inline-flex}",
			".udw_segment{appearance:none;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:8px;justify-content:center;align-items:center;gap:6px;padding:6px 12px;font-family:inherit;font-size:13px;line-height:1.4;display:inline-flex}",
			".udw_segment:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".udw_segment[data-active=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px #00000014}",
			".udw_segment:disabled{cursor:default;opacity:.45}",
			".udw_segment:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".udw_iconButton{appearance:none;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;justify-content:center;align-items:center;width:30px;height:30px;padding:0;display:inline-flex}",
			".udw_iconButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".udw_iconButton:disabled{cursor:default;opacity:.45}",
			".udw_iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".udw_spin{animation:udw-spin .9s linear infinite}",
			"@keyframes udw-spin{to{transform:rotate(360deg)}}",
		 // Metric cards: a 4-up grid that folds to 2-up then 1-up.
			".udw_metrics{grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;display:grid}",
			".udw_metric{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:8px;min-width:0;padding:16px 18px;display:flex;container-type:inline-size}",
			".udw_metricHead{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;display:flex}",
			".udw_metricHead svg{color:var(--dsw-alias-label-tertiary);flex:none}",
			// The value is fitted to the CARD's content box, measured in REAL glyph
			// widths rather than "one em per character": a tabular digit is ~0.6em and
			// a thousands separator ~0.3em, so a 14-character total costs ~7.5em, not
			// 14em. Sizing against 14em is what pinned the token totals at 11.5px while
			// the card had room for roughly twice that.
			//
			// Two steps, not five: the token figures are this band's subject and take
			// the fitted size (up to 34px); the call count is a supporting number and
			// is capped lower on purpose, so the eye lands on consumption first.
			".udw_metricValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;letter-spacing:-.02em;align-items:baseline;gap:4px;font-size:min(34px,calc((100cqw - 40px)/var(--udw-token-em,7.5)));font-weight:600;line-height:1.1;display:flex}",
			// The call count is a supporting figure, so it is capped at 0.72 of the
			// token step rather than at a fixed pixel size: a fixed cap made it 22px
			// while the widest token total was 20.7px, i.e. the SMALLER number
			// rendered LARGER. Tying it to the token size keeps consumption dominant
			// at every breakpoint.
			".udw_metricFoot{color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;min-height:18px;font-size:12px;flex-wrap:wrap;display:flex}",
		 // Five cards need a five-way breakpoint ladder: 1250px holds them in one
		 // row, then 3+2, then 2, then 1. The old four-card ladder is gone so the
		 // row never squeezes five columns into a width meant for four.
			"@container udw-page (width<=1250px){.udw_metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}",
			"@container udw-page (width<=880px){.udw_metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}",
			"@container udw-page (width<=560px){.udw_metrics{grid-template-columns:minmax(0,1fr)}}",
		 // Split layout: the calendar takes the wide column, the detail panel
		 // the narrow one, matching how the detail answers a calendar click.
			".udw_card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;min-width:0;display:flex;overflow:hidden}",
			".udw_cardHead{align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px 0;display:flex}",
			".udw_cardTitle{color:var(--dsw-alias-label-primary);align-items:center;gap:7px;flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;display:flex}",
			".udw_cardTitle svg{color:var(--dsw-alias-label-tertiary);flex:none}",
			".udw_cardBody{flex-direction:column;gap:14px;padding:14px 16px 16px;display:flex}",
		 // Calendar: three months side by side, each its own Monday-first grid.
			".udw_calWeekday{color:var(--dsw-alias-label-tertiary);text-align:center;font-size:10.5px;line-height:1}",
			".udw_calHeadRow{margin-bottom:2px}",
			".udw_calColumns{grid-template-columns:repeat(var(--udw-cal-cols,3),minmax(0,1fr));gap:18px 14px;min-width:0;display:grid}",
			".udw_calColumn{flex-direction:column;gap:6px;min-width:0;align-self:start;display:flex}",
			".udw_calRows{flex-direction:column;gap:6px;display:flex}",
			".udw_calRow{grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;display:grid}",
			".udw_calSpacer{aspect-ratio:1/1;min-width:0}",
			".udw_cell[data-outside-month=true]{opacity:.42}",
			".udw_monthTitle{color:var(--dsw-alias-label-secondary);margin:0 0 0;font-size:12px;font-weight:600;letter-spacing:.02em;height:16px;line-height:16px}",

			".udw_cell{appearance:none;aspect-ratio:1/1;box-sizing:border-box;min-width:0;width:100%;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:var(--dsw-alias-bg-layer-3);border:1px solid #0000;border-radius:8px;justify-content:center;align-items:center;font-family:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;padding:0;display:flex;transition:transform .12s,box-shadow .12s}",
			".udw_cell:hover:not(:disabled){box-shadow:0 0 0 1.5px var(--dsw-alias-label-secondary);transform:translateY(-1px)}",
			".udw_cell:disabled{cursor:default;background:0 0;color:var(--dsw-alias-label-dimmed)}",
			".udw_cell[data-selected=true]{box-shadow:0 0 0 2px var(--dsw-alias-label-primary)}",
			".udw_cell[data-today=true]{border-color:var(--dsw-alias-brand-primary)}",
			".udw_cell[data-selected=true][data-today=true]{box-shadow:0 0 0 2px var(--dsw-alias-label-primary)}",
			".udw_cell:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".udw_legend{align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);align-self:flex-end;font-size:11px;display:flex}",
			".udw_legendSwatch{border-radius:3px;flex:none;width:11px;height:11px}",
		 // Day detail: the panel is the calendar's answer, so its numbers lead.
			".udw_detailEmpty{color:var(--dsw-alias-label-tertiary);flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;min-height:220px;padding:20px;font-size:12px;line-height:1.7;display:flex}",
			".udw_detailDate{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".udw_detailValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;align-items:baseline;gap:4px;font-size:25px;font-weight:600;line-height:1.2;display:flex}",
			".udw_detailUnit{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500}",
			".udw_statRow{box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l1);justify-content:space-between;align-items:baseline;gap:8px;padding-top:10px;font-size:12px;display:flex}",
			".udw_statLabel{color:var(--dsw-alias-label-tertiary)}",
			".udw_statValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600}",
			".udw_statValueBad{color:var(--dsw-alias-state-error-primary)}",
			".udw_miniList{flex-direction:column;gap:9px;display:flex}",
			".udw_miniLabel{color:var(--dsw-alias-label-tertiary);margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:.02em}",
			".udw_miniName{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:12px;overflow:hidden}",
			".udw_miniValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:12px;font-weight:600}",
			".udw_miniTrack{grid-column:1/-1;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;overflow:hidden}",
			".udw_miniFill{border-radius:999px;height:100%}",
		 // Distribution: a donut plus a ranked legend, then a bar ranking.
			".udw_distGrid{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;align-items:center;display:grid}",
			".udw_donutWrap{justify-content:center;align-items:center;display:flex}",
			".udw_donut{width:100%;max-width:190px;aspect-ratio:1/1}",
			".udw_donutTotal{fill:var(--dsw-alias-label-primary);font-size:15px;font-weight:600}",
			".udw_donutCaption{fill:var(--dsw-alias-label-tertiary);font-size:8px}",
			".udw_rows{flex-direction:column;gap:10px;display:flex}",
		 // Workspace rows: denser than the generic bar row, because a workspace has
		 // more worth showing than a name and a number.
		 //
		 // The clickable line is a full-width button so the whole row is the target
		 // and the keyboard reaches it; the figures sit inline after the name so one
		 // scan compares several workspaces without opening any of them.
		// The distribution columns render at FULL content height and let the page
		// scroll. An inner scroller here hijacked the wheel over the card (its
		// `overscroll-behavior:contain` also dead-stopped the page at the list's
		// edge), and `min-height:420px` reserved blank scroll space under short
		// lists — both gone with the inner scroll.
		// The ranking list under a distribution card: it may GROW past the card's
		// max-height, so it becomes the card's scroll region — the page never
		// scrolls inside the card, and the expanded workspace detail scrolls with
		// its list instead of stretching the card.
		".udw_wsList{flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;display:flex}",
		".udw_wsRow{border-radius:8px;min-height:38px;flex-shrink:0;position:relative;transition:background .12s}",
		// Inside the distribution cards the list is the scroll region and the rows
		// should DISTRIBUTE over its height instead of piling at the top and
		// leaving a void above the reveal button.
		".udw_distSection .udw_wsList{justify-content:flex-start}",
		".udw_distSection .udw_wsRow{flex:0 0 auto}",
		// The whole article is the pointer target: the stats cluster carries
		// `pointer-events:none`, so a click anywhere on the row — name, numbers,
		// whitespace right of them, the share bar — toggles the detail, not just
		// the name span inside the inner button.
		".udw_wsRow[data-expandable=true]{cursor:pointer}",
		".udw_wsRow[data-expandable=true]:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		".udw_wsRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		".udw_wsRow[data-open=true]{background:var(--dsw-alias-interactive-bg-hover)}",
		".udw_wsMain{box-sizing:border-box;appearance:none;cursor:inherit;text-align:left;color:inherit;background:0 0;border:0;align-items:center;gap:8px;width:100%;padding:3px 8px;font-family:inherit;font-size:12.5px;line-height:1.4;display:flex}",
		".udw_wsMain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
		".udw_wsStats{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;align-items:baseline;gap:10px;flex:none;display:flex;pointer-events:none}",
		".udw_wsDot{border-radius:999px;flex:none;width:7px;height:7px}",
		".udw_wsName{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-weight:600;overflow:hidden}",
		".udw_wsStats{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;align-items:baseline;gap:10px;flex:none;display:flex;pointer-events:none}",
		".udw_wsStat{color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:400}",
		".udw_wsUnattr .udw_wsStat{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
		// The unattributed row is not clickable, so its stats keep hover: the hint
		// on the stat span is a native title tooltip, and `pointer-events:none`
		// would silence it.
		".udw_wsUnattr .udw_wsStats{pointer-events:auto}",
		".udw_wsTrack{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:3px;overflow:hidden;position:absolute;left:8px;right:8px;bottom:2px}",
		".udw_wsFill{border-radius:999px;height:100%}",
		 // Workspace two-column: donut+legend on the left, list on the right.
		 // 分布 tab: provider / model / workspace side by side, one screen.
		 // All three cards share ONE height: `align-items:stretch` (the grid
		 // default) plus a max-height with internal scroll on each list. An
		 // expanded workspace detail scrolls INSIDE its own card instead of
		 // growing it, so the row of cards never changes height on click. The
		 // unattributed footnote joins the SCROLL REGION of the workspace card:
		 // keeping it as a fixed foot reserved ~90px of card height the other
		 // two cards can never use, which showed up as dead space on them.
		".udw_dist{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:stretch;display:grid}",
		"@container udw-page (width<=1100px){.udw_dist{grid-template-columns:repeat(2,minmax(0,1fr))}}",
		"@container udw-page (width<=760px){.udw_dist{grid-template-columns:minmax(0,1fr)}}",
		"@container udw-page (width<=1500px){.udw_distChart{grid-template-columns:minmax(0,1fr);justify-items:center}}",
		".udw_distSection{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:4px;padding:10px 12px;min-width:0;height:620px;overflow:hidden;display:flex}",
		// The reveal control under the ranking: OUTSIDE the scroll region, so it
		// stays visible while the list above scrolls. 5 rows per click.
		".udw_distMore{appearance:none;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:8px;flex:none;align-self:stretch;justify-content:flex-start;gap:4px;margin:4px 0 0;padding:4px 8px 0;font-family:inherit;font-size:11.5px;display:inline-flex}",
		".udw_distMore:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		".udw_distMore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
		".udw_distHead{color:var(--dsw-alias-label-primary);align-items:center;gap:6px;margin:0 0 2px;font-size:12.5px;font-weight:600;display:flex}",
		".udw_distHead svg{color:var(--dsw-alias-label-tertiary);flex:none}",
		".udw_distChart{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:2px 12px;flex:none;display:grid}",
		".udw_distChart .udw_donut{width:128px;max-width:128px}",
		".udw_wsLegend{flex-direction:column;gap:1px;width:100%;margin-top:4px;display:flex}",
		".udw_wsLegendRow{align-items:center;gap:6px;width:100%;padding:1px 4px;font-size:11.5px;display:flex}",
		".udw_wsLegendDot{border-radius:999px;flex:none;width:6px;height:6px}",
		".udw_wsLegendName{color:var(--dsw-alias-label-secondary);flex:1;text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
		".udw_wsLegendPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}",
				 // The unattributed remainder: a quiet single-line footnote, not a
		 // full-height row — smaller ink, no min-height, tight padding, and no
		 // forced top margin, so it never allocates visible blank space.
		".udw_wsUnattr{border-top:1px solid var(--dsw-alias-border-l2);margin:4px 0 0;padding:2px 8px 4px;opacity:.6;flex-shrink:0;align-items:center;gap:8px;display:flex;min-height:0}",
		".udw_wsUnattr .udw_wsMain{padding:0;font-size:11px}",
		".udw_wsUnattr .udw_wsDot{width:5px;height:5px}",
		".udw_wsUnattr .udw_wsName{font-weight:400}",
		".udw_wsTokens{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600;margin-left:auto;flex:none}",
".udw_wsSplit{grid-template-columns:minmax(190px,230px) minmax(0,1fr);gap:4px 24px;align-items:start;display:grid}",
		".udw_wsChart{flex-direction:column;align-items:center;gap:2px;display:flex}",
		".udw_wsLegend{flex-direction:column;gap:1px;width:100%;margin-top:4px;display:flex}",
		".udw_wsLegendRow{align-items:center;gap:6px;width:100%;padding:1px 4px;font-size:11.5px;display:flex}",
		".udw_wsLegendDot{border-radius:999px;flex:none;width:6px;height:6px}",
		".udw_wsLegendName{color:var(--dsw-alias-label-secondary);flex:1;text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
		".udw_wsLegendPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}",
		 // Donut hover: the slice itself is focusable; the thickening is the affordance.
		".udw_donutSlice{cursor:pointer;transition:stroke-width .12s;outline:none}",
		".udw_donutSlice:focus-visible{stroke-width:18}",
		"@container udw-page (width<=900px){.udw_wsSplit{grid-template-columns:minmax(0,1fr)}}",
		 // Tool detail table.
		".udw_wsTools{flex-direction:column;gap:1px;margin-top:6px;display:flex}",
		".udw_wsToolsHead{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600}",
		".udw_wsToolRows{flex-direction:column;gap:0;display:flex}",
		".udw_wsToolRow{grid-template-columns:minmax(0,1fr) auto auto auto auto;align-items:baseline;gap:10px;padding:1px 0;font-size:11px;display:grid}",
		".udw_wsToolName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);font-weight:500;overflow:hidden}",
		".udw_wsToolNum{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}",
		".udw_wsToolFail{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}",
		".udw_wsDetail{border-top:1px solid var(--dsw-alias-border-l2);margin:6px 8px 8px;padding:8px 0 2px}",
		".udw_wsPath{color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-bottom:8px;font-size:11px;line-height:1.5}",
		".udw_wsFacts{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 16px;margin:0;display:grid}",
		".udw_wsFact{align-items:baseline;gap:6px;min-width:0;display:flex}",
		".udw_wsFact dt{color:var(--dsw-alias-label-secondary);flex:none;font-size:11.5px}",
		".udw_wsFact dd{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap;min-width:0;margin:0;font-size:11.5px;font-weight:600;overflow:hidden}",
		".udw_cardHint{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-size:11.5px}",
			".udw_row{grid-template-columns:minmax(0,1fr) auto auto;gap:6px 10px;align-items:center;display:grid}",
			".udw_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;font-size:13px;display:flex;overflow:hidden}",
			".udw_dot{border-radius:50%;flex:none;width:8px;height:8px}",
			".udw_rowShare{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:44px;text-align:right;font-size:12px}",
			".udw_rowValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;min-width:72px;text-align:right;font-size:12px;font-weight:600}",
			".udw_rowTrack{grid-column:1/-1;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:6px;overflow:hidden}",
			".udw_rowFill{border-radius:999px;height:100%;transition:width .2s ease-out}",
			".udw_rank{flex-direction:column;gap:12px;display:flex}",
			".udw_rankRow{grid-template-columns:22px minmax(0,1fr) auto;gap:10px;align-items:baseline;display:grid}",
			".udw_rankIndex{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}",
			".udw_rankName{color:var(--dsw-alias-label-primary);flex-direction:column;gap:1px;min-width:0;font-size:13px;display:flex}",
			".udw_rankModel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".udw_rankMeta{color:var(--dsw-alias-label-tertiary);font-size:11px}",
			".udw_rankValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex-direction:column;align-items:flex-end;gap:1px;text-align:right;font-size:13px;font-weight:600;display:flex}",
			".udw_rankShare{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}",
			".udw_rankTrack{grid-column:2/-1;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:5px;overflow:hidden}",
			".udw_rankFill{border-radius:999px;height:100%}",
		 // Custom-range picker: a small popover under the trigger, never a modal, because the user still needs to see the calendar it will reshape.
		".udw_rangeButton{font-variant-numeric:tabular-nums}",
		".udw_pickerPop{z-index:30;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:10px;box-shadow:0 12px 32px #0b1f3026;flex-direction:column;gap:10px;width:260px;padding:12px;display:flex;position:absolute;top:calc(100% + 6px);right:0}",
		".udw_pickerField{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;font-size:12px;display:flex}",
		".udw_dateInput{box-sizing:border-box;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 8px;font-family:inherit;font-size:13px}",
		".udw_dateInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
		".udw_pickerHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}",
		".udw_pickerWarn{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:12px;line-height:1.5}",
		".udw_pickerActions{justify-content:flex-end;gap:8px;display:flex}",
		".udw_pickerCancel,.udw_pickerApply{appearance:none;cursor:pointer;border-radius:8px;padding:5px 12px;font-family:inherit;font-size:12px}",
		".udw_pickerCancel{color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2)}",
		".udw_pickerCancel:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		".udw_pickerApply{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:1px solid #0000}",
		".udw_pickerApply:hover{background:var(--dsw-alias-button-primary-hover)}",
		".udw_pickerCancel:focus-visible,.udw_pickerApply:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
		 // Day dialog: a modal over the page. The backdrop dims the shell without
		 // hiding it, and the panel scrolls on its own for a long model list.
			// The dialog needs a scrim of its own: the skin's mask token is faint in
			// several themes, and a modal whose backdrop barely dims reads as a
			// floating panel rather than as a dialog.
			".udw_dialogBackdrop{z-index:1400;background:color-mix(in srgb, var(--dsw-alias-label-primary, #13283b) 26%, transparent);backdrop-filter:blur(2px);justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0;animation:udw-fade-in .14s ease-out}",
			"@keyframes udw-fade-in{from{opacity:0}to{opacity:1}}",
			// A modal must not show the page through it: --dsw-alias-bg-base is
			// translucent in several skins (future-window paints it at ~22%), so the
			// panel stacks an opaque layer-1 surface under the skin's overlay colour
			// and keeps the shell's blur, so it still reads as part of the shell.
			".udw_dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));backdrop-filter:blur(20px) saturate(140%);border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));width:min(760px,100%);max-height:calc(100vh - 64px);box-shadow:0 20px 56px #0b1f3033;color:var(--dsw-alias-label-primary);border-radius:14px;flex-direction:column;isolation:isolate;display:flex;overflow:hidden;animation:udw-pop-in .16s cubic-bezier(.2,.8,.2,1)}",
			"@keyframes udw-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}",
			".udw_dialogHead{background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px 12px;display:flex}",
			".udw_dialogTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:17px;font-weight:600}",
			".udw_dialogClose{appearance:none;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:8px;flex:none;justify-content:center;align-items:center;width:30px;height:30px;padding:0;display:inline-flex}",
			".udw_dialogClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".udw_dialogClose:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".udw_dialogBody{background:var(--dsw-alias-bg-layer-2);flex-direction:column;gap:16px;min-height:0;padding:16px 18px 18px;display:flex;overflow-y:auto}",
			".udw_dialogSummary{color:var(--dsw-alias-label-primary);flex-wrap:wrap;align-items:baseline;gap:4px 6px;margin:0;font-size:14px;line-height:1.6;display:flex}",
			".udw_dialogLead{flex-direction:column;gap:4px;display:flex}",
		 // The rates under the totals: same column, one step down in size and grey,
		 // so they qualify the figures above instead of competing with them.
			".udw_dialogQuality{color:var(--dsw-alias-label-secondary);flex-wrap:wrap;gap:4px 8px;margin:0;font-size:12px;line-height:1.5;display:flex;font-variant-numeric:tabular-nums}",
		 // The day's workspace breakdown. A list with a rule above it, not another
		 // card: the provider cards above are the dialog's subject.
			".udw_dayWs{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:14px;display:flex}",
			".udw_dayWsHead{align-items:baseline;justify-content:space-between;gap:8px;display:flex}",
			".udw_dayWsTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600}",
			".udw_dayWsHint{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}",
			".udw_dayWsList{flex-direction:column;gap:10px;display:flex}",
			".udw_dayWsNote{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".udw_providerList{flex-direction:column;gap:10px;display:flex}",
			".udw_providerCard{box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}",
			".udw_providerTop{align-items:baseline;gap:8px;display:flex}",
			".udw_providerName{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:700;align-items:center;gap:6px;flex:1;display:flex;white-space:nowrap;overflow:hidden}",
			".udw_providerTokens{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none;font-size:13px;font-weight:600}",
		 // The hit rate and the total share one right-hand cluster so the total
		 // stays flush right and the rate reads as a qualifier of it, not as a
		 // third column competing with the provider name.
			".udw_providerRight{align-items:baseline;gap:8px;flex:none;display:flex}",
			".udw_providerHit{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px;font-weight:400}",
			".udw_providerTrack{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:6px;overflow:hidden}",
			".udw_providerFill{border-radius:999px;height:100%}",
		 // Grouped day detail: the provider header keeps its original shape — name
		 // left, figures right, a FULL-width track of its own below — and the model
		 // rows keep their indented thread line. The model rows share ONE grid
		 // (.udw_modelList): name | track | figures, so every model bar starts and
		 // ends at the same x and the figure clusters end flush with the provider
		 // track's right edge. A per-row grid could not do this: each row's figure
		 // columns resize with their own content, which is how the bars drifted.
		".udw_providerModelCount{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;flex:none;margin-left:6px;padding:1px 7px;font-size:10.5px;font-weight:400}",
		// The model row puts the NAME FIRST and lets it take what it needs:
		// name `max-content` (capped at half the row so one long name cannot
		// squeeze the detail) | elastic gap | detail `max-content`. The detail
		// run — bar `140px` + figures at fixed 64/46/44px — always ends flush
		// with the card's right edge, and the middle gap absorbs whatever is
		// left. A short name leaves a wide gap; a long name renders IN FULL and
		// only ellipsizes past half the row (hover shows the whole text).
		".udw_modelList{display:grid;grid-template-columns:minmax(0,max-content) minmax(12px,1fr) max-content;align-items:center;gap:7px 10px;margin:4px 0 6px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px}",
		".udw_modelName{text-overflow:ellipsis;white-space:nowrap;max-width:100%;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden}",
		".udw_modelDetail{align-items:center;gap:10px;min-width:0;display:flex}",
		".udw_modelBar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:6px;overflow:hidden;display:block;flex:none;width:140px}",
		".udw_modelFill{border-radius:999px;height:100%;display:block;box-shadow:0 0 0 .5px #00000012}",
		// The model row is detail under the group header: its figures stay at or
		// below the header's 13px, so the group total keeps the lead.
		".udw_modelTokens{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:left;font-weight:600;font-size:12px;min-width:64px}",
		".udw_modelHit{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:left;font-weight:500;font-size:11px;min-width:46px}",
		".udw_modelCalls{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:left;font-size:11px;min-width:44px}",
			".udw_providerMeta{color:var(--dsw-alias-label-secondary);flex-wrap:wrap;gap:2px 6px;margin:0;font-size:12px;line-height:1.5;display:flex}",
			".udw_barRow{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center;display:grid}",
			".udw_barLabel{min-width:0;align-items:center;gap:7px;display:flex}",
			".udw_barName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}",
			".udw_barValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12.5px;font-weight:600}",
			".udw_barSub{color:var(--dsw-alias-label-tertiary);font-weight:400}",
			".udw_barTrack{grid-column:1/-1;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:5px;overflow:hidden}",
			".udw_barFill{border-radius:999px;height:100%}",
			".udw_cardHint{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px}",
			"@container udw-page (width<=560px){.udw_dialogBackdrop{padding:0;align-items:stretch}.udw_dialog{width:100%;max-height:none;height:100%;border-radius:0;border:0}}",
			"@media (prefers-reduced-motion:reduce){.udw_dialogBackdrop,.udw_dialog{animation:none}}",
		 // Trend: a hand-drawn SVG chart, tokens on the left axis, calls on the right.
			".udw_trendWrap{position:relative;width:100%}",
			".udw_trendSvg{display:block;width:100%;height:230px;overflow:visible}",
			".udw_trendGrid{stroke:var(--dsw-alias-border-l1);stroke-width:1}",
			".udw_trendAxis{fill:var(--dsw-alias-label-tertiary);font-size:10px}",
			".udw_trendAreaTokens{fill:url(#udw-tokens-grad)}",
			".udw_trendLineTokens{fill:none;stroke:var(--dsw-static-blue-500,#3b82f6);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}",
			".udw_trendLineCalls{fill:none;stroke:#8b5cf6;stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;opacity:.95}",
			".udw_trendDotTokens{fill:var(--dsw-static-blue-500,#3b82f6)}",
			".udw_trendDotCalls{fill:#8b5cf6}",
			".udw_trendHit{fill:transparent;cursor:pointer}",
			".udw_trendHit:focus-visible{outline:none}",
			".udw_trendCursor{stroke:var(--dsw-alias-label-tertiary);stroke-width:1;stroke-dasharray:3 3}",
			".udw_tooltip{box-sizing:border-box;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 6px 20px #0000001f;color:var(--dsw-alias-label-primary);z-index:5;pointer-events:none;flex-direction:column;gap:4px;padding:8px 10px;font-size:11.5px;line-height:1.5;display:flex;position:absolute}",
			".udw_tooltipTitle{color:var(--dsw-alias-label-secondary);font-size:11px}",
			".udw_tooltipRow{align-items:center;gap:6px;font-variant-numeric:tabular-nums;display:flex}",
			".udw_tooltipDot{border-radius:50%;flex:none;width:6px;height:6px}",
			".udw_trendLegend{align-items:center;gap:14px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex}",
			".udw_trendLegendItem{align-items:center;gap:6px;display:inline-flex}",
			".udw_trendLegendLine{border-radius:999px;flex:none;width:14px;height:2px}",
		 // State surfaces: loading skeleton, error, empty.
			".udw_skeleton{background:var(--dsw-alias-bg-skeleton);border-radius:8px;animation:udw-pulse 1.4s ease-in-out infinite}",
			"@keyframes udw-pulse{0%,100%{opacity:.55}50%{opacity:.85}}",
			".udw_state{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;align-items:center;justify-content:center;flex-direction:column;gap:10px;text-align:center;padding:40px 24px;display:flex}",
			".udw_stateTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600}",
			".udw_stateBody{color:var(--dsw-alias-label-secondary);max-width:420px;margin:0;font-size:13px;line-height:1.6}",
			".udw_stateIcon{color:var(--dsw-alias-label-tertiary)}",
			".udw_retry{appearance:none;cursor:pointer;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:0;border-radius:8px;align-items:center;gap:6px;margin-top:4px;padding:7px 16px;font-family:inherit;font-size:13px;font-weight:600;display:inline-flex}",
			".udw_retry:hover{background:var(--dsw-alias-button-primary-hover)}",
			".udw_retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".udw_banner{box-sizing:border-box;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);align-items:center;gap:8px;padding:7px 12px;font-size:12px;display:flex}",
			".udw_bannerWarn{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".udw_srOnly{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}",
		 // Responsive: the calendar's three columns collapse first, then the
		 // split layout, then the metric grid.
			"@container udw-page (width<=1080px){.udw_page{padding:24px 24px 40px}udw_distGrid{grid-template-columns:minmax(0,1fr)}}",
			"@container udw-page (width<=1080px){.udw_calColumns{grid-template-columns:repeat(min(var(--udw-cal-cols,3),4),minmax(0,1fr))}.udw_donutWrap{padding:8px 0}}",
			"@container udw-page (width<=560px){.udw_page{padding:18px 14px 32px}.udw_headerTools{width:100%;gap:6px}.udw_segmented{max-width:100%}.udw_title{font-size:20px}.udw_trendSvg{height:190px}.udw_calRow{gap:4px}.udw_calRows{gap:4px}.udw_calColumns{gap:14px}.udw_cell{font-size:10.5px;border-radius:6px}.udw_cardBody{padding:12px 12px 14px}.udw_cardHead{padding:12px 12px 0}.udw_page{gap:16px}udw_legend{width:100%;justify-content:flex-end}.udw_trendLegend{width:100%;justify-content:flex-start}}",
			"@container udw-page (width<=380px){.udw_calRow{gap:3px}.udw_calRows{gap:3px}.udw_cell{border-radius:5px}.udw_segment{padding:5px 9px;font-size:12px}.udw_page{padding:14px 10px 28px}}",
			"@media (prefers-reduced-motion:reduce){.udw_cell,.udw_rowFill{transition:none}.udw_spin,.udw_skeleton{animation:none}}"
		];

		const styleTagId = "dsh-token-board/client";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(styleTagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-board";
			tag.dataset.pluginCss = styleTagId;
			tag.textContent = css.join("");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region data access
		/** The viewer's timezone offset in seconds, for host-side day bucketing. */
		function tzOffsetSeconds() {
			return -new Date().getTimezoneOffset() * 60;
		}

		/**
		 * The viewer's IANA zone name (`Asia/Shanghai`, `America/New_York`).
		 *
		 * The numeric offset above is only a sample of "now": a viewer in a zone
		 * that observes DST would have every hour on the other side of the switch
		 * bucketed with today's offset, landing on the wrong calendar day. The
		 * zone name lets the host resolve each hour against that zone's own rules.
		 *
		 * Returns undefined when the browser cannot name its zone, which keeps the
		 * older offset-only behaviour rather than failing the request.
		 * @returns {string|undefined} IANA name.
		 */
		function tzName() {
			try {
				const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				return typeof zone === "string" && zone !== "" ? zone : undefined;
			} catch {
				return undefined;
			}
		}

		/**
 * Whether two payloads carry the same numbers.
 *
 * A refresh that returns identical figures must keep the PREVIOUS object
 * identity: replacing it re-renders the page for no reason and drops clicks
 * that land between render and repaint.
 * @param a - previous payload, or null.
 * @param b - incoming payload.
 * @returns true when nothing a viewer could see has changed.
 */
function samePayload(a, b) {
	if (a === null || a === undefined || b === null || b === undefined) return false;
	if (a.updatedAt !== b.updatedAt) return false;
	if (a.sessions !== b.sessions) return false;
	if (a.partial !== b.partial) return false;
	if ((a.window === undefined ? null : a.window.to) !== (b.window === undefined ? null : b.window.to)) return false;
	if (dayTotals(a.allTime) !== dayTotals(b.allTime)) return false;
	// The day rows are what the calendar, the tooltip and the day dialog print,
	// so a change in ANY of them has to count. Comparing only their COUNT let a
	// corrected per-day figure keep the previous object identity, which is how a
	// fixed backend kept showing the old number until the page was reloaded.
	const left = a.days === undefined ? [] : a.days;
	const right = b.days === undefined ? [] : b.days;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const one = left[index];
		const other = right[index];
		if (one.date !== other.date || one.tokens !== other.tokens || one.calls !== other.calls) return false;
	}
	return true;
}

/** The cumulative token and call totals, or null when absent. */
	function dayTotals(allTime) {
		if (allTime === undefined || allTime === null) return null;
		return `${allTime.totals.tokens}:${allTime.totals.calls}`;
	}

/** Fetch one JSON endpoint with the timezone header the host buckets by. */
		async function fetchJson(path, signal) {
			// Both headers go out: the zone name is authoritative when the host can
			// use it (DST-correct history), the offset is the fallback for browsers
			// that report no zone and for older hosts that only read the offset.
			const headers = {
				accept: "application/json",
				"x-dsh-usage-dashboard-tz-offset": String(tzOffsetSeconds())
			};
			const zone = tzName();
			if (zone !== undefined) headers["x-dsh-usage-dashboard-tz-name"] = zone;
			const response = await fetch(path, { headers, signal });
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(detail === "" ? `HTTP ${response.status}` : `${response.status}: ${detail.slice(0, 200)}`);
			}
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) throw new Error("unexpected response");
			return payload;
		}

		/**
		 * Read the summary once.
		 *
		 * A preset sends its trailing day count; an explicit range sends `from`/`to`
		 * so the host windows by the exact dates the picker shows.
		 * @param range - `{ days, from?, to? }`.
		 * @param options - `{ signal, refresh }`.
		 */
		function loadSummary(range, options = {}) {
			const params = new URLSearchParams();
			if (range.from !== undefined && range.to !== undefined) {
				params.set("from", range.from);
				params.set("to", range.to);
			} else {
				params.set("days", String(range.days));
			}
			if (options.refresh === true) params.set("refresh", "1");
			return fetchJson(`${SUMMARY_PATH}?${params.toString()}`, options.signal);
		}

		/** Read one day's detail (used when the day falls outside the cached window). */
		function loadDay(date, options = {}) {
			return fetchJson(`${DAY_PATH}?date=${encodeURIComponent(date)}`, options.signal);
		}
		//#endregion

		//#region geometry helpers
		/**
		 * Build one Monday-first month as rows of exactly seven weekday slots.
		 *
		 * Unlike a plain month grid, the lead slots are FILLED with the trailing
		 * days of the previous month: the first week of the month is the week the
		 * viewer actually lived through. That is what lets consecutive months
		 * stack on one continuous axis — every column stays a real weekday and no
		 * month restarts its grid at the 1st.
		 * @param year - calendar year.
		 * @param monthIndex - zero-based month.
		 * @returns `{ key, label, rows }` where each row is seven
		 *   `{ key, dayNumber, inMonth } | null` slots.
		 */
		function monthGrid(year, monthIndex, translate) {
			const first = new Date(year, monthIndex, 1);
			const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
			// Monday-first lead count: how many blank slots precede the 1st.
			const lead = (first.getDay() + 6) % 7;
			const cells = [];
			// Blank slots, NOT the previous month's days: each month block shows
			// only its own dates.
			for (let index = 0; index < lead; index += 1) cells.push(null);
			for (let day = 1; day <= daysInMonth; day += 1) {
				const date = new Date(year, monthIndex, day);
				cells.push({ key: dayKeyOf(date), dayNumber: day });
			}
			while (cells.length % 7 !== 0) cells.push(null);
			const rows = [];
			for (let index = 0; index < cells.length; index += 7) rows.push(cells.slice(index, index + 7));
			return {
				key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
				label: `${year} · ${translate(`monthShort.${monthIndex + 1}`)}`,
				rows
			};
		}

		/** The `count` months ending with the month containing `toKey`. */
		function recentMonths(toKey, count, translate) {
			const anchor = parseDay(toKey);
			const months = [];
			for (let index = count - 1; index >= 0; index -= 1) {
				const month = new Date(anchor.getFullYear(), anchor.getMonth() - index, 1);
				months.push(monthGrid(month.getFullYear(), month.getMonth(), translate));
			}
			return months;
		}

		/**
		 * Heat colour for one cell in ONE hue. Depth follows a square-root scale
		 * of the metric against the window maximum, so a single heavy day does
		 * not flatten every other cell; an empty day gets the neutral surface.
		 * @param value - the cell's metric value.
		 * @param max - the window's largest value for that metric.
		 * @returns `{ background, color }` for the cell.
		 */
		function heatStyle(value, max) {
			if (!Number.isFinite(value) || value <= 0 || max <= 0) {
				return { background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-tertiary)" };
			}
			// Square-root scale, then a floor high enough that a light day is still
			// visibly a blue rather than a washed-out tint on its own surface.
			const ratio = Math.sqrt(Math.min(1, value / max));
			const alpha = 0.22 + 0.74 * ratio;
			return {
				background: `color-mix(in srgb, ${HEAT_HUE} ${(alpha * 100).toFixed(0)}%, transparent)`,
				color: alpha >= 0.55 ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-primary)"
			};
		}

		/** Cumulative points for one series, ready for a polyline. */
		function seriesPoints(values, max, width, height, padX, padY) {
			const innerW = Math.max(1, width - padX * 2);
			const innerH = Math.max(1, height - padY * 2);
			const step = values.length <= 1 ? 0 : innerW / (values.length - 1);
			return values.map((value, index) => ({
				x: padX + step * index,
				y: padY + innerH - (max > 0 ? (Math.min(value, max) / max) * innerH : 0)
			}));
		}

		/** `polyline` path data for a point list. */
		function polylineOf(points) {
			return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
		}

		/** Closed area path under a point list. */
		function areaOf(points, baseline) {
			if (points.length === 0) return "";
			const line = polylineOf(points);
			const first = points[0];
			const last = points[points.length - 1];
			return `${line} L${last.x.toFixed(2)},${baseline.toFixed(2)} L${first.x.toFixed(2)},${baseline.toFixed(2)} Z`;
		}

		//#endregion

		//#region icons
		/** One stroke icon at the shell's glyph weight. */
		function Glyph({ size = 16, children }) {
			return jsx.jsxs("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children
			});
		}

		/**
		 * Sidebar row glyph. The shell owns the row box, label, tooltip and active
		 * highlight; this draws only the mark, at the size and tone the shell
		 * passes in. It carries `data-dsh-panel-entry` because that is the only
		 * DOM this plugin owns inside the shell-owned row (the semantic anchor
		 * skins and other L2 contracts resolve rows through).
		 */
		function PanelRowIcon({ size = 16 }) {
			return jsx.jsx("svg", {
				"data-dsh-panel-entry": PANEL_ID,
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx.jsx("path", { key: "a", d: "M2.5 13.5h11" }),
					jsx.jsx("path", { key: "b", d: "M4 13.5V9" }),
					jsx.jsx("path", { key: "c", d: "M8 13.5V4.5" }),
					jsx.jsx("path", { key: "d", d: "M12 13.5V7" })
				]
			});
		}

		/** Panel glyph: bars over a baseline, the conventional usage/statistics mark. */
		function DashboardIcon({ size }) {
			return jsx.jsx(Glyph, {
				size,
				children: [
					jsx.jsx("path", { key: "a", d: "M2.5 13.5h11" }),
					jsx.jsx("path", { key: "b", d: "M4 13.5V9" }),
					jsx.jsx("path", { key: "c", d: "M8 13.5V4.5" }),
					jsx.jsx("path", { key: "d", d: "M12 13.5V7" })
				]
			});
		}

		const IconCalendar = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("rect", { key: "r", x: "2.5", y: "3.5", width: "11", height: "10", rx: "1.6" }),
			jsx.jsx("path", { key: "a", d: "M2.5 6.5h11" }),
			jsx.jsx("path", { key: "b", d: "M5.5 2.2v2.2M10.5 2.2v2.2" })
		] });

		const IconLayers = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M8 2.2 13.8 5.4 8 8.6 2.2 5.4Z" }),
			jsx.jsx("path", { key: "b", d: "M2.2 8.2 8 11.4 13.8 8.2" }),
			jsx.jsx("path", { key: "c", d: "M2.2 10.9 8 14.1 13.8 10.9" })
		] });

		const IconPhone = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M4.2 2.6h2l1 2.6-1.3 1a7.6 7.6 0 0 0 3.9 3.9l1-1.3 2.6 1v2a1.6 1.6 0 0 1-1.7 1.6A11.4 11.4 0 0 1 2.6 4.3 1.6 1.6 0 0 1 4.2 2.6Z" })
		] });

		const IconStack = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("ellipse", { key: "a", cx: "8", cy: "4", rx: "5.6", ry: "2.2" }),
			jsx.jsx("path", { key: "b", d: "M2.4 4v8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V4" }),
			jsx.jsx("path", { key: "c", d: "M2.4 8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2" })
		] });

		const IconCube = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M8 2.2 13.8 5.4v5.2L8 13.8 2.2 10.6V5.4Z" }),
			jsx.jsx("path", { key: "b", d: "M2.4 5.5 8 8.7l5.6-3.2M8 8.7v5" })
		] });

		const IconTrend = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M2.4 11.6 6 7.4l2.6 2.4L13.6 4" }),
			jsx.jsx("path", { key: "b", d: "M10.3 4h3.3v3.3" })
		] });

		const IconRefresh = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M13.4 8a5.4 5.4 0 1 1-1.6-3.8" }),
			jsx.jsx("path", { key: "b", d: "M13.6 2.6v3.2h-3.2" })
		] });

		const IconAlert = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M8 2.6 14.2 13H1.8Z" }),
			jsx.jsx("path", { key: "b", d: "M8 6.4v3.2" }),
			jsx.jsx("circle", { key: "c", cx: "8", cy: "11.4", r: "0.6", fill: "currentColor" })
		] });

		const IconClose = (props) => jsx.jsxs(Glyph, { ...props, children: [
			jsx.jsx("path", { key: "a", d: "M3.6 3.6 12.4 12.4" }),
			jsx.jsx("path", { key: "b", d: "M12.4 3.6 3.6 12.4" })
		] });

		const IconArrowUp = (props) => jsx.jsxs(Glyph, { ...props, children: [jsx.jsx("path", { d: "M8 12.6V3.6M4.2 7.4 8 3.6l3.8 3.8" })] });
		//#endregion

		//#region small components
		/** One proportional bar row used by both distributions. */
		function BarRow({ name, value, share, accent, secondary, barLabel }) {
			return jsx.jsxs("div", { className: "udw_row", children: [
				jsx.jsxs("div", { className: "udw_rowName", children: [
					jsx.jsx("span", { className: "udw_dot", style: { background: accent }, "aria-hidden": "true" }),
					jsx.jsx("span", { children: name })
				] }),
				jsx.jsxs("div", { className: "udw_rowShare", children: [share.toFixed(1), "%"] }),
				jsx.jsx("div", { className: "udw_rowValue", children: value }),
				jsx.jsxs("div", {
					className: "udw_rowTrack",
					"aria-hidden": barLabel === undefined ? "true" : undefined,
					"aria-label": barLabel,
					role: barLabel === undefined ? undefined : "img",
					children: jsx.jsx("div", {
						className: "udw_rowFill",
						style: { width: `${Math.max(1.5, share)}%`, background: accent }
					})
				}),
				secondary === null || secondary === undefined ? null : jsx.jsx("div", { className: "udw_rowMeta", children: secondary })
			] });
		}

		/** Donut chart with a centered total; segments follow the palette order. */
		/**
		 * Format a duration in milliseconds for a compact row.
		 *
		 * Sub-second values keep millisecond precision because tool calls are often
		 * that fast, and rounding them all to "0s" would make the column useless.
		 * @param ms - duration in milliseconds.
		 * @returns a short human string.
		 */
		function fmtDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0";
			if (ms < 1000) return `${Math.round(ms)}ms`;
			const seconds = ms / 1000;
			if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
			const minutes = seconds / 60;
			if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
			const hours = minutes / 60;
			return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
		}

		/**
		 * The share donut with hover.
		 *
		 * A slice highlights on hover and the CENTER swaps to that slice's own name
		 * and figure — no tooltip to chase, and the eye never leaves the middle of
		 * the ring. Leaving the ring restores the total. Slices are focusable, with
		 * real labels, so keyboard users get the same readout.
		 *
		 * `rows` items may be providers, models or workspaces: anything with a
		 * `tokens` figure and an identity key works.
		 */
		function Donut({ rows, totalLabel, totalValue, nameOf, accentOf: accentFor }) {
			const total = rows.reduce((sum, row) => sum + row.tokens, 0);
			const [hoverKey, setHoverKey] = react.useState(null);
			if (total <= 0) return null;
			const radius = 46;
			const circumference = 2 * Math.PI * radius;
			let offset = 0;
			const segments = rows.map((row, index) => {
				const share = row.tokens / total;
				const key = String(row.provider ?? row.model ?? row.cwd ?? index);
				const label = nameOf ? nameOf(row) : String(row.provider ?? row.model ?? "");
				const segment = {
					key, label, share,
					tokens: row.tokens,
					stroke: accentFor ? accentFor(row) : accentOf(key),
					dasharray: `${Math.max(0, share * circumference - 2)} ${circumference}`,
					dashoffset: -offset,
					calls: row.calls
				};
				offset += share * circumference;
				return segment;
			});
			const hovered = hoverKey === null ? null : segments.find((s) => s.key === hoverKey) ?? null;
			return jsx.jsxs("div", { className: "udw_donutWrap", children: [jsx.jsxs("svg", {
				className: "udw_donut",
				viewBox: "0 0 120 120",
				role: "img",
				"aria-label": totalLabel,
				children: [
					jsx.jsx("circle", {
						cx: "60", cy: "60", r: radius, fill: "none",
						stroke: "var(--dsw-alias-interactive-bg-hover)", strokeWidth: "14"
					}),
					...segments.map((segment) => jsx.jsx("circle", {
						cx: "60", cy: "60", r: radius, fill: "none",
						stroke: segment.stroke,
						// The hovered slice thickens: on saturated fills a colour change
						// alone is hard to see, and the ring is wide enough to spare the
						// pixels.
						strokeWidth: hoverKey === segment.key ? "18" : "14",
						strokeLinecap: "butt",
						strokeDasharray: segment.dasharray, strokeDashoffset: segment.dashoffset,
						transform: "rotate(-90 60 60)",
						className: "udw_donutSlice",
						onMouseEnter: () => setHoverKey(segment.key),
						onMouseLeave: () => setHoverKey(null),
						onFocus: () => setHoverKey(segment.key),
						onBlur: () => setHoverKey(null),
						tabIndex: 0,
						"aria-label": `${segment.label} ${Math.round(segment.share * 100)}%`
					}, segment.key)),
					hovered === null ? [
						jsx.jsx("text", { x: "60", y: "57", textAnchor: "middle", className: "udw_donutTotal", children: totalValue }, "t"),
						jsx.jsx("text", { x: "60", y: "71", textAnchor: "middle", className: "udw_donutCaption", children: totalLabel }, "c")
					] : [
						jsx.jsx("text", { x: "60", y: "57", textAnchor: "middle", className: "udw_donutTotal", children: fmtTokens(hovered.tokens, bindTranslate()) }, "t"),
						jsx.jsx("text", { x: "60", y: "71", textAnchor: "middle", className: "udw_donutCaption", children: hovered.label }, "c")
					]
				]
			})] });
		}


		/**
		 * One day cell. Depth and label both come from the selected metric, so the
		 * same grid serves the token and the call view.
		 */
		function DayCell({ cell, dayMap, max, selected, today, onSelect, translate }) {
			const entry = dayMap.get(cell.key);
			const value = entry === undefined ? 0 : entry.tokens;
			const isSelected = cell.key === selected;
			const isToday = cell.key === today;
			const label = entry === undefined
				? translate("aria.dayEmpty", { date: cell.key })
				: translate("aria.day", {
					date: cell.key,
					tokens: fmtTokens(entry.tokens, translate),
					calls: fmtCalls(entry.calls)
				});
			return jsx.jsx("button", {
				type: "button",
				className: "udw_cell",
				style: heatStyle(value, max),
				"data-selected": isSelected ? "true" : "false",
				"data-today": isToday ? "true" : "false",
				"data-cell-date": cell.key,
				"aria-haspopup": "dialog",
				"aria-label": label,
				"aria-selected": isSelected ? "true" : "false",
				onClick: () => onSelect(cell.key),
				children: cell.dayNumber
			});
		}

		/**
		 * The calendar as one continuous three-month span.
		 *
		 * Three month blocks sit side by side. Each block carries its own weekday
		 * header — calendar ROWS are weeks and COLUMNS are weekday positions, so a
		 * single shared header would have to line up with three independent
		 * column sets at once. What makes the span continuous is the cells: the
		 * first week of every month is filled with the trailing days of the
		 * previous one, so a block never restarts at the 1st and consecutive
		 * blocks read as one timeline.
		 */
		function CalendarGrid({ months, dayMap, max, selected, today, onSelect, translate }) {
			// Columns follow the number of months (capped at six), so a 3-month range
			// fills 3 columns instead of leaving half a row empty.
			const columns = Math.min(Math.max(months.length, 1), 6);
			const weekdays = [1, 2, 3, 4, 5, 6, 7].map((day) => translate(`weekShort.${day}`));
			// Every block is padded to the tallest one, so the three blocks share a
			// single baseline and read as one grid.
			const rowCount = Math.max(...months.map((month) => month.rows.length), 0);
			return jsx.jsx("div", { className: "udw_calColumns", style: { "--udw-cal-cols": String(columns) }, children: months.map((month) => jsx.jsxs("div", { className: "udw_calColumn", children: [
				jsx.jsx("p", { className: "udw_monthTitle", children: month.label }),
				jsx.jsx("div", { className: "udw_calRow udw_calHeadRow", "aria-hidden": "true", children: weekdays.map((label, index) => (
					jsx.jsx("span", { className: "udw_calWeekday", children: label }, `h${index}`)
				)) }),
				month.rows.map((row, rowIndex) => jsx.jsx("div", { className: "udw_calRow", children: row.map((cell, cellIndex) => (
					cell === null
						? jsx.jsx("span", { className: "udw_calSpacer", "aria-hidden": "true" }, `p${rowIndex}-${cellIndex}`)
						: jsx.jsx(DayCell, {
							cell,
							dayMap,
							max,
							selected,
							today,
							onSelect,
							translate
						}, cell.key)
				)) }, `r${rowIndex}`)),
				Array.from({ length: Math.max(0, rowCount - month.rows.length) }, (_, padIndex) => (
					jsx.jsx("div", { className: "udw_calRow", "aria-hidden": "true", children: [0, 1, 2, 3, 4, 5, 6].map((cellIndex) => (
						jsx.jsx("span", { className: "udw_calSpacer", key: `pad${padIndex}-${cellIndex}` })
					)) }, `pad${padIndex}`)
				))
			] }, month.key)) });
		}

		//#endregion

		//#region charts
		/**
		 * Dual-metric trend: token tokens on the left axis, call counts on the
		 * right, each scaled to its own maximum so both shapes stay legible
		 * without pretending they share a unit.
		 */
		function TrendChart({ days, translate }) {
			const [hover, setHover] = react.useState(null);
			const width = 720;
			const height = 230;
			const pad = { left: 44, right: 40, top: 16, bottom: 26 };
			if (days.length === 0) {
				return jsx.jsx("div", { className: "udw_detailEmpty", children: translate("trend.empty") });
			}
			const tokenValues = days.map((day) => day.tokens);
			const callValues = days.map((day) => day.calls);
			const tokenMax = Math.max(...tokenValues, 1);
			const callMax = Math.max(...callValues, 1);
			// Round the axis tops up so gridlines land on readable numbers.
			const tokenTop = niceCeil(tokenMax);
			const callTop = niceCeil(callMax);
			const tokenPoints = seriesPoints(tokenValues, tokenTop, width, height, pad.left, pad.top, pad.bottom);
			const callPoints = seriesPoints(callValues, callTop, width, height, pad.left, pad.top, pad.bottom);
			const innerH = height - pad.top - pad.bottom;
			const ticks = [0, 0.25, 0.5, 0.75, 1];
			const step = days.length <= 1 ? 0 : (width - pad.left - pad.right) / (days.length - 1);
			const labelEvery = Math.max(1, Math.ceil(days.length / 7));
			const hovered = hover === null ? null : days[hover];
			return jsx.jsxs("div", { className: "udw_trendWrap", children: [
				jsx.jsxs("svg", {
					className: "udw_trendSvg",
					viewBox: `0 0 ${width} ${height}`,
					preserveAspectRatio: "none",
					role: "img",
					"aria-label": translate("trend.title"),
					children: [
						jsx.jsxs("defs", { children: [
							jsx.jsxs("linearGradient", {
								id: "udw-tokens-grad", x1: "0", y1: "0", x2: "0", y2: "1",
								children: [
									jsx.jsx("stop", { offset: "0%", stopColor: "#3b82f6", stopOpacity: "0.26" }),
									jsx.jsx("stop", { offset: "100%", stopColor: "#3b82f6", stopOpacity: "0.02" })
								]
							})
						] }),
						...ticks.map((tick, index) => {
							const y = pad.top + innerH * tick;
							return jsx.jsxs("g", { children: [
								jsx.jsx("line", {
									className: "udw_trendGrid",
									x1: pad.left, x2: width - pad.right, y1: y, y2: y,
									opacity: index === ticks.length - 1 ? 0.9 : 0.5
								}),
								jsx.jsx("text", {
									className: "udw_trendAxis", x: pad.left - 8, y: y + 3, textAnchor: "end",
									children: fmtTokens(tokenTop * (1 - tick), translate)
								}),
								jsx.jsx("text", {
									className: "udw_trendAxis", x: width - pad.right + 8, y: y + 3, textAnchor: "start",
									children: fmtCalls(callTop * (1 - tick))
								})
							] }, `grid${index}`);
						}),
						jsx.jsx("path", { className: "udw_trendAreaTokens", d: areaOf(tokenPoints, height - pad.bottom) }),
						jsx.jsx("path", { className: "udw_trendLineTokens", d: polylineOf(tokenPoints) }),
						jsx.jsx("path", { className: "udw_trendLineCalls", d: polylineOf(callPoints) }),
						hover === null ? null : jsx.jsx("line", {
							className: "udw_trendCursor",
							x1: pad.left + step * hover, x2: pad.left + step * hover,
							y1: pad.top, y2: height - pad.bottom
						}),
						days.map((day, index) => {
							const x = pad.left + step * index;
							const showLabel = index % labelEvery === 0 || index === days.length - 1;
							return jsx.jsxs("g", { children: [
								showLabel
									? jsx.jsx("text", {
										className: "udw_trendAxis", x, y: height - pad.bottom + 16,
										textAnchor: index === 0 || days.length <= 2 ? "start" : "middle",
										children: `${parseDay(day.date).getMonth() + 1}/${parseDay(day.date).getDate()}`
									})
									: null,
								// A full-height hit target per day keeps the pointer
								// usable without a 2px-precision dot.
								jsx.jsx("rect", {
									className: "udw_trendHit",
									x: Math.max(0, x - step / 2), y: pad.top,
									width: Math.max(step, 8), height: innerH,
									onMouseEnter: () => setHover(index),
									onMouseLeave: () => setHover((current) => (current === index ? null : current)),
									onFocus: () => setHover(index),
									onBlur: () => setHover(null),
									tabIndex: 0,
									"aria-label": translate("aria.day", {
										date: day.date,
										tokens: fmtTokens(day.tokens, translate),
										calls: fmtCalls(day.calls)
									})
								})
							] }, day.date);
						}),
						hover === null ? null : jsx.jsxs("g", { children: [
							jsx.jsx("circle", {
								className: "udw_trendDotTokens",
								cx: pad.left + step * hover, cy: tokenPoints[hover].y, r: "3.4"
							}),
							jsx.jsx("circle", {
								className: "udw_trendDotCalls",
								cx: pad.left + step * hover, cy: callPoints[hover].y, r: "3.4"
							})
						] })
					]
				}),
				hovered === undefined || hovered === null ? null : jsx.jsxs("div", {
					className: "udw_tooltip",
					style: {
						left: `${Math.min(92, Math.max(2, ((pad.left + step * hover) / width) * 100))}%`,
						top: "4px",
						transform: "translateX(-50%)"
					},
					children: [
						jsx.jsx("div", { className: "udw_tooltipTitle", children: dayLabel(hovered.date, translate) }),
						jsx.jsxs("div", { className: "udw_tooltipRow", children: [
							jsx.jsx("span", { className: "udw_tooltipDot", style: { background: HEAT_HUE } }),
							jsx.jsxs("span", { children: [translate("trend.tokens"), ": ", fmtTokens(hovered.tokens, translate)] })
						] }),
						jsx.jsxs("div", { className: "udw_tooltipRow", children: [
							jsx.jsx("span", { className: "udw_tooltipDot", style: { background: CALL_HUE } }),
							jsx.jsxs("span", { children: [translate("trend.calls"), ": ", fmtCalls(hovered.calls)] })
						] })
					]
				})
			] });
		}

		/** Round an axis maximum up to a readable 1/2/5×10^n value. */
		function niceCeil(value) {
			if (!Number.isFinite(value) || value <= 0) return 1;
			const magnitudeValue = Math.pow(10, Math.floor(Math.log10(value)));
			const scaled = value / magnitudeValue;
			const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
			return step * magnitudeValue;
		}
		//#endregion

		//#region calendar + detail
		/** The three-month heat calendar with a metric switch and a legend. */
		function CalendarCard({ days, range, selected, today, onSelect, translate }) {
			const dayMap = react.useMemo(() => {
				const map = new Map();
				for (const day of days) map.set(day.date, day);
				return map;
			}, [days]);
			// The month span to paint, as both a count and the anchor it ends on.
			//
			// "全部" starts at the OLDEST month that actually holds usage and ends at
			// the newest, so it never leads with months that have no data (a store
			// untouched for a while would otherwise open with a run of blank columns
			// before anything appears). The fixed presets keep their own span but are
			// still clamped to the data, so a 12-month window over 6 months of history
			// draws 6 columns instead of 6 empty ones.
			const span = react.useMemo(() => {
				const wanted = range.key === "all" ? MAX_ALL_MONTHS : Math.min(Math.max(range.months, 1), MAX_ALL_MONTHS);
				// No data yet: fall back to the preset's own span ending today.
				if (days.length === 0) return { count: wanted, end: range.to ?? today };
				const first = parseDay(days[0].date);
				const last = parseDay(days[days.length - 1].date);
				const covered = (last.getFullYear() * 12 + last.getMonth()) - (first.getFullYear() * 12 + first.getMonth()) + 1;
				const count = Math.min(Math.max(covered, 1), wanted);
				// "全部" anchors on the newest month WITH DATA so the span ends where the
				// usage ends; the presets stay pinned to "today" so switching between
				// them does not shift the calendar.
				const anchor = range.key === "all"
					? dayKeyOf(new Date(last.getFullYear(), last.getMonth(), 1))
					: (range.from === undefined ? today : (range.to ?? today));
				return { count, end: anchor };
			}, [days, range, today]);

			// Paint `span.count` months ending on `span.end`. For the presets that end
			// is "today"; for "全部" it is the newest month that holds usage, which is
			// what keeps a long-idle store from opening on blank columns.
			const months = react.useMemo(
				() => recentMonths(span.end, span.count, translate),
				[translate, span]
			);
			// A single heavy day must not flatten the rest of the calendar into one
			// shade, so the ramp is normalized against the 90th percentile of days
			// that actually had activity. Values above it clamp to the deepest step,
			// which keeps "top days" reading as top days.
			const max = react.useMemo(() => {
				const values = days
					.map((day) => day.tokens)
					.filter((value) => value > 0)
					.sort((a, b) => a - b);
				if (values.length === 0) return 0;
				const percentile = values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
				return Math.max(percentile, values[values.length - 1] * 0.35);
			}, [range]);
			const legendSteps = [0.24, 0.44, 0.64, 0.92];
			return jsx.jsxs("div", { className: "udw_card", children: [
				jsx.jsxs("div", { className: "udw_cardHead", children: [
					jsx.jsxs("h2", { className: "udw_cardTitle", children: [
						jsx.jsx(IconCalendar, { size: 16 }),
						translate("calendar.title")
					] }),
					jsx.jsx("span", { className: "udw_cardHint", children: translate("calendar.hint") })
				] }),
				jsx.jsxs("div", { className: "udw_cardBody", children: [
					days.length === 0
						? jsx.jsx("div", { className: "udw_detailEmpty", children: translate("calendar.empty") })
						: jsx.jsx(CalendarGrid, {
							months,
							dayMap,
							max,
							selected,
							today,
							onSelect,
							translate
						}),
					jsx.jsxs("div", { className: "udw_legend", children: [
						jsx.jsx("span", { children: translate("calendar.less") }),
						jsx.jsx("span", { className: "udw_legendSwatch", style: { background: "var(--dsw-alias-bg-layer-3)" } }),
						...legendSteps.map((alpha) => jsx.jsx("span", {
							className: "udw_legendSwatch",
							style: { background: `color-mix(in srgb, ${HEAT_HUE} ${(alpha * 100).toFixed(0)}%, transparent)` }
						}, `l${alpha}`)),
						jsx.jsx("span", { children: translate("calendar.more") })
					] })
				] })
			] });
		}

		/** The day detail side panel. */
		/**
		 * The qualifiers under a day's totals: how much of the input was served
		 * from cache, and — only when they actually happened — the failures and
		 * retries behind them.
		 *
		 * They sit on their own line instead of extending the totals line: a
		 * percentage reads as an explanation of the figure above it, not as one
		 * more figure beside it. The failure part reports the raw pair
		 * (`4 / 2,154 次尝试`) rather than a rate, because a rate rounds: 99.8%
		 * prints as "100%" next to "失败 4", which reads as a contradiction.
		 */
		function dayQualityOf(day, translate) {
			const parts = [];
			if (day.cacheReadTokens > 0 && day.cacheHitRate !== null) parts.push(translate("detail.cacheHitShort", { rate: fmtPercent(day.cacheHitRate) }));
			if (day.failedCalls > 0) parts.push(translate("metric.failedOfAttempts", { failed: fmtCalls(day.failedCalls), attempts: fmtCalls(day.attempts) }));
			if (day.retries > 0) parts.push(translate("metric.retries", { count: fmtCalls(day.retries) }));
			return parts;
		}

		/** How many workspace rows a day's dialog lists before it summarizes the rest. */
		const DAY_WORKSPACE_LIMIT = 6;

		/**
		 * Day-detail DIALOG, opened by clicking a calendar cell.
		 *
		 * It is a dialog rather than a side panel so the calendar keeps the full
		 * width of the card and the detail can list per-provider and per-model
		 * rows without being squeezed into a narrow column. Escape and a backdrop
		 * click both close it; focus moves into the dialog on open and the
		 * keyboard trap keeps Tab inside it while it is up.
		 */
		function DayDialog({ day, date, translate, onClose }) {
			const closeRef = react.useRef(null);
			const panelRef = react.useRef(null);
			react.useEffect(() => {
				// Focus the close button so Escape and Tab work immediately.
				closeRef.current?.focus();
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
						return;
					}
					if (event.key !== "Tab" || panelRef.current === null) return;
					// Focus trap: keep Tab inside the panel.
					const focusable = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
					if (focusable.length === 0) return;
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => document.removeEventListener("keydown", onKeyDown, true);
			}, [onClose]);

			// ONE ROW PER (provider, model), not per provider. byProvider merged all
			// models of one provider into a single card titled by modelOfProvider —
			// find, i.e. the FIRST model only. A provider that ran two models in one
			// day showed one card named after whichever sorted first, hiding the
			// second model entirely.
			// GROUPED BY PROVIDER: one header card per provider, its models listed
			// inside. A provider that ran two models showed them as two unrelated
			// cards before, and the provider total existed nowhere.
			const groups = day === null ? [] : (() => {
				const map = new Map();
				for (const row of day.byModel) {
					// A route whose calls all failed keeps a row with 0 tokens and 0
					// calls (the fold counts its attempts), and printing it here reads
					// as a real zero beside real spend. The provider card is built from
					// these rows, so skipping the row drops the empty card too.
					if (!hasFigure(row)) continue;
					const { provider, model } = splitModelKey(row.model);
					let g = map.get(provider);
					if (g === undefined) {
						g = { provider, models: [], tokens: 0, calls: 0, cacheReadTokens: 0 };
						map.set(provider, g);
					}
					g.models.push({ model, name: row.name, tokens: row.tokens, calls: row.calls, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens, cacheHitRate: row.cacheHitRate, failedCalls: row.failedCalls });
					g.tokens += row.tokens;
					g.calls += row.calls;
					g.cacheReadTokens += row.cacheReadTokens;
				}
				return [...map.values()].sort((a, b) => b.tokens - a.tokens);
			})();
			const total = Math.max(1, day === null ? 1 : day.tokens);
			// The qualifiers under the totals (hit rate, failures, retries).
			const quality = day === null ? [] : dayQualityOf(day, translate);
			// The workspaces that spent on THIS day, already sorted by the host.
			// A MISSING list means the host does not report workspaces at all (an
			// older host half during a restart), and then the block is left out —
			// only an EMPTY list is the fact "this day cannot be attributed", which
			// is what the note says. Showing that note for a field that was never
			// sent would claim something the host never said.
			const hasWorkspaces = day !== null && Array.isArray(day.byWorkspace);
			const dayWorkspaces = hasWorkspaces ? day.byWorkspace : [];
			const workspaceRows = dayWorkspaces.slice(0, DAY_WORKSPACE_LIMIT);
			const workspaceTokens = dayWorkspaces.reduce((sum, row) => sum + row.tokens, 0);
			return jsx.jsx("div", {
				className: "udw_dialogBackdrop",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: jsx.jsxs("div", {
					className: "udw_dialog",
					ref: panelRef,
					role: "dialog",
					"aria-modal": "true",
					"aria-labelledby": "udw-dialog-title",
					"data-date": date,
					children: [
						// No "日期详情" title: the date IS the heading, and the dialog opens
						// for exactly one reason — a day was clicked. A second label above
						// it would only repeat what the click already said.
						jsx.jsxs("div", { className: "udw_dialogHead", children: [
							jsx.jsx("h3", { className: "udw_dialogTitle", id: "udw-dialog-title", children: dayLabel(date, translate) }),
							jsx.jsx("button", {
								type: "button",
								className: "udw_dialogClose",
								ref: closeRef,
								"aria-label": translate("detail.close"),
								onClick: onClose,
								children: jsx.jsx(IconClose, { size: 16 })
							})
						] }),
						jsx.jsxs("div", { className: "udw_dialogBody", children: [
							day === null || groups.length === 0
								? jsx.jsx("div", { className: "udw_detailEmpty", children: translate("detail.noDay") })
								: jsx.jsxs(jsx.Fragment, { children: [
									// The lead block: the day's figures, then the rates that qualify
									// them. Grouping the two in one column keeps the rates attached to
									// the totals (4px apart) while the provider cards below stay a
									// full 16px away — the totals read as one statement, not as two
									// paragraphs.
									jsx.jsxs("div", { className: "udw_dialogLead", children: [
										// One summary line: the day's TOTAL first, then the split behind
										// it. A percentage lives on the line below instead: "缓存命中
										// 84%" explains that total, it is not one more figure in it.
										jsx.jsx("p", { className: "udw_dialogSummary", children: [
											translate("detail.totalShort", { tokens: fmtTokens(day.tokens, translate) }),
											translate("detail.inputShort", { tokens: fmtTokens(day.inputTokens, translate) }),
											translate("detail.outputShort", { tokens: fmtTokens(day.outputTokens, translate) }),
											translate("detail.cacheShort", { tokens: fmtTokens(day.cacheReadTokens, translate) }),
											translate("detail.callsShort", { count: fmtCalls(day.calls) })
										].join(" · ") }),
										quality.length === 0 ? null : jsx.jsx("p", { className: "udw_dialogQuality", children: quality.join(" · ") })
									] }),
									jsx.jsx("div", { className: "udw_providerList", children: groups.map((group) => jsx.jsxs("article", {
										className: "udw_providerCard",
										children: [
											// Provider header keeps its original shape: name + model count
											// left, figures right, and a FULL-width track of its own below.
											jsx.jsxs("div", { className: "udw_providerTop", children: [
												jsx.jsxs("span", { className: "udw_providerName", children: [
													jsx.jsx("span", { className: "udw_dot", style: { background: accentOf(group.provider) }, "aria-hidden": "true" }),
													group.provider,
													// A provider that ran several models says so in the header, so a
													// single-model group does not carry dead ink.
													group.models.length > 1 ? jsx.jsx("span", { className: "udw_providerModelCount", children: translate("detail.modelCount", { count: group.models.length }) }) : null
												] }),
												jsx.jsxs("span", { className: "udw_providerRight", children: [
													jsx.jsx("span", { className: "udw_providerTokens", children: fmtTokens(group.tokens, translate) }),
													jsx.jsx("span", { className: "udw_providerHit", children: fmtCalls(group.calls) })
												] })
											] }),
											jsx.jsx("div", { className: "udw_providerTrack", children: jsx.jsx("div", {
												className: "udw_providerFill",
												style: { width: `${Math.max(3, (group.tokens / total) * 100)}%`, background: accentOf(group.provider) }
											}) }),
											// Model rows share ONE grid (.udw_modelList): name | gap |
											// detail. Name and detail each take half the leftover width,
											// so detail ends flush right and the elastic gap sits between
											// name and bar — it shrinks as the name grows, never overlaps.
											jsx.jsx("div", { className: "udw_modelList", children: group.models.flatMap((m) => [
												jsx.jsx("span", { className: "udw_modelName", title: m.model, children: m.name ?? m.model }, `n-${m.model}`),
												// The elastic gap: half of the leftover width, between the
												// name and the detail run.
												jsx.jsx("span", { "aria-hidden": "true" }, `g-${m.model}`),
												// The detail run: bar + figures, packed left, flush right.
												jsx.jsxs("span", { className: "udw_modelDetail", children: [
													jsx.jsx("span", { className: "udw_modelBar", children: jsx.jsx("span", { className: "udw_modelFill", style: { width: `${group.tokens > 0 ? Math.max(2, (m.tokens / group.tokens) * 100) : 0}%`, background: accentOf(group.provider) } }) }),
													// The PER-MODEL hit rate, not the group total: two models on one
													// provider can sit at opposite ends (a cached flash model beside an
													// uncached reasoning one), and a merged figure erases exactly that.
													jsx.jsx("span", { className: "udw_modelTokens", children: fmtTokens(m.tokens, translate) }),
													jsx.jsx("span", { className: "udw_wsStat udw_modelHit", children: fmtPercent(m.cacheHitRate) }),
													jsx.jsx("span", { className: "udw_modelCalls", children: fmtCalls(m.calls) })
												] }, `d-${m.model}`)
											]) }),
											jsx.jsx("p", { className: "udw_providerMeta", children: [
												translate("detail.inputShort", { tokens: fmtTokens(group.models.reduce((a, m) => a + m.inputTokens, 0), translate) }),
												translate("detail.outputShort", { tokens: fmtTokens(group.models.reduce((a, m) => a + m.outputTokens, 0), translate) }),
												translate("detail.cacheShort", { tokens: fmtTokens(group.cacheReadTokens, translate) }),
												// A provider that lost calls says so HERE: the day line
												// reports the total, this one names the route behind it, and
												// a clean provider stays a single unadorned line.
												group.models.reduce((sum, m) => sum + (m.failedCalls ?? 0), 0) > 0
													? translate("detail.failed", { count: fmtCalls(group.models.reduce((sum, m) => sum + (m.failedCalls ?? 0), 0)) })
													: null
											].filter((part) => part !== null).join(" · ") })
										]
									}, `g-${group.provider}`)) }),
									// Where the day's tokens were spent, by project. A list, not a
									// card: the provider cards are the page's subject, and a second
									// stack of cards below them would compete for that role. The
									// rows reuse the distribution bars, so a workspace keeps the same
									// shape it has on the "分布" page.
									hasWorkspaces ? jsx.jsxs("section", { className: "udw_dayWs", "aria-labelledby": "udw-day-ws-title", children: [
										jsx.jsxs("div", { className: "udw_dayWsHead", children: [
											jsx.jsx("h4", { className: "udw_dayWsTitle", id: "udw-day-ws-title", children: translate("detail.workspaces") }),
											dayWorkspaces.length === 0
												? null
												: jsx.jsx("span", { className: "udw_dayWsHint", children: translate("detail.workspacesHint", {
													count: fmtCalls(dayWorkspaces.length),
													tokens: fmtTokens(workspaceTokens, translate)
												}) })
										] }),
										dayWorkspaces.length === 0
											? jsx.jsx("p", { className: "udw_dayWsNote", children: translate("detail.workspacesNone") })
											: jsx.jsx("div", { className: "udw_dayWsList", children: workspaceRows.map((row) => jsx.jsxs("div", { className: "udw_barRow", children: [
												jsx.jsx("span", { className: "udw_barLabel", children: jsx.jsx("span", { className: "udw_barName", title: row.cwd, children: row.name }) }),
												jsx.jsxs("span", { className: "udw_barValue", children: [
													fmtTokens(row.tokens, translate),
													jsx.jsx("span", { className: "udw_barSub", children: ` · ${fmtPercent(total > 0 ? (row.tokens / total) * 100 : 0)} · ${translate("detail.callsShort", { count: fmtCalls(row.calls) })}` })
												] }),
												jsx.jsx("div", { className: "udw_barTrack", children: jsx.jsx("div", {
													className: "udw_barFill",
													style: { width: `${total > 0 ? Math.max(2, (row.tokens / total) * 100) : 0}%`, background: accentOf(row.name) }
												}) })
											] }, row.cwd)) }),
										dayWorkspaces.length > workspaceRows.length
											? jsx.jsx("p", { className: "udw_dayWsNote", children: translate("detail.workspacesMore", { count: dayWorkspaces.length - workspaceRows.length }) })
											: null
									] }) : null
								] })
						] })
					]
				})
			});
		}
		//#endregion

		//#region page sections
		/** The metric card row, including the today-vs-yesterday delta. */
		/**
		 * The metric card row: today, this month, the selected range, all time,
		 * and the call count of that range.
		 *
		 * Every card's footnote says WHICH period its call count covers, and the
		 * range card names the selection itself — "近 3 月", "近 1 年", or the
		 * hand-picked span — so a reader never has to infer what "窗口" meant.
		 */
		function MetricGrid({ payload, range, translate }) {
			const windowTotals = payload.windowTotals;
			const allTime = payload.allTime.totals;
			const days = payload.days;
			// The range is the selection the reader made, spelled the same way the
			// range control spells it: a preset's own name, or the explicit span.
			const rangeLabel = range.key === "custom" && range.from !== undefined && range.to !== undefined
				? `${range.from} → ${range.to}`
				: translate(`window.${range.key}`);
			// Today's row only exists once a sample has landed, so fall back to a
			// zeroed placeholder for today's DATE — never to the last day present,
			// which would label yesterday's usage as today's.
			const todayDate = todayKey();
			const today = days.length === 0
				? undefined
				: (days.find((day) => day.date === todayDate) ?? { date: todayDate, tokens: 0, calls: 0, failedCalls: 0, cacheReadTokens: 0, cacheHitRate: null, byProvider: [], byModel: [], successRate: null });
			const todayTokens = today === undefined ? 0 : today.tokens;
			// The current calendar month comes from the host, which windows it
			// independently of the selection: it must not change when the range does.
			const month = payload.month === undefined ? undefined : payload.month.totals;
			// The row publishes TWO fitted sizes, measured in em (real glyph widths):
			// every token figure shares the "token em" budget of the row's longest one,
			// and the call count gets its own smaller budget. That keeps the four token
			// cards on one scale, gives the counts a deliberate supporting size, and
			// lets each be as large as its own card actually allows.
			//
			// `emOf` counts a tabular digit as 0.6em and a thousands separator as
			// 0.3em, plus the tracking the value carries; using the character COUNT
			// instead would under-size every number by roughly half.
			const emOf = (value) => {
				const text = fmtExact(value);
				let em = 0;
				for (const char of text) em += char === "," ? 0.3 : 0.6;
				return Math.max(1.8, em);
			};
			const tokenEm = Math.max(...[todayTokens, month === undefined ? 0 : month.tokens, windowTotals.tokens, allTime.tokens].map(emOf));
			const rowStyle = { "--udw-token-em": tokenEm.toFixed(2) };
			return jsx.jsxs("div", { className: "udw_metrics", style: rowStyle, children: [
				jsx.jsxs("div", { className: "udw_metric", children: [
					jsx.jsxs("div", { className: "udw_metricHead", children: [jsx.jsx(IconCalendar, { size: 15 }), jsx.jsx("span", { children: translate("metric.today") })] }),
					jsx.jsx("div", { className: "udw_metricValue", children: fmtExact(todayTokens) }),
					jsx.jsx("div", { className: "udw_metricFoot", children: translate("metric.periodCalls", { period: translate("metric.periodToday"), count: fmtCalls(today === undefined ? 0 : today.calls) }) })
				] }, "today"),
				jsx.jsxs("div", { className: "udw_metric", children: [
					jsx.jsxs("div", { className: "udw_metricHead", children: [jsx.jsx(IconCube, { size: 15 }), jsx.jsx("span", { children: translate("metric.month") })] }),
					jsx.jsx("div", { className: "udw_metricValue", children: fmtExact(month === undefined ? 0 : month.tokens) }),
					jsx.jsx("div", { className: "udw_metricFoot", children: translate("metric.periodCalls", { period: translate("metric.periodMonth"), count: fmtCalls(month === undefined ? 0 : month.calls) }) })
				] }, "month"),
				jsx.jsxs("div", { className: "udw_metric", children: [
					jsx.jsxs("div", { className: "udw_metricHead", children: [jsx.jsx(IconLayers, { size: 15 }), jsx.jsx("span", { children: rangeLabel })] }),
					jsx.jsx("div", { className: "udw_metricValue", children: fmtExact(windowTotals.tokens) }),
					jsx.jsx("div", { className: "udw_metricFoot", children: translate("metric.periodCalls", { period: rangeLabel, count: fmtCalls(windowTotals.calls) }) })
				] }, "window"),
				jsx.jsxs("div", { className: "udw_metric", children: [
					jsx.jsxs("div", { className: "udw_metricHead", children: [jsx.jsx(IconStack, { size: 15 }), jsx.jsx("span", { children: translate("metric.total") })] }),
					jsx.jsx("div", { className: "udw_metricValue", children: fmtExact(allTime.tokens) }),
					jsx.jsx("div", { className: "udw_metricFoot", children: translate("metric.periodCalls", { period: translate("metric.periodAll"), count: fmtCalls(allTime.calls) }) })
				] }, "total"),
				jsx.jsxs("div", { className: "udw_metric", children: [
					jsx.jsxs("div", { className: "udw_metricHead", children: [jsx.jsx(IconPhone, { size: 15 }), jsx.jsx("span", { children: translate("metric.calls") })] }),
					jsx.jsx("div", { className: "udw_metricValue", children: fmtExact(windowTotals.calls) }),
					// "62,784 次尝试" already carries its unit, so the period is stated
					// without appending another "次" to it.
					jsx.jsx("div", { className: "udw_metricFoot", children: `${rangeLabel} · ${translate("metric.attemptsShort", { count: fmtCalls(windowTotals.attempts) })}` })
				] }, "calls"),
			] });
		}

		/** Provider distribution card. */
		function ProviderSection({ providers, translate }) {
			const total = providers.reduce((sum, row) => sum + row.tokens, 0);
			if (providers.length === 0) {
				return jsx.jsx("div", { className: "udw_card", children: jsx.jsx("div", { className: "udw_cardBody", children: jsx.jsx("div", { className: "udw_detailEmpty", children: translate("dist.empty") }) }) });
			}
			return jsx.jsxs("div", { className: "udw_card", children: [
				jsx.jsxs("div", { className: "udw_cardHead", children: [
					jsx.jsxs("h2", { className: "udw_cardTitle", children: [jsx.jsx(IconLayers, { size: 16 }), translate("dist.providerTitle")] })
				] }),
				jsx.jsxs("div", { className: "udw_cardBody", children: [jsx.jsxs("div", { className: "udw_distGrid", children: [
					jsx.jsx(Donut, {
						rows: providers.slice(0, 6),
						totalLabel: translate("dist.windowTitle"),
						totalValue: fmtTokens(total, translate)
					}),
					jsx.jsx("div", { className: "udw_rows", children: providers.slice(0, 8).map((row) => jsx.jsx(BarRow, {
						name: row.provider,
						value: fmtTokens(row.tokens, translate),
						share: total > 0 ? (row.tokens / total) * 100 : 0,
						accent: accentOf(row.provider),
						secondary: null,
						barLabel: translate("aria.providerBar", {
							name: row.provider,
							share: fmtPercent(total > 0 ? (row.tokens / total) * 100 : 0)
						})
					}, row.provider)) })
				] })] })
			] });
		}

/**
 * Workspace ranking: which project directory consumed the most.
 *
 * Rows arrive already sorted by consumption, so nothing here re-sorts them:
 * the order is the answer to the question this tab exists for. The bar is a
 * share of the window's total, the same proportion the provider and model
 * tabs draw, so the three readings stay comparable.
 */
		/**
		 * Workspace ranking: which project directory consumed the most.
		 *
		 * Each row carries every figure the data supports — tokens split into input,
		 * output and cache, the hit rate that explains a cheap total, calls and
		 * attempts, sessions and active days, plus the dominant provider — because a
		 * single number per workspace answers "who spent most" and nothing else.
		 *
		 * A row expands in place on click. A modal was rejected: the reader is
		 * comparing rows, and a dialog would hide the comparison they are making.
		 */
		function WorkspaceSection({ workspaces, translate, limit }) {
			const [openKey, setOpenKey] = react.useState(null);
			const rows = workspaces.slice(0, limit ?? 24);
			const total = workspaces.reduce((sum, row) => sum + row.tokens, 0);
			if (rows.length === 0) {
				return jsx.jsx("div", { className: "udw_card", children: jsx.jsx("div", { className: "udw_cardBody", children: jsx.jsx("div", { className: "udw_detailEmpty", children: translate("workspace.empty") }) }) });
			}
			return jsx.jsxs("div", { className: "udw_card", children: [
				jsx.jsxs("div", { className: "udw_cardHead", children: [
					jsx.jsxs("h2", { className: "udw_cardTitle", children: [jsx.jsx(IconCube, { size: 16 }), translate("workspace.title")] }),
					jsx.jsx("span", { className: "udw_cardHint", children: translate("workspace.hint") })
				]}),
				jsx.jsx("div", { className: "udw_cardBody", children: jsx.jsxs("div", { className: "udw_wsSplit", children: [
					// Left: the donut plus a legend. The legend fills the space under the
					// ring — a chart alone leaves the column half empty, and the names are
					// what a reader actually scans.
					jsx.jsxs("div", { className: "udw_wsChart", children: [
						jsx.jsx(Donut, {
							rows: rows.slice(0, 8),
							totalLabel: translate("dist.windowTitle"),
							totalValue: fmtTokens(total, translate),
							nameOf: (row) => row.name
						}),
						jsx.jsx("div", { className: "udw_wsLegend", children: rows.slice(0, 6).map((row) => {
							const share = total > 0 ? (row.tokens / total) * 100 : 0;
							return jsx.jsxs("div", { className: "udw_wsLegendRow", children: [
								jsx.jsx("span", { className: "udw_wsLegendDot", style: { background: accentOf(row.name) } }),
								jsx.jsx("span", { className: "udw_wsLegendName", title: row.cwd, children: row.name }),
								jsx.jsx("span", { className: "udw_wsLegendPct", children: fmtPercent(share) })
							] }, `l-${row.cwd}`);
						}) })
					] }),
					// Right: the list with every figure per workspace.
					jsx.jsx("div", { className: "udw_wsList", children: rows.map((row) => {
						const share = total > 0 ? (row.tokens / total) * 100 : 0;
						const open = openKey === row.cwd;
						const accent = accentOf(row.name);
						return jsx.jsxs("article", {
							className: "udw_wsRow",
							"data-open": open ? "true" : "false",
							"data-expandable": "true",
							onClick: (event) => {
								if (event.target.closest("button, a, input, select, textarea") !== null) return;
								setOpenKey((key) => (key === row.cwd ? null : row.cwd));
							},
							children: [
								jsx.jsxs("button", {
									type: "button",
									className: "udw_wsMain",
									"aria-expanded": open ? "true" : "false",
									onClick: () => setOpenKey((key) => (key === row.cwd ? null : row.cwd)),
									"aria-label": row.cwd,
									title: row.cwd,
									children: [
										jsx.jsx("span", { className: "udw_wsDot", style: { background: accent }, "aria-hidden": "true" }),
										jsx.jsx("span", { className: "udw_wsName", children: row.name }),
										jsx.jsxs("span", { className: "udw_wsStats", children: [
											jsx.jsx("span", { children: fmtTokens(row.tokens, translate) }),
											jsx.jsxs("span", { className: "udw_wsStat", children: [fmtCalls(row.calls), " 次"] }),
											jsx.jsxs("span", { className: "udw_wsStat", children: [fmtCalls(row.sessions), " 会话"] }),
											jsx.jsxs("span", { className: "udw_wsStat", children: [fmtPercent(share), ""] })
										]}),
									]
								}),
								jsx.jsx("div", { className: "udw_wsTrack", children: jsx.jsx("div", {
									className: "udw_wsFill",
									style: { width: `${Math.max(1.5, share)}%`, background: accent }
								}) }),
								open ? jsx.jsx(WorkspaceDetail, { row, translate }) : null
							]
						}, `ws-${row.cwd}`);
					}) })
				] }) })
			] });
		}

		/**
		 * The "分布" tab: provider, model and workspace side by side, one screen.
		 *
		 * Three separate tabs existed before; each was a single card holding one
		 * chart plus a short list, which left every page half empty. Three columns
		 * share the width instead, so all three dimensions are visible at once.
		 *
		 * Every column is the same shape — donut+legend above, rows below — so the
		 * eye learns the pattern once and reads all three fast.
		 */
		function DistributionSection({ providers, models, workspaces, unattributed, translate }) {
			// Which workspace row is expanded. Only workspaces carry a detail body
			// (tools, compactions, model time); provider and model rows are single lines.
			const [openKey, setOpenKey] = react.useState(null);
			// How many EXTRA rows each section has revealed. The list scrolls inside
			// the card now, so the full ranking is reachable; the reveal keeps the
			// initial view short and grows it 5 rows per click instead of jumping
			// straight to the end of a 60-row list.
			const [revealed, setRevealed] = react.useState(() => ({ p: 0, m: 0, w: 0 }));
			const REVEAL_STEP = 5;
			const INITIAL_LIMIT = 10;
			const revealMore = (key, total) => setRevealed((prev) => ({
				...prev,
				[key]: Math.min(prev[key] + REVEAL_STEP, Math.max(0, total - INITIAL_LIMIT))
			}));
			// Provider and model rows with no tokens and no calls are a failed route,
			// not a usage figure, so the lists skip them; `all` keeps them for the
			// section total (they add nothing to it) and for the reveal counts.
			const sections = [
				{ key: "p", icon: IconLayers, title: translate("dist.providersTitle"), rows: providers.filter(hasFigure), idOf: (r) => r.provider, all: providers },
				{ key: "m", icon: IconStack, title: translate("dist.modelsTitle"), rows: models.filter(hasFigure), idOf: (r) => r.model, labelOf: (r) => modelKeyLabelOf(r.model, r.name), all: models },
				{ key: "w", icon: IconCube, title: translate("dist.workspacesTitle"), rows: (workspaces ?? []), idOf: (r) => r.name, all: unattributed === null || unattributed === undefined ? (workspaces ?? []) : [...(workspaces ?? []), unattributed] }
			];
			return jsx.jsxs("div", { className: "udw_dist", children: sections.map((section) => {

				// The ring's centre reports the FULL figure; the list below shows the
				// top rows only. Summing the truncated rows made the three rings report
				// three different totals (186 / 165 / 131) — a display limit read as a
				// data error.
				const total = section.all.reduce((sum, row) => sum + row.tokens, 0);
				if (section.rows.length === 0) return null;
				const visibleCount = Math.min(INITIAL_LIMIT + revealed[section.key], section.rows.length);
				const visibleRows = section.rows.slice(0, visibleCount);
				const hiddenCount = section.rows.length - visibleRows.length;
				return jsx.jsxs("div", { className: "udw_distSection", children: [
					jsx.jsxs("h3", { className: "udw_distHead", children: [jsx.jsx(section.icon, { size: 14 }), section.title] }),
					jsx.jsxs("div", { className: "udw_distChart", children: [
						jsx.jsx(Donut, {
							rows: section.rows.slice(0, 8),
							totalLabel: translate("dist.windowTitle"),
							totalValue: fmtTokens(total, translate),
							nameOf: (row) => labelOfRow(section, row),
							accentOf: (row) => sectionAccentOf(section.key, section.idOf(row))
						}),
						jsx.jsx("div", { className: "udw_wsLegend", children: section.rows.slice(0, 6).map((row) => jsx.jsxs("div", { className: "udw_wsLegendRow", children: [
							jsx.jsx("span", { className: "udw_wsLegendDot", style: { background: sectionAccentOf(section.key, section.idOf(row)) } }),
							jsx.jsx("span", { className: "udw_wsLegendName", title: section.idOf(row), children: labelOfRow(section, row) }),
							jsx.jsx("span", { className: "udw_wsLegendPct", children: fmtPercent(total > 0 ? (row.tokens / total) * 100 : 0) })
						] }, `lg-${section.key}-${section.idOf(row)}`)) })
					] }),
					jsx.jsx("div", { className: "udw_wsList", children: [
						...visibleRows.map((row) => {
						const share = total > 0 ? (row.tokens / total) * 100 : 0;
						const id = section.idOf(row);
						const accent = sectionAccentOf(section.key, id);
						// Only workspaces carry a detail body (tools, compactions, model time);
						// provider and model rows are single-line facts.
							const expandable = section.key === "w" && row.unattributed !== true;
						const open = expandable && openKey === row.cwd;
						const main = jsx.jsxs("div", { className: "udw_wsMain", children: [
							jsx.jsx("span", { className: "udw_wsDot", style: { background: accent }, "aria-hidden": "true" }),
							jsx.jsx("span", { className: "udw_wsName", children: labelOfRow(section, row) }),
							jsx.jsxs("span", { className: "udw_wsStats", children: [
								jsx.jsx("span", { children: fmtTokens(row.tokens, translate) }),
								jsx.jsxs("span", { className: "udw_wsStat", children: [fmtCalls(row.calls), " 次"] }),
								section.key === "w" ? jsx.jsx("span", { className: "udw_wsStat", children: [fmtCalls(row.sessions), " 会话"] }) : null,
								jsx.jsxs("span", { className: "udw_wsStat", children: [fmtPercent(share), ""] })
							]}),
						] });
						return jsx.jsxs("article", {
							className: "udw_wsRow",
							"data-open": open ? "true" : "false",
							"data-expandable": expandable ? "true" : "false",
							// Clicking anywhere on the row toggles the detail; the inner
							// button stays for keyboard focus and screen-reader semantics.
							// The row handler yields when the click starts inside the button
							// (or any native control) so a click never toggles twice.
							onClick: expandable ? (event) => {
								if (event.target.closest("button, a, input, select, textarea") !== null) return;
								setOpenKey((key) => (key === row.cwd ? null : row.cwd));
							} : undefined,
							children: [
								expandable ? jsx.jsxs("button", {
									type: "button",
									className: "udw_wsMain",
									"aria-expanded": open ? "true" : "false",
									onClick: () => setOpenKey((key) => (key === row.cwd ? null : row.cwd)),
									"aria-label": row.cwd,
									title: row.cwd,
									children: [main]
								}) : main,
								jsx.jsx("div", { className: "udw_wsTrack", children: jsx.jsx("div", {
									className: "udw_wsFill",
									style: { width: `${Math.max(1.5, share)}%`, background: accent }
								}) }),
								open ? jsx.jsx(WorkspaceDetail, { row, translate }) : null
							]
						}, `d-${section.key}-${id}`);
						}),
						// The unattributed remainder lives INSIDE the scroll region, after
						// the ranked rows: it scrolls with them instead of reserving a
						// fixed foot that starves the other two cards of height. It is not
						// a workspace, has no directory to click into, and stays outside
						// the sort — but it no longer costs the card's fixed height.
						// ONLY the workspace column: the gap is a workspace-attribution fact,
						// and it has no meaning under "by provider" or "by model".
						unattributed === null || unattributed === undefined || section.key !== "w" ? null : jsx.jsx("div", { className: "udw_wsRow udw_wsUnattr", children: [
							jsx.jsxs("div", { className: "udw_wsMain", children: [
								jsx.jsx("span", { className: "udw_wsDot", style: { background: "var(--dsw-alias-label-tertiary)" }, "aria-hidden": "true" }),
								jsx.jsx("span", { className: "udw_wsName", children: unattributed.name }),
								jsx.jsxs("span", { className: "udw_wsStats", children: [
									jsx.jsx("span", { className: "udw_wsStat", title: translate("dist.unattrHint"), children: translate("dist.unattrHint") })
								]}),
							] }),
							jsx.jsx("span", { className: "udw_wsTokens", children: fmtTokens(unattributed.tokens, translate) })
						] })
					] }),
					// The reveal control. `hiddenCount > 0` shows 展开其余 N; once every
					// row is visible a 收起 link appears instead (only when something was
					// revealed), so the growth is always reversible. It lives OUTSIDE
					// the scroll region and pins to the card foot.
					hiddenCount > 0 ? jsx.jsx("button", {
						type: "button",
						className: "udw_distMore",
						onClick: () => revealMore(section.key, section.rows.length),
						children: translate(section.key === "p" ? "dist.showMoreProviders" : section.key === "m" ? "dist.showMoreModels" : "dist.showMoreWorkspaces", { count: hiddenCount })
					}) : revealed[section.key] > 0 ? jsx.jsx("button", {
						type: "button",
						className: "udw_distMore",
						onClick: () => setRevealed((prev) => ({ ...prev, [section.key]: 0 })),
						children: translate("dist.showLess")
					}) : null
				] }, section.key);
			}) });
		}

		/**
		 * The expanded body of one workspace row.
		 *
		 * Everything here comes from the summary payload, so nothing is fetched: the
		 * figures were already aggregated for the same window the ranking uses.
		 */
		function WorkspaceDetail({ row, translate }) {
			const parts = [
				[translate("detail.input"), fmtTokens(row.inputTokens, translate)],
				[translate("detail.output"), fmtTokens(row.outputTokens, translate)],
				[translate("workspace.cacheRead"), fmtTokens(row.cacheReadTokens, translate)],
				[translate("workspace.reasoning"), fmtTokens(row.reasoningTokens, translate)],
				[translate("workspace.hitRate"), fmtPercent(row.cacheHitRate)],
				// Every extended field is read defensively: an older host build still
				// serves a summary without them, and a missing one must leave a dash
				// rather than blank the whole card with a thrown render.
				[translate("workspace.attempts"), row.attempts === undefined ? "—" : `${fmtCalls(row.attempts)} · ${fmtPercent(row.successRate)}`],
				[translate("workspace.activeDays"), row.activeDays === undefined ? "—" : String(row.activeDays)],
				[translate("workspace.peak"), row.peakDay === null || row.peakDay === undefined ? "—" : `${row.peakDay.date} · ${fmtTokens(row.peakDay.tokens, translate)}`],
				[translate("workspace.providers"), !Array.isArray(row.providers) || row.providers.length === 0 ? "—" : row.providers.slice(0, 3).join(" · ")]
			];
			const activity = row.activity;
			const tools = activity === undefined || !Array.isArray(activity.tools) ? [] : activity.tools;
			const work = activity === undefined ? [] : [
				[translate("workspace.toolCalls"), fmtCalls(activity.toolCalls)],
				[translate("workspace.compactions"), activity.compactions === 0 ? "0" : `${fmtCalls(activity.compactions)} · ${fmtDuration(activity.compactionMs)}`],
				[translate("workspace.llmTime"), activity.llmCalls === 0 ? "—" : `${fmtDuration(activity.llmMs)} / ${fmtCalls(activity.llmCalls)} 步`]
			];
			return jsx.jsxs("div", { className: "udw_wsDetail", children: [
				jsx.jsx("div", { className: "udw_wsPath", children: row.cwd }),
				jsx.jsx("dl", { className: "udw_wsFacts", children: parts.map(([label, value]) => jsx.jsxs("div", { className: "udw_wsFact", children: [
					jsx.jsx("dt", { children: label }),
					jsx.jsx("dd", { children: value })
				] }, label)) }),
				work.length === 0 ? null : jsx.jsx("dl", { className: "udw_wsFacts", children: work.map(([label, value]) => jsx.jsxs("div", { className: "udw_wsFact", children: [
					jsx.jsx("dt", { children: label }),
					jsx.jsx("dd", { children: value })
				] }, label)) }),
				// Tool ranking. Omitted entirely when there are none, rather than
				// drawn as an empty box.
				tools.length === 0 ? null : jsx.jsxs("div", { className: "udw_wsTools", children: [
					jsx.jsx("div", { className: "udw_wsToolsHead", children: translate("workspace.toolsTitle") }),
					jsx.jsx("div", { className: "udw_wsToolRows", children: tools.slice(0, 12).map((tool) => jsx.jsxs("div", { className: "udw_wsToolRow", children: [
						jsx.jsx("span", { className: "udw_wsToolName", title: tool.name, children: tool.name }),
						jsx.jsxs("span", { className: "udw_wsToolNum", children: [fmtCalls(tool.calls), " 次"] }),
						jsx.jsxs("span", { className: "udw_wsToolNum", children: [translate("workspace.avg"), fmtDuration(tool.avgMs)] }),
						jsx.jsxs("span", { className: "udw_wsToolNum", children: [translate("workspace.max"), fmtDuration(tool.maxMs)] }),
						// A failure count is only worth ink when it is not zero.
						jsx.jsx("span", { className: tool.failedCalls > 0 ? "udw_wsToolFail" : "udw_wsToolNum", children: tool.failedCalls > 0 ? `${translate("workspace.failed")} ${fmtCalls(tool.failedCalls)}` : "" })
					] }, tool.name)) })
				] })
			] });
		}

		/**
		 * Mark the sidebar row that belongs to this plugin and hand it the figure.
		 *
		 * Called from `label` (which the shell invokes on every list rebuild) and
		 * from the refresher after each read. The row element is looked up by this
		 * plugin's own `data-dsh-panel-entry` on the glyph, so nothing here depends
		 * on the shell's generated class names.
		 */
		function applyPanelRowMark() {
			const mark = document.querySelector(`[data-dsh-panel-entry="${PANEL_ID}"]`);
			const row = mark === null ? null : mark.closest("button");
			if (row === null) return;
			row.setAttribute("data-udw-row", "true");
			const titleEl = row.querySelector('[class*="panelTitle"]');
			if (titleEl === null) return;
			titleEl.setAttribute("data-udw-title", "true");
			// CSS `content` needs a quoted string, and the figure must never be able to
			// break out of those quotes.
			// Only quotes and backslashes can terminate the CSS string early; stripping
			const quoted = String.fromCharCode(34) + panelLabelSuffix.replace(/["\\\\]/g, "") + String.fromCharCode(34);
			// Two properties, not one: the marker decides whether the ::after rule draws
			// anything, so an empty figure leaves the title exactly as the shell drew it.
			titleEl.style.setProperty("--udw-figure", quoted);
			titleEl.style.setProperty("--udw-figure-on", panelLabelSuffix === "" ? "0" : "1");
		}

		/** Model ranking card with the token share of each model. */
		function ModelSection({ models, translate, limit }) {
			const total = models.reduce((sum, row) => sum + row.tokens, 0);
			const rows = models.slice(0, limit ?? 8);
			if (rows.length === 0) {
				return jsx.jsx("div", { className: "udw_card", children: jsx.jsx("div", { className: "udw_cardBody", children: jsx.jsx("div", { className: "udw_detailEmpty", children: translate("rank.empty") }) }) });
			}
			return jsx.jsxs("div", { className: "udw_card", children: [
				jsx.jsxs("div", { className: "udw_cardHead", children: [
					jsx.jsxs("h2", { className: "udw_cardTitle", children: [jsx.jsx(IconStack, { size: 16 }), translate("rank.title")] })
				] }),
				jsx.jsxs("div", { className: "udw_cardBody", children: [jsx.jsx("div", { className: "udw_rank", children: rows.map((row, index) => {
					const share = total > 0 ? (row.tokens / total) * 100 : 0;
					const { provider, model } = splitModelKey(row.model);
					return jsx.jsxs("div", { className: "udw_rankRow", children: [
						jsx.jsx("span", { className: "udw_rankIndex", children: String(index + 1).padStart(2, "0") }),
						jsx.jsxs("div", { className: "udw_rankName", children: [
							jsx.jsx("span", { className: "udw_rankModel", title: row.model, children: row.name ?? model }),
							jsx.jsxs("span", { className: "udw_rankMeta", children: [provider, " · ", translate("rank.calls", { count: fmtCalls(row.calls) })] })
						] }),
						jsx.jsxs("div", { className: "udw_rankValue", children: [
							jsx.jsx("span", { children: fmtTokens(row.tokens, translate) }),
							jsx.jsx("span", { className: "udw_rankShare", children: `${share.toFixed(1)}%` })
						] }),
						jsx.jsx("div", { className: "udw_rankTrack", children: jsx.jsx("div", {
							className: "udw_rankFill",
							style: { width: `${Math.max(1.5, share)}%`, background: accentOf(provider) }
						}) })
					] }, row.model);
				}) })] })
			] });
		}

		/** Trend card wrapper. */
		function TrendCard({ days, translate }) {
			return jsx.jsxs("div", { className: "udw_card", children: [
				jsx.jsxs("div", { className: "udw_cardHead", children: [
					jsx.jsxs("h2", { className: "udw_cardTitle", children: [jsx.jsx(IconTrend, { size: 16 }), translate("trend.title")] }),
					jsx.jsxs("div", { className: "udw_trendLegend", children: [
						jsx.jsxs("span", { className: "udw_trendLegendItem", children: [
							jsx.jsx("span", { className: "udw_trendLegendLine", style: { background: HEAT_HUE } }),
							translate("trend.tokens")
						] }),
						jsx.jsxs("span", { className: "udw_trendLegendItem", children: [
							jsx.jsx("span", { className: "udw_trendLegendLine", style: { background: CALL_HUE } }),
							translate("trend.calls")
						] })
					] })
				] }),
				jsx.jsx("div", { className: "udw_cardBody", children: jsx.jsx(TrendChart, { days, translate }) })
			] });
		}
		//#endregion

		//#region page
		/**
		 * The figure the sidebar row shows after its label: today's tokens and the
		 * call count behind them. Empty until the first read lands, which is what
		 * `applyPanelRowMark` treats as "draw nothing extra".
		 */
		let panelLabelSuffix = "";

		/**
		 * The whole dashboard page. It owns the read lifecycle: load, background
		 * refresh, retry after failure, and the selected day.
		 */
		function DashboardPage({ t, initialState }) {
			const translate = react.useCallback((key, params) => interpolate(typeof t === "function" ? t(key) : key, params), [t]);
			const [tab, setTab] = react.useState(initialState?.tab ?? "overview");
			// The selected RANGE, not a bare day count: a range carries both the
			// payload window and the calendar span, so the two cannot drift apart.
			const [range, setRange] = react.useState(initialState?.range ?? DEFAULT_RANGE);
			// Custom-range picker: open flag plus the two draft dates. Drafts stay
			// local until both ends are valid, so a half-filled range never refetches.
			const [pickerOpen, setPickerOpen] = react.useState(false);
			const [draftFrom, setDraftFrom] = react.useState(dayKeyOf(new Date(Date.now() - 89 * 86400000)));
			const [draftTo, setDraftTo] = react.useState(todayKey());
			const [payload, setPayload] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [selected, setSelected] = react.useState(null);
			const [refreshToken, setRefreshToken] = react.useState(0);
			const abortRef = react.useRef(null);

			// A range change re-reads the payload; the open dialog would then describe
			// a day outside the new window, so it closes.
			react.useEffect(() => {
				setSelected(null);
			}, [range]);

			// One read per (window, refresh token). A new window aborts the
			// previous request so a fast toggle cannot land a stale payload.
			react.useEffect(() => {
				const controller = new AbortController();
				abortRef.current?.abort();
				abortRef.current = controller;
				let cancelled = false;
				setLoading(true);
				setError(null);
				loadSummary(range, { signal: controller.signal, refresh: refreshToken === 0 })
					.then((next) => {
						if (cancelled) return;
						setPayload((previous) => (samePayload(previous, next) ? previous : next));
						setLoading(false);
					})
					.catch((failure) => {
						if (cancelled || failure.name === "AbortError") return;
						setError(failure.message);
						setLoading(false);
					});
				return () => {
					cancelled = true;
					controller.abort();
				};
			}, [range, refreshToken]);

			// Background refresh while the page is open. Each read folds the live
			// in-memory tail, so the current day stays current without a store walk.
			react.useEffect(() => {
				const timer = window.setInterval(() => setRefreshToken((token) => token + 1), REFRESH_MS);
				return () => window.clearInterval(timer);
			}, []);

			// While the host is still folding, poll so the figures fill in. The
			// payload is only replaced when its CONTENT changed, so an unchanged
			// refresh does not re-render the page under the user's pointer (which
			// previously swallowed clicks aimed at the tabs).
			react.useEffect(() => {
				if (payload === null || payload.refreshing !== true) return undefined;
				const timer = window.setTimeout(() => setRefreshToken((token) => token + 1), 3_000);
				return () => window.clearTimeout(timer);
			}, [payload === null ? null : payload.refreshing, payload === null ? 0 : payload.updatedAt]);

			const dayMap = react.useMemo(() => {
				if (payload === null) return new Map();
				const map = new Map();
				for (const day of payload.days) map.set(day.date, day);
				return map;
			}, [payload]);

			/**
			 * The open day dialog. `selected` is only ever set by clicking a
			 * calendar cell, and a cell with no usage opens the dialog too: it
			 * explains that the day is empty instead of silently doing nothing.
			 */
			const selectedDay = selected === null ? null : dayMap.get(selected) ?? null;
			const closeDialog = react.useCallback(() => setSelected(null), []);

			/** Apply the drafted range; the host clamps anything past one year. */
			const applyDraft = react.useCallback(() => {
				setRange(customRange(draftFrom, draftTo));
				setPickerOpen(false);
			}, [draftFrom, draftTo]);

			/** Whether the range is a hand-picked span rather than a preset. */
			const isCustom = range.key === "custom";

			/** Whole days covered by the current draft, inclusive. */
			const spannedDays = react.useMemo(() => {
				const lo = parseDay(draftFrom <= draftTo ? draftFrom : draftTo);
				const hi = parseDay(draftFrom <= draftTo ? draftTo : draftFrom);
				if (Number.isNaN(lo.getTime()) || Number.isNaN(hi.getTime())) return 0;
				return Math.round((hi - lo) / 86400000) + 1;
			}, [draftFrom, draftTo]);
			const windowModels = react.useMemo(() => {
				if (payload === null) return [];
				const map = new Map();
				for (const day of payload.days) for (const row of day.byModel) {
					const current = map.get(row.model) ?? { model: row.model, name: row.name, tokens: 0, calls: 0 };
					current.tokens += row.tokens;
					current.calls += row.calls;
					map.set(row.model, current);
				}
				return [...map.values()].sort((a, b) => b.tokens - a.tokens);
			}, [payload]);
			const windowProviders = react.useMemo(() => {
				if (payload === null) return [];
				const map = new Map();
				for (const day of payload.days) for (const row of day.byProvider) {
					const current = map.get(row.provider) ?? { provider: row.provider, tokens: 0, calls: 0 };
					current.tokens += row.tokens;
					current.calls += row.calls;
					map.set(row.provider, current);
				}
				return [...map.values()].sort((a, b) => b.tokens - a.tokens);
			}, [payload]);

			// Four tabs, each a distinct view. A "calendar" tab repeated the
			// overview's calendar verbatim, so it stays removed rather than kept as
			// a shortcut to the same screen.
			const tabs = [
				{ id: "overview", label: translate("tab.overview") },
				{ id: "dist", label: translate("tab.dist") }
			];

			const updatedLabel = payload === null
				? null
				: translate("page.updatedAt", { time: new Date(payload.updatedAt).toLocaleTimeString() });

			return jsx.jsxs("div", { "data-dsh-token-board-view": "", "data-dsh-plugin": "dsh-token-board", children: [
				jsx.jsx("div", { className: "udw_scroll", children: jsx.jsxs("div", { className: "udw_page", children: [
					jsx.jsxs("header", { className: "udw_header", children: [
						jsx.jsxs("div", { className: "udw_headerText", children: [
							jsx.jsx("h1", { className: "udw_title", children: translate("page.title") }),
							jsx.jsx("p", { className: "udw_subtitle", children: translate("page.subtitle") })
						] }),
						jsx.jsxs("div", { className: "udw_headerTools", children: [
							updatedLabel === null ? null : jsx.jsx("span", { className: "udw_stamp", children: updatedLabel }),
							// ONE pill group: every range — including 全部 and 自定义 — is a peer
							// segment of the same control, so they share size, radius and states.
							jsx.jsx("div", { className: "udw_segmented", role: "group", "aria-label": translate("window.label"), children: [
								WINDOWS.map((preset) => jsx.jsx("button", {
									type: "button",
									className: "udw_segment",
									"data-active": range.key === preset.key ? "true" : "false",
									"aria-pressed": range.key === preset.key ? "true" : "false",
									onClick: () => setRange(preset),
									children: translate(`window.${preset.key}`)
								}, preset.key)),
								jsx.jsx("button", {
									type: "button",
									className: "udw_segment",
									"data-active": isCustom ? "true" : "false",
									"aria-pressed": isCustom ? "true" : "false",
									"aria-expanded": pickerOpen ? "true" : "false",
									onClick: () => setPickerOpen((open) => !open),
									children: isCustom ? `${range.from} → ${range.to}` : translate("window.custom")
								})
							] }),
							jsx.jsx("button", {
								type: "button",
								className: "udw_iconButton",
								"aria-label": translate("state.retry"),
								onClick: () => setRefreshToken((token) => token + 1),
								children: jsx.jsx(IconRefresh, { size: 15 })
							}),
							pickerOpen
								? jsx.jsxs("div", { className: "udw_pickerPop", role: "dialog", "aria-label": translate("window.custom"), children: [
									jsx.jsxs("label", { className: "udw_pickerField", children: [
										jsx.jsx("span", { children: translate("window.from") }),
										jsx.jsx("input", { type: "date", value: draftFrom, max: draftTo, className: "udw_dateInput", onChange: (event) => setDraftFrom(event.target.value) })
									] }),
									jsx.jsxs("label", { className: "udw_pickerField", children: [
										jsx.jsx("span", { children: translate("window.to") }),
										jsx.jsx("input", { type: "date", value: draftTo, min: draftFrom, className: "udw_dateInput", onChange: (event) => setDraftTo(event.target.value) })
									] }),
									spannedDays > MAX_RANGE_DAYS
										? jsx.jsx("p", { className: "udw_pickerWarn", children: translate("window.tooLong", { days: MAX_RANGE_DAYS }) })
										: jsx.jsx("p", { className: "udw_pickerHint", children: translate("window.spanDays", { days: spannedDays }) }),
									jsx.jsxs("div", { className: "udw_pickerActions", children: [
										jsx.jsx("button", { type: "button", className: "udw_pickerCancel", onClick: () => setPickerOpen(false), children: translate("window.cancel") }),
										jsx.jsx("button", { type: "button", className: "udw_pickerApply", onClick: applyDraft, children: translate("window.apply") })
									] })
								] })
								: null
							] })
						] }),

					jsx.jsx("nav", { "aria-label": translate("page.title"), children: jsx.jsxs("div", { className: "udw_segmented", role: "tablist", children: tabs.map((entry) => jsx.jsx("button", {
						type: "button",
						role: "tab",
						className: "udw_segment",
						"data-active": tab === entry.id ? "true" : "false",
						"aria-selected": tab === entry.id ? "true" : "false",
						onClick: () => setTab(entry.id),
						children: entry.label
					}, entry.id)) }) }),

					payload !== null && payload.partial === true
						? jsx.jsxs("div", { className: "udw_banner", children: [
							jsx.jsx(IconRefresh, { size: 13 }),
							translate("state.loadingPartial")
						] })
						: null,
					error !== null
						? jsx.jsxs("div", { className: "udw_state", children: [
							jsx.jsx(IconAlert, { size: 26, className: "udw_stateIcon" }),
							jsx.jsx("p", { className: "udw_stateTitle", children: translate("state.errorTitle") }),
							jsx.jsx("p", { className: "udw_stateBody", children: translate("state.errorBody", { message: error }) }),
							jsx.jsxs("button", {
								type: "button",
								className: "udw_retry",
								onClick: () => setRefreshToken((token) => token + 1),
								children: [jsx.jsx(IconRefresh, { size: 14 }), translate("state.retry")]
							})
						] })
						: loading && payload === null
							? jsx.jsx(LoadingState, { translate })
							: payload === null
								? jsx.jsx(EmptyState, { translate })
								: payload.days.length === 0
									? jsx.jsx(EmptyState, { translate })
									: jsx.jsxs(jsx.Fragment, { children: [
										jsx.jsx(MetricGrid, { payload, range, translate }),
										tab === "overview"
											? jsx.jsxs(jsx.Fragment, { children: [
												jsx.jsx(CalendarCard, {
													days: payload.days,
													range,
													selected,
													today: todayKey(),
													onSelect: setSelected,
													translate
												}),
												jsx.jsx(TrendCard, { days: payload.days, translate })
												// No provider distribution and no model ranking here: the
												// "By provider" and "By model" tabs own those views, so
												// repeating them would make several tabs one screen.
											] })
											: null,
										tab === "dist"
											? jsx.jsx(DistributionSection, {
												providers: windowProviders,
												models: windowModels,
												workspaces: payload.workspaces ?? [],
												unattributed: payload.unattributed ?? null,
												translate
											})
											: null,
									] })
				] }) }),
				selected === null ? null : jsx.jsx(DayDialog, {
					day: selectedDay,
					date: selected,
					translate,
					onClose: closeDialog
				})
			] });
		}

		/** Loading skeleton in the final layout's shape, so nothing jumps. */
		function LoadingState({ translate }) {
			return jsx.jsxs("div", { className: "udw_metrics", children: [0, 1, 2, 3].map((index) => jsx.jsxs("div", { className: "udw_metric", children: [
				jsx.jsx("div", { className: "udw_skeleton", style: { height: "14px", width: "55%" } }),
				jsx.jsx("div", { className: "udw_skeleton", style: { height: "30px", width: "78%" } }),
				jsx.jsx("div", { className: "udw_skeleton", style: { height: "12px", width: "45%" } })
			] }, `s${index}`)) });
		}

		/** Empty state: an explanation plus the next action, never a bare dash. */
		function EmptyState({ translate }) {
			return jsx.jsxs("div", { className: "udw_state", children: [
				jsx.jsx(IconStack, { size: 26, className: "udw_stateIcon" }),
				jsx.jsx("p", { className: "udw_stateTitle", children: translate("state.emptyTitle") }),
				jsx.jsx("p", { className: "udw_stateBody", children: translate("state.emptyBody") })
			] });
		}
		//#endregion

		//#region registration
		/**
		 * Register the sidebar row and the center-column page.
		 *
		 * Both seats belong to shell plugins (ui-sidebar / ui-layout) that this
		 * package does not depend on at runtime, so each registration is wrapped
		 * in `ctx.slots.inject`: the callback runs only after the owning entry
		 * declares the seat, and a shell that never declares it leaves the row
		 * absent instead of failing boot.
		 */
		function registerPanel(ctx) {
			const slots = ctx.slots;
			const disposers = [
				slots.inject("sidebar.panellist", () => slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: PANEL_ORDER,
					// The shell re-renders the row from this callback, so the live
					// figure is applied on the next frame — after that build's DOM
					// exists. Applying it inside the callback would look up a row that
					// has not mounted yet, and a miss is a silent no-op by design.
					label: () => {
						window.requestAnimationFrame(applyPanelRowMark);
						return translateRuntime("entry.label");
					}
				}, PanelRowIcon)),
				slots.inject("main", () => slots.register({
					name: "main",
					key: PANEL_ID,
					inject: () => ({ t: bindTranslate() })
				}, DashboardPage))
			];
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}
		//#endregion

		//#region label refresh
		/**
		 * Keep the row's figure current.
		 *
		 * ui-sidebar rebuilds its panel list on `slots.subscribe("sidebar.panellist")`
		 * and on every locale publish, so the figure reaches the DOM through one of
		 * those. `locale.register` is the only public call that publishes, and its
		 * disposer publishes too: registering a throwaway dictionary key both
		 * pushes the new label out and costs nothing.
		 *
		 * The toast is deliberately a dictionary entry rather than a resource update:
		 * a namespace re-registration of the SAME entries throws, so this uses a
		 * unique key under a private namespace.
		 */
		function startLabelRefresh(ctx, logger) {
			let cancelled = false;
			let sequence = 0;
			let disposeRegistration = null;
			let published = false;
			const publish = (tokens, calls) => {
				panelLabelSuffix = `${fmtTokens(tokens, bindTranslate())} · ${fmtCalls(calls)}次`;
				published = true;
				sequence += 1;
				try {
					if (disposeRegistration !== null) disposeRegistration();
					disposeRegistration = ctx.locale.register(LABEL_NS, {
						"en": { [`tick.${sequence}`]: String(sequence) }
					});
				} catch (error) {
					logger?.warn?.(`dsh-token-board: label refresh failed: ${String(error)}`);
				}
			};
			const read = (first) => {
				loadSummary(DEFAULT_RANGE, { refresh: first })
					.then((payload) => {
						if (cancelled) return;
						const days = payload.days ?? [];
						const local = days.find((day) => day.date === todayKey());
						const tokens = local === undefined ? 0 : local.tokens;
						const calls = local === undefined ? 0 : local.calls;
						// Right after a restart the host is still folding, and the day row
						// it reports is a partial count. Showing that number would label
						// today's spend with a value that visibly jumps seconds later, so a
						// zero during a partial generation is treated as "not ready" and
						// retried shortly instead of being published.
						if (tokens === 0 && calls === 0 && payload.partial === true) {
							if (!published) window.setTimeout(() => read(false), 1_500);
							return;
						}
							// A generation published while a scan is still running will grow:
							// today's figure would sit behind the page's until the next full
							// interval. Follow the host's own readiness signal instead — re-read
							// in 2s while it settles, so both readers land on the same number.
							if (payload.partial === true || payload.refreshing === true) {
								window.setTimeout(() => read(false), 2_000);
								return;
							}
						publish(tokens, calls);
					})
					.catch((error) => {
						if (cancelled || error?.name === "AbortError") return;
						// A failed first read is worth one retry: the row would otherwise
						// stay blank for a whole refresh interval after a boot hiccup.
						if (first && !published) window.setTimeout(() => read(false), 2_000);
					});
			};
			read(true);
			const timer = window.setInterval(() => read(false), BUBBLE_REFRESH_MS);
			return () => {
				cancelled = true;
				window.clearInterval(timer);
				if (disposeRegistration !== null) disposeRegistration();
			};
		}
		//#endregion

		let runtimeTranslate = null;
		function translateRuntime(key, params) {
			if (runtimeTranslate === null) return key;
			return interpolate(runtimeTranslate(key), params);
		}
		function bindTranslate() {
			return runtimeTranslate ?? ((key) => key);
		}

		/** Required services: slot registration and the locale registry. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register dictionaries, keep one stable translate
		 * binding, then register the row and page.
		 * @param ctx - client root context (services: slots, locale).
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-token-board: dictionaries");
			try {
				runtimeTranslate = ctx.locale.bind(NS);
			} catch {
				runtimeTranslate = null;
			}
			ctx.effect(() => registerPanel(ctx), "dsh-token-board: sidebar row + page");
			ctx.effect(() => startLabelRefresh(ctx, ctx.logger), "dsh-token-board: live row figure");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		// Preview entry: the page component itself, so the offline preview
		// harness can render it without a host. Not used by the shell.
		exports.__previewPage = DashboardPage;
		return module.exports;
	}
});
