/**
 * A mark an AI app added at the server without a live page (MCP `add_mark`)
 * has its whole screenshot as its crop: a crop is cut here for showing it,
 * and nothing of it goes back (DEC-047).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Case, Rect } from "../src/lib/case.ts";
import type { Op } from "../src/lib/cloud/api.ts";
import type { StoredImage } from "../src/lib/store.ts";
import { type FakeApi, FakeServer, TEAM } from "./cloud-fake.ts";
import {
	addMark,
	type Device,
	device,
	signIn,
	startCase,
	sync,
	webp,
} from "./cloud-helpers.ts";

const TESS = { id: "u_tess", name: "Tess Tester" };
const DANA = { id: "u_dana", name: "Dana Developer" };

let server: FakeServer;
let tess: Device<FakeApi>;
let dana: Device<FakeApi>;
let cuts: { rect: Rect; viewportWidth: number; shotWidth: number }[];

beforeEach(() => {
	server = new FakeServer();
	cuts = [];
	tess = device("tess", server.api(TESS));
	dana = device("dana", server.api(DANA), false, {
		cutCrop: async (shot: StoredImage, rect: Rect, viewportWidth: number) => {
			cuts.push({ rect, viewportWidth, shotWidth: shot.width });
			return { blob: webp("cut here", 140, 90), width: 140, height: 90 };
		},
	});
});

/** A mark as MCP `add_mark` makes it: no element, the screenshot's image as its crop. */
async function addMarkAtServer(caseId: string): Promise<void> {
	const [shot] = server.shotsOf(caseId);
	if (shot === undefined) throw new Error("no shot");
	const op = {
		opId: "o_mcp_1",
		type: "mark.create",
		caseId,
		mark: {
			id: "m_mcp_1",
			number: 2,
			shotId: shot.id,
			comment: "Added by Claude at the server",
			author: "ai",
			shape: { kind: "box", rect: { x: 300, y: 200, width: 100, height: 50 } },
			crop: shot.image,
			element: null,
			resolution: null,
			reopens: [],
			findings: [],
		},
	} as unknown as Op;
	const { results } = await server.api(TESS).ops(TEAM, [op]);
	expect(results[0]?.status).toBe("applied");
}

describe("a mark added at the server without a live page", () => {
	test("gets a crop cut here around its shape; the server's crop stays the screenshot's", async () => {
		await signIn(tess);
		await signIn(dana);
		await startCase(tess, "c_mcp");
		await addMark(tess, "c_mcp", "First");
		await sync(tess, dana);
		await addMarkAtServer("c_mcp");
		await dana.engine.request();
		const c = (await dana.store.getCase("c_mcp")) as Case;
		const a = c.annotations.find((x) => x.number === 2);
		expect(a?.comment).toBe("Added by Claude at the server");
		expect(a?.element).toBeNull();
		// Cut around the box with the margin a drawn mark's crop has.
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.rect).toEqual({ x: 260, y: 160, width: 180, height: 130 });
		const crop = await dana.store.getImage("c_mcp", a?.crop as string);
		expect(crop?.width).toBe(140);
		// Nothing goes back: no op for it, and the server's crop is unchanged.
		const before = server.marksOf("c_mcp").find((m) => m.id === "m_mcp_1");
		await dana.engine.request();
		const after = server.marksOf("c_mcp").find((m) => m.id === "m_mcp_1");
		expect(after?.crop).toEqual(before?.crop as never);
		expect(after?.crop.sha256).toBe(server.shotsOf("c_mcp")[0]?.image.sha256);
	});

	test("without a cutter (or when cutting fails) the whole screenshot stays its crop", async () => {
		const plain = device("plain", server.api(DANA));
		await signIn(tess);
		await signIn(plain);
		await startCase(tess, "c_mcp");
		await addMark(tess, "c_mcp", "First");
		await sync(tess, plain);
		await addMarkAtServer("c_mcp");
		await plain.engine.request();
		const c = (await plain.store.getCase("c_mcp")) as Case;
		const a = c.annotations.find((x) => x.number === 2);
		const crop = await plain.store.getImage("c_mcp", a?.crop as string);
		const shot = await plain.store.getImage(
			"c_mcp",
			c.shots[0]?.image as string,
		);
		expect(crop?.width).toBe(shot?.width as number);
	});
});
