import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:package");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const rootManifest = await json(join(root, "package.json"));
const core = await json(join(root, "packages/core/package.json"));
const ux = await json(join(root, "packages/ux/package.json"));
assert.equal(rootManifest.private, true, "The workspace root must stay private");
assert.equal(rootManifest.license, "MIT");
const license = await readFile(join(root, "LICENSE"), "utf8");
for (const workspace of ["core", "ux"]) {
	assert.equal(await readFile(join(root, "packages", workspace, "LICENSE"), "utf8"), license);
}
assert.equal(core.name, "@maynewong/pi-advisor-core");
assert.equal(ux.name, "@maynewong/pi-advisor");
assert.equal(ux.version, core.version);
assert.equal(ux.dependencies[core.name], core.version);
for (const manifest of [core, ux]) {
	assert.notEqual(manifest.private, true);
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/");
}

const temp = await mkdtemp(join(tmpdir(), "pi-advisor-package-"));
const npm = (args, cwd, capture = false) => execFileSync(process.execPath, [npmCli, ...args], {
	cwd,
	encoding: "utf8",
	stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	timeout: 240_000,
	maxBuffer: 4 * 1024 * 1024,
});
try {
	const packs = JSON.parse(npm([
		"pack", "--workspaces", "--json", "--ignore-scripts", "--pack-destination", temp,
	], root, true));
	assert.deepEqual(packs.map((pack) => pack.name).sort(), [core.name, ux.name].sort());
	for (const pack of packs) {
		const files = new Set(pack.files.map((file) => file.path));
		for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts"]) assert.ok(files.has(required), `${pack.name}: missing ${required}`);
		for (const file of files) {
			assert.match(file, /\.(ts|md|json)$|^LICENSE(?:\.[\w-]+)?$/i, `Unexpected package file: ${file}`);
			assert.ok(!/(^|\/)(test|node_modules|\.git|\.pi|bitter-lessons)\//.test(file), `Unexpected package directory: ${file}`);
		}
		if (pack.name === ux.name) {
			for (const required of [
				"extensions/subagent.ts", "agents/advisor.md", "agents/search.md", "default-routing.json",
				"pi-advisor.example.json", "pi-advisor.profiles.example.json",
				...["extension", "provider", "adapter", "cli", "config"].map((name) => `examples/runtime-providers/herdr/${name}.ts`),
			]) assert.ok(files.has(required), `Missing plugin resource: ${required}`);
		}
		console.log(`${pack.id}: ${files.size} files, ${pack.size} bytes packed`);
	}

	// A directory outside the repository prevents workspace symlinks from hiding missing dependencies.
	const consumer = join(temp, "consumer");
	await mkdir(consumer);
	const peerNames = new Set([...Object.keys(core.peerDependencies), ...Object.keys(ux.peerDependencies)]);
	const peerVersions = Object.fromEntries(await Promise.all([...peerNames].map(async (name) => {
		const manifest = await json(join(root, "node_modules", name, "package.json"));
		return [name, manifest.version];
	})));
	await writeFile(join(consumer, "package.json"), JSON.stringify({
		name: "pi-advisor-package-smoke", private: true, type: "module",
		dependencies: {
			...peerVersions,
			...Object.fromEntries(packs.map((pack) => [pack.name, `file:${join(temp, pack.filename)}`])),
		},
	}, null, 2));
	npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", "--fetch-retries=0", "--fetch-timeout=30000"], consumer);
	for (const { name } of packs) {
		const installed = join(consumer, "node_modules", name);
		assert.equal((await json(join(installed, "package.json"))).license, "MIT");
		assert.equal(await readFile(join(installed, "LICENSE"), "utf8"), license);
	}
	await copyFile(join(root, "scripts/package-probe.ts"), join(consumer, "package-probe.ts"));
	await copyFile(join(root, "scripts/package-smoke.mjs"), join(consumer, "package-smoke.mjs"));
	const agentDir = join(temp, "agent");
	await mkdir(agentDir);
	execFileSync(process.execPath, [join(consumer, "package-smoke.mjs")], {
		cwd: consumer,
		stdio: "inherit",
		timeout: 60_000,
		env: {
			...process.env,
			NODE_PATH: "", NODE_OPTIONS: "",
			PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: agentDir,
			PI_HERDR_ADVISOR_CONFIG: join(temp, "unused-herdr-config.json"),
		},
	});
	console.log("Package checks passed. No packages published or agent runs started.");
} finally {
	await rm(temp, { recursive: true, force: true });
}
