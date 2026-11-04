/**
 * Finding an annotation's element on another build: every candidate is
 * scored by the weighted similarity of its details to the stored ones (after
 * Similo; see kb/design/overview.md). Pure, so it is tested without a browser.
 */

import type { ElementDetails } from "./case.ts";

export type MatchStatus = "found" | "probable" | "ambiguous" | "lost";

export const FOUND = 0.75;
export const PROBABLE = 0.5;
/** Two candidates closer than this are a tie. */
export const TIE = 0.03;

export const WEIGHTS = {
	testId: 3,
	id: 1.5,
	tag: 1.5,
	role: 1,
	name: 1.5,
	text: 1.5,
	classes: 1,
	attributes: 1,
	heading: 1,
	landmark: 0.5,
	ancestors: 0.5,
	position: 0.5,
	size: 0.5,
} as const;

function bigrams(s: string): Map<string, number> {
	const out = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2);
		out.set(g, (out.get(g) ?? 0) + 1);
	}
	return out;
}

/** Dice coefficient of character bigrams, ignoring case and spacing (0 to 1). */
export function textSimilarity(a: string, b: string): number {
	const x = a.toLowerCase().replace(/\s+/g, " ").trim();
	const y = b.toLowerCase().replace(/\s+/g, " ").trim();
	if (x === y) return 1;
	if (x.length < 2 || y.length < 2) return 0;
	const gx = bigrams(x);
	const gy = bigrams(y);
	let shared = 0;
	for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
	return (2 * shared) / (x.length - 1 + (y.length - 1));
}

function jaccard(a: readonly string[], b: readonly string[]): number {
	const x = new Set(a);
	const y = new Set(b);
	let inter = 0;
	for (const v of x) if (y.has(v)) inter++;
	const union = x.size + y.size - inter;
	return union === 0 ? 1 : inter / union;
}

/** 2 × longest common subsequence ÷ total length. */
function sequenceSimilarity(
	a: readonly string[],
	b: readonly string[],
): number {
	if (a.length + b.length === 0) return 1;
	const row = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		let diagonal = 0;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] ?? 0;
			row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0);
			diagonal = above;
		}
	}
	return (2 * (row[b.length] ?? 0)) / (a.length + b.length);
}

function centre(d: ElementDetails): { x: number; y: number } | undefined {
	if (d.page.width <= 0 || d.page.height <= 0) return undefined;
	return {
		x: (d.rect.x + d.rect.width / 2) / d.page.width,
		y: (d.rect.y + d.rect.height / 2) / d.page.height,
	};
}

/** How alike a candidate is to the stored element (0 to 1). */
export function score(
	stored: ElementDetails,
	candidate: ElementDetails,
): number {
	let total = 0;
	let weight = 0;
	const add = (w: number, similarity: number) => {
		total += w * similarity;
		weight += w;
	};
	if (stored.testId)
		add(WEIGHTS.testId, candidate.testId === stored.testId ? 1 : 0);
	if (stored.id) add(WEIGHTS.id, candidate.id === stored.id ? 1 : 0);
	add(WEIGHTS.tag, candidate.tag === stored.tag ? 1 : 0);
	if (stored.role) add(WEIGHTS.role, candidate.role === stored.role ? 1 : 0);
	if (stored.name)
		add(WEIGHTS.name, textSimilarity(stored.name, candidate.name ?? ""));
	if (stored.text)
		add(WEIGHTS.text, textSimilarity(stored.text, candidate.text ?? ""));
	if (stored.classes.length > 0)
		add(WEIGHTS.classes, jaccard(stored.classes, candidate.classes));
	const keys = Object.keys(stored.attributes);
	if (keys.length > 0) {
		const same = keys.filter(
			(k) => candidate.attributes[k] === stored.attributes[k],
		).length;
		add(WEIGHTS.attributes, same / keys.length);
	}
	if (stored.heading)
		add(
			WEIGHTS.heading,
			textSimilarity(stored.heading, candidate.heading ?? ""),
		);
	if (stored.landmark)
		add(WEIGHTS.landmark, candidate.landmark === stored.landmark ? 1 : 0);
	if (stored.ancestors.length > 0)
		add(
			WEIGHTS.ancestors,
			sequenceSimilarity(stored.ancestors, candidate.ancestors),
		);
	const a = centre(stored);
	const b = centre(candidate);
	if (a !== undefined && b !== undefined && stored.rect.width > 0)
		add(
			WEIGHTS.position,
			Math.max(0, 1 - 3 * Math.hypot(a.x - b.x, a.y - b.y)),
		);
	const areaA = stored.rect.width * stored.rect.height;
	const areaB = candidate.rect.width * candidate.rect.height;
	if (areaA > 0)
		add(
			WEIGHTS.size,
			areaB > 0 ? Math.min(areaA, areaB) / Math.max(areaA, areaB) : 0,
		);
	return weight === 0 ? 0 : total / weight;
}

export interface Ranked {
	/** Index into the candidates. */
	index: number;
	score: number;
}

/** The best candidates, best first. */
export function rank(
	stored: ElementDetails,
	candidates: readonly ElementDetails[],
	limit = 3,
): Ranked[] {
	return candidates
		.map((c, index) => ({ index, score: score(stored, c) }))
		.sort((x, y) => y.score - x.score || x.index - y.index)
		.slice(0, limit);
}

export function classify(ranked: readonly Ranked[]): MatchStatus {
	const [best, second] = ranked;
	if (best === undefined || best.score < PROBABLE) return "lost";
	if (second !== undefined && best.score - second.score < TIE)
		return "ambiguous";
	return best.score >= FOUND ? "found" : "probable";
}
