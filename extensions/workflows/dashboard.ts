import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "../../src/types.ts";
import {
  alignDashboardRow,
  createDashboardFrame,
  dashboardMaxHeight,
} from "../dashboard-style.ts";
import { aggregateWorkflowUsage, workflowIsTerminal } from "../../src/workflows/manager.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import { formatUsage, sanitizeInline, sanitizeText, shortId, traceStatusMeta } from "../subagents/render.ts";

const MAX_RESULT_CHARS = 16_384;
const MAX_RESULT_ROWS = 400;

export type WorkflowsDashboardAction =
  | { type: "cancel"; runId: string }
  | { type: "cancelAgent"; runId: string; agentIndex: number }
  | { type: "pause"; runId: string }
  | { type: "resume"; runId: string }
  | { type: "restartAgent"; runId: string; agentIndex: number }
  | { type: "close" };

export interface WorkflowsDashboardManager {
  list(): WorkflowSnapshot[];
  check(runId: string): WorkflowSnapshot;
  cancel(runId: string, reason?: string): Promise<WorkflowSnapshot>;
  cancelAgent(runId: string, agentIndex: number, reason?: string): Promise<WorkflowSnapshot>;
  pause(runId: string): Promise<WorkflowSnapshot>;
  resume(runId: string): Promise<WorkflowSnapshot>;
  restartAgent(runId: string, agentIndex: number): Promise<{ snapshot: WorkflowSnapshot }>;
  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void;
}

export interface WorkflowsDashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  renderMarkdown?: (text: string, width: number) => string[];
}

type AgentFilter = "all" | "active" | "failed" | "completed";
const AGENT_FILTERS: AgentFilter[] = ["all", "active", "failed", "completed"];

export function createWorkflowsDashboardOverlay(
  tui: Pick<TUI, "requestRender" | "terminal">,
  theme: Theme,
  keybindings: KeybindingsManager,
  manager: WorkflowsDashboardManager,
  done: (action: WorkflowsDashboardAction) => void,
  options: WorkflowsDashboardOverlayOptions = {},
): WorkflowsDashboardOverlay {
  return new WorkflowsDashboardOverlay(tui, theme, keybindings, manager, done, options);
}

