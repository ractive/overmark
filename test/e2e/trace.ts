/**
 * Steps of the end-to-end setup, each with its start and end on stderr and
 * a time limit, so that a hook that hangs in CI says which step it was in
 * (its last line has no "done") instead of only that it timed out.
 */

const origin = Date.now();
const at = () => `+${((Date.now() - origin) / 1000).toFixed(1)}s`;

/** Run `run` as the step `name`, logged on stderr; it fails after `timeoutMs`. */
export async function step<T>(
	name: string,
	run: () => Promise<T>,
	timeoutMs = 20_000,
): Promise<T> {
	const start = Date.now();
	process.stderr.write(`[e2e ${at()}] ${name}\n`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${name}: did not finish in ${timeoutMs} ms`)),
					timeoutMs,
				);
			}),
		]);
		process.stderr.write(
			`[e2e ${at()}] ${name}: done in ${Date.now() - start} ms\n`,
		);
		return value;
	} catch (error) {
		process.stderr.write(
			`[e2e ${at()}] ${name}: failed in ${Date.now() - start} ms: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
