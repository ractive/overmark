/**
 * The case format `overmark/1` (see kb/design/overview.md): the same JSON in
 * IndexedDB and in an export. Images are referenced by paths relative to the
 * case (`shots/s1.webp`, `crops/a1.webp`).
 */

export const CASE_FORMAT = "overmark/1";

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Viewport {
	width: number;
	height: number;
	/** `devicePixelRatio`: screenshot pixels per CSS pixel. */
	dpr: number;
}

/** A mark, in CSS pixels of its screenshot (or of the document while drawing). */
export type Shape =
	| { kind: "element"; rect: Rect }
	| { kind: "box"; rect: Rect }
	| { kind: "arrow"; from: Point; to: Point }
	| { kind: "pen"; points: Point[] }
	| { kind: "note"; at: Point };

export type ShapeKind = Shape["kind"];

/** What Overmark knows about an annotation's element (see element.ts). */
export interface ElementDetails {
	tag: string;
	/** A hand-written id (generated ones are left out). */
	id?: string;
	testId?: string;
	role?: string;
	/** Accessible name. */
	name?: string;
	/** Text content, whitespace collapsed, at most 200 characters. */
	text?: string;
	/** The readable parts of the classes. */
	classes: string[];
	/** `name`, `type`, `href` (path), `src` (file), `placeholder`, `alt`, `title`. */
	attributes: Record<string, string>;
	/** The nearest heading before the element. */
	heading?: string;
	/** The landmark around it, e.g. `navigation: Hauptmenü`. */
	landmark?: string;
	/** Ancestors, nearest first, e.g. `nav`, `header.Header_root`. */
	ancestors: string[];
	/** Position and size in document coordinates (CSS pixels). */
	rect: Rect;
	/** The document's size when it was described. */
	page: { width: number; height: number };
	/** A best-effort CSS selector (W3C Web Annotation `CssSelector`). */
	selector: string;
}

export interface Shot {
	id: string;
	/** `shots/<id>.webp` */
	image: string;
	scrollX: number;
	scrollY: number;
	viewport: Viewport;
	capturedAt: string;
}

export interface Annotation {
	id: string;
	/** Shown on the page and in lists; unique in the case. */
	number: number;
	shot: string;
	comment: string;
	/** Who made it: the user, or an AI app through a tool. */
	author: "user" | "ai";
	/** In the shot's coordinates. */
	shape: Shape;
	/** `crops/<id>.webp` */
	crop: string;
	element: ElementDetails | null;
}

export interface PageInfo {
	url: string;
	title: string;
	lang: string;
	viewport: Viewport;
	userAgent: string;
}

export interface Case {
	format: typeof CASE_FORMAT;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	page: PageInfo;
	shots: Shot[];
	annotations: Annotation[];
	verdict: string | null;
}

export class CaseError extends Error {
	override name = "CaseError";
}

/** A new random id with a prefix, e.g. `c_8f3k…`. */
export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export const shotImage = (shotId: string) => `shots/${shotId}.webp`;
export const cropImage = (annotationId: string) => `crops/${annotationId}.webp`;

/** The IndexedDB key of a case's image. */
export const imageKey = (caseId: string, path: string) => `${caseId}/${path}`;

/** The next annotation number and shot number of a case. */
export function nextNumbers(c: Case | undefined): {
	annotation: number;
	shot: number;
} {
	if (c === undefined) return { annotation: 1, shot: 1 };
	const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);
	return {
		annotation: max(c.annotations.map((a) => a.number)) + 1,
		shot: max(c.shots.map((s) => Number(s.id.slice(1)) || 0)) + 1,
	};
}

/** The smallest rectangle around a shape. */
export function shapeBounds(shape: Shape): Rect {
	switch (shape.kind) {
		case "element":
		case "box":
			return shape.rect;
		case "note":
			return { x: shape.at.x, y: shape.at.y, width: 0, height: 0 };
		case "arrow":
			return boundsOf([shape.from, shape.to]);
		case "pen":
			return boundsOf(shape.points);
	}
}

