/**
 * Telling hand-written class names and ids from generated ones. Only the
 * readable part of a class helps find an element in another environment, and it is
 * also what a developer can search the code for.
 */

/** A hash-like token: 5–12 characters with a digit, or with mixed case. */
function looksLikeHash(token: string): boolean {
	if (!/^[A-Za-z0-9_-]{5,12}$/.test(token)) return false;
	const letters = token.replace(/[^A-Za-z]/g, "");
	const mixed = /[a-z]/.test(letters) && /[A-Z]/.test(letters);
	return /\d/.test(token) || (mixed && /[A-Z]/.test(token.slice(1)));
}

/** A whole class that is random: `sc-bdVaJa`, `css-1x2y3z`, `kLmNoP`, `e1abc2d3`. */
function isRandomClass(name: string): boolean {
	if (/^(sc|css|jsx|svelte|emotion)-[A-Za-z0-9]+$/.test(name)) return true;
	if (/^[a-z]{1,3}\d[a-z0-9]{3,}$/i.test(name) && /\d/.test(name)) return true;
	// Several capitals after the first letter and no separator: a hash.
	const inner = name.slice(1).replace(/[^A-Z]/g, "").length;
	return /^[A-Za-z]{5,12}$/.test(name) && inner >= 2 && /[a-z]/.test(name);
}

/**
 * The readable part of one class, or `undefined` for a random one:
 * - CSS modules (Next.js, webpack): `Button_primary__x7Yz2` → `Button_primary`
 * - CSS modules (Vite): `_primary_1a2b3_1` → `primary`
 * - styled-components with a display name: `Button__StyledButton-sc-1x2y3z-0` → `Button__StyledButton`
 * - emotion with a label: `css-1a2b3c-Button` → `Button`
 * - BEM and utility classes stay as they are: `card__title`, `px-4`.
 */
export function readableClass(name: string): string | undefined {
	if (name === "" || name.length > 200) return undefined;
	const emotion = /^css-[a-z0-9]+-(.+)$/i.exec(name);
	if (emotion?.[1] !== undefined) return emotion[1];
	const styled = /^(.+?)-sc-[a-z0-9]+(?:-\d+)?$/i.exec(name);
	if (styled?.[1] !== undefined) return styled[1];
	const vite = /^_(.+)_[a-z0-9]{5}_\d+$/i.exec(name);
	if (vite?.[1] !== undefined) return vite[1];
	const modules = /^(.+?)__([A-Za-z0-9_-]+)$/.exec(name);
	if (
		modules?.[1] !== undefined &&
		modules[2] !== undefined &&
		looksLikeHash(modules[2])
	)
		return modules[1];
	if (isRandomClass(name)) return undefined;
	return name;
}

/** The readable parts of a `class` attribute, in order, without duplicates. */
export function readableClasses(classAttribute: string): string[] {
	const out: string[] = [];
	for (const name of classAttribute.split(/\s+/)) {
		const readable = readableClass(name);
		if (readable !== undefined && !out.includes(readable)) out.push(readable);
	}
	return out.slice(0, 20);
}

/**
 * An id that a framework or library generated: React `:r1:`, `«r1»` and
 * `_r_1_` (also inside a longer id, `_R_2abH1_-label`), UUIDs, long numbers or
 * hex, `ember123`, `mui-42`, `headlessui-menu-button-3`.
 */
export function isGeneratedId(id: string): boolean {
	if (id === "" || id.length > 100) return true;
	if (/[:«»]/.test(id)) return true;
	if (/_[rR]_[0-9a-z]+(H[0-9a-z]+)?_/.test(id)) return true;
	if (/\d{3,}/.test(id)) return true;
	if (/[0-9a-f]{8,}/i.test(id) && /\d/.test(id)) return true;
	if (/^[a-z]+-[a-z0-9-]*-\d+$/i.test(id)) return true;
	if (/^(ember|mui|rc|radix|headlessui|react-select)[-_]?/i.test(id))
		return /\d/.test(id);
	return false;
}
