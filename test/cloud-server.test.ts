/**
 * The sync against a real sitegloss.dev server (DEC-039), when one is named:
 *
 *   SITEGLOSS_SERVER=http://localhost:3200 SITEGLOSS_PASSWORD=… \
 *     bun test test/cloud-server.test.ts
 *
 * The server is the app's local one with its demo team
 * (`bun scripts/serve-local.ts 3200 --demo` in the server's repository): the
 * users tess@example.com and dana@example.com, with the password its demo
 * data gives them. Skipped without the variables: CI has no server. The
 * tokens are got as the extension gets them, by the authorization code flow
 * with PKCE; only the browser's window is replaced, by signing in with the
 * password and answering the consent page over HTTP.
 */

import { describe, expect, test } from "bun:test";
import {
	type Case,
	withChoice,
	withComment,
	withoutAnnotation,
} from "../src/lib/case.ts";
import { eventsUrl } from "../src/lib/cloud/api.ts";
import {
	AuthError,
	discover,
	refreshTokens,
	TOKENS_KEY,
	type Tokens,
} from "../src/lib/cloud/auth.ts";
import type { Account } from "../src/lib/cloud/book.ts";
import { listen } from "../src/lib/cloud/sse.ts";
import {
	addMark,
	change,
	images,
	look,
	PAY,
	removeCase,
	signIn,
	startCase,
	status,
	sync,
} from "./cloud-helpers.ts";
import { SERVER as BASE, real } from "./cloud-real.ts";

const serverTest = BASE === undefined ? describe.skip : describe;

