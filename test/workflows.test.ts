/**
 * The workflows' checks, run as GitHub would run them: each step's script
 * under `bash -e` with the environment it declares, and a stand-in for `gh`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Step {
	id?: string;
	name?: string;
	if?: string;
	uses?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
	run?: string;
}

interface Workflow {
	on: { workflow_dispatch?: { inputs: Record<string, unknown> } };
	permissions?: Record<string, string>;
	jobs: Record<
		string,
		{
			needs?: string | string[];
			if?: string;
			permissions?: Record<string, string>;
			outputs?: Record<string, string>;
			uses?: string;
			with?: Record<string, string | boolean>;
			secrets?: unknown;
			steps: Step[];
		}
	>;
}

const workflow = async (name: string) =>
	Bun.YAML.parse(
		await Bun.file(join(import.meta.dir, "../.github/workflows", name)).text(),
	) as Workflow;

function stepOf(w: Workflow, job: string, name: string): Step {
	const step = w.jobs[job]?.steps.find((s) => s.name === name);
	if (step === undefined) throw new Error(`no step ${name}`);
	return step;
}

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sitegloss-workflow-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A `gh` that prints `answer` and logs its arguments to `gh.log`, first on PATH. */
function fakeGh(answer: string): string {
	const dir = tempDir();
	const gh = join(dir, "gh");
	writeFileSync(
		gh,
		`#!/bin/sh\necho "$*" >> "$(dirname "$0")/gh.log"\necho ${answer}\n`,
	);
	chmodSync(gh, 0o755);
	return dir;
}