export class WorkflowsDashboardOverlay {
  focused = false;
  #selectedRun = 0;
  #selectedPhase = 0;
  #selectedAgent = 0;
  #selectionRunId: string | undefined;
  #inspectingAgent = false;
  #agentFilter: AgentFilter = "all";
  #scroll = 0;
  #scrollKey: string | undefined;
  #resultRows = 0;
  #resultTotal = 0;
  #finished = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #now: () => number;
  readonly #clearInterval: typeof clearInterval;
  readonly #renderMarkdown: (text: string, width: number) => string[];
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly manager: WorkflowsDashboardManager;
  private readonly done: (action: WorkflowsDashboardAction) => void;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: WorkflowsDashboardManager,
    done: (action: WorkflowsDashboardAction) => void,
    options: WorkflowsDashboardOverlayOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.manager = manager;
    this.done = done;
    this.#now = options.now ?? Date.now;
    this.#clearInterval = options.clearInterval ?? clearInterval;
    this.#renderMarkdown = options.renderMarkdown ?? renderWorkflowMarkdown;
    const schedule = options.setInterval ?? setInterval;
    this.#timer = schedule(() => {
      if (!this.#finished) this.tui.requestRender();
    }, 500);
    this.#unsubscribe = manager.subscribe(() => {
      if (!this.#finished) this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    const runs = this.manager.list();
    const terminalRows = Math.max(0, this.tui.terminal?.rows ?? 24);
    const maxHeight = dashboardMaxHeight(terminalRows);
    if (!maxHeight) return [];
    if (width < 4) {
      return [truncateWorkflowDashboardLine(`Workflows ${runs.length}`, width)];
    }

    this.#selectedRun = runs.length
      ? clamp(this.#selectedRun, 0, runs.length - 1)
      : 0;
    let chosen = runs[this.#selectedRun];
    if (chosen) {
      try {
        chosen = this.manager.check(chosen.runId);
      } catch {
        // The list snapshot remains useful if a run was evicted between calls.
      }
    }
    this.syncSelections(chosen);

    const frame = createDashboardFrame(this.theme, width, this.focused);
    if (maxHeight < 10) {
      return this.renderCompact(maxHeight, runs.length, frame);
    }

    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    const headerLeft = this.theme.fg(
      "accent",
      this.theme.bold("Workflow runs"),
    );
    const headerRight = this.theme.fg(
      "muted",
      `${runs.length} run${runs.length === 1 ? "" : "s"}`,
    );
    const lines = [
      frame.header(headerLeft, headerRight),
      frame.top(`runs · ${active} active / ${runs.length}`),
    ];

    const contentRows = Math.max(2, maxHeight - 5);
    const listRows = runs.length
      ? Math.min(runs.length, Math.max(1, Math.floor(contentRows / 3)))
      : 1;
    const detailRows = Math.max(1, contentRows - listRows);
    if (!runs.length) {
      lines.push(
        frame.row(
          this.theme.fg("muted", "  No workflow runs in this session."),
        ),
      );
    } else {
      for (const { run, index } of this.listViewport(runs, listRows)) {
        lines.push(
          frame.row(
            this.renderRun(run, index === this.#selectedRun, frame.innerWidth),
          ),
        );
      }
    }

    const selectedAgent = this.selectedAgent(chosen);
    const detailTitle = this.#inspectingAgent && selectedAgent
      ? `agent · ${sanitizeInline(selectedAgent.name)} · ${selectedAgent.state}`
      : chosen?.phases.length
        ? `detail · phase ${this.#selectedPhase + 1}/${chosen.phases.length} · filter ${this.#agentFilter}`
        : "detail";
    lines.push(frame.divider(detailTitle));
    for (const detail of this.detailViewport(
      chosen,
      detailRows,
      Math.max(1, frame.innerWidth - 1),
    )) {
      lines.push(frame.row(` ${detail}`));
    }
    lines.push(frame.bottom());

    const controls = [
      chosen && !workflowIsTerminal(chosen.status) ? `p ${chosen.status === "paused" ? "resume" : "pause"}` : "",
      selectedAgent?.callIndex !== undefined ? "r restart agent" : "",
      selectedAgent && (selectedAgent.state === "queued" || selectedAgent.state === "running") ? "x cancel agent" : "",
      chosen && !workflowIsTerminal(chosen.status) ? "X cancel run" : "",
    ].filter(Boolean).join(" · ");
    const back = this.#inspectingAgent ? " · h/← overview" : "";
    lines.push(
      frame.hint(
        `${controls}${controls ? " · " : ""}↑↓/jk run · ←→/hl phase · Tab agent · Enter inspect · f filter${back} · Shift+↑↓/Pg scroll`,
        "· Esc close",
      ),
    );
    return lines.slice(0, maxHeight);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    const runs = this.manager.list();
    if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ type: "close" });
      return;
    }

    if (matchesKey(data, Key.shift(Key.up))) this.scrollResult(-1);
    else if (matchesKey(data, Key.shift(Key.down))) this.scrollResult(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollResult(-Math.max(1, this.#resultRows - 1));
    else if (matchesKey(data, Key.pageDown)) this.scrollResult(Math.max(1, this.#resultRows - 1));
    else if (this.#inspectingAgent && (matchesKey(data, Key.left) || matchesKey(data, "h"))) {
      this.#inspectingAgent = false;
      this.resetScroll();
    }
    else if (!this.#inspectingAgent && (matchesKey(data, Key.up) || matchesKey(data, "k"))) this.selectRun(this.#selectedRun - 1, runs);
    else if (!this.#inspectingAgent && (matchesKey(data, Key.down) || matchesKey(data, "j"))) this.selectRun(this.#selectedRun + 1, runs);
    else if (!this.#inspectingAgent && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.selectPhase(-1, runs[this.#selectedRun]);
    else if (!this.#inspectingAgent && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.selectPhase(1, runs[this.#selectedRun]);
    else if (data === "\t") this.selectAgent(runs[this.#selectedRun]);
    else if (!this.#inspectingAgent && matchesKey(data, "f")) this.cycleAgentFilter(runs[this.#selectedRun]);
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const run = runs[this.#selectedRun];
      if (this.selectedAgent(run)) {
        this.#inspectingAgent = true;
        this.resetScroll();
      }
    }
    else if (matchesKey(data, "p")) {
      const run = runs[this.#selectedRun];
      if (run && !workflowIsTerminal(run.status)) {
        this.finish({ type: run.status === "paused" ? "resume" : "pause", runId: run.runId });
        return;
      }
    }
    else if (matchesKey(data, "r")) {
      const run = runs[this.#selectedRun];
      const agent = this.selectedAgent(run);
      if (run && agent?.callIndex !== undefined) {
        this.finish({ type: "restartAgent", runId: run.runId, agentIndex: agent.index });
        return;
      }
    }
    else if (matchesKey(data, "x")) {
      const run = runs[this.#selectedRun];
      const agent = this.selectedAgent(run);
      if (run && agent && (agent.state === "queued" || agent.state === "running")) {
        this.finish({ type: "cancelAgent", runId: run.runId, agentIndex: agent.index });
        return;
      }
    }
    else if (matchesKey(data, Key.shift("x"))) {
      const run = runs[this.#selectedRun];
      if (run && !workflowIsTerminal(run.status)) {
        this.finish({ type: "cancel", runId: run.runId });
        return;
      }
    }
    this.tui.requestRender();
  }

  private finish(action: WorkflowsDashboardAction): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
    this.done(action);
  }

  private cleanup(): void {
    if (this.#timer !== undefined) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
  }

  private syncSelections(run: WorkflowSnapshot | undefined): void {
    if (!run) {
      this.#selectionRunId = undefined;
      this.#selectedPhase = 0;
      this.#selectedAgent = 0;
      this.#inspectingAgent = false;
      this.resetScroll();
      return;
    }
    if (this.#selectionRunId !== run.runId) {
      this.#selectionRunId = run.runId;
      const current = run.phases.findIndex((phase) => phase.index === run.currentPhase);
      this.#selectedPhase = current >= 0 ? current : Math.max(0, run.phases.length - 1);
      this.#selectedAgent = 0;
      this.#inspectingAgent = false;
      this.resetScroll();
    }
    this.#selectedPhase = run.phases.length ? clamp(this.#selectedPhase, 0, run.phases.length - 1) : 0;
    const agents = this.phaseAgents(run, run.phases[this.#selectedPhase]);
    this.#selectedAgent = agents.length ? clamp(this.#selectedAgent, 0, agents.length - 1) : 0;
  }

  private renderCompact(
    maxHeight: number,
    count: number,
    frame: ReturnType<typeof createDashboardFrame>,
  ): string[] {
    const header = frame.header(
      this.theme.fg("accent", this.theme.bold("Workflow runs")),
      this.theme.fg("muted", `${count} run${count === 1 ? "" : "s"}`),
    );
    if (maxHeight === 1) {
      return [truncateWorkflowDashboardLine("Workflows", frame.innerWidth + 2)];
    }
    if (maxHeight === 2) return [header, frame.hint("Esc close")];
    if (maxHeight === 3) return [header, frame.top("runs"), frame.bottom()];
    return [
      header,
      frame.top("runs"),
      frame.row(this.theme.fg("dim", "  Screen too short for dashboard detail.")),
      frame.bottom(),
      frame.hint("Esc close"),
    ].slice(0, maxHeight);
  }

  private listViewport(runs: WorkflowSnapshot[], rows: number): Array<{ run: WorkflowSnapshot; index: number }> {
    const start = Math.max(0, Math.min(this.#selectedRun - Math.floor(rows / 2), runs.length - rows));
    return runs.slice(start, start + rows).map((run, offset) => ({ run, index: start + offset }));
  }

  private renderRun(
    run: WorkflowSnapshot,
    selected: boolean,
    width: number,
  ): string {
    const status = traceStatusMeta(run.status, this.#now());
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const name = selected
      ? this.theme.fg("accent", sanitizeInline(run.name))
      : this.theme.fg("text", sanitizeInline(run.name));
    const left = ` ${marker} ${this.theme.fg(status.color, status.glyph)} ${name} ${this.theme.fg("dim", shortId(sanitizeText(run.runId)))}`;
    const phase =
      run.currentPhase === null
        ? "waiting"
        : `${Math.min(run.phases.length, run.currentPhase + 1)}/${run.phases.length}`;
    const right =
      this.theme.fg(
        "muted",
        `phase ${phase} · ${formatElapsed(run, this.#now())}`,
      ) + ` · ${this.theme.fg(status.color, run.status)} `;
    return alignDashboardRow(left, right, width);
  }

  private detailViewport(run: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!run) {
      this.#resultRows = 0;
      this.#resultTotal = 0;
      return [this.theme.fg("dim", "Start a workflow to inspect phases, agents, and results.")].slice(0, rows);
    }
    return this.#inspectingAgent
      ? this.agentInspectorViewport(run, rows, width)
      : this.workflowOverviewViewport(run, rows, width);
  }

  private workflowOverviewViewport(run: WorkflowSnapshot, rows: number, width: number): string[] {
    this.#resultRows = 0;
    this.#resultTotal = 0;
    const phase = run.phases[this.#selectedPhase];
    const allAgents = this.allPhaseAgents(run, phase);
    const agents = this.phaseAgents(run, phase);
    const status = traceStatusMeta(run.status, this.#now());
    const usage = formatUsage(aggregateWorkflowUsage(run));
    const lines: string[] = [
      `${this.theme.fg("accent", this.theme.bold(sanitizeInline(run.name) || "Workflow"))} ${this.theme.fg("dim", `· ${shortId(sanitizeText(run.runId))} · ${status.glyph} ${run.status} · ${formatElapsed(run, this.#now())}`)}`,
      this.theme.fg("dim", sanitizeInline(run.description) || "(no workflow description)"),
      phase ? this.renderPhase(phase, run.phases.length) : this.theme.fg("dim", "Phase · waiting for the first phase"),
    ];
    if (usage) lines.push(this.theme.fg("dim", `Usage · ${usage}`));
    for (const warning of run.warnings?.slice(0, 2) ?? []) lines.push(this.theme.fg("warning", `⚠ ${sanitizeInline(warning)}`));
    lines.push(this.theme.fg("muted", `Agents · ${agents.length}/${allAgents.length} shown · filter ${this.#agentFilter} · Tab select · Enter inspect`));

    if (!agents.length) {
      lines.push(this.theme.fg("dim", allAgents.length ? "No agents match this filter." : "No agents in this phase yet."));
      if (!allAgents.length && run.result !== undefined && lines.length < rows - 1) {
        lines.push(this.theme.fg("muted", "Workflow result"));
        lines.push(...this.renderBoundedResult(run, phase, undefined, width).slice(0, Math.max(0, rows - lines.length)));
      }
      return lines.slice(0, rows);
    }
    const room = Math.max(1, rows - lines.length);
    const start = Math.max(0, Math.min(this.#selectedAgent - Math.floor(room / 2), agents.length - room));
    for (const [offset, agent] of agents.slice(start, start + room).entries()) {
      lines.push(this.renderAgentRow(agent, start + offset === this.#selectedAgent));
    }
    return lines.slice(0, rows);
  }

  private agentInspectorViewport(run: WorkflowSnapshot, rows: number, width: number): string[] {
    const phase = run.phases[this.#selectedPhase];
    const agents = this.phaseAgents(run, phase);
    const agent = agents[this.#selectedAgent];
    if (!agent) {
      this.#inspectingAgent = false;
      return this.workflowOverviewViewport(run, rows, width);
    }

    const status = traceStatusMeta(agent.state, this.#now());
    const route = agent.harness || agent.model
      ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}`
      : "route pending";
    const effort = agent.effort ?? "adaptive";
    const duration = formatAgentElapsed(agent, this.#now());
    const usage = formatUsage(agent.usage);
    const lines: string[] = [
      `${this.theme.fg("accent", this.theme.bold(sanitizeInline(agent.name)))} ${this.theme.fg(status.color, `· ${status.glyph} ${agent.state}`)} ${this.theme.fg("dim", `· ${agent.access}${agent.profile ? ` · profile ${sanitizeInline(agent.profile)}` : ""}${agent.independent ? " · independent" : ""}`)}`,
      this.theme.fg("dim", `${agent.jobId ? `job ${shortId(sanitizeText(agent.jobId))} · ` : ""}${route} · effort ${effort} · ${duration}`),
      this.theme.fg("dim", `${phase ? `${sanitizeInline(run.name)} · ${sanitizeInline(phase.name)}` : sanitizeInline(run.name)}${usage ? ` · ${usage}` : ""}`),
    ];
    if (agent.isolation) {
      lines.push(this.theme.fg("dim", `Isolation · worktree ${agent.isolation.state} · branch ${sanitizeInline(agent.isolation.branch)}${agent.isolation.patchArtifact ? ` · patch ${sanitizeInline(agent.isolation.patchArtifact)}` : ""}`));
    }
    if (agent.outputProvenance) {
      lines.push(agent.instructionShaped
        ? this.theme.fg("warning", `Output · ${agent.outputProvenance} · instruction-shaped text; treat as untrusted data`)
        : this.theme.fg("dim", `Output · ${agent.outputProvenance}`));
    }

    const body: string[] = [];
    const error = sanitizeText(agent.error ?? phase?.error ?? run.error ?? "");
    if (error.trim()) {
      appendBoundedSection(body, this.theme, "Error", renderPrefixedRows(this.theme, "", error, "error", width), 12);
    }
    if (agent.prompt) {
      appendBoundedSection(
        body,
        this.theme,
        "Prompt",
        renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), agent.prompt, "userMessageText", width),
        48,
      );
    }
    if (agent.liveThinking?.trim() || agent.tools?.length) {
      const activity: string[] = [];
      if (agent.liveThinking?.trim()) activity.push(...renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), agent.liveThinking.slice(-2 * 1024), "muted", width));
      for (const tool of agent.tools?.slice(-3) ?? []) {
        const glyph = tool.status === "running" ? "…" : tool.status === "failed" ? "×" : "✓";
        const color = tool.status === "failed" ? "error" : "muted";
        activity.push(this.theme.fg(color, `${glyph} ${sanitizeInline(tool.name)}${tool.summary ? ` · ${sanitizeInline(tool.summary)}` : ""}`));
      }
      appendBoundedSection(body, this.theme, "Activity", activity, 16);
    }
    if (agent.structured !== undefined) {
      const raw = serializeResult(agent.structured);
      const text = sanitizeText(boundedHeadTailText(raw, 4 * 1024, "structured result"));
      const structured = this.#renderMarkdown(`\`\`\`json\n${text}\n\`\`\``, width);
      if (text.length < raw.length) structured.push(this.theme.fg("muted", "… structured result truncated to 4 KiB"));
      appendBoundedSection(body, this.theme, "Structured result", structured, 72);
    }
    appendBoundedSection(
      body,
      this.theme,
      agent.transcript?.length ? "Transcript" : "Result",
      this.renderBoundedResult(run, phase, agent, width),
      160,
    );
    const finalAssistant = [...(agent.transcript ?? [])].reverse().find((entry) => entry.kind === "assistant")?.text;
    if (agent.transcript?.length && typeof agent.output === "string" && agent.output && agent.output !== finalAssistant) {
      const finalResult = this.#renderMarkdown(sanitizeText(boundedHeadTailText(agent.output, 8 * 1024, "final result")), width);
      appendBoundedSection(body, this.theme, "Final result", finalResult, 80);
    }
    if (body.length > MAX_RESULT_ROWS) body.splice(MAX_RESULT_ROWS);

    const viewportRows = Math.max(0, rows - lines.length - 1);
    this.#resultRows = viewportRows;
    this.#resultTotal = body.length;
    const key = `${run.runId}:${phase?.index ?? "workflow"}:${agent.index}:inspector`;
    if (key !== this.#scrollKey) {
      this.#scrollKey = key;
      this.#scroll = 0;
    }
    this.#scroll = clamp(this.#scroll, 0, Math.max(0, body.length - viewportRows));
    const start = this.#scroll;
    const end = Math.min(body.length, start + viewportRows);
    lines.push(this.theme.fg("dim", `Detail ${viewportRows ? `${start + 1}–${end}` : "0"}/${body.length} · Shift+↑↓/PgUp/PgDn`));
    lines.push(...body.slice(start, end));
    return lines.slice(0, rows);
  }

  private renderPhase(phase: WorkflowPhase, total: number): string {
    const status = traceStatusMeta(phase.status, this.#now());
    return `${this.theme.fg("accent", `Phase ${this.#selectedPhase + 1}/${total}`)} ${this.theme.fg(status.color, `${status.glyph} ${sanitizeInline(phase.name)}`)} ${this.theme.fg("dim", `· ${phase.status} · ←→`)}`;
  }

  private renderAgentRow(agent: WorkflowAgentRecord, selected: boolean): string {
    const status = traceStatusMeta(agent.state, this.#now());
    const marker = selected ? this.theme.fg("accent", "›") : " ";
    const label = selected ? this.theme.fg("accent", sanitizeInline(agent.name)) : this.theme.fg("text", sanitizeInline(agent.name));
    const route = agent.harness || agent.model ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}` : "route pending";
    const usage = formatUsage(agent.usage);
    const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
    return `${marker} ${this.theme.fg(status.color, status.glyph)} ${label} ${this.theme.fg("dim", `· ${agent.access}${agent.profile ? ` · profile ${sanitizeInline(agent.profile)}` : ""}${agent.independent ? " · independent" : ""} · ${route} · effort ${agent.effort ?? "adaptive"} · ${formatAgentElapsed(agent, this.#now())}${usage ? ` · ${usage}` : ""}${warning}`)}`;
  }

  private allPhaseAgents(run: WorkflowSnapshot, phase: WorkflowPhase | undefined): WorkflowAgentRecord[] {
    if (!phase) return [];
    const indices = new Set(phase.agents);
    return run.agents.filter((agent) => indices.has(agent.index) || agent.phase === phase.index);
  }

  private phaseAgents(run: WorkflowSnapshot, phase: WorkflowPhase | undefined): WorkflowAgentRecord[] {
    return this.allPhaseAgents(run, phase).filter((agent) => matchesAgentFilter(agent, this.#agentFilter));
  }

  private selectedAgent(run: WorkflowSnapshot | undefined): WorkflowAgentRecord | undefined {
    if (!run) return undefined;
    return this.phaseAgents(run, run.phases[this.#selectedPhase])[this.#selectedAgent];
  }

  private renderBoundedResult(
    run: WorkflowSnapshot,
    phase: WorkflowPhase | undefined,
    agent: WorkflowAgentRecord | undefined,
    width: number,
  ): string[] {
    const safeWidth = Math.max(1, width);
    const transcript = agent?.transcript?.length ? agent.transcript : undefined;
    let rows: string[] = [];
    let truncated = false;

    if (transcript) {
      const parts = boundedTranscriptParts(transcript, MAX_RESULT_CHARS);
      for (const { entry, text } of parts) {
        if (!entry) {
          rows.push(this.theme.fg("muted", text));
          continue;
        }
        if (!text.trim()) continue;

        if (entry.kind === "assistant") {
          rows.push(...this.#renderMarkdown(text, safeWidth));
        } else if (entry.kind === "user") {
          rows.push(...renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), text, "userMessageText", safeWidth));
        } else if (entry.kind === "thinking") {
          rows.push(...renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), text, "muted", safeWidth));
        } else {
          const prefix = entry.error ? this.theme.fg("error", "× ") : this.theme.fg("muted", "→ ");
          rows.push(...renderPrefixedRows(this.theme, prefix, text, entry.error ? "error" : "muted", safeWidth));
        }
      }
    } else {
      const value = [agent?.output, agent?.preview, phase?.result, run.result]
        .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
      if (value === undefined) {
        rows = [this.theme.fg("dim", run.status === "running" || run.status === "paused" || run.status === "pending" ? "(no result yet)" : "(no result)")];
      } else {
        const structured = typeof value !== "string";
        const raw = serializeResult(value);
        truncated = raw.length > MAX_RESULT_CHARS;
        const text = sanitizeText(boundedHeadTailText(raw, MAX_RESULT_CHARS, structured ? "structured result" : "result"));
        rows = this.#renderMarkdown(structured ? `\`\`\`json\n${text}\n\`\`\`` : text, safeWidth);
      }
    }

    if (truncated) rows.push(this.theme.fg("muted", "… result truncated to 16 KiB"));
    if (rows.length > MAX_RESULT_ROWS) {
      const omitted = rows.length - MAX_RESULT_ROWS + 1;
      rows = [...rows.slice(0, MAX_RESULT_ROWS - 1), this.theme.fg("muted", `… ${omitted} rendered rows omitted`)];
    }
    return rows.length ? rows : [" "];
  }

  private selectRun(index: number, runs: WorkflowSnapshot[]): void {
    const next = runs.length ? clamp(index, 0, runs.length - 1) : 0;
    if (next === this.#selectedRun) return;
    this.#selectedRun = next;
    this.#selectionRunId = undefined;
    this.#inspectingAgent = false;
    this.resetScroll();
  }

  private selectPhase(delta: number, run: WorkflowSnapshot | undefined): void {
    if (!run?.phases.length) return;
    this.#selectedPhase = clamp(this.#selectedPhase + delta, 0, run.phases.length - 1);
    this.#selectedAgent = 0;
    this.#inspectingAgent = false;
    this.resetScroll();
  }

  private selectAgent(run: WorkflowSnapshot | undefined): void {
    if (!run) return;
    const agents = this.phaseAgents(run, run.phases[this.#selectedPhase]);
    if (!agents.length) return;
    this.#selectedAgent = (this.#selectedAgent + 1) % agents.length;
    this.resetScroll();
  }

  private cycleAgentFilter(run: WorkflowSnapshot | undefined): void {
    const index = AGENT_FILTERS.indexOf(this.#agentFilter);
    this.#agentFilter = AGENT_FILTERS[(index + 1) % AGENT_FILTERS.length]!;
    this.#selectedAgent = 0;
    this.#inspectingAgent = false;
    this.resetScroll();
    if (run) this.syncSelections(run);
  }

  private scrollResult(delta: number): void {
    this.#scroll = clamp(this.#scroll + delta, 0, Math.max(0, this.#resultTotal - this.#resultRows));
  }

  private resetScroll(): void {
    this.#scroll = 0;
    this.#scrollKey = undefined;
  }
}

function boundedHeadTailText(text: string, limit: number, label: string): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const marker = `\n\n… ${label} truncated …\n\n`;
  if (marker.length >= limit) return text.slice(-limit);
  const head = Math.max(1, Math.ceil((limit - marker.length) / 2));
  const tail = Math.max(0, limit - marker.length - head);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`;
}

function transcriptDisplayText(entry: TranscriptEntry): string {
  if (entry.kind !== "tool") return sanitizeText(entry.text);
  return sanitizeText(`${entry.name}${entry.text ? ` · ${entry.text}` : ""}`);
}

function boundedTranscriptParts(
  entries: TranscriptEntry[],
  limit: number,
): Array<{ entry?: TranscriptEntry; text: string }> {
  const parts = entries.map((entry) => ({ entry, text: transcriptDisplayText(entry) }));
  const total = parts.reduce((sum, part) => sum + part.text.length, 0);
  if (total <= limit) return parts;
  if (parts.length === 1) {
    return [{ entry: parts[0]!.entry, text: boundedHeadTailText(parts[0]!.text, limit, "transcript") }];
  }

  const marker = "… older transcript content omitted …";
  const firstBudget = Math.max(1, Math.floor((limit - marker.length) / 3));
  const first = {
    entry: parts[0]!.entry,
    text: parts[0]!.text.slice(0, firstBudget),
  };
  let remaining = Math.max(0, limit - first.text.length - marker.length);
  const tail: Array<{ entry?: TranscriptEntry; text: string }> = [];
  for (let index = parts.length - 1; index > 0 && remaining > 0; index--) {
    const part = parts[index]!;
    if (part.text.length <= remaining) {
      tail.unshift(part);
      remaining -= part.text.length;
      continue;
    }
    tail.unshift({ entry: part.entry, text: boundedHeadTailText(part.text, remaining, "transcript entry") });
    remaining = 0;
  }
  return [first, { text: marker }, ...tail];
}

function serializeResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    try { return String(value); }
    catch { return "[unrenderable result]"; }
  }
}

function appendBoundedSection(
  target: string[],
  theme: Theme,
  label: string,
  rows: string[],
  limit: number,
): void {
  target.push(theme.fg("muted", label));
  if (rows.length <= limit) {
    target.push(...rows);
    return;
  }
  const head = Math.max(1, Math.ceil((limit - 1) / 2));
  const tail = Math.max(0, limit - head - 1);
  const omitted = rows.length - head - tail;
  target.push(...rows.slice(0, head));
  target.push(theme.fg("muted", `… ${omitted} ${label.toLowerCase()} rows omitted`));
  if (tail) target.push(...rows.slice(-tail));
}

function renderPrefixedRows(
  theme: Theme,
  prefix: string,
  text: string,
  color: Parameters<Theme["fg"]>[0],
  width: number,
): string[] {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(sanitizeText(text), Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${theme.fg(color, line)}`);
}

export function renderWorkflowMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new Markdown(sanitizeText(text), 0, 0, getMarkdownTheme())
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

export async function openWorkflowsDashboard(
  ctx: ExtensionCommandContext,
  manager: WorkflowsDashboardManager,
): Promise<void> {
  if (ctx.mode !== "tui") {
    const runs = manager.list();
    const message = runs.length
      ? runs.map((run) => `${sanitizeInline(run.runId)} ${run.status} ${sanitizeInline(run.name)}`).join("\n")
      : "No workflow runs in this session.";
    ctx.ui.notify(message, "info");
    return;
  }

  for (;;) {
    const action = await ctx.ui.custom<WorkflowsDashboardAction>(
      (tui, theme, keybindings, done) => createWorkflowsDashboardOverlay(tui, theme, keybindings, manager, done),
      { overlay: true, overlayOptions: { width: "100%", minWidth: 60, maxHeight: "80%", anchor: "center" } },
    );
    if (!action || action.type === "close") return;
    try {
      if (action.type === "cancelAgent") {
        await manager.cancelAgent(action.runId, action.agentIndex, "Workflow agent cancelled from /workflows dashboard");
      } else if (action.type === "pause") {
        await manager.pause(action.runId);
      } else if (action.type === "resume") {
        await manager.resume(action.runId);
      } else if (action.type === "restartAgent") {
        const restarted = await manager.restartAgent(action.runId, action.agentIndex);
        ctx.ui.notify(`Restarted as ${restarted.snapshot.runId}`, "info");
      } else {
        await manager.cancel(action.runId, "Cancelled from /workflows dashboard");
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

function matchesAgentFilter(agent: WorkflowAgentRecord, filter: AgentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.state === "queued" || agent.state === "running";
  if (filter === "failed") return agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted";
  return agent.state === "completed";
}

function formatAgentElapsed(agent: WorkflowAgentRecord, now: number): string {
  const elapsed = Math.max(0, (agent.timestamps.endedAt ?? now) - (agent.timestamps.startedAt ?? agent.timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}


function formatElapsed(run: WorkflowSnapshot, now: number): string {
  const elapsed = Math.max(0, (run.timestamps.endedAt ?? now) - (run.timestamps.startedAt ?? run.timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function truncateWorkflowDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}
