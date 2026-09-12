import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentEvent, SubagentProfile, SubagentResult } from "../types.ts";

export class ArtifactWriter {
	readonly dir: string;
	readonly eventsPath: string;
	readonly resultPath: string;
	readonly transcriptPath: string;
	private writes: Promise<void> = Promise.resolve();

	constructor(baseDir: string, id: string) {
		this.dir = join(baseDir, id);
		this.eventsPath = join(this.dir, "events.jsonl");
		this.resultPath = join(this.dir, "result.json");
		this.transcriptPath = join(this.dir, "transcript.md");
	}

	async initialize(profile: SubagentProfile, task: string, prompt: string): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await Promise.all([
			writeFile(join(this.dir, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`),
			writeFile(join(this.dir, "task.md"), `${task}\n\n${prompt}\n`),
			writeFile(this.eventsPath, ""),
		]);
	}

	appendEvent(event: SubagentEvent): void {
		this.writes = this.writes.then(() => appendFile(this.eventsPath, `${JSON.stringify(event)}\n`));
	}

	async finish(result: SubagentResult, transcript?: string): Promise<void> {
		await this.writes;
		if (transcript) await writeFile(this.transcriptPath, transcript);
		await writeFile(this.resultPath, `${JSON.stringify(result, null, 2)}\n`);
	}
}
