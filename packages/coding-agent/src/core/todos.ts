// Finds TODO and FIXME comments in a project with ripgrep, for the /todos command.
import { spawn } from "node:child_process";
import { sep } from "node:path";
import { createInterface } from "node:readline";
import { ensureTool, type ToolStatus } from "../utils/tools-manager.ts";
import { truncateLine } from "./tools/truncate.ts";

export interface TodoMatch {
	/** Path relative to the searched directory, with forward slashes. */
	path: string;
	/** 1-based line number. */
	line: number;
	/** The matching line, trimmed and shortened. */
	text: string;
}

export interface TodoResult {
	/** The first `limit` matches, ordered by path then line. */
	matches: TodoMatch[];
	/** Every match found, including those not in `matches`. */
	total: number;
}

export interface FindTodosOptions {
	/** Maximum number of matches to keep in the result (default 100). Matches beyond it are still counted. */
	limit?: number;
	signal?: AbortSignal;
	onToolStatus?: (status: ToolStatus) => void;
}

export const DEFAULT_TODO_LIMIT = 100;

// Whole uppercase words only: "todo", "TODOS" and "MY_TODO" are not outstanding work items.
const TODO_PATTERN = "\\b(TODO|FIXME)\\b";
const MAX_TEXT_LENGTH = 200;

/** Searches `cwd` for TODO and FIXME comments, respecting .gitignore, and returns them ordered by path and line. */
export async function findTodos(cwd: string, options: FindTodosOptions = {}): Promise<TodoResult> {
	const { signal, onToolStatus } = options;
	const limit = Math.max(1, options.limit ?? DEFAULT_TODO_LIMIT);
	if (signal?.aborted) throw new Error("Operation aborted");

	const rgPath = await ensureTool("rg", onToolStatus);
	if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");

	// --no-config: results must not depend on ambient user config such as RIPGREP_CONFIG_PATH.
	// --no-require-git: honor .gitignore even when cwd is not inside a git repository.
	// --sort path: a deterministic order, so the capped list is stable between runs.
	const args = [
		"--no-config",
		"--json",
		"--hidden",
		"--no-require-git",
		"--case-sensitive",
		"--sort",
		"path",
		"--glob",
		"!.git",
		"-e",
		TODO_PATTERN,
		"--",
		".",
	];

	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const lines = createInterface({ input: child.stdout });
		const matches: TodoMatch[] = [];
		let total = 0;
		let stderr = "";
		let aborted = false;
		let settled = false;
		let exitCode: number | null | undefined;
		// The result is ready once both the process has exited and every stdout line was read.
		let pending = 2;

		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			lines.close();
			fn();
		};
		const completeOne = () => {
			pending--;
			if (pending > 0) return;
			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			// Exit code 1 means no matches. Code 2 also covers unreadable files, which should not hide real matches.
			if (exitCode !== 0 && exitCode !== 1 && total === 0) {
				settle(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${exitCode}`)));
				return;
			}
			settle(() => resolve({ matches, total }));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
		});
		child.on("close", (code) => {
			exitCode = code;
			completeOne();
		});
		lines.on("line", (line) => {
			const match = parseMatchLine(line);
			if (!match) return;
			total++;
			if (matches.length < limit) matches.push(match);
		});
		lines.on("close", completeOne);
	});
}

/** Formats a result as plain lines: a count header, one `path:line: text` row per match, and how many were left out. */
export function formatTodoReport(result: TodoResult): string[] {
	if (result.total === 0) return ["No TODO or FIXME comments found."];

	const noun = result.total === 1 ? "comment" : "comments";
	const report = [`${result.total} TODO/FIXME ${noun}`, ""];
	for (const match of result.matches) {
		report.push(`${match.path}:${match.line}: ${match.text}`);
	}
	const hidden = result.total - result.matches.length;
	if (hidden > 0) report.push(`...and ${hidden} more`);
	return report;
}

// Parses one line of `rg --json` output; anything but a match event with a text path and line number is ignored.
function parseMatchLine(line: string): TodoMatch | undefined {
	if (!line.trim()) return undefined;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (event.type !== "match") return undefined;

	const filePath = event.data?.path?.text;
	const lineNumber = event.data?.line_number;
	if (typeof filePath !== "string" || typeof lineNumber !== "number") return undefined;

	const rawText = typeof event.data?.lines?.text === "string" ? event.data.lines.text : "";
	return {
		path: toRelativePath(filePath),
		line: lineNumber,
		text: truncateLine(rawText.trim(), MAX_TEXT_LENGTH).text,
	};
}

function toRelativePath(rgPath: string): string {
	return rgPath.split(sep).join("/").replace(/^\.\//, "");
}
