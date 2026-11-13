/**
 * The offscreen document of the sync to Downloads (DEC-025). A service worker
 * has no `URL.createObjectURL`, so this document, which has, builds a case's
 * export and makes the blob URL the worker hands to `chrome.downloads`. It
 * answers the worker alone, and only while a sync run needs it.
 */

/** Its page in the build. */
export const OFFSCREEN_PATH = "offscreen/index.html";

/** From the worker. */
export type OffscreenRequest =
	| { type: "offscreen:export"; caseId: string }
	| { type: "offscreen:revoke"; url: string };

/** Its answer: the URL, or why the case could not be exported. */
export type OffscreenResponse =
	| { ok: true; url?: string }
	| { ok: false; error: string };

export function isOffscreenRequest(m: unknown): m is OffscreenRequest {
	const r = m as { type?: unknown; caseId?: unknown; url?: unknown } | null;
	return (
		(r?.type === "offscreen:export" && typeof r.caseId === "string") ||
		(r?.type === "offscreen:revoke" && typeof r.url === "string")
	);
}
