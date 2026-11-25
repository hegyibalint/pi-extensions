import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BAR_WIDTH = 20;
const QUOTA_REFRESH_MS = 60_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const AUTH_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");

type Theme = {
	fg(color: "text" | "dim" | "muted" | "warning" | "error", text: string): string;
};

interface Totals {
	input: number;
	output: number;
	cost: number;
}

interface OAuthAuth {
	type: "oauth";
	accountId?: string;
}

interface QuotaWindow {
	usedPercentage: number;
	resetsAt?: number;
	windowSeconds: number;
}

interface QuotaState {
	provider: string;
	status: "loading" | "ready" | "unavailable";
	windows: QuotaWindow[];
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) {
		const value = tokens / 1_000;
		return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}k`;
	}
	const value = tokens / 1_000_000;
	return `${value.toFixed(value >= 10 ? 1 : 2).replace(/\.0$/, "")}m`;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(0)}`;
}

function contextColor(theme: Theme, percentage: number, text: string): string {
	if (percentage >= 90) return theme.fg("error", text);
	if (percentage >= 70) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function remainingColor(theme: Theme, percentage: number, text: string): string {
	if (percentage <= 10) return theme.fg("error", text);
	if (percentage <= 30) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function readOAuth(provider: string): OAuthAuth | null {
	try {
		const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, OAuthAuth>;
		const entry = auth[provider];
		return entry?.type === "oauth" ? entry : null;
	} catch {
		return null;
	}
}

function readCodexCliOAuth(): { access: string; accountId?: string } | null {
	try {
		const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
		const auth = JSON.parse(readFileSync(path, "utf8"));
		if (auth.auth_mode && auth.auth_mode !== "chatgpt") return null;
		const tokens = auth.tokens;
		if (typeof tokens?.access_token !== "string" || !tokens.access_token.trim()) return null;
		return {
			access: tokens.access_token,
			accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
		};
	} catch {
		return null;
	}
}

function epochSeconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric / 1000 : numeric;
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed / 1000;
	}
	return undefined;
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function fetchCodexQuota(access: string, accountId?: string): Promise<QuotaWindow[]> {
	const data = await requestJson("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${access}`,
			Accept: "application/json",
			"User-Agent": "codex-cli",
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
	}) as any;

	const primary = data?.rate_limit?.primary_window;
	const secondary = data?.rate_limit?.secondary_window;
	return [
		primary && {
			usedPercentage: Number(primary.used_percent),
			resetsAt: epochSeconds(primary.reset_at),
			windowSeconds: Number(primary.limit_window_seconds) || FIVE_HOURS_SECONDS,
		},
		secondary && {
			usedPercentage: Number(secondary.used_percent),
			resetsAt: epochSeconds(secondary.reset_at),
			windowSeconds: Number(secondary.limit_window_seconds) || SEVEN_DAYS_SECONDS,
		},
	].filter((window): window is QuotaWindow => Boolean(window) && Number.isFinite(window.usedPercentage));
}

async function fetchAnthropicQuota(access: string): Promise<QuotaWindow[]> {
	const data = await requestJson("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${access}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"anthropic-beta": "oauth-2025-04-20",
			"User-Agent": "pi-statusbar",
		},
	}) as any;
	const parse = (raw: any, windowSeconds: number): QuotaWindow | null => {
		if (!raw || raw.utilization === undefined) return null;
		const utilization = Number(raw.utilization);
		const usedPercentage = utilization <= 1 ? utilization * 100 : utilization;
		return Number.isFinite(usedPercentage)
			? { usedPercentage, resetsAt: epochSeconds(raw.resets_at), windowSeconds }
			: null;
	};
	return [parse(data?.five_hour, FIVE_HOURS_SECONDS), parse(data?.seven_day, SEVEN_DAYS_SECONDS)]
		.filter((window): window is QuotaWindow => window !== null);
}

