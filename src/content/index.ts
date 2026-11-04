/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import type { Broadcast, ContentRequest } from "../lib/messages.ts";
import { Annotator } from "./annotator.ts";
import { HOST_ID, Overlay } from "./overlay.ts";

declare global {
	var __overmark: boolean | undefined;
}

function start(): void {
	// An instance orphaned by an extension reload or update leaves its overlay
	// behind; its script can no longer be reached, so take the page over.
	document.getElementById(HOST_ID)?.remove();
	const overlay = new Overlay(document);
	const annotator = new Annotator(overlay);
	overlay.onChange = () => {
		const message: Broadcast = {
			type: "overlay:changed",
			state: annotator.state(),
		};
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
