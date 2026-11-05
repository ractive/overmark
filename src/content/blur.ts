/**
 * Blurring form fields while a screenshot is taken: password fields always,
 * every form field when the user turned on "Blur form fields in screenshots".
 * Inline style through the CSSOM, which a page's CSP does not block.
 */

const FORM_FIELDS =
	"input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [contenteditable='true'], [contenteditable='']";

/** Blur the fields; the returned function restores them. */
export function blurFields(doc: Document, allForms: boolean): () => void {
	const fields = doc.querySelectorAll<HTMLElement>(
		allForms ? FORM_FIELDS : "input[type=password]",
	);
	const before = [...fields].map((f) => ({
		f,
		value: f.style.getPropertyValue("filter"),
		priority: f.style.getPropertyPriority("filter"),
	}));
	for (const { f } of before)
		f.style.setProperty("filter", "blur(6px)", "important");
	return () => {
		for (const { f, value, priority } of before) {
			if (value) f.style.setProperty("filter", value, priority);
			else f.style.removeProperty("filter");
		}
	};
}
