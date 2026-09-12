import { randomUUID } from "node:crypto";

export type EscalationDecision = "allow" | "deny";

export interface PermissionEscalationEvent {
	type: "escalation";
	id: string;
	tool: string;
	question: string;
}

interface PendingEscalation {
	resolve: (decision: EscalationDecision) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class PermissionEscalations {
	private readonly pending = new Map<string, PendingEscalation>();

	constructor(private readonly emit: (event: PermissionEscalationEvent) => void) {}

	request(tool: string, question: string, timeoutMs: number): Promise<EscalationDecision> {
		const id = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve("deny");
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.emit({ type: "escalation", id, tool, question });
		});
	}

	resolve(id: string, decision: EscalationDecision): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		pending.resolve(decision);
		return true;
	}

	denyAll(): void {
		for (const id of [...this.pending.keys()]) this.resolve(id, "deny");
	}
}