/** Run a step's script; `expressions` stand in for what GitHub puts into its env. */
async function run(
	step: Step,
	expressions: Record<string, string>,
	env: Record<string, string> = {},
	cwd = tempDir(),
): Promise<{ code: number; output: string }> {
	const declared = Object.fromEntries(
		Object.entries(step.env ?? {}).map(([key, value]) => [
			key,
			expressions[value] ?? value,
		]),
	);
	const script = join(tempDir(), "step.sh");
	writeFileSync(script, step.run ?? "");
	const proc = Bun.spawn(["bash", "-e", script], {
		cwd,
		env: {
			PATH: process.env["PATH"] ?? "",
			GITHUB_REPOSITORY: "ractive/sitegloss",
			...declared,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: stdout + stderr };
}

const PATH_WITH = (dir: string) => `${dir}:${process.env["PATH"]}`;

describe("publishing to the Chrome Web Store", () => {
	const REF = "${{ github.ref_name }}";
	const SHARED =
		/^ractive\/release-workflows\/\.github\/workflows\/chrome-extension-publish\.yml@[0-9a-f]{40}$/;

	// release.yml's job after the release, and publish.yml's by hand: the same
	// call of release-workflows' job (DEC-032).
	const callers = async () => [
		(await workflow("release.yml")).jobs["publish"],
		(await workflow("publish.yml")).jobs["publish"],
	];

	test("both run release-workflows' job on the run's own tag", async () => {
		for (const job of await callers()) {
			expect(job?.uses).toMatch(SHARED);
			expect(job?.with?.["tag"]).toBe(REF);
			expect(job?.with?.["tag-prefix"]).toBeUndefined();
			expect(job?.with?.["asset"]).toBe("sitegloss-{version}-store.zip");
			expect(job?.with?.["extension-id"]).toBe(
				"ldmcfigcnobhnbaigehcaodheklibeon",
			);
		}
	});

	test("both upload only a zip release.yml attested, as a CRX signed with our key", async () => {
		for (const job of await callers()) {
			expect(job?.with?.["attest-signer-workflow"]).toBe(
				".github/workflows/release.yml",
			);
			expect(job?.with?.["sign-crx"]).toBeUndefined();
			expect(job?.with?.["signing-key-id"]).toBe(
				"fhagiknobniheomfcadmfdpanogmpmka",
			);
			expect(job?.permissions).toEqual({
				contents: "read",
				attestations: "read",
			});
			// The environment's secrets reach a reusable workflow only when
			// the caller passes them on; the repository has none of its own.
			expect(job?.secrets).toBe("inherit");
		}
	});

	test("release.yml publishes after the release, publish.yml takes no tag", async () => {
		const [release, byHand] = await callers();
		expect(release?.needs).toBe("release");
		const w = await workflow("publish.yml");
		expect(w.on.workflow_dispatch?.inputs["tag"]).toBeUndefined();
		expect(byHand?.with?.["submit"]).toBe("${{ inputs.submit }}");
		expect(byHand?.if).toBe("inputs.store != 'edge'");
	});
});

describe("publishing to Microsoft Edge Add-ons", () => {
	const REF = "${{ github.ref_name }}";
	const SHARED =
		/^ractive\/release-workflows\/\.github\/workflows\/edge-extension-publish\.yml@[0-9a-f]{40}$/;

	// release.yml's job beside the Chrome Web Store's, and publish.yml's by
	// hand: the same call of release-workflows' job (DEC-033).
	const callers = async () => [
		(await workflow("release.yml")).jobs["publish-edge"],
		(await workflow("publish.yml")).jobs["publish-edge"],
	];

	test("both publish the attested store zip to the Edge item, with the environment's secrets", async () => {
		for (const job of await callers()) {
			expect(job?.uses).toMatch(SHARED);
			expect(job?.with?.["tag"]).toBe(REF);
			expect(job?.with?.["tag-prefix"]).toBeUndefined();
			expect(job?.with?.["asset"]).toBe("sitegloss-{version}-store.zip");
			expect(job?.with?.["product-id"]).toBe(
				"5c87cd72-07f3-427a-a433-edcd7c08eff4",
			);
			expect(job?.with?.["attest-signer-workflow"]).toBe(
				".github/workflows/release.yml",
			);
			expect(job?.with?.["allow-host-permissions"]).toBeUndefined();
			expect(String(job?.with?.["notes"]).length).toBeLessThanOrEqual(2000);
			expect(job?.permissions).toEqual({
				contents: "read",
				attestations: "read",
			});
			expect(job?.secrets).toBe("inherit");
		}
	});

	test("release.yml runs it beside the Chrome job, publish.yml when Edge is picked", async () => {
		const [release, byHand] = await callers();
		// Not after the Chrome job: one store's failure must not hold back the other.
		expect(release?.needs).toBe("release");
		const w = await workflow("publish.yml");
		expect(w.on.workflow_dispatch?.inputs["store"]).toMatchObject({
			type: "choice",
			options: ["chrome", "edge", "both"],
		});
		expect(byHand?.if).toBe("inputs.store != 'chrome'");
		expect(byHand?.with?.["submit"]).toBe("${{ inputs.submit }}");
		// The same notes for certification either way.
		expect(byHand?.with?.["notes"]).toBe(release?.with?.["notes"]);
	});
});

describe("release.yml", () => {
	const BUILT = "${{ needs.build.outputs.commit }}";
	const REF = "${{ github.ref_name }}";
	const still = "The tag still points at the commit that was built";

	test("the release job compares the tag's commit with the one built", async () => {
		const gh = fakeGh("aaaa");
		const step = stepOf(await workflow("release.yml"), "release", still);
		const result = await run(
			step,
			{ [REF]: "v1.2.3", [BUILT]: "aaaa" },
			{ PATH: PATH_WITH(gh) },
		);
		expect(result.code).toBe(0);
		expect(await Bun.file(join(gh, "gh.log")).text()).toContain(
			"api repos/ractive/sitegloss/commits/refs/tags/v1.2.3",
		);
	});

	test("a tag moved since the push stops the release", async () => {
		const step = stepOf(await workflow("release.yml"), "release", still);
		const result = await run(
			step,
			{ [REF]: "v1.2.3", [BUILT]: "aaaa" },
			{ PATH: PATH_WITH(fakeGh("bbbb")) },
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain(
			"tag v1.2.3 is at bbbb, this run built aaaa",
		);
	});

	test("the check comes before the release, and a failed lookup stops it", async () => {
		const w = await workflow("release.yml");
		const names = w.jobs["release"]?.steps.map((s) => s.name) ?? [];
		expect(names.indexOf(still)).toBeGreaterThanOrEqual(0);
		expect(names.indexOf(still)).toBeLessThan(
			names.indexOf("Create the release with both zips"),
		);
		const gh = fakeGh("");
		writeFileSync(join(gh, "gh"), "#!/bin/sh\nexit 1\n");
		const step = stepOf(w, "release", still);
		const result = await run(
			step,
			{ [REF]: "v1.2.3", [BUILT]: "" },
			{ PATH: PATH_WITH(gh) },
		);
		expect(result.code).not.toBe(0);
	});

	test("the zips are attested before the release, by the job that runs no third-party code, always", async () => {
		const w = await workflow("release.yml");
		const steps = w.jobs["release"]?.steps ?? [];
		const names = steps.map((s) => s.name);
		const attest = "Attest both zips";
		// After the tag was checked, before anything is published: a failed
		// attestation leaves no release.
		expect(names.indexOf(still)).toBeLessThan(names.indexOf(attest));
		expect(names.indexOf(attest)).toBeLessThan(
			names.indexOf("Create the release with both zips"),
		);
		const step = stepOf(w, "release", attest);
		// The job publish verifies the attestation, so the step is never skipped.
		expect(step.if).toBeUndefined();
		// Pinned to a commit, as every action that gets a token is.
		expect(step.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
		// Both zips the release then attaches.
		expect(step.with?.["subject-path"]).toBe("sitegloss-*.zip");
		const create = stepOf(w, "release", "Create the release with both zips");
		expect(create.run).toContain('gh release create "$TAG" sitegloss-*.zip');
		// What signing and storing an attestation need, and only where no
		// third-party code runs: the build job keeps the read-only token.
		expect(w.jobs["release"]?.permissions).toEqual({
			contents: "write",
			"id-token": "write",
			attestations: "write",
			"artifact-metadata": "write",
		});
		expect(w.permissions).toEqual({ contents: "read" });
		expect(w.jobs["build"]?.permissions).toBeUndefined();
		expect(
			w.jobs["build"]?.steps.some((s) => s.uses?.startsWith("actions/attest")),
		).toBe(false);
	});

	test("the build job hands on the commit of an annotated tag, not the tag object", async () => {
		const w = await workflow("release.yml");
		expect(w.jobs["build"]?.outputs?.["commit"]).toBe(
			"${{ steps.tag.outputs.commit }}",
		);
		const step = stepOf(w, "build", "The tag is a Chrome version on main");
		expect(step.id).toBe("tag");

		const repo = tempDir();
		const git = (...args: string[]) =>
			Bun.$`git -c user.name=t -c user.email=t@example.com ${args}`
				.cwd(repo)
				.quiet()
				.text();
		await git("init", "--quiet");
		await git("commit", "--quiet", "--allow-empty", "-m", "one");
		await git("update-ref", "refs/remotes/origin/main", "HEAD");
		await git("tag", "-a", "v1.2.3", "-m", "release");
		const object = (await git("rev-parse", "v1.2.3")).trim();
		const commit = (await git("rev-parse", "v1.2.3^{commit}")).trim();
		expect(object).not.toBe(commit);

		const outputs = join(tempDir(), "outputs");
		const result = await run(
			step,
			{ [REF]: "v1.2.3" },
			{ GITHUB_SHA: object, GITHUB_OUTPUT: outputs },
			repo,
		);
		expect(result.code).toBe(0);
		expect(await Bun.file(outputs).text()).toBe(`commit=${commit}\n`);
	});
});

describe(".gitignore", () => {
	test("keeps .env files out of git, but not the example", async () => {
		const ignored = async (path: string) =>
			(
				await Bun.$`git check-ignore --no-index -q ${path}`
					.cwd(join(import.meta.dir, ".."))
					.nothrow()
					.quiet()
			).exitCode === 0;
		expect(await ignored(".env")).toBe(true);
		expect(await ignored(".env.local")).toBe(true);
		expect(await ignored(".env.example")).toBe(false);
	});
});
