/**
 * Saving an export (DEC-020). With the optional "downloads" permission it goes
 * through `chrome.downloads`, so the panel can say where the file went; without
 * it (a no to Chrome's prompt, or no such API) as a link's download, as before.
 */

export const DOWNLOADS: chrome.permissions.Permissions = {
	permissions: ["downloads"],
};

/**
 * Chrome's prompt for "downloads". It shows only during a click, so call it
 * before anything is awaited; where Overmark has it already, the answer is yes
 * at once and nothing shows. Asked again at the next click after a no, never
 * otherwise.
 */
export function askForDownloads(): Promise<boolean> {
	try {
		return chrome.permissions.request(DOWNLOADS).then(
			(granted) => granted === true,
			(error: unknown) => {
				// Not the user's no: outside a click, say. The file is saved anyway.
				console.warn(`Overmark could not ask for downloads: ${error}`);
				return false;
			},
		);
	} catch (error) {
		console.warn(`Overmark could not ask for downloads: ${error}`);
		return Promise.resolve(false);
	}
}

/** Where a file was saved, as Chrome tells. */
export interface SavedFile {
	downloadId: number;
	/** The absolute path. */
	path: string;
}

/** The download done; `undefined` when the user cancelled Chrome's Save as. */
function finished(
	id: number,
): Promise<chrome.downloads.DownloadItem | undefined> {
	return new Promise((resolve, reject) => {
		let done = false;
		const end = () => {
			done = true;
			chrome.downloads.onChanged.removeListener(changed);
		};
		const check = async () => {
			const [item] = await chrome.downloads.search({ id });
			if (done) return;
			if (item === undefined) {
				end();
				reject(new Error("Chrome lost the download."));
			} else if (item.state === "complete") {
				end();
				resolve(item);
			} else if (item.state === "interrupted") {
				end();
				if (item.error === "USER_CANCELED") resolve(undefined);
				else
					reject(
						new Error(`Chrome stopped saving the file (${item.error ?? "?"}).`),
					);
			}
		};
		const changed = (delta: chrome.downloads.DownloadDelta) => {
			if (delta.id === id && delta.state !== undefined) check().catch(reject);
		};
		chrome.downloads.onChanged.addListener(changed);
		// It may have ended before the listener was there.
		check().catch(reject);
	});
}

/** The way without the permission: Chrome saves it, and says nothing. */
function saveByLink(url: string, name: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
}

/**
 * Save `bytes` as `name`. Where it went, when `allowed` (askForDownloads,
 * asked in the click) says yes; otherwise, or when the user cancelled Chrome's
 * Save as, `undefined`.
 */
export async function saveFile(
	bytes: Uint8Array,
	name: string,
	allowed: Promise<boolean>,
): Promise<SavedFile | undefined> {
	const url = URL.createObjectURL(
		new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
	);
	let id: number | undefined;
	if ((await allowed) && typeof chrome.downloads?.download === "function") {
		try {
			id = await chrome.downloads.download({ url, filename: name });
		} catch (error) {
			// The file still gets saved, the old way.
			console.warn(`Overmark could not save through downloads: ${error}`);
		}
	}
	if (id === undefined) {
		saveByLink(url, name);
		// The link's download reads the URL after this task.
		setTimeout(() => URL.revokeObjectURL(url), 30_000);
		return undefined;
	}
	try {
		const item = await finished(id);
		return item === undefined
			? undefined
			: { downloadId: id, path: item.filename };
	} finally {
		URL.revokeObjectURL(url);
	}
}
