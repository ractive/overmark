/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import type { ContentRequest, OverlayState } from "../lib/messages.ts";
import { Overlay } from "./overlay.ts";

declare global {
	var __overmark: boolean | undefined;
}

function start(): void {
	const overlay = new Overlay(document);
	const state = (): OverlayState => ({
		visible: overlay.visible,
		url: location.href,
		title: document.title,
	});
	chrome.runtime.onMessage.addListener(
		(message: ContentRequest, _sender, sendResponse) => {
			switch (message.type) {
				case "overlay:show":
					overlay.show();
					break;
				case "overlay:hide":
					overlay.hide();
					break;
				case "overlay:state":
					break;
			}
			sendResponse(state());
			return false;
		},
	);
}

if (!globalThis.__overmark) {
	globalThis.__overmark = true;
	start();
}
