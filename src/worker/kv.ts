/**
 * The AI connection's settings and the address secret in IndexedDB, in the
 * extension's own origin and used from the service worker only (DEC-016).
 * Content scripts run in the page's origin and cannot reach it, whatever
 * Chrome's version. A database of its own: the cases' ("sitegloss") stays as it is.
 */

import { type Kv, openKv as openDatabase } from "../lib/kv.ts";

export { type Kv, kvWhenOpen, memoryKv } from "../lib/kv.ts";

export const DATABASE = "sitegloss-settings";

/** The settings database, opened (and made the first time). */
export const openKv = (name = DATABASE): Promise<Kv> => openDatabase(name);
