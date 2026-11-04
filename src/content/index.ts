/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import type { ContentRequest } from "../lib/messages.ts";
import { Annotator } from "./annotator.ts";
import { Overlay } from "./overlay.ts";
import { Reviewer } from "./review.ts";

declare global {
	var __overmark: boolean | undefined;
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
					reviewer.load(message.case).then(sendResponse, (error: unknown) =>
						sendResponse({
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					return true; // answers asynchronously
				case "case:show":
					sendResponse(
						reviewer.show(message.annotationId, message.candidate) ?? null,
					);
					break;
				case "case:clear":
					reviewer.clear();
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
