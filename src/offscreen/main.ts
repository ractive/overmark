/**
 * The offscreen document (DEC-025): exports a case from the extension's own
 * database and makes a blob URL of it for the worker's download; revokes it
 * once the worker says the download is over. Only the worker is answered.
 */

import { isSafeId } from "../lib/case.ts";
import { exportCase } from "../lib/export.ts";
import { IdbStore } from "../lib/store.ts";
import {
	isOffscreenRequest,
	type OffscreenRequest,
	type OffscreenResponse,
} from "./protocol.ts";

const store = new IdbStore();
const WORKER = chrome.runtime.getURL("background.js");

async function answer(request: OffscreenRequest): Promise<OffscreenResponse> {
	if (request.type === "offscreen:revoke") {
		URL.revokeObjectURL(request.url);
		return { ok: true };
	}
	if (!isSafeId(request.caseId)) throw new Error("invalid id");
	const c = await store.getCase(request.caseId);
	if (c === undefined) throw new Error("the case is gone");
	const zip = await exportCase(store, c);
	const blob = new Blob([zip as Uint8Array<ArrayBuffer>], {
		type: "application/zip",
	});
	return { ok: true, url: URL.createObjectURL(blob) };
}

chrome.runtime.onMessage.addListener((request: unknown, sender, reply) => {
	// The side panel hears the worker's messages too, and a content script may send one.
	if (sender.id !== chrome.runtime.id || sender.url !== WORKER) return false;
	if (!isOffscreenRequest(request)) return false;
	answer(request).then(reply, (error: unknown) =>
		reply({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		} satisfies OffscreenResponse),
	);
	return true;
});
