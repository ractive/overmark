import { CASE_FORMAT, type Case } from "../src/lib/case.ts";

/** A case without shots or annotations. */
export function sampleCase(
	id = "c_1",
	updatedAt = "2026-11-04T10:00:00Z",
): Case {
	return {
		format: CASE_FORMAT,
		id,
		title: "Button contrast",
		createdAt: "2026-11-04T10:00:00Z",
		updatedAt,
		page: {
			url: "https://www.example.com/kk",
			title: "KK",
			lang: "de",
			viewport: { width: 1280, height: 800, dpr: 2 },
			userAgent: "test",
		},
		shots: [],
		annotations: [],
		verdict: null,
	};
}
