import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTodos, formatTodoReport } from "../src/core/todos.ts";

describe("findTodos", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-todos-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function write(relativePath: string, content: string): void {
		const absolute = join(dir, relativePath);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content);
	}

	it("returns relative path, line number and trimmed text for TODO and FIXME", async () => {
		write("src/a.ts", "const a = 1;\n\t// TODO: handle errors\nconst b = 2; // FIXME broken\n");

		const result = await findTodos(dir);

		expect(result.total).toBe(2);
		expect(result.matches).toEqual([
			{ path: "src/a.ts", line: 2, text: "// TODO: handle errors" },
			{ path: "src/a.ts", line: 3, text: "const b = 2; // FIXME broken" },
		]);
	});

	it("matches only the whole uppercase words", async () => {
		write(
			"words.ts",
			[
				"// todo lowercase",
				"// Todo capitalized",
				"// TODOS plural",
				"// MY_TODO_LIST identifier",
				"// FIXMEs plural",
				"// TODO: real one",
			].join("\n"),
		);

		const result = await findTodos(dir);

		expect(result.matches.map((match) => match.line)).toEqual([6]);
		expect(result.total).toBe(1);
	});

	it("skips files ignored by .gitignore", async () => {
		write(".gitignore", "ignored/\n");
		write("ignored/skip.ts", "// TODO: ignored\n");
		write("kept/keep.ts", "// TODO: kept\n");

		const result = await findTodos(dir);

		expect(result.matches.map((match) => match.path)).toEqual(["kept/keep.ts"]);
	});

	it("does not search inside .git", async () => {
		write(".git/info/note.txt", "TODO: internal\n");
		write("real.ts", "// TODO: real\n");

		const result = await findTodos(dir);

		expect(result.matches.map((match) => match.path)).toEqual(["real.ts"]);
	});

	it("orders matches by path then line", async () => {
		write("b.ts", "// TODO: b\n");
		write("a.ts", "x\n// TODO: a2\n// TODO: a3\n");

		const result = await findTodos(dir);

		expect(result.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["a.ts:2", "a.ts:3", "b.ts:1"]);
	});

	it("keeps only `limit` matches but counts all of them", async () => {
		for (let index = 0; index < 5; index++) {
			write(`f${index}.ts`, `// TODO: item ${index}\n`);
		}

		const result = await findTodos(dir, { limit: 2 });

		expect(result.matches).toHaveLength(2);
		expect(result.total).toBe(5);
	});

	it("returns an empty result when nothing matches", async () => {
		write("clean.ts", "export const x = 1;\n");

		const result = await findTodos(dir);

		expect(result).toEqual({ matches: [], total: 0 });
	});

	it("truncates very long lines", async () => {
		write("long.ts", `// TODO: ${"x".repeat(1000)}\n`);

		const result = await findTodos(dir);

		expect(result.matches[0]?.text.length).toBeLessThan(300);
		expect(result.matches[0]?.text.endsWith("[truncated]")).toBe(true);
	});

	it("rejects when the signal is already aborted", async () => {
		write("a.ts", "// TODO: a\n");
		const controller = new AbortController();
		controller.abort();

		await expect(findTodos(dir, { signal: controller.signal })).rejects.toThrow("aborted");
	});
});

describe("formatTodoReport", () => {
	it("says so when there are no TODOs", () => {
		expect(formatTodoReport({ matches: [], total: 0 })).toEqual(["No TODO or FIXME comments found."]);
	});

	it("lists every match under a count header", () => {
		const lines = formatTodoReport({
			matches: [
				{ path: "a.ts", line: 1, text: "// TODO: one" },
				{ path: "b.ts", line: 9, text: "// FIXME: two" },
			],
			total: 2,
		});

		expect(lines).toEqual(["2 TODO/FIXME comments", "", "a.ts:1: // TODO: one", "b.ts:9: // FIXME: two"]);
	});

	it("uses the singular for one match", () => {
		const lines = formatTodoReport({ matches: [{ path: "a.ts", line: 1, text: "// TODO" }], total: 1 });

		expect(lines[0]).toBe("1 TODO/FIXME comment");
	});

	it("reports how many matches were not shown", () => {
		const lines = formatTodoReport({
			matches: [{ path: "a.ts", line: 1, text: "// TODO: one" }],
			total: 13,
		});

		expect(lines[0]).toBe("13 TODO/FIXME comments");
		expect(lines.at(-1)).toBe("...and 12 more");
	});
});