serverTest("against a real server", () => {
	const base = BASE as string;
	const id = `c_it${Date.now().toString(36)}`;

	test("two devices of two people sync a case both ways, live", async () => {
		const tess = await real(base, "tess", "tess@example.com");
		const dana = await real(base, "dana", "dana@example.com");
		const me = await tess.device.api.me();
		expect(me.user.email).toBe("tess@example.com");
		const team = me.teams.find((t) => t.name === "Pedal & Pine web");
		expect(team?.permissions).toContain("mark:create");

		// Signing in fetches the team's cases: the demo case, its pictures too.
		await tess.device.engine.signedIn(base, me);
		await signIn(dana.device);
		const account = (await tess.device.engine.account()) as Account;
		expect(account.teamId).toBe(team?.id as string);
		expect(status(tess.device)?.state).toBe("synced");
		const demo = (await tess.device.store.getCase("demo_case_1")) as Case;
		expect(demo.annotations.length).toBeGreaterThanOrEqual(5);
		expect(demo.pages?.length).toBe(2);
		expect(demo.importedAt).toBeUndefined();
		expect(
			Object.values(await images(tess.device, "demo_case_1")),
		).not.toContain("MISSING");
		const crop = await tess.device.store.getImage(
			"demo_case_1",
			demo.annotations[0]?.crop as string,
		);
		const head = new Uint8Array(
			(await crop?.blob.arrayBuffer()) ?? new ArrayBuffer(0),
		).slice(0, 4);
		expect(new TextDecoder().decode(head)).toBe("RIFF");

		// The events stream, as the panel listens to it.
		const heard: number[] = [];
		const end = new AbortController();
		const listening = listen({
			url: eventsUrl(base, account.teamId as string),
			token: (fresh) => tess.session.access(base, fresh),
			onChange: (cursor) => heard.push(cursor),
			signal: end.signal,
		});

		// A new case of Tess's, across two pages.
		await startCase(tess.device, id);
		await addMark(tess.device, id, "Total is cut off", { element: true });
		await addMark(tess.device, id, "Pay button too pale", {
			url: PAY,
			title: "Payment",
		});
		await sync(tess.device, dana.device);
		const there = (await dana.device.store.getCase(id)) as Case;
		expect(look(there)).toEqual(look(await tess.device.store.getCase(id)));
		expect(
			look(there)?.marks.map((m) => [m.number, m.comment, m.page]),
		).toEqual([
			[1, "Total is cut off", "https://shop.example/cart"],
			[2, "Pay button too pale", PAY],
		]);
		expect(await images(dana.device, id)).toEqual(
			await images(tess.device, id),
		);
		expect(there.annotations[0]?.createdBy?.name).toBe("Tess Tester");
		// The pages are the server's, made from the screenshots: each with
		// the title its first screenshot named, though no list was ever sent.
		expect(there.pages).toEqual([
			{ url: "https://shop.example/cart", title: "Your cart", lang: "en" },
			{ url: PAY, title: "Payment", lang: "en" },
		]);
		expect(there.page.url).toBe("https://shop.example/cart");
		// Dana settles a mark: Tess hears of it on the stream, and has it with who did it.
		const before = heard.length;
		await change(dana.device, id, (c, now) =>
			withChoice(c, "a1", "fixed", "Widened the column", now),
		);
		await dana.device.engine.request();
		for (let i = 0; i < 50 && heard.length === before; i++)
			await new Promise((r) => setTimeout(r, 100));
		expect(heard.length).toBeGreaterThan(before);
		await tess.device.engine.request();
		const mine = (await tess.device.store.getCase(id)) as Case;
		expect(mine.annotations[0]?.resolution).toMatchObject({
			kind: "fixed",
			note: "Widened the column",
			user: { name: "Dana Developer" },
		});

		// Both add a mark at once: the server gives the later one the next number.
		await addMark(tess.device, id, "Tess's third");
		await addMark(dana.device, id, "Dana's third");
		await tess.device.engine.request();
		await dana.device.engine.request();
		await sync(tess.device, dana.device);
		for (const d of [tess.device, dana.device])
			expect(
				look(await d.store.getCase(id))?.marks.map((m) => [m.id, m.comment]),
			).toEqual([
				["a1", "Total is cut off"],
				["a2", "Pay button too pale"],
				["a3", "Tess's third"],
				["a4", "Dana's third"],
			]);
		expect(await images(dana.device, id)).toEqual(
			await images(tess.device, id),
		);

		// Two changes to one mark: both stay.
		await change(tess.device, id, (c, now) =>
			withComment(c, "a2", "Edited by Tess", now),
		);
		await change(dana.device, id, (c, now) =>
			withChoice(c, "a2", "wontfix", "", now),
		);
		await sync(tess.device, dana.device);
		for (const d of [tess.device, dana.device])
			expect(look(await d.store.getCase(id))?.marks[1]).toMatchObject({
				comment: "Edited by Tess",
				status: "wontfix",
			});

		// The refresh token rotates, and the new one works.
		const first = (tess.kv.data.get(TOKENS_KEY) as Tokens).refresh;
		await tess.session.access(base, true);
		const second = (tess.kv.data.get(TOKENS_KEY) as Tokens).refresh;
		expect(second).not.toBe(first);
		await tess.session.access(base, true);
		expect((await tess.device.api.me()).user.email).toBe("tess@example.com");

		// The same page on localhost is no second page at the server either,
		// and a page leaves the server's list with its last mark.
		const local = await addMark(dana.device, id, "Here too", {
			url: "http://localhost:3000/checkout/pay/",
			title: "Payment (dev)",
		});
		const done = await addMark(dana.device, id, "Thanks page", {
			url: "https://shop.example/done",
			title: "Thank you",
		});
		await sync(dana.device, tess.device);
		expect(
			(await tess.device.store.getCase(id))?.pages?.map((p) => [
				p.url,
				p.title,
			]),
		).toEqual([
			["https://shop.example/cart", "Your cart"],
			[PAY, "Payment"],
			["https://shop.example/done", "Thank you"],
		]);
		for (const gone of [done.id, local.id])
			await change(dana.device, id, (c, now) =>
				withoutAnnotation(c, gone, now),
			);
		await sync(dana.device, tess.device);
		expect(
			(await tess.device.store.getCase(id))?.pages?.map((p) => p.url),
		).toEqual(["https://shop.example/cart", PAY]);
		expect(status(tess.device)?.problems).toEqual([]);

		// Deleted on one device: deleted for the team, and gone on the other.
		await removeCase(tess.device, id);
		await tess.device.engine.request();
		await dana.device.engine.request();
		expect(await dana.device.store.getCase(id)).toBeUndefined();
		expect(status(dana.device)?.state).toBe("synced");
		expect(status(tess.device)?.problems).toEqual([]);

		// Signing out ends the grant at the server: its tokens are refused.
		end.abort();
		await listening;
		const { access: old, refresh: spent } = tess.kv.data.get(
			TOKENS_KEY,
		) as Tokens;
		await tess.session.end(base);
		// The real server took the extension's sign-out (a public client's,
		// without a secret): the refresh token is worth nothing afterwards.
		const again = await refreshTokens(
			(input, init) => fetch(input, init),
			base,
			await discover((input, init) => fetch(input, init), base),
			{ access: old, refresh: spent, expiresAt: 0 },
			Date.now(),
		).catch((error: unknown) => error);
		expect(again).toBeInstanceOf(AuthError);
		expect((again as AuthError).signedOut).toBe(true);
		const refused = await fetch(`${base}/api/v1/me`, {
			headers: { authorization: `Bearer ${old}` },
		});
		// The access token is a signed one and holds until it runs out; the
		// refresh token is what the server ends.
		expect([200, 401]).toContain(refused.status);
		expect(tess.kv.data.has(TOKENS_KEY)).toBe(false);
		await dana.session.end(base);
	}, 120_000);
});
