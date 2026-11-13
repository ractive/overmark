/**
 * What a selector from an AI app may say (CR-01). A selector is a question
 * asked of the live page: whether something matches is an answer, even when
 * nothing is read. So it may name only what the markup Overmark sends shows:
 * tags, classes, ids, a few attributes that hold no field value, the
 * structure around an element, and the combinators. It may not test what is
 * typed or chosen (`:checked`, `:placeholder-shown`, `[value^=…]`), the state
 * of the page (`:focus`, `:target`, `:visited`), nor look inside an element
 * (`:has()`, `:empty`), which would reach into form fields and editors.
 *
 * An allow-list: the selector is scanned as CSS tokenizes it (escapes
 * decoded, names compared in lower case, strings only as attribute values)
 * and anything that is not on the list is refused, comments, namespaces and
 * pseudo-elements included. The syntax itself is checked by the browser
 * first; this only reads the names.
 */

import { TEST_ID_ATTRIBUTES } from "./element.ts";

/**
 * Attributes a selector may test: the ones a form field keeps in the markup
 * (`inspect.ts` `FIELD_ATTRIBUTES`) but `style` and `title`, which can carry
 * a value's length or the value itself, and a few that only name an element.
 * Never `value`, `checked`, `selected`, `aria-value*`, `aria-checked`,
 * `href`, `src` (their query string) or another `data-*` than a test id.
 */
export const SELECTOR_ATTRIBUTES: ReadonlySet<string> = new Set([
	"id",
	"class",
	"role",
	"name",
	"type",
	"for",
	"alt",
	"aria-label",
	"placeholder",
	"disabled",
	"readonly",
	"required",
	"multiple",
	"min",
	"max",
	"step",
	"minlength",
	"maxlength",
	"pattern",
	"size",
	"rows",
	"cols",
	"wrap",
	"autocomplete",
	"inputmode",
	"enterkeyhint",
	"form",
	"list",
	"accept",
	"tabindex",
	"hidden",
	"dir",
	"lang",
	"spellcheck",
	"contenteditable",
	...TEST_ID_ATTRIBUTES,
]);

/**
 * Pseudo-classes of markup and structure. `:required` and `:optional`
 * follow the `required` attribute, `:disabled`, `:enabled`, `:read-only` and
 * `:read-write` the `disabled`, `readonly` and `contenteditable` attributes:
 * markup the field keeps, never what was typed into it.
 */
const PSEUDO_CLASSES = new Set([
	"root",
	"scope",
	"first-child",
	"last-child",
	"only-child",
	"first-of-type",
	"last-of-type",
	"only-of-type",
	"required",
	"optional",
	"disabled",
	"enabled",
	"read-only",
	"read-write",
]);

/** Take a selector list: whatever they hold is scanned the same way. */
const LIST_FUNCTIONS = new Set(["is", "where", "not"]);
/** Take `An+B`, the first two also `of` a selector list. */
const NTH_FUNCTIONS = new Set([
	"nth-child",
	"nth-last-child",
	"nth-of-type",
	"nth-last-of-type",
]);
const NTH_OF = new Set(["nth-child", "nth-last-child"]);

const ALLOWED_PSEUDO =
	":is(), :where(), :not(), :nth-child(), :nth-last-child(), :nth-of-type(), :nth-last-of-type(), :first-child, :last-child, :only-child, :first-of-type, :last-of-type, :only-of-type, :root, :scope, :required, :optional, :disabled, :enabled, :read-only, :read-write";

const ALLOWED_ATTRIBUTES = `${[...SELECTOR_ATTRIBUTES].join(", ")}`;

/** A name from the selector as it may be repeated in a message: the AI app's own text. */
const said = (name: string) =>
	name.length > 40 ? `${name.slice(0, 40)}…` : name;

const STATE = (name: string) =>
	`The pseudo-class :${said(name)} is not allowed: a selector may not test what is typed or chosen in a form, nor the state of the page (focus, hover, target, visited links). Allowed pseudo-classes: ${ALLOWED_PSEUDO}.`;

const HAS =
	"The pseudo-class :has() is not allowed: it looks inside elements, form fields and editors included. A selector is looked for among the mark's element's ancestors first, so name the ancestor itself (`.Card_root`, `form`).";

