/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import type { ContentRequest } from "../lib/messages.ts";
import { Annotator } from "./annotator.ts";
import { Overlay } from "./overlay.ts";

declare global {
	var __overmark: boolean | undefined;
}

function start(): void {
	const annotator = new Annotator(new Overlay(document));
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
					break;
				case "overlay:hide":
					annotator.hide();
					break;
				case "overlay:state":
					break;
				default:
					return false;
			}
			sendResponse(annotator.state());
			return false;
		},
	);
}

if (!globalThis.__overmark) {
	globalThis.__overmark = true;
	start();
}
