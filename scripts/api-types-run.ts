/**
 * The part of `scripts/api-types.ts` that runs openapi-typescript. On its
 * own it would not run: openapi-typescript needs TypeScript 5's compiler
 * API, and this repository's `typescript` is 7, which has none. So
 * `api-types.ts` bundles this file with `typescript` pointed at TypeScript 5
 * (the dev dependency `typescript-5`) and runs the bundle.
 */

import openapiTS, { astToString } from "openapi-typescript";

/** The types of an OpenAPI document, as TypeScript source. */
export async function generate(spec: URL): Promise<string> {
	return astToString(await openapiTS(spec));
}
