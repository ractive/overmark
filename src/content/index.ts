/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import { describeElement } from "../lib/element.ts";
import type {
	BlurResult,
	Broadcast,
	ContentRequest,
	DescribedElement,
	Released,
} from "../lib/messages.ts";
import { PageActivity } from "./activity.ts";
import { Annotator } from "./annotator.ts";
import { PageBlur } from "./blur.ts";
import { HOST_ID, Overlay } from "./overlay.ts";
import { Reviewer } from "./review.ts";

declare global {
	var __overmark: boolean | undefined;
}

const pageBlur = new PageBlur(document);
const activity = new PageActivity();

/** Lets go of the blur an AI app's `element:mark` or `page:blur` holds. */
let releaseBlur: (() => void) | undefined;

function unblur(): void {
	releaseBlur?.();
	releaseBlur = undefined;
}

/** An AI app's screenshot is over (or abandoned): its mark and blur go. */
function endAi(overlay: Overlay): void {
	overlay.setTemporaryMark(null);
	unblur();
}

function mark(
	overlay: Overlay,
	selector: string,
	number: number,
	blurForms: boolean,
): DescribedElement {
	let matches: Element[];
	try {
		matches = [...document.querySelectorAll(selector)].filter(
			(e) => !overlay.host.contains(e),
		);
	} catch {
		return { ok: false, error: `Not a valid CSS selector: ${selector}` };
	}
	if (matches.length === 0)
		return { ok: false, error: `No element on this page matches ${selector}` };
	// Layouts often keep a hidden copy: a mark on it would sit in the corner.
	const el = matches.find((e) => {
		const box = e.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	});
	if (el === undefined)
		return { ok: false, error: `Nothing that matches ${selector} is visible.` };
	const started = activity.begin("ai-mark", () => endAi(overlay));
	if (!started.ok) return started;
	el.scrollIntoView({
		block: "center",
		inline: "nearest",
		behavior: "instant",
	});
	const r = el.getBoundingClientRect();
	const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
	overlay.setTemporaryMark({ number, rect });
	releaseBlur = pageBlur.hold(blurForms);
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
	const annotator = new Annotator(overlay, pageBlur, activity);
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
				case "overlay:settings":
					annotator.setBlurForms(message.blurForms);
					sendResponse(state());
					break;
				case "page:captured":
					annotator.captured();
					break;
				case "case:load":
					if (activity.busy !== undefined) {
						sendResponse({ error: activity.busy });
						break;
					}
					reviewer.load(message.case).then(sendResponse, (error: unknown) =>
						sendResponse({
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					return true; // answers asynchronously
				case "case:show":
					if (activity.busy !== undefined) {
						sendResponse({ error: activity.busy });
						break;
					}
					sendResponse(
						reviewer.caseId === message.caseId
							? (reviewer.show(message.annotationId, message.candidate) ?? null)
							: null,
					);
					break;
				case "case:clear":
					// An AI app may have loaded another case meanwhile: that one stays.
					if (
						message.caseId === undefined ||
						message.caseId === reviewer.caseId
					)
						reviewer.clear();
					sendResponse(state());
					break;
				case "element:mark":
					sendResponse(
						mark(overlay, message.selector, message.number, message.blurForms),
					);
					break;
				case "element:unmark": {
					const held = activity.now.kind === "ai-mark";
					activity.end("ai-mark");
					endAi(overlay);
					sendResponse({ held } satisfies Released);
					break;
				}
				case "page:blur": {
					const started = activity.begin("ai-capture", () => endAi(overlay));
					if (started.ok) releaseBlur = pageBlur.hold(message.blurForms);
					sendResponse(started satisfies BlurResult);
					break;
				}
				case "page:unblur": {
					const held = activity.now.kind === "ai-capture";
					activity.end("ai-capture");
					unblur();
					sendResponse({ held } satisfies Released);
					break;
				}
				default:
					return false;
			}
			return false;
		},
	);
	// The panel learns that Overmark runs here now: after a click on the
	// icon, a case waiting for this tab loads.
	overlay.onChange();
}

if (!globalThis.__overmark) {
	globalThis.__overmark = true;
	start();
}