async function fetchQuota(ctx: ExtensionContext): Promise<Pick<QuotaState, "windows">> {
	const model = ctx.model;
	if (!model || !["openai", "openai-codex", "anthropic"].includes(model.provider)) return { windows: [] };
	if (!ctx.modelRegistry.isUsingOAuth(model)) return { windows: [] };
	if (model.provider === "openai") {
		// Direct tokens cannot read Codex usage; use the CLI credential as a read-only fallback.
		// Read only: Codex owns refreshing its credentials, and may be signed into a different account.
		const cli = readCodexCliOAuth();
		if (!cli) return { windows: [] };
		return { windows: await fetchCodexQuota(cli.access, cli.accountId) };
	}
	// Pi serializes refreshes and persists rotated credentials; the footer must not refresh independently.
	const access = (await ctx.modelRegistry.getProviderAuth(model.provider))?.auth.apiKey;
	if (!access) return { windows: [] };
	const windows = model.provider === "openai-codex"
		? await fetchCodexQuota(access, readOAuth("openai-codex")?.accountId)
		: await fetchAnthropicQuota(access);
	return { windows };
}

function progressBar(theme: Theme, percentage: number | null, width: number): string {
	if (percentage === null) return theme.fg("dim", "░".repeat(width));
	const used = Math.max(0, Math.min(100, percentage));
	const filled = Math.round((used * width) / 100);
	const color = used >= 90 ? "error" : used >= 70 ? "warning" : "text";
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function formatRemaining(resetsAt?: number): string {
	if (!resetsAt) return "—";
	let seconds = Math.max(0, Math.floor(resetsAt - Date.now() / 1000));
	const days = Math.floor(seconds / 86_400);
	seconds %= 86_400;
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${String(minutes).padStart(2, "0")}`;
	return `${minutes}m`;
}

function formatQuota(theme: Theme, window: QuotaWindow): string {
	const used = Math.max(0, Math.min(100, window.usedPercentage));
	const remaining = 100 - used;
	const number = remainingColor(theme, remaining, `${Math.round(remaining)}%`);
	if (!window.resetsAt) return theme.fg("dim", "· — ") + number;

	const startedAt = window.resetsAt - window.windowSeconds;
	const elapsed = Date.now() / 1000 - startedAt;
	const expectedUsed = Math.max(0, Math.min(100, (elapsed / window.windowSeconds) * 100));
	const rawDelta = expectedUsed - used;
	const delta = Math.round(rawDelta);
	const deadZone = window.windowSeconds <= FIVE_HOURS_SECONDS ? 5 : 0;
	let pacing = theme.fg("dim", "~0%");
	if (Math.abs(rawDelta) > deadZone && delta < 0) {
		const burn = -delta;
		pacing = burn >= 30
			? theme.fg("error", `↓${burn}%`)
			: burn >= 10 ? theme.fg("warning", `↓${burn}%`) : theme.fg("dim", `↓${burn}%`);
	} else if (Math.abs(rawDelta) > deadZone && delta > 0) pacing = theme.fg("dim", `↑${delta}%`);
	return theme.fg("dim", `· ${formatRemaining(window.resetsAt)} `) + number + pacing;
}

function totalsFromBranch(entries: readonly unknown[]): Totals {
	const totals: Totals = { input: 0, output: 0, cost: 0 };
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; message?: { role?: string } };
		if (candidate.type !== "message" || candidate.message?.role !== "assistant") continue;
		const message = candidate.message as AssistantMessage;
		totals.input += message.usage?.input ?? 0;
		totals.output += message.usage?.output ?? 0;
		totals.cost += message.usage?.cost?.total ?? 0;
	}
	return totals;
}

export default function statusbar(pi: ExtensionAPI) {
	let enabled = true;
	let quota: QuotaState | null = null;
	let quotaTimer: ReturnType<typeof setInterval> | undefined;
	let refreshUsage: (() => void) | undefined;

	function stopQuotaRefresh(): void {
		if (quotaTimer) clearInterval(quotaTimer);
		quotaTimer = undefined;
		refreshUsage = undefined;
	}

	function install(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		stopQuotaRefresh();
		const provider = ctx.model?.provider ?? "";
		quota = ["openai", "openai-codex", "anthropic"].includes(provider)
			? { provider, status: "loading", windows: [] }
			: null;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			let refreshing = false;
			let disposed = false;
			const refresh = async () => {
				if (refreshing || disposed) return;
				refreshing = true;
				try {
					const result = await fetchQuota(ctx);
					if (!disposed && quota?.provider === provider) {
						quota = { provider, status: result.windows.length ? "ready" : "unavailable", ...result };
					}
				} catch {
					if (!disposed && quota?.provider === provider) {
						quota = { provider, status: "unavailable", windows: [] };
					}
				} finally {
					refreshing = false;
					if (!disposed) tui.requestRender();
				}
			};
			refreshUsage = () => { void refresh(); };
			refreshUsage();
			quotaTimer = setInterval(refreshUsage, QUOTA_REFRESH_MS);

			return {
				dispose() {
					disposed = true;
					unsubscribeBranch();
					stopQuotaRefresh();
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];

					const usage = ctx.getContextUsage();
					const percentage = usage?.percent ?? null;
					const percentageText = percentage === null
						? theme.fg("dim", "n/a")
						: contextColor(theme, percentage, `${Math.round(percentage)}%`);
					const tokenText = usage
						? `${usage.tokens === null ? "?" : formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`
						: "? / ?";

					const model = ctx.model?.name || ctx.model?.id || "no model";
					const thinking = pi.getThinkingLevel();
					const modelChip = thinking === "off" ? model : `${model} * ${thinking}`;
					const totals = totalsFromBranch(ctx.sessionManager.getBranch());
					const branch = footerData.getGitBranch();

					const prefix = theme.fg("muted", `[${modelChip}]`);
					const contextDetail = theme.fg("dim", `(${tokenText})`);
					const traffic = theme.fg("dim", `· ↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`);
					const cost = theme.fg("dim", `· ${formatCost(totals.cost)}`);
					const branchText = branch ? theme.fg("dim", `· git:${branch}`) : "";

					// Drop lower-priority details on narrow terminals, then shrink the bar.
					const currentQuota = quota;
					let quotaText: string[] = [];
					if (currentQuota && currentQuota.provider === ctx.model?.provider) {
						if (currentQuota.status === "ready") {
							quotaText = currentQuota.windows.slice(0, 2).map((window) => formatQuota(theme, window));
						} else {
							quotaText = [theme.fg("dim", currentQuota.status === "loading" ? "· quota loading" : "· quota unavailable")];
						}
					}
					const optional = [contextDetail, traffic, cost, ...quotaText, branchText].filter(Boolean);
					let barWidth = DEFAULT_BAR_WIDTH;
					const build = () => [prefix, progressBar(theme, percentage, barWidth), percentageText, ...optional]
						.filter(Boolean)
						.join(" ");
					let line = build();
					while (visibleWidth(line) > width && optional.length > 0) {
						optional.pop();
						line = build();
					}
					while (visibleWidth(line) > width && barWidth > 4) {
						barWidth--;
						line = build();
					}
					// Custom footers must render setStatus() values themselves.
					// Keep each status on its own line so one extension cannot hide another.
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, status]) => status.replace(/[\r\n]/g, " "))
						.filter(Boolean)
						.map((status) => truncateToWidth(theme.fg("muted", status), width, "…"));
					return [truncateToWidth(line, width, "…"), ...statuses];
				},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (enabled) install(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (enabled) install(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopQuotaRefresh();
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("statusbar", {
		description: "Toggle the Claude-like context and usage status bar",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (ctx.mode === "tui") {
				if (enabled) install(ctx);
				else {
					stopQuotaRefresh();
					ctx.ui.setFooter(undefined);
				}
			}
			if (ctx.hasUI) ctx.ui.notify(`Status bar ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