const EMPTY =
	"The pseudo-class :empty is not allowed: it tests what a text area or an editor holds.";

const ATTRIBUTE = (name: string) =>
	`The attribute selector [${said(name)}] is not allowed: one may hold what is typed or chosen in a form. A selector may test only these attributes: ${ALLOWED_ATTRIBUTES}.`;

const OTHER = (what: string) =>
	`${what} is not allowed in a selector. A selector may use tags, classes (.name), ids (#name), the attributes ${ALLOWED_ATTRIBUTES}, the pseudo-classes ${ALLOWED_PSEUDO}, and the combinators space, >, + and ~.`;

/** What an escape that names no character stands for. */
const REPLACEMENT = String.fromCodePoint(0xfffd);

class Refused extends Error {}

const isHex = (c: string | undefined) =>
	c !== undefined && /^[0-9a-f]$/i.test(c);
const isSpace = (c: string | undefined) =>
	c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
/** A character an identifier may hold (CSS Syntax 4.2: ident code point). */
const isNameChar = (c: string | undefined) =>
	c !== undefined && (/^[A-Za-z0-9_-]$/.test(c) || c.charCodeAt(0) >= 0x80);

class Scanner {
	readonly #s: string;
	#i = 0;

	constructor(s: string) {
		this.#s = s;
	}

