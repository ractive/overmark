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

interface Grams {
	text: string;
	grams: Map<string, number>;
}

/**
 * Normalised text and its bigrams, remembered: loading a case compares the
 * same strings thousands of times. The cache is emptied when it grows large.
 */
const gramCache = new Map<string, Grams>();

function grams(s: string): Grams {
	let found = gramCache.get(s);
	if (found === undefined) {
		const text = s.toLowerCase().replace(/\s+/g, " ").trim();
		const out = new Map<string, number>();
		for (let i = 0; i < text.length - 1; i++) {
			const g = text.slice(i, i + 2);
			out.set(g, (out.get(g) ?? 0) + 1);
		}
		if (gramCache.size > 50_000) gramCache.clear();
		found = { text, grams: out };
		gramCache.set(s, found);
	}
	return found;
}

/** Dice coefficient of character bigrams, ignoring case and spacing (0 to 1). */
export function textSimilarity(a: string, b: string): number {
	const { text: x, grams: gx } = grams(a);
	const { text: y, grams: gy } = grams(b);
	if (x === y) return 1;
	if (x.length < 2 || y.length < 2) return 0;
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

/**
 * How much a candidate shares what identifies the stored element (its test
 * id, id, accessible name or text), 0 to 1; `undefined` when the stored
 * element has none of these.
 */
export function identity(
	stored: ElementDetails,
	candidate: ElementDetails,
): number | undefined {
	if (stored.testId && candidate.testId === stored.testId) return 1;
	if (stored.id && candidate.id === stored.id) return 1;
	const texts: number[] = [];
	if (stored.name)
		texts.push(textSimilarity(stored.name, candidate.name ?? ""));
	if (stored.text)
		texts.push(textSimilarity(stored.text, candidate.text ?? ""));
	if (texts.length > 0) return Math.max(...texts);
	return stored.testId || stored.id ? 0 : undefined;
}

/**
 * The share of the context score a candidate keeps by its identity: siblings
 * share tag, classes, heading and position, so without this the neighbour of
 * a removed element would be "found". An element whose name and text were
 * rewritten completely is therefore reported lost: the screenshot still
 * shows what was meant.
 */
function identityFactor(value: number | undefined): number {
	if (value === undefined || value >= 0.7) return 1;
	if (value <= 0.5) return 0.5;
	return 0.5 + (value - 0.5) * 2.5;
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
	if (weight === 0) return 0;
	return (total / weight) * identityFactor(identity(stored, candidate));
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