export function boundsOf(points: readonly Point[]): Rect {
	if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Move a shape by `dx`, `dy`. */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
	const p = (q: Point): Point => ({ x: q.x + dx, y: q.y + dy });
	const r = (q: Rect): Rect => ({ ...q, x: q.x + dx, y: q.y + dy });
	switch (shape.kind) {
		case "element":
		case "box":
			return { kind: shape.kind, rect: r(shape.rect) };
		case "note":
			return { kind: "note", at: p(shape.at) };
		case "arrow":
			return { kind: "arrow", from: p(shape.from), to: p(shape.to) };
		case "pen":
			return { kind: "pen", points: shape.points.map(p) };
	}
}

// --- validation (imports, iteration 3) ---------------------------------------

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
	throw new CaseError(`${path}: ${what}`);
}

function obj(v: unknown, path: string): Obj {
	if (typeof v !== "object" || v === null || Array.isArray(v))
		fail(path, "must be an object");
	return v as Obj;
}

function str(v: unknown, path: string, max = 100_000): string {
	if (typeof v !== "string") fail(path, "must be a string");
	if (v.length > max) fail(path, `longer than ${max} characters`);
	return v;
}

function num(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v))
		fail(path, "must be a number");
	return v;
}

function arr(v: unknown, path: string, max = 10_000): unknown[] {
	if (!Array.isArray(v)) fail(path, "must be an array");
	if (v.length > max) fail(path, `more than ${max} items`);
	return v;
}

function point(v: unknown, path: string): Point {
	const o = obj(v, path);
	return { x: num(o["x"], `${path}.x`), y: num(o["y"], `${path}.y`) };
}

function rect(v: unknown, path: string): Rect {
	const o = obj(v, path);
	return {
		x: num(o["x"], `${path}.x`),
		y: num(o["y"], `${path}.y`),
		width: num(o["width"], `${path}.width`),
		height: num(o["height"], `${path}.height`),
	};
}

function viewport(v: unknown, path: string): Viewport {
	const o = obj(v, path);
	return {
		width: num(o["width"], `${path}.width`),
		height: num(o["height"], `${path}.height`),
		dpr: num(o["dpr"], `${path}.dpr`),
	};
}

function shape(v: unknown, path: string): Shape {
	const o = obj(v, path);
	switch (o["kind"]) {
		case "element":
		case "box":
			return { kind: o["kind"], rect: rect(o["rect"], `${path}.rect`) };
		case "arrow":
			return {
				kind: "arrow",
				from: point(o["from"], `${path}.from`),
				to: point(o["to"], `${path}.to`),
			};
		case "pen":
			return {
				kind: "pen",
				points: arr(o["points"], `${path}.points`, 5000).map((p, i) =>
					point(p, `${path}.points[${i}]`),
				),
			};
		case "note":
			return { kind: "note", at: point(o["at"], `${path}.at`) };
		default:
			fail(`${path}.kind`, "unknown shape");
	}
}

function optionalString(o: Obj, key: string, path: string, out: Obj): void {
	if (o[key] !== undefined) out[key] = str(o[key], `${path}.${key}`, 2000);
}

