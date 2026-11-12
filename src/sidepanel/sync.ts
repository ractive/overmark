/**
 * The side panel's part of the sync to a folder (DEC-021): choosing the
 * folder (Chrome's picker needs the click), Change folder, Stop syncing, and
 * giving Chrome's permission again ("Allow access"), which also needs a click
 * in a window. The service worker writes the files; the panel reads its
 * status from the sync's database and asks it to run.
 */

import { newId } from "../lib/case.ts";
import { type Kv, kvWhenOpen, openKv } from "../lib/kv.ts";
import type { Broadcast } from "../lib/messages.ts";
import {
	type ChosenFolder,
	chooseFolder,
	FOLDER_KEY,
	type PickedFolder,
	STATUS_KEY,
	SYNC_DATABASE,
	type SyncStatus,
	stopSyncing,
} from "../lib/sync.ts";
import type { PanelState } from "./state.ts";

declare const OVERMARK_TEST_BUILD: boolean | undefined;

/** A folder handle as a window has it: it may ask for permission. */
interface WindowFolder extends PickedFolder {
	requestPermission(descriptor: {
		mode: "readwrite";
	}): Promise<"granted" | "denied" | "prompt">;
}

type Picker = (options: {
	id?: string;
	mode: "readwrite";
	startIn?: string;
}) => Promise<WindowFolder>;

type Update = (change: (s: PanelState) => void) => void;

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** The panel's view of the sync, and its actions. */
export interface PanelSync {
	/** Read the folder and the worker's status again. */
	refresh(): Promise<void>;
	/** "Sync to a folder…" and "Change folder…": call in the click. */
	choose(): void;
	stop(): void;
	/** "Allow access": call in the click. */
	allow(): void;
	/** "Try again". */
	retry(): void;
}

/** Ask the worker to bring the folder up to date. */
function run(): void {
	const news: Broadcast = { type: "sync:run" };
	chrome.runtime.sendMessage(news).catch(() => undefined);
}

/** The panel's sync; `kv` is the sync's database (tests pass their own). */
export function startSync(
	update: Update,
	kv: Kv = kvWhenOpen(() => openKv(SYNC_DATABASE)),
): PanelSync {
	/** The folder as last read, for a click that must not wait for the database. */
	let current: (ChosenFolder & { handle: WindowFolder }) | undefined;
	/** The problem `refresh` shows while the database cannot be read. */
	let unreadable: string | undefined;

	const problem = (text: string | undefined) =>
		update((s) => {
			s.sync.problem = text;
		});

	async function refresh(): Promise<void> {
		let all: Record<string, unknown>;
		try {
			all = await kv.all();
		} catch (error) {
			unreadable = `Could not read the sync's state: ${message(error)} Close and open the side panel to try again.`;
			problem(unreadable);
			return;
		}
		const folder = all[FOLDER_KEY] as typeof current;
		const status = all[STATUS_KEY] as SyncStatus | undefined;
		current = folder;
		const was = unreadable;
		unreadable = undefined;
		update((s) => {
			s.sync.folder = folder?.name;
			s.sync.status = status?.folderId === folder?.id ? status : undefined;
			// Readable again: that problem is over.
			if (was !== undefined && s.sync.problem === was)
				s.sync.problem = undefined;
		});
	}

	/** Use `handle` from now on: a folder synced before keeps what was written there. */
	async function use(handle: WindowFolder): Promise<void> {
		await chooseFolder(kv, handle, () => newId("f"));
		problem(undefined);
		await refresh();
		run();
	}

	function choose(): void {
		const picker = (window as unknown as { showDirectoryPicker?: Picker })
			.showDirectoryPicker;
		if (picker === undefined) {
			problem("This browser cannot write to a folder of your choice.");
			return;
		}
		// Chrome shows its picker only during a click: nothing is awaited before.
		let picking: Promise<WindowFolder>;
		try {
			picking = picker({ id: "overmark-sync", mode: "readwrite" });
		} catch (error) {
			problem(`Could not open the folder picker: ${message(error)}`);
			return;
		}
		picking.then(
			(handle) =>
				use(handle).catch((error: unknown) =>
					problem(`Could not use that folder: ${message(error)}`),
				),
			(error: unknown) => {
				// Cancelled in the picker: nothing changes.
				if ((error as { name?: string }).name === "AbortError") return;
				problem(`Could not use that folder: ${message(error)}`);
			},
		);
	}

	function stop(): void {
		// The folder stays known: choosing it again keeps what was written there.
		void stopSyncing(kv).then(
			() => {
				problem(undefined);
				return refresh();
			},
			(error: unknown) => problem(`Could not stop syncing: ${message(error)}`),
		);
	}

	function allow(): void {
		const folder = current;
		if (folder === undefined) return;
		// Chrome asks only during a click: nothing is awaited before.
		let asking: Promise<string>;
		try {
			asking = folder.handle.requestPermission({ mode: "readwrite" });
		} catch (error) {
			problem(`Could not ask for access: ${message(error)}`);
			return;
		}
		asking.then(
			(answer) => {
				if (answer === "granted") {
					problem(undefined);
					run();
				} else
					problem(
						`Chrome did not allow access to “${folder.name}”. Click Allow access to ask again, or Change folder… to choose another one.`,
					);
			},
			(error: unknown) =>
				problem(
					`Could not ask for access to “${folder.name}”: ${message(error)} Click Change folder… to choose it again.`,
				),
		);
	}

	// The end-to-end tests cannot answer Chrome's picker: they hand the panel a
	// folder of the origin's private file system instead.
	if (typeof OVERMARK_TEST_BUILD !== "undefined" && OVERMARK_TEST_BUILD)
		Object.assign(window, { overmarkUseFolder: use });

	void refresh().then(run);
	return {
		refresh,
		choose,
		stop,
		allow,
		retry: () => {
			problem(undefined);
			run();
		},
	};
}
