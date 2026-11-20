import { describe, expect, test } from "bun:test";
import {
	type CardStatus,
	CONFIRM_DELAY_MS,
	cardStatus,
	cardView,
	confirms,
	hasNewGrant,
	switchShown,
} from "../src/sidepanel/card.ts";
import type { AiState } from "../src/worker/protocol.ts";

const base: AiState = {
	relay: "https://relay.example",
	keepOn: false,
	blurForms: false,
	state: "disconnected",
	retrying: false,
	grants: [],
	pairing: false,
	questions: [],
};
const ADDRESS = "https://relay.example/s/sitegloss/mcp";
const claude = {
	grantId: "g1",
	name: "Claude",
	host: "claude.ai",
	allowAll: false,
	always: [],
};

describe("the AI app card", () => {
	test.each([
		[{}, "off"],
		[{ problem: "Could not connect" }, "off"],
		[{ state: "connecting" }, "connecting"],
		[{ state: "reconnecting" }, "retrying"],
		[{ retrying: true, problem: "Could not connect" }, "retrying"],
		[{ state: "connected" }, "waiting"],
		[{ state: "connected", grants: [claude] }, "on"],
	] as [Partial<AiState>, CardStatus][])("%o is %s", (change, status) => {
		expect(cardStatus({ ...base, ...change })).toBe(status);
	});

	test("off: the switch is off, Turn on AI access is the step, no address", () => {
		expect(cardView({ ...base, address: ADDRESS }, false)).toEqual({
			status: "off",
			stateText: "AI access is off · paired apps stay paired",
			switchOn: false,
			turnOn: true,
			pairing: false,
			addApp: false,
			done: false,
			address: "",
		});
	});

	test("connecting or retrying: the switch is on (to stop it), nothing to pair yet", () => {
		for (const change of [{ state: "connecting" }, { retrying: true }] as const)
			expect(cardView({ ...base, ...change }, true)).toMatchObject({
				switchOn: true,
				turnOn: false,
				pairing: false,
				addApp: false,
			});
	});

	test("on with no app paired: the address and the code at once, no Done", () => {
		const view = cardView(
			{ ...base, state: "connected", address: ADDRESS },
			false,
		);
		expect(view).toEqual({
			status: "waiting",
			stateText: "On · no AI app paired yet",
			switchOn: true,
			turnOn: false,
			pairing: true,
			addApp: false,
			done: false,
			address: ADDRESS,
		});
	});

	test("apps paired: their names, + Add another AI app, the address hidden until asked", () => {
		const state: AiState = {
			...base,
			state: "connected",
			address: ADDRESS,
			grants: [
				claude,
				{
					grantId: "g2",
					name: "",
					host: "chatgpt.com",
					allowAll: false,
					always: [],
				},
			],
		};
		expect(cardView(state, false)).toEqual({
			status: "on",
			stateText: "Connected · Claude, chatgpt.com",
			switchOn: true,
			turnOn: false,
			pairing: false,
			addApp: true,
			done: false,
			address: "",
		});
		expect(cardView(state, true)).toMatchObject({
			pairing: true,
			addApp: false,
			done: true,
			address: ADDRESS,
		});
	});
});

describe("the card's clicks", () => {
	test("the second click of a double click does not confirm Disconnect", () => {
		expect(confirms(1000, 1000 + 120)).toBe(false);
		expect(confirms(1000, 1000 + CONFIRM_DELAY_MS - 1)).toBe(false);
		expect(confirms(1000, 1000 + CONFIRM_DELAY_MS)).toBe(true);
	});

	test("the switch keeps the user's flip until the state follows, or the wait ends", () => {
		const intent = { on: true, until: 5000 };
		// A state from before the connect: the switch stays on.
		expect(switchShown(false, intent, 1000)).toEqual({ checked: true, intent });
		// The state follows: the intent is done.
		expect(switchShown(true, intent, 1200)).toEqual({
			checked: true,
			intent: undefined,
		});
		// It never followed: the state wins after the wait.
		expect(switchShown(false, intent, 5000)).toEqual({
			checked: false,
			intent: undefined,
		});
		expect(switchShown(true, undefined, 0)).toEqual({
			checked: true,
			intent: undefined,
		});
	});
});

describe("hasNewGrant", () => {
	const connected: AiState = { ...base, state: "connected", grants: [claude] };

	test("no new app: the pairing box stays for the one being added", () => {
		expect(hasNewGrant(new Set(["g1"]), connected)).toBe(false);
	});

	test("the app being added connected: adding ends", () => {
		const code = { ...claude, grantId: "g2", name: "Claude Code" };
		const both = { ...connected, grants: [claude, code] };
		expect(hasNewGrant(new Set(["g1"]), both)).toBe(true);
		// The view then shows the card without the box.
		expect(cardView(both, false).pairing).toBe(false);
	});

	test("an app disconnected meanwhile is no new one", () => {
		expect(hasNewGrant(new Set(["g1", "g2"]), connected)).toBe(false);
	});
});
