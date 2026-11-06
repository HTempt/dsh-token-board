/**
 * Visual preview harness for the dashboard client bundle.
 *
 * Loads the real `lib/client.js` through a fake `__ModuleLoader__` with the
 * page's own module exports, mocks the two host endpoints with representative
 * fixtures, and renders the page into a real browser. This is how the layout
 * gets eyes on it before it ships into the running GUI.
 *
 * Serve with any static server (`node preview/server.mjs`) and open
 * `preview/preview.html?scene=...`.
 */
window.__MODULE_TABLE__ = {};

(function boot() {
	const modules = {};
	const factories = {};
	const cache = {};
	// The bundle names itself (`id` in `__ModuleLoader__.load`), and that name
	// changes whenever the package is renamed. Remembering it here means the
	// harness never has to be told the name a second time.
	const loadedIds = [];
	window.__ModuleLoader__ = {
		load(entry) {
			factories[entry.id] = entry.factory;
			loadedIds.push(entry.id);
		},
		require(id) {
			return require(id);
		}
	};

	const translate = (key, params) => {
		const dict = window.__PREVIEW_LOCALE__ === "en" ? window.__PREVIEW_EN__ : window.__PREVIEW_ZH__;
		const template = dict[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
	};
	window.__PREVIEW_TRANSLATE__ = translate;

	function require(id) {
		if (cache[id] !== undefined) return cache[id];
		if (id === "react") {
			cache[id] = window.React;
			return cache[id];
		}
		if (id === "react/jsx-runtime") {
			// Match the real runtime's contract: jsx(type, props, key). The key is
		// the THIRD argument, never a child, so a stray third argument must not
		// be passed through as children.
		const make = (type, props, key) => {
				const next = props === undefined ? {} : Object.assign({}, props);
				if (key !== undefined) next.key = key;
				return window.React.createElement(type, next);
			};
			cache[id] = { jsx: make, jsxs: make, Fragment: window.React.Fragment };
			return cache[id];
		}
		// Any other module is an injected service we do not need in the preview.
		cache[id] = {};
		return cache[id];
	}

	window.__PREVIEW_LOAD__ = function load() {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			// Load the REAL bundle, not a copy: preview/client.js used to be a
			// byte-identical duplicate of lib/client.js, which meant every UI fix
		// had to be copied to two places and a stale copy silently previewed
		// old code. server.mjs resolves this path; the static host must serve
		// the parent directory for it to load.
			script.src = "../lib/client.js";
			script.onload = () => {
				const id = loadedIds[loadedIds.length - 1];
				const factory = id === undefined ? undefined : factories[id];
				if (factory === undefined) {
					reject(new Error("client bundle did not register its factory"));
					return;
				}
				resolve(factory(require));
			};
			script.onerror = () => reject(new Error("client.js did not load"));
			document.head.appendChild(script);
		});
	};
})();

window.__PREVIEW_ZH__ ={
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

window.__PREVIEW_EN__ ={
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
