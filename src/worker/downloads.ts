/**
 * What the sync's Downloads target (DEC-025) needs of Chrome, in the worker:
 * the `downloads` permission and API, and the offscreen document that makes
 * the blob URLs (a service worker has no `URL.createObjectURL`). The document
 * is opened at the first file of a run and closed when the run is over.
 */

import type { Kv } from "../lib/kv.ts";
import {
	type DownloadEnd,
	type DownloadsApi,
	LAST_DOWNLOAD_KEY,
} from "../lib/sync.ts";
import {
	OFFSCREEN_PATH,
	type OffscreenRequest,
	type OffscreenResponse,
} from "../offscreen/protocol.ts";

const DOWNLOADS: chrome.permissions.Permissions = {
	permissions: ["downloads"],
};

let opening: Promise<void> | undefined;

/** The offscreen document, opened once however many ask at the same time. */
function offscreen(): Promise<void> {
	opening ??= (async () => {
		if (await chrome.offscreen.hasDocument()) return;
		await chrome.offscreen.createDocument({
			url: OFFSCREEN_PATH,
			reasons: [chrome.offscreen.Reason.BLOBS],
			justification:
				"Overmark writes each case to Downloads/Overmark: the download needs a blob URL of the case's file.",
		});
	})();
	opening.catch(() => undefined).finally(() => (opening = undefined));
	return opening;
}

async function ask(request: OffscreenRequest): Promise<OffscreenResponse> {
	await offscreen();
	const answer = (await chrome.runtime.sendMessage(request)) as
		| OffscreenResponse
		| undefined;
	if (answer === undefined)
		throw new Error("the offscreen document did not answer");
	return answer;
}

/** How download `id` ended, by `chrome.downloads.onChanged`. */
function finished(id: number, timeoutMs: number): Promise<DownloadEnd> {
	return new Promise((resolve, reject) => {
		let done = false;
		const end = (result: DownloadEnd) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			chrome.downloads.onChanged.removeListener(changed);
			resolve(result);
		};
		const check = async () => {
			const [item] = await chrome.downloads.search({ id });
			if (item === undefined) end({ state: "interrupted", error: "LOST" });
			else if (item.state === "complete")
				end({ state: "complete", filename: item.filename });
			else if (item.state === "interrupted")
				end({ state: "interrupted", error: item.error ?? "?" });
		};
		const changed = (delta: chrome.downloads.DownloadDelta) => {
			if (delta.id === id && delta.state !== undefined) check().catch(reject);
		};
		const timer = setTimeout(() => end({ state: "timeout" }), timeoutMs);
		chrome.downloads.onChanged.addListener(changed);
		// It may have ended before the listener was there.
		check().catch(reject);
	});
}

/** Chrome's downloads, for the sync's database `kv`. */
export function chromeDownloads(kv: Kv): DownloadsApi {
	return {
		granted: async () =>
			typeof chrome.downloads?.download === "function" &&
			(await chrome.permissions.contains(DOWNLOADS)),
		async url(c) {
			const answer = await ask({ type: "offscreen:export", caseId: c.id });
			if (!answer.ok) throw new Error(answer.error);
			if (answer.url === undefined) throw new Error("no URL");
			return answer.url;
		},
		async revoke(url) {
			// A document closed meanwhile took its URLs with it.
			if (!(await chrome.offscreen.hasDocument())) return;
			const request: OffscreenRequest = { type: "offscreen:revoke", url };
			await chrome.runtime.sendMessage(request);
		},
		download: (options) => chrome.downloads.download(options),
		finished,
		cancel: (id) => chrome.downloads.cancel(id),
		erase: async (id) => {
			await chrome.downloads.erase({ id });
		},
		last: async () => {
			const id = await kv.get(LAST_DOWNLOAD_KEY);
			return typeof id === "number" ? id : undefined;
		},
		setLast: (id) => kv.set({ [LAST_DOWNLOAD_KEY]: id }),
		async end() {
			await opening?.catch(() => undefined);
			if (await chrome.offscreen.hasDocument())
				await chrome.offscreen.closeDocument();
		},
	};
}
