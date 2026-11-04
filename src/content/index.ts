/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import { describeElement } from "../lib/element.ts";
import type {
	Broadcast,
	ContentRequest,
	DescribedElement,
} from "../lib/messages.ts";
import { Annotator } from "./annotator.ts";
import { blurFields } from "./blur.ts";
import { HOST_ID, Overlay } from "./overlay.ts";
import { Reviewer } from "./review.ts";

declare global {
	var __overmark: boolean | undefined;
}

/** Undoes the blur of `element:mark` or `page:blur`. */
let restoreBlur: (() => void) | undefined;

function blur(allForms: boolean): void {
	restoreBlur?.();
	restoreBlur = blurFields(document, allForms);
}

function unblur(): void {
	restoreBlur?.();
	restoreBlur = undefined;
}

function mark(
	overlay: Overlay,
	annotator: Annotator,
	selector: string,
	number: number,
	blurForms: boolean,
): DescribedElement {
	if (annotator.state().saving)
		return {
			ok: false,
			error:
				"The user is saving marks on this page right now; try again in a few seconds.",
		};
	let el: Element | null;
	try {
		el = document.querySelector(selector);
	} catch {
		return { ok: false, error: `Not a valid CSS selector: ${selector}` };
	}
	if (el === null || overlay.host.contains(el))
		return { ok: false, error: `No element on this page matches ${selector}` };
	el.scrollIntoView({
		block: "center",
		inline: "nearest",
		behavior: "instant",
	});
	const r = el.getBoundingClientRect();
	const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
	overlay.setTemporaryMark({ number, rect });
	blur(blurForms);
	return {
		ok: true,
		details: describeElement(el),
		rect,
		viewport: {
			width: innerWidth,
			height: innerHeight,
			dpr: devicePixelRatio || 1,
		},
		scroll: { x: scrollX, y: scrollY },
		url: location.href,
		title: document.title,
	};
}

function start(): void {
	// An instance orphaned by an extension reload or update leaves its overlay
	// behind; its script can no longer be reached, so take the page over.
	document.getElementById(HOST_ID)?.remove();
	const overlay = new Overlay(document);
	const annotator = new Annotator(overlay);
	const reviewer = new Reviewer(overlay);
	const state = () => {
		const s = annotator.state();
		const loaded = reviewer.caseId;
		return loaded === undefined ? s : { ...s, loadedCase: loaded };
	};
	overlay.onChange = () => {
		const message: Broadcast = { type: "overlay:changed", state: state() };
		// Nobody may be listening (side panel closed): that is fine.
		chrome.runtime.sendMessage(message).catch(() => {});
	};
	chrome.runtime.onMessage.addListener(
		(message: ContentRequest, sender, sendResponse) => {
			if (sender.id !== chrome.runtime.id) return false;
			switch (message.type) {
				case "overlay:show":
					annotator.show({
						...(message.target ? { target: message.target } : {}),
						...(message.blurForms !== undefined
							? { blurForms: message.blurForms }
							: {}),
					});
					sendResponse(state());
					break;
				case "overlay:hide":
					annotator.hide();
					sendResponse(state());
					break;
				case "overlay:state":
					sendResponse(state());
					break;
				case "case:load":
					reviewer.load(message.case).then(sendResponse, (error: unknown) =>
						sendResponse({
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					return true; // answers asynchronously
				case "case:show":
					sendResponse(
						reviewer.caseId === message.caseId
							? (reviewer.show(message.annotationId, message.candidate) ?? null)
							: null,
					);
					break;
				case "case:clear":
					reviewer.clear();
					sendResponse(state());
					break;
				case "element:mark":
					sendResponse(
						mark(
							overlay,
							annotator,
							message.selector,
							message.number,
							message.blurForms,
						),
					);
					break;
				case "element:unmark":
					overlay.setTemporaryMark(null);
					unblur();
					sendResponse(state());
					break;
				case "page:blur":
					blur(message.blurForms);
					sendResponse(state());
					break;
				case "page:unblur":
					unblur();
					sendResponse(state());
					break;
				default:
					return false;
			}
			return false;
		},
	);
}

if (!globalThis.__overmark) {
	globalThis.__overmark = true;
	start();
}
