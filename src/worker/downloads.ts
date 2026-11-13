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
	TargetFailed,
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

/**
 * A document left open by a worker that stopped in the middle of a run: it
 * goes at the worker's start, before a run opens one of its own.
 */
let cleared: Promise<void> | undefined;
function clearLeftover(): Promise<void> {
	cleared ??= (async () => {
		if (await chrome.offscreen.hasDocument())
			await chrome.offscreen.closeDocument();
	})().catch(() => undefined);
	return cleared;
}

/** The offscreen document, opened once however many ask at the same time. */
function offscreen(): Promise<void> {
	opening ??= (async () => {
		await clearLeftover();
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

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Ask the offscreen document. Its not opening or not answering is the
 * target's failure, not each case's: the run stops there.
 */
async function ask(request: OffscreenRequest): Promise<OffscreenResponse> {
	let answer: OffscreenResponse | undefined;
	try {
		await offscreen();
		answer = (await chrome.runtime.sendMessage(request)) as
			| OffscreenResponse
			| undefined;
	} catch (error) {
		throw new TargetFailed(
			`Overmark could not prepare the files for your downloads: ${message(error)} Overmark tries again at the next change, or click Try again.`,
		);
	}
	if (answer === undefined)
		throw new TargetFailed(
			"Overmark could not prepare the files for your downloads: its offscreen document did not answer. Overmark tries again at the next change, or click Try again.",
		);
	return answer;
}

/**
 * While the worker waits for a download it calls an extension API this
 * often: that keeps Chrome from stopping it after 30 s without events.
 */
export const KEEP_ALIVE_MS = 20_000;

/** How download `id` ended, by `chrome.downloads.onChanged`. */
export function finished(
	id: number,
	timeoutMs: number,
	keepAliveMs = KEEP_ALIVE_MS,
): Promise<DownloadEnd> {
	return new Promise((resolve, reject) => {
		let done = false;
		const stop = () => {
			done = true;
			clearTimeout(timer);
			clearInterval(alive);
			chrome.downloads.onChanged.removeListener(changed);
		};
		const end = (result: DownloadEnd) => {
			if (done) return;
			stop();
			resolve(result);
		};
		const fail = (error: unknown) => {
			if (done) return;
			stop();
			reject(error);
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
			if (delta.id === id && delta.state !== undefined) check().catch(fail);
		};
		const timer = setTimeout(() => end({ state: "timeout" }), timeoutMs);
		const alive = setInterval(
			() => void chrome.runtime.getPlatformInfo().catch(() => undefined),
			keepAliveMs,
		);
		chrome.downloads.onChanged.addListener(changed);
		// It may have ended before the listener was there.
		check().catch(fail);
	});
}

/** Chrome's downloads, for the sync's database `kv`. */
export function chromeDownloads(kv: Kv): DownloadsApi {
	// At the worker's start: a document a stopped worker left goes.
	void clearLeftover();
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
