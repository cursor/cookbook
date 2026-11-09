export interface Workspace {
  dir: string;
  fixture: string;
  now: string;
  skillDigestBefore: string;
  headBefore: string;
}

export interface Turn {
  prompt: string;
  before?: (ws: Workspace) => void;
}

export interface ToolCall {
  // The driver's call id, which links a call to its protected-file snapshots.
  id?: string;
  name: string;
  status: string;
  args: Record<string, unknown>;
}

// The digest of the protected files (see protected.ts) when a tool call started or finished.
export interface Snapshot {
  call: string;
  phase: "before" | "after";
  digest: string;
}

// sdk: an agent driven through @cursor/sdk. external: an agent driven by hand or another harness,
// with no tool calls recorded. scripted: a negative case's attack script standing in for the agent.
export type Driver = "sdk" | "external" | "scripted";

export interface Trajectory {
  driver: Driver;
  toolCalls: ToolCall[];
  // In event order. Present when the driver could hash the protected files around each tool call.
  snapshots?: Snapshot[];
  text: string;
  durationMs: number;
  tokens: number | null;
  error: string | null;
}

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Grade {
  gates: GateResult[];
  soft: { judge: number | null; judgeReasons: string[]; page: number | null; pageReasons: string[]; wallMs: number; toolCalls: number; tokens: number | null };
}

export type Gate = (ws: Workspace, t: Trajectory, c: EvalCase) => GateResult;

export interface EvalCase {
  id: string;
  fixture: string;
  // negative: a scripted attack replaces the agent, and the case passes only if its gates reject it.
  // holdout: never used to decide a hill-climb round; reported separately.
  tags: ("smoke" | "full" | "negative" | "holdout")[];
  // Extra `readiness audit` flags for the scripted control arm, which reads no prompt.
  scriptedArgs?: string[];
  expectedRun?: string;
  turns: Turn[];
  setup?: (ws: Workspace) => void;
  env?: Record<string, string>;
  prs?: string;
  remediation?: boolean;
  gates?: Gate[];
  // Runs in place of an agent and returns what it did. Needs no API key.
  attack?: (ws: Workspace, c: EvalCase) => Trajectory;
  description: string;
}

// agent: the agent with the skill, the arm the baseline measures. skill-off: the same agent with
// the skill removed. scripted: `readiness audit` with no agent and no narration. The two controls
// show what the agent and the skill add over the scripts alone.
export type Arm = "agent" | "skill-off" | "scripted";

export interface CaseRun {
  id: string;
  repeat: number;
  model: string;
  driver: Driver;
  arm?: Arm;
  judgeModel?: string | null;
  rubric?: string | null;
  // How the agent was kept from the machine owner's rules and skills (isolation.ts ISOLATION).
  isolation?: string | null;
  workspace: string;
  grade: Grade;
  error: string | null;
  // Set when the run was retried for an infrastructure error (capacity, network, a crashed
  // worker). lost: every attempt failed that way, so the run says nothing about the agent.
  infra?: { attempts: number; errors: string[]; lost: boolean } | null;
}
