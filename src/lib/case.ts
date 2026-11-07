/**
 * The case format `overmark/1` (see kb/design/overview.md): the same JSON in
 * IndexedDB and in an export. Images are referenced by paths relative to the
 * case (`shots/s1.webp`, `crops/a1.webp`).
 */

export const CASE_FORMAT = "overmark/1";

/** The attributes element details keep (element.ts). */
export const ELEMENT_ATTRIBUTES = [
	"name",
	"type",
	"href",
	"src",
	"placeholder",
	"alt",
	"title",
] as const;

/** A language tag as `<html lang>` gives it, e.g. `de-CH`. */
export const LANGUAGE = /^[A-Za-z0-9-]{0,35}$/;

/** The highest annotation number a case may use. */
export const MAX_NUMBER = 99_999;

/** The longest verdict a case may hold, in characters. */
export const MAX_VERDICT = 50_000;

/** The longest comment on a mark, in characters. */
export const MAX_COMMENT = 20_000;

/** The most points a freehand mark may have. */
export const MAX_PEN_POINTS = 5000;

/** The longest page address a case may hold. */
export const MAX_URL = 8000;

/** The longest page title a case may hold. */
export const MAX_PAGE_TITLE = 2000;

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
	/** The page's address when it was taken; a case can span an app's routes. */
	url?: string;
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
	/** When this copy came in from a file: its texts are whoever wrote the file's. */
	importedAt?: string;
}

/** The longest case title. */
export const MAX_TITLE = 500;

export class CaseError extends Error {
	override name = "CaseError";
}

/**
 * A new random id with a prefix, e.g. `c_8f3k…`. `crypto.randomUUID` does not
 * exist in a content script on a plain http: page; this does.
 */