function element(v: unknown, path: string): ElementDetails | null {
	if (v === null) return null;
	const o = obj(v, path);
	const attributes: Record<string, string> = {};
	for (const [k, value] of Object.entries(
		obj(o["attributes"], `${path}.attributes`),
	)) {
		attributes[k] = str(value, `${path}.attributes.${k}`, 2000);
	}
	const page = obj(o["page"], `${path}.page`);
	const out: Obj = {
		tag: str(o["tag"], `${path}.tag`, 64),
		classes: arr(o["classes"], `${path}.classes`, 200).map((c, i) =>
			str(c, `${path}.classes[${i}]`, 200),
		),
		attributes,
		ancestors: arr(o["ancestors"], `${path}.ancestors`, 50).map((c, i) =>
			str(c, `${path}.ancestors[${i}]`, 300),
		),
		rect: rect(o["rect"], `${path}.rect`),
		page: {
			width: num(page["width"], `${path}.page.width`),
			height: num(page["height"], `${path}.page.height`),
		},
		selector: str(o["selector"], `${path}.selector`, 2000),
	};
	for (const key of [
		"id",
		"testId",
		"role",
		"name",
		"text",
		"heading",
		"landmark",
	])
		optionalString(o, key, path, out);
	return out as unknown as ElementDetails;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function id(v: unknown, path: string): string {
	const s = str(v, path, 64);
	if (!SAFE_ID.test(s)) fail(path, "is not a valid id");
	return s;
}

/** Check that `value` is a case in format `overmark/1` and return it typed. */
export function validateCase(value: unknown): Case {
	const o = obj(value, "case");
	if (o["format"] !== CASE_FORMAT)
		fail("case.format", `must be "${CASE_FORMAT}"`);
	const page = obj(o["page"], "case.page");
	const shots = arr(o["shots"], "case.shots", 200).map((v, i): Shot => {
		const s = obj(v, `case.shots[${i}]`);
		const shotId = id(s["id"], `case.shots[${i}].id`);
		const image = str(s["image"], `case.shots[${i}].image`);
		if (image !== shotImage(shotId))
			fail(`case.shots[${i}].image`, `must be ${shotImage(shotId)}`);
		return {
			id: shotId,
			image,
			scrollX: num(s["scrollX"], `case.shots[${i}].scrollX`),
			scrollY: num(s["scrollY"], `case.shots[${i}].scrollY`),
			viewport: viewport(s["viewport"], `case.shots[${i}].viewport`),
			capturedAt: str(s["capturedAt"], `case.shots[${i}].capturedAt`, 64),
		};
	});
	const shotIds = new Set(shots.map((s) => s.id));
	const numbers = new Set<number>();
	const ids = new Set<string>();
	const annotations = arr(o["annotations"], "case.annotations", 1000).map(
		(v, i): Annotation => {
			const p = `case.annotations[${i}]`;
			const a = obj(v, p);
			const annotationId = id(a["id"], `${p}.id`);
			if (ids.has(annotationId)) fail(`${p}.id`, "is used twice");
			ids.add(annotationId);
			const number = num(a["number"], `${p}.number`);
			if (!Number.isInteger(number) || number < 1 || numbers.has(number))
				fail(`${p}.number`, "must be a unique positive integer");
			numbers.add(number);
			const shot = str(a["shot"], `${p}.shot`, 64);
			if (!shotIds.has(shot)) fail(`${p}.shot`, "names no shot of the case");
			const crop = str(a["crop"], `${p}.crop`);
			if (crop !== cropImage(annotationId))
				fail(`${p}.crop`, `must be ${cropImage(annotationId)}`);
			const author = a["author"];
			if (author !== "user" && author !== "ai")
				fail(`${p}.author`, `must be "user" or "ai"`);
			return {
				id: annotationId,
				number,
				shot,
				comment: str(a["comment"], `${p}.comment`, 20_000),
				author,
				shape: shape(a["shape"], `${p}.shape`),
				crop,
				element: element(a["element"], `${p}.element`),
			};
		},
	);
	const verdict = o["verdict"];
	return {
		format: CASE_FORMAT,
		id: id(o["id"], "case.id"),
		title: str(o["title"], "case.title", 500),
		createdAt: str(o["createdAt"], "case.createdAt", 64),
		updatedAt: str(o["updatedAt"], "case.updatedAt", 64),
		page: {
			url: str(page["url"], "case.page.url", 8000),
			title: str(page["title"], "case.page.title", 2000),
			lang: str(page["lang"], "case.page.lang", 64),
			viewport: viewport(page["viewport"], "case.page.viewport"),
			userAgent: str(page["userAgent"], "case.page.userAgent", 2000),
		},
		shots,
		annotations,
		verdict:
			verdict === null || verdict === undefined
				? null
				: str(verdict, "case.verdict", 50_000),
	};
}
