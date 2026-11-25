import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// IDE context is optional: don't hold up prompts for a slow local peer.
const IPC_TIMEOUT_MS = 100;
const MAX_IPC_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_SELECTION_CHARS = 40_000;
const MAX_OPEN_TABS = 100;
const MAX_OPEN_TABS_CHARS = 20_000;
const MAX_STATUS_SELECTION_CHARS = 4_000;

interface Position {
	line: number;
	character: number;
}

interface Range {
	start: Position;
	end: Position;
}

interface FileDescriptor {
	label: string;
	path: string;
	fsPath?: string;
}

interface ActiveFile extends FileDescriptor {
	selection: Range;
	activeSelectionContent: string;
	selections: Range[];
}

interface IdeContext {
	activeFile?: ActiveFile;
	openTabs: FileDescriptor[];
}

interface IpcResponse {
	type?: string;
	requestId?: string;
	resultType?: "success" | "error";
	error?: string;
	result?: {
		ideContext?: IdeContext;
	};
}

function ipcSocketPaths(): string[] {
	if (process.platform === "win32") return [String.raw`\\.\pipe\codex-ipc`];

	const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	const primary = join(codexHome, "ipc", "ipc.sock");
	const uid = process.getuid?.();
	const legacyDirectory = join(tmpdir(), "codex-ipc");
	const legacy = uid === undefined
		? join(legacyDirectory, "ipc.sock")
		: uid === 0
			? join(legacyDirectory, "ipc.sock")
			: join(legacyDirectory, `ipc-${uid}.sock`);

	return primary === legacy ? [primary] : [primary, legacy];
}

async function validateUnixSocket(socketPath: string): Promise<void> {
	if (process.platform === "win32") return;

	const uid = process.getuid?.();
	if (uid === undefined) return;

	const directory = await lstat(dirname(socketPath));
	if (!directory.isDirectory() || directory.uid !== uid) {
		throw new Error("IPC socket directory is not owned by the current user");
	}
	if ((directory.mode & 0o022) !== 0) {
		throw new Error("IPC socket directory is writable by other users");
	}

	const socket = await lstat(socketPath);
	if (!socket.isSocket() || socket.uid !== uid) {
		throw new Error("IPC socket is not owned by the current user");
	}
}

function fetchFromSocket(socketPath: string, workspaceRoot: string, timeoutMs: number): Promise<IdeContext> {
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const request = {
			type: "request",
			requestId,
			sourceClientId: `pi-${process.pid}`,
			version: 0,
			method: "ide-context",
			params: { workspaceRoot },
		};
		const payload = Buffer.from(JSON.stringify(request), "utf8");
		const frame = Buffer.allocUnsafe(4 + payload.length);
		frame.writeUInt32LE(payload.length, 0);
		payload.copy(frame, 4);

		let buffered = Buffer.alloc(0);
		let expectedLength: number | undefined;
		let settled = false;
		const socket = createConnection(socketPath);

		const finish = (error?: Error, context?: IdeContext): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(context ?? { openTabs: [] });
		};

		// Absolute deadline: incoming data must not reset the timeout.
		const timer = setTimeout(() => finish(new Error("timed out waiting for IDE context")), timeoutMs);
		socket.once("connect", () => socket.write(frame));
		socket.once("error", (error) => finish(error));
		socket.once("end", () => finish(new Error("IDE IPC connection closed before responding")));
		socket.on("data", (chunk) => {
			buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

			while (!settled) {
				if (expectedLength === undefined) {
					if (buffered.length < 4) return;
				expectedLength = buffered.readUInt32LE(0);
				buffered = buffered.subarray(4);
				if (expectedLength === 0 || expectedLength > MAX_IPC_FRAME_BYTES) {
					finish(new Error(`invalid IDE IPC frame length: ${expectedLength}`));
					return;
				}
				}

				if (buffered.length < expectedLength) return;
				const body = buffered.subarray(0, expectedLength);
				buffered = buffered.subarray(expectedLength);
				expectedLength = undefined;

				let response: IpcResponse;
				try {
					response = JSON.parse(body.toString("utf8")) as IpcResponse;
				} catch (error) {
					finish(new Error(`invalid IDE IPC JSON: ${error instanceof Error ? error.message : String(error)}`));
					return;
				}

				if (response.type !== "response" || response.requestId !== requestId) continue;
				if (response.resultType === "error") {
					finish(new Error(response.error || "IDE context request failed"));
					return;
				}
				if (response.resultType !== "success" || !response.result?.ideContext) {
					finish(new Error("IDE context response had an unexpected shape"));
					return;
				}
				finish(undefined, response.result.ideContext);
			}
		});
	});
}

