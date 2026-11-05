/**
 * The content script, injected on a click on the icon. A second injection
 * into the same page is a no-op: the first one keeps answering.
 */

import type {
	Broadcast,
	ContentRequest,
	OverlayState,
} from "../lib/messages.ts";
import { HOST_ID, Overlay } from "./overlay.ts";

declare global {
	var __overmark: boolean | undefined;
}

function start(): void {
	// An instance orphaned by an extension reload or update leaves its overlay
	// behind; its script can no longer be reached, so take the page over.
	document.getElementById(HOST_ID)?.remove();
	const overlay = new Overlay(document);
	const state = (): OverlayState => ({
		visible: overlay.visible,
		url: location.href,
		title: document.title,
	});
	overlay.onChange = () => {
		const message: Broadcast = { type: "overlay:changed", state: state() };
		// Nobody may be listening (side panel closed): that is fine.
		chrome.runtime.sendMessage(message).catch(() => {});
	};
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