	#peek(): string | undefined {
		return this.#s[this.#i];
	}

	/** The whole selector, or a nested list up to its `)` (left for the caller). */
	list(nested: boolean): void {
		for (;;) {
			const c = this.#peek();
			if (c === undefined) {
				if (nested) throw new Refused(OTHER("An unclosed bracket"));
				return;
			}
			if (c === ")") {
				if (!nested) throw new Refused(OTHER("“)”"));
				return;
			}
			if (c === "/" && this.#s[this.#i + 1] === "*")
				throw new Refused(OTHER("A comment"));
			if (isSpace(c) || c === "," || c === ">" || c === "+" || c === "~") {
				this.#i++;
				continue;
			}
			if (c === "*") {
				this.#i++;
				this.#noNamespace();
				continue;
			}
			if (c === ".") {
				this.#i++;
				this.#name();
				continue;
			}
			if (c === "#") {
				this.#i++;
				this.#name();
				continue;
			}
			if (c === "[") {
				this.#attribute();
				continue;
			}
			if (c === ":") {
				this.#pseudo();
				continue;
			}
			if (c === "|") throw new Refused(OTHER("A namespace (|)"));
			if (isNameChar(c) || c === "\\") {
				this.#name();
				this.#noNamespace();
				continue;
			}
			throw new Refused(OTHER(`“${c}”`));
		}
	}

	/** `ns|tag` and `*|tag`: refused, they are no part of an HTML page's selectors. */
	#noNamespace(): void {
		if (this.#peek() === "|") throw new Refused(OTHER("A namespace (|)"));
	}

	#spaces(): void {
		while (isSpace(this.#peek())) this.#i++;
	}

	/** An identifier or a hash's name, its escapes decoded. */
	#name(): string {
		let out = "";
		for (;;) {
			const c = this.#peek();
			if (c === "\\") {
				out += this.#escape();
				continue;
			}
			if (!isNameChar(c)) break;
			out += c;
			this.#i++;
		}
		if (out === "") throw new Refused(OTHER("A missing name"));
		return out;
	}

	/** `\` and what follows (CSS Syntax 4.3.7). */
	#escape(): string {
		this.#i++; // the backslash
		const c = this.#peek();
		if (c === undefined) return REPLACEMENT;
		if (c === "\n" || c === "\r" || c === "\f")
			throw new Refused(OTHER("An escaped line break"));
		if (!isHex(c)) {
			// One code point, which may be two UTF-16 units.
			const point = this.#s.codePointAt(this.#i) ?? 0xfffd;
			this.#i += point > 0xffff ? 2 : 1;
			return String.fromCodePoint(point);
		}
		let hex = "";
		while (hex.length < 6 && isHex(this.#peek())) {
			hex += this.#peek();
			this.#i++;
		}
		if (this.#peek() === "\r" && this.#s[this.#i + 1] === "\n") this.#i += 2;
		else if (isSpace(this.#peek())) this.#i++;
		const point = Number.parseInt(hex, 16);
		return point === 0 ||
			(point >= 0xd800 && point <= 0xdfff) ||
			point > 0x10ffff
			? REPLACEMENT
			: String.fromCodePoint(point);
	}

	/** A quoted string (an attribute's value): its content is not looked at. */
	#string(): void {
		const quote = this.#peek();
		this.#i++;
		for (;;) {
			const c = this.#peek();
			if (c === undefined) return; // the end closes it, as in CSS
			if (c === quote) {
				this.#i++;
				return;
			}
			if (c === "\n" || c === "\r" || c === "\f")
				throw new Refused(OTHER("A line break in a string"));
			if (c === "\\") this.#i++;
			this.#i++;
		}
	}

	/** `[name]`, `[name op value]`, `[name op value i]`. */
	#attribute(): void {
		this.#i++; // [
		this.#spaces();
		if (this.#peek() === "|" || this.#peek() === "*")
			throw new Refused(OTHER("A namespace (|)"));
		const name = this.#name().toLowerCase();
		if (this.#peek() === "|" && this.#s[this.#i + 1] !== "=")
			throw new Refused(OTHER("A namespace (|)"));
		if (!SELECTOR_ATTRIBUTES.has(name)) throw new Refused(ATTRIBUTE(name));
		this.#spaces();
		if (this.#peek() === "]") {
			this.#i++;
			return;
		}
		if ("~|^$*".includes(this.#peek() ?? "=")) this.#i++;
		if (this.#peek() !== "=") throw new Refused(OTHER("An attribute operator"));
		this.#i++;
		this.#spaces();
		if (this.#peek() === '"' || this.#peek() === "'") this.#string();
		else this.#name();
		this.#spaces();
		// The flag: `i` or `s`.
		if (this.#peek() !== "]") {
			const flag = this.#name().toLowerCase();
			if (flag !== "i" && flag !== "s")
				throw new Refused(OTHER(`The attribute flag “${said(flag)}”`));
			this.#spaces();
		}
		if (this.#peek() !== "]") throw new Refused(OTHER("An unclosed [ ]"));
		this.#i++;
	}

	/** `:name` or `:name(…)`; `::` is a pseudo-element. */
	#pseudo(): void {
		this.#i++; // :
		if (this.#peek() === ":")
			throw new Refused(OTHER("A pseudo-element (::before, ::part())"));
		const name = this.#name().toLowerCase();
		if (this.#peek() !== "(") {
			if (PSEUDO_CLASSES.has(name)) return;
			throw new Refused(name === "empty" ? EMPTY : STATE(name));
		}
		this.#i++; // (
		if (name === "has") throw new Refused(HAS);
		if (LIST_FUNCTIONS.has(name)) this.list(true);
		else if (NTH_FUNCTIONS.has(name)) this.#nth(NTH_OF.has(name));
		else throw new Refused(STATE(`${name}()`));
		if (this.#peek() !== ")") throw new Refused(OTHER("An unclosed ( )"));
		this.#i++;
	}

	/** `An+B`, `odd`, `even`, and for `:nth-child()` `of` a selector list. */
	#nth(of: boolean): void {
		const rest = this.#s.slice(this.#i);
		const anb =
			/^[ \t\n\r\f]*(?:odd|even|[+-]?\d*n(?:[ \t\n\r\f]*[+-][ \t\n\r\f]*\d+)?|[+-]?\d+)[ \t\n\r\f]*/i.exec(
				rest,
			);
		if (anb === null) throw new Refused(OTHER("This :nth-…() argument"));
		this.#i += anb[0].length;
		if (this.#peek() === ")") return;
		if (of && /^of[ \t\n\r\f]/i.test(this.#s.slice(this.#i))) {
			this.#i += 3;
			this.list(true);
			return;
		}
		throw new Refused(OTHER("This :nth-…() argument"));
	}
}

/**
 * Why `selector` may not be asked of the page, if it may not: it names
 * something that is not on the list above. The syntax is the browser's to
 * check; a selector it accepts that this cannot read is refused too.
 */
export function selectorVocabularyProblem(
	selector: string,
): string | undefined {
	try {
		new Scanner(selector).list(false);
		return undefined;
	} catch (error) {
		if (error instanceof Refused) return error.message;
		throw error;
	}
}