async function fetchIdeContext(workspaceRoot: string): Promise<IdeContext> {
	const deadline = Date.now() + IPC_TIMEOUT_MS;
	let lastError: Error | undefined;

	for (const socketPath of ipcSocketPaths()) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			await validateUnixSocket(socketPath);
			const socketBudget = deadline - Date.now();
			if (socketBudget <= 0) break;
			return await fetchFromSocket(socketPath, workspaceRoot, socketBudget);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("no Codex IDE IPC socket was available");
}

function selectedRanges(activeFile: ActiveFile): Range[] {
	const candidates = activeFile.selections.length > 0 ? activeFile.selections : [activeFile.selection];
	return candidates.filter((range) =>
		range.start.line !== range.end.line || range.start.character !== range.end.character,
	);
}

function formatRange(range: Range): string {
	const start = `line ${range.start.line + 1}, column ${range.start.character + 1}`;
	const end = `line ${range.end.line + 1}, column ${range.end.character + 1}`;
	return `${start} to ${end}`;
}

function truncateCharacters(text: string, limit: number, notice: string): string {
	const characters = Array.from(text);
	if (characters.length <= limit) return text;
	return `${characters.slice(0, limit).join("")}\n[${notice}]`;
}

function renderPromptContext(context: IdeContext): string | undefined {
	const sections: string[] = ["# Context from my IDE setup:"];
	const activeFile = context.activeFile;

	if (activeFile) {
		sections.push(`\n## Active file: ${activeFile.path}`);
		const ranges = selectedRanges(activeFile);
		if (ranges.length > 0 && (!activeFile.activeSelectionContent || ranges.length > 1)) {
			sections.push(`\n## Active selection range${ranges.length === 1 ? "" : "s"}:`);
			for (const range of ranges) sections.push(`- ${activeFile.path}: ${formatRange(range)}`);
		}
		if (activeFile.activeSelectionContent) {
			sections.push("\n## Active selection of the file:");
			sections.push(truncateCharacters(
				activeFile.activeSelectionContent,
				MAX_ACTIVE_SELECTION_CHARS,
				`Selection truncated to ${MAX_ACTIVE_SELECTION_CHARS} characters.`,
			));
		}
	}

	if (context.openTabs.length > 0) {
		sections.push("\n## Open tabs:");
		let tabCharacters = 0;
		let renderedTabs = 0;
		for (const tab of context.openTabs) {
			if (renderedTabs >= MAX_OPEN_TABS) break;
			const line = `- ${tab.label}: ${tab.path}`;
			if (tabCharacters + line.length + 1 > MAX_OPEN_TABS_CHARS) break;
			sections.push(line);
			tabCharacters += line.length + 1;
			renderedTabs++;
		}
		const omitted = context.openTabs.length - renderedTabs;
		if (omitted > 0) sections.push(`[${omitted} open tab${omitted === 1 ? "" : "s"} omitted.]`);
	}

	return sections.length > 1 ? sections.join("\n") : undefined;
}

function renderStatus(context: IdeContext, workspaceRoot: string): string {
	const lines = ["IDE IPC: connected", `Workspace: ${workspaceRoot}`];
	const activeFile = context.activeFile;

	if (!activeFile) {
		lines.push("Active file: none");
	} else {
		lines.push(`Active file: ${activeFile.path}`);
		const ranges = selectedRanges(activeFile);
		if (ranges.length === 0) {
			const cursor = activeFile.selection.start;
			lines.push(`Cursor: line ${cursor.line + 1}, column ${cursor.character + 1}`);
		} else if (ranges.length === 1) lines.push(`Selection: ${formatRange(ranges[0]!)}`);
		else {
			lines.push("Selections:");
			for (const range of ranges) lines.push(`- ${formatRange(range)}`);
		}
		if (activeFile.activeSelectionContent) {
			lines.push("Selected text:");
			lines.push(truncateCharacters(
				activeFile.activeSelectionContent,
				MAX_STATUS_SELECTION_CHARS,
				`Status preview truncated to ${MAX_STATUS_SELECTION_CHARS} characters.`,
			));
		}
	}

	if (context.openTabs.length === 0) lines.push("Open tabs: none");
	else {
		lines.push("Open tabs:");
		for (const tab of context.openTabs) lines.push(`- ${tab.label}: ${tab.path}`);
	}

	return lines.join("\n");
}

export default function ideContextExtension(pi: ExtensionAPI): void {
	pi.registerCommand("ide", {
		description: "Show the current IDE context visible through Codex IPC",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /ide", "warning");
				return;
			}
			try {
				const context = await fetchIdeContext(ctx.cwd);
				ctx.ui.notify(renderStatus(context, ctx.cwd), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`IDE IPC: unavailable\n${message}`, "error");
			}
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const context = await fetchIdeContext(ctx.cwd);
			const content = renderPromptContext(context);
			if (!content) return;
			return {
				message: {
					customType: "ide-context",
					content,
					display: false,
				},
			};
		} catch {
			// No IDE is normal. Stay quiet; /ide provides diagnostics.
		}
	});
}
