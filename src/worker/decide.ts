/**
 * Whether a call of a tool that changes something may run (DEC-018): Always
 * allow for that tool, or Allow all changes, for the AI app it came from;
 * otherwise the user's answer to a question. Only for an AI app connected
 * through the relay: a call through the browser's WebMCP (which Overmark
 * leaves off) is refused without a question. A question nobody answered in
 * time is `"unanswered"`: the AI app hears that, not that the user declined.
 */

import type { ConfirmAnswer, ConfirmRequest } from "@ractive-ch/tab-mcp-client";
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
	/** A call that is not an AI app's through the relay was refused. */
	refused?(request: ConfirmRequest): void;
}

export async function decide(
	d: Decider,
	request: ConfirmRequest,
): Promise<ConfirmAnswer> {
	// Overmark turns WebMCP off; should a call come through it all the same,
	// it is refused: no question, no Always allow (they are per AI app).
	if (request.client.kind !== "relay") {
		d.refused?.(request);
		return false;
	}
	const { grantId } = request.client;
	const tool = request.tool.name;
	if (d.always.has(grantId, tool)) return true;
	const answer = await d.ask(request);
	// Kept only for an app still connected: one disconnected while the
	// question was open gets nothing from it.
	if (answer === "always" && d.connected(grantId))
		await d.always.addTool(grantId, tool).then(d.kept, d.notKept);
	if (answer === "timeout") return "unanswered";
	return answer === "allow" || answer === "always";
}
