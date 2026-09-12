import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface PruneOptions {
	/** Delete run directories older than this many days. 0 disables age pruning. */
	retentionDays?: number;
	/** After age pruning, keep at most this many run directories (newest by mtime). */
	maxRuns?: number;
}

export interface PruneResult {
	scanned: number;
	deleted: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Policy-free retention for a single artifacts bucket. Deletes run directories whose
 * mtime is older than `retentionDays`, then trims the newest survivors down to `maxRuns`.
 * A missing directory is treated as an empty bucket. Callers own error handling.
 */
export async function pruneSubagentRuns(artifactsDir: string, options: PruneOptions = {}): Promise<PruneResult> {
	const retentionDays = options.retentionDays ?? 14;
	const maxRuns = options.maxRuns ?? 200;
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scanned: 0, deleted: [] };
		throw error;
	}
	const runs: { dir: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(artifactsDir, entry.name);
		try {
			const info = await stat(dir);
			runs.push({ dir, mtimeMs: info.mtimeMs });
		} catch {
			// Skip entries that vanish or are unreadable during the scan.
		}
	}
	const scanned = runs.length;
	const deleted: string[] = [];
	const cutoff = retentionDays > 0 ? Date.now() - retentionDays * DAY_MS : undefined;
	const survivors: typeof runs = [];
	for (const run of runs) {
		if (cutoff !== undefined && run.mtimeMs < cutoff) {
			await rm(run.dir, { recursive: true, force: true });
			deleted.push(run.dir);
		} else {
			survivors.push(run);
		}
	}
	if (maxRuns >= 0 && survivors.length > maxRuns) {
		survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const run of survivors.slice(0, survivors.length - maxRuns)) {
			await rm(run.dir, { recursive: true, force: true });
			deleted.push(run.dir);
		}
	}
	return { scanned, deleted };
}
