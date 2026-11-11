/**
 * Whether a call of a tool that changes something may run (DEC-018): Always
 * allow for that tool, or Allow all changes, for the AI app it came from;
 * otherwise the user's answer to a question.
 */

import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import type { AlwaysAllowed } from "./always.ts";
import type { Answer } from "./protocol.ts";

/** What `decide` needs. */
export interface Decider {
	always: Pick<AlwaysAllowed, "has" | "addTool">;
	/** Ask the user; `"timeout"` when nobody answered in time. */
	ask(request: ConfirmRequest): Promise<Answer | "timeout">;
	/** The AI app of `grantId` is still connected (the relay lists it). */
	connected(grantId: string): boolean;
	/** Always allow could not be kept; the call runs all the same. */
	notKept(error: unknown): void;
	/** Always allow was kept: questions it now covers need no answer. */
	kept(): void;
}

export async function decide(
	d: Decider,
	request: ConfirmRequest,
): Promise<boolean> {
	const { grantId } = request.client;
	const tool = request.tool.name;
	if (d.always.has(grantId, tool)) return true;
	const answer = await d.ask(request);
	// Kept only for an app still connected: one disconnected while the
	// question was open gets nothing from it.
	if (answer === "always" && d.connected(grantId))
		await d.always.addTool(grantId, tool).then(d.kept, d.notKept);
	return answer === "allow" || answer === "always";
}