export function newId(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${prefix}_${hex}`;
}

export const shotImage = (shotId: string) => `shots/${shotId}.webp`;
export const cropImage = (annotationId: string) => `crops/${annotationId}.webp`;
/** A screenshot taken for a save that is not committed yet (save.ts). */
export const pendingImage = (shotId: string) => `pending/${shotId}.webp`;

/** The paths of all images a case references (its screenshots and crops). */
export function caseImages(c: Case): Set<string> {
	return new Set([
		...c.shots.map((s) => s.image),
		...c.annotations.map((a) => a.crop),
	]);
}

/**
 * The screenshot's real pixels per CSS pixel. `devicePixelRatio` can differ
 * from what `captureVisibleTab` delivers (browser zoom, device emulation), so
 * the image's own width decides; `fallback` when it cannot.
 */
export function imageScale(
	imageWidth: number,
	viewportWidth: number,
	fallback: number,
): number {
	return imageWidth > 0 && viewportWidth > 0
		? imageWidth / viewportWidth
		: fallback;
}

/**
 * A page's address as Overmark keeps it and tells an AI app: origin and path,
 * since a query or a fragment can carry personal data or tokens, as for links
 * (DEC-009). A hash route (`#/path`, `#!/path`) names the page, so it stays,
 * up to the first character that starts parameters.
 */
const hashRoute = (hash: string) => /^#!?\/[^?#&=]*/.exec(hash)?.[0] ?? "";

export function plainUrl(href: string): string {
	try {
		const url = new URL(href);
		const route = hashRoute(url.hash);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = route;
		return url.href.slice(0, MAX_URL);
	} catch {
		return href.slice(0, MAX_URL);
	}
}

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

/** A position along one axis of a box, on the same axis of another box. */
function along(
	v: number,
	start: number,
	size: number,
	newStart: number,
	newSize: number,
): number {
	if (size <= 0 || v < start) return newStart + v - start;
	if (v > start + size) return newStart + newSize + v - start - size;
	return newStart + ((v - start) * newSize) / size;
}

/**
 * A shape that was on the box `from`, on the box `to`. What was inside the box
 * scales with it; what was outside keeps its distance to the edge, or a small
 * element that grew would throw it far away. An element's mark is the box itself.
 */
export function shapeOnBox(shape: Shape, from: Rect, to: Rect): Shape {
	const p = (q: Point): Point => ({
		x: along(q.x, from.x, from.width, to.x, to.width),
		y: along(q.y, from.y, from.height, to.y, to.height),
	});
	switch (shape.kind) {
		case "element":
			return { kind: "element", rect: to };
		case "box": {
			const { x, y, width, height } = shape.rect;
			const a = p({ x, y });
			const b = p({ x: x + width, y: y + height });
			return {
				kind: "box",
				rect: { ...a, width: b.x - a.x, height: b.y - a.y },
			};
		}
		case "note":
			return { kind: "note", at: p(shape.at) };
		case "arrow":
			return { kind: "arrow", from: p(shape.from), to: p(shape.to) };
		case "pen":
			return { kind: "pen", points: shape.points.map(p) };
	}
}

/**
 * The same page, whatever the origin: a case from prod "belongs" to localhost
 * too. A hash route names a page; a plain `#section` does not.
 */
export function samePath(a: string, b: string): boolean {
	const page = (href: string) => {
		const { pathname, hash } = new URL(href);
		return `${pathname.replace(/\/+$/, "") || "/"}${hashRoute(hash)}`;
	};
	try {
		return page(a) === page(b);
	} catch {
		return false;
	}
}

/**
 * The case is for `url`, sure enough to load it without a click: every site's
 * home page has the same path.
 */
export function isPageOf(c: Case, url: string): boolean {
	if (!samePath(c.page.url, url)) return false;
	const { origin, pathname } = new URL(url);
	return pathname !== "/" || origin === new URL(c.page.url).origin;
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
				points: arr(o["points"], `${path}.points`, MAX_PEN_POINTS).map((p, i) =>
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
	const given = obj(o["attributes"], `${path}.attributes`);
	const attributes: Record<string, string> = {};
	for (const k of ELEMENT_ATTRIBUTES) {
		if (Object.hasOwn(given, k))
			attributes[k] = str(given[k], `${path}.attributes.${k}`, 2000);
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
const SHOT_ID = /^s[1-9]\d{0,5}$/;

/** Ids of cases, shots and annotations: safe in image paths and keys. */
export const isSafeId = (value: string) => SAFE_ID.test(value);

function id(v: unknown, path: string): string {
	const s = str(v, path, 64);
	if (!SAFE_ID.test(s)) fail(path, "is not a valid id");
	return s;
}

function language(v: unknown, path: string): string {
	const s = str(v, path, 35);
	if (!LANGUAGE.test(s)) fail(path, "is not a language tag");
	return s;
}

/** Check that `value` is a case in format `overmark/1` and return it typed. */
export function validateCase(value: unknown): Case {
	const o = obj(value, "case");
	if (o["format"] !== CASE_FORMAT)
		fail("case.format", `must be "${CASE_FORMAT}"`);
	const page = obj(o["page"], "case.page");
	const shotIds = new Set<string>();
	const shots = arr(o["shots"], "case.shots", 200).map((v, i): Shot => {
		const s = obj(v, `case.shots[${i}]`);
		const shotId = id(s["id"], `case.shots[${i}].id`);
		if (!SHOT_ID.test(shotId))
			fail(`case.shots[${i}].id`, "must be s followed by a number");
		if (shotIds.has(shotId)) fail(`case.shots[${i}].id`, "is used twice");
		shotIds.add(shotId);
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
			...(s["url"] === undefined
				? {}
				: { url: str(s["url"], `case.shots[${i}].url`, MAX_URL) }),
		};
	});
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
			if (
				!Number.isInteger(number) ||
				number < 1 ||
				number > MAX_NUMBER ||
				numbers.has(number)
			)
				fail(`${p}.number`, `must be a unique integer from 1 to ${MAX_NUMBER}`);
			numbers.add(number);
			// Saving names new marks a<number>: another scheme would collide later.
			if (annotationId !== `a${number}`)
				fail(`${p}.id`, `must be a${number}, after its number`);
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
				comment: str(a["comment"], `${p}.comment`, MAX_COMMENT),
				author,
				shape: shape(a["shape"], `${p}.shape`),
				crop,
				element: element(a["element"], `${p}.element`),
			};
		},
	);
	const verdict = o["verdict"];
	const importedAt = o["importedAt"];
	return {
		format: CASE_FORMAT,
		id: id(o["id"], "case.id"),
		title: str(o["title"], "case.title", MAX_TITLE),
		createdAt: str(o["createdAt"], "case.createdAt", 64),
		updatedAt: str(o["updatedAt"], "case.updatedAt", 64),
		page: {
			url: str(page["url"], "case.page.url", MAX_URL),
			title: str(page["title"], "case.page.title", MAX_PAGE_TITLE),
			lang: language(page["lang"], "case.page.lang"),
			viewport: viewport(page["viewport"], "case.page.viewport"),
			userAgent: str(page["userAgent"], "case.page.userAgent", 2000),
		},
		shots,
		annotations,
		verdict:
			verdict === null || verdict === undefined
				? null
				: str(verdict, "case.verdict", MAX_VERDICT),
		...(importedAt === undefined
			? {}
			: { importedAt: str(importedAt, "case.importedAt", 64) }),
	};
}
