/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import { describeElement } from "../lib/element.ts";
import type { ContentRequest, DescribedElement } from "../lib/messages.ts";
import { Annotator } from "./annotator.ts";
import { Overlay } from "./overlay.ts";
import { Reviewer } from "./review.ts";

declare global {
	var __overmark: boolean | undefined;
}

function mark(
	overlay: Overlay,
	selector: string,
	number: number,
): DescribedElement {
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
	const overlay = new Overlay(document);
	const annotator = new Annotator(overlay);
	const reviewer = new Reviewer(overlay);
	const state = () => {
		const s = annotator.state();
		const loaded = reviewer.caseId;
		return loaded === undefined ? s : { ...s, loadedCase: loaded };
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
					sendResponse(reviewer.load(message.case));
					break;
				case "case:show":
					sendResponse(
						reviewer.show(message.annotationId, message.candidate) ?? null,
					);
					break;
				case "case:clear":
					reviewer.clear();
					sendResponse(state());
					break;
				case "element:mark":
					sendResponse(mark(overlay, message.selector, message.number));
					break;
				case "element:unmark":
					overlay.setTemporaryMark(null);
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
