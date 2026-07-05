import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceRequest {
	mode: "worktree";
	baseRef?: string;
	retain?: boolean;
}

export interface ProvisionedWorkspace {
	cwd: string;
	cleanup(): Promise<void>;
}

export interface WorkspaceProvider {
	prepare(id: string, request: WorkspaceRequest, baseCwd: string): Promise<ProvisionedWorkspace>;
}

export class GitWorktreeProvider implements WorkspaceProvider {
	constructor(private readonly root = join(tmpdir(), "pi-subagent-worktrees")) {}

	async prepare(id: string, request: WorkspaceRequest, baseCwd: string): Promise<ProvisionedWorkspace> {
		await mkdir(this.root, { recursive: true });
		const cwd = join(this.root, id);
		await execFileAsync("git", ["worktree", "add", "--detach", cwd, request.baseRef ?? "HEAD"], { cwd: baseCwd });
		return {
			cwd,
			cleanup: async () => {
				await execFileAsync("git", ["worktree", "remove", "--force", cwd], { cwd: baseCwd });
			},
		};
	}
}
