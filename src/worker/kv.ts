/**
 * The AI connection's settings and the address secret in IndexedDB, in the
 * extension's own origin and used from the service worker only (DEC-016).
 * Content scripts run in the page's origin and cannot reach it, whatever
 * Chrome's version; `chrome.storage.local` they can read and write by
 * default, and whether `setAccessLevel` closes it to them depends on the
 * Chrome. A database of its own: the cases' ("overmark") stays as it is.
 */

import { type Kv, openKv as openDatabase } from "../lib/kv.ts";
import { SECRET_PREFIX } from "./settings.ts";

export { type Kv, kvWhenOpen, memoryKv } from "../lib/kv.ts";

export const DATABASE = "overmark-settings";

/** The settings database, opened (and made the first time). */
export const openKv = (name = DATABASE): Promise<Kv> => openDatabase(name);

/**
 * The keys an unreleased build (overmark#26) kept in `chrome.storage.local`.
 * Only the owner's own build ever wrote them there.
 */
const OLD_KEYS = new Set([
	"relay",
	"keepAiOn",
	"blurForms",
	"replaced",
	"migrated",
]);

/** A key of the settings as `chrome.storage.local` had them. */
export function isOldSettingKey(key: string): boolean {
	return OLD_KEYS.has(key) || key.startsWith(SECRET_PREFIX);
}

/** What the clean-up needs of `chrome.storage.local`. */
export interface OldArea {
	get(keys: null): Promise<Record<string, unknown>>;
	remove(keys: string[]): Promise<void>;
}

/**
 * Remove the settings keys from `chrome.storage.local`, at every start, and
 * never take them over (DEC-016): where Chrome does not keep content scripts
 * out of that area, one could write a relay or a secret there for the worker
 * to pick up. Returns the keys removed.
 */
export async function removeOldSettings(old: OldArea): Promise<string[]> {
	const keys = Object.keys(await old.get(null)).filter(isOldSettingKey);
	if (keys.length > 0) await old.remove(keys);
	return keys;
}
