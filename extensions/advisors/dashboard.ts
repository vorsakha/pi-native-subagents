import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { AdvisorConsultResult, AdvisorSnapshot } from "../../src/advisors.ts";
import { createDashboardFrame, dashboardLayout, dashboardOverlayRows, isFullscreenTui } from "../dashboard-style.ts";
import { formatUsage, sanitizeInline, shortId } from "../subagents/render.ts";
import { boundedHeadTailText, renderWorkflowMarkdown } from "../workflows/dashboard-detail.ts";

export interface AdvisorsDashboardManager {
  list(threadId: string, trusted: boolean): AdvisorSnapshot[];
  subscribe(listener: (advisor: AdvisorSnapshot) => void): () => void;
  consult(request: {
    threadId: string;
    advisorId: string;
    question: string;
    sender: "human";
    trusted: boolean;
  }): Promise<AdvisorConsultResult>;
  close(threadId: string, advisorId: string, trusted: boolean): Promise<AdvisorSnapshot>;
  reset(threadId: string, advisorId: string, trusted: boolean): Promise<AdvisorSnapshot>;
}

type Mode = "list" | "ask" | "answer" | "confirm-close" | "confirm-reset";

export function advisorViewport(
  roster: string[],
  inspector: string[],
  actions: string[],
  selectedIndex: number,
  rows: number,
): string[] {
  const budget = Math.max(0, rows);
  if (!budget) return [];
  if (!inspector.length || selectedIndex < 0) return [...roster, ...actions].slice(0, budget);

  const rosterBudget = Math.min(roster.length, Math.max(1, Math.floor(budget / 2)));
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(rosterBudget / 2)),
    Math.max(0, roster.length - rosterBudget),
  );
  const visibleRoster = roster.slice(start, start + rosterBudget);
  const inspectorBudget = budget - visibleRoster.length;
  if (inspectorBudget <= 0) return visibleRoster;

  const visibleActions = actions.slice(-inspectorBudget);
  const detailBudget = inspectorBudget - visibleActions.length;
  const details = detailBudget === 1 && inspector[0] === "─"
    ? inspector.slice(1, 2)
    : inspector.slice(0, detailBudget);
  return [...visibleRoster, ...details, ...visibleActions];
}

export class AdvisorsDashboard implements Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #manager: AdvisorsDashboardManager;
  readonly #threadId: string;
  readonly #isTrusted: () => boolean;
  readonly #done: () => void;
  readonly #unsubscribe: () => void;
  #selectedId?: string;
  #mode: Mode = "list";
  #input = new Input();
  #message?: string;
  #answer?: { advisorName: string; text: string };
  #answerScroll = 0;
  #answerRows = 0;
  #answerTotal = 0;
  #focused = false;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, manager: AdvisorsDashboardManager, threadId: string, isTrusted: () => boolean, done: () => void) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#manager = manager;
    this.#threadId = threadId;
    this.#isTrusted = isTrusted;
    this.#done = done;
    this.#selectedId = manager.list(threadId, isTrusted())[0]?.id;
    this.#unsubscribe = manager.subscribe(() => {
      if (!this.#isTrusted()) return;
      this.#repairSelection();
      this.#tui.requestRender();
    });
  }

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; }

  dispose(): void { this.#unsubscribe(); }
  invalidate(): void { this.#tui.requestRender(); }

  handleInput(data: string): void {
    const cancel = matchesKey(data, Key.escape) || this.#keybindings.matches(data, "tui.select.cancel");
    if (!this.#isTrusted()) {
      if (cancel) {
        this.dispose();
        this.#done();
      } else {
        this.#message = this.#theme.fg("error", "Advisors are disabled because this project is untrusted.");
        this.#tui.requestRender();
      }
      return;
    }
    if (this.#mode === "ask") {
      if (cancel) {
        this.#mode = "list";
        this.#message = undefined;
      } else if (this.#keybindings.matches(data, "tui.input.submit") || matchesKey(data, Key.enter)) {
        const question = this.#input.getValue().trim();
        if (question) void this.#ask(question);
      } else this.#input.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    if (this.#mode === "answer") {
      if (cancel) {
        this.#mode = "list";
        this.#answer = undefined;
      } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#scrollAnswer(-1);
      else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#scrollAnswer(1);
      else if (matchesKey(data, Key.pageUp)) this.#scrollAnswer(-Math.max(1, this.#answerRows - 1));
      else if (matchesKey(data, Key.pageDown)) this.#scrollAnswer(Math.max(1, this.#answerRows - 1));
      else if (matchesKey(data, "g")) this.#answerScroll = 0;
      else if (matchesKey(data, Key.shift("g"))) this.#answerScroll = Math.max(0, this.#answerTotal - this.#answerRows);
      this.#tui.requestRender();
      return;
    }
    if (this.#mode === "confirm-close" || this.#mode === "confirm-reset") {
      if (cancel) this.#mode = "list";
      else if (matchesKey(data, Key.enter) || this.#keybindings.matches(data, "tui.select.confirm")) void this.#confirm();
      this.#tui.requestRender();
      return;
    }
    if (cancel) {
      this.dispose();
      this.#done();
      return;
    }
    const roster = this.#manager.list(this.#threadId, this.#isTrusted());
    const index = Math.max(0, roster.findIndex((advisor) => advisor.id === this.#selectedId));
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#selectedId = roster[Math.max(0, index - 1)]?.id;
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#selectedId = roster[Math.min(roster.length - 1, index + 1)]?.id;
    else if (matchesKey(data, "a") && this.#selected()) {
      this.#mode = "ask";
      this.#input = new Input();
      this.#message = undefined;
    } else if (matchesKey(data, "x") && this.#selected()) this.#mode = "confirm-close";
    else if (matchesKey(data, "r") && this.#selected()) this.#mode = "confirm-reset";
    else if ((matchesKey(data, Key.enter) || matchesKey(data, "v")) && this.#selected()) this.#showLatest();
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const rows = dashboardOverlayRows(this.#tui.terminal.rows, isFullscreenTui(this.#tui));
    const layout = dashboardLayout(width, rows);
    const frame = createDashboardFrame(this.#theme, width, this.#focused);
    if (!this.#isTrusted()) {
      const lines = [frame.header("Thread advisors", "unavailable"), frame.top("trusted project required")];
      for (let index = 0; index < layout.contentRows; index++) {
        lines.push(frame.row(index === 0 ? this.#theme.fg("error", "Advisor state is hidden while this project is untrusted.") : ""));
      }
      lines.push(frame.bottom(), frame.hint("Esc close"));
      return lines.slice(0, rows);
    }
    if (this.#mode === "answer" && this.#answer) return this.#renderAnswer(frame, layout.contentRows, rows);
    const roster = this.#manager.list(this.#threadId, this.#isTrusted());
    const selected = this.#selected();
    const title = `Thread advisors · ${roster.length}/${16}`;
    const rosterLines: string[] = [];
    if (!roster.length) rosterLines.push(this.#theme.fg("dim", "No advisors. Use /advisor open <name> <description>."));
    for (const advisor of roster) {
      const marker = advisor.id === this.#selectedId ? "❯" : " ";
      const state = advisor.state === "unavailable" ? "!" : advisor.state === "consulting" ? "↻" : advisor.state === "idle" ? "●" : "○";
      rosterLines.push(`${marker} ${state} ${sanitizeInline(advisor.name)} · ${advisor.state} · ${advisor.policy.harness} · q${advisor.queued}`);
    }
    const inspector: string[] = [];
    if (selected) {
      inspector.push("─");
      inspector.push(`${selected.name} · ${shortId(selected.id)} · owner ${shortId(selected.threadId)}`);
      inspector.push(`Route · ${selected.policy.harness}/${selected.policy.model ?? "default"} · read-only · profile ${selected.policy.profile ?? "none"}`);
      inspector.push(`Lineage · ${selected.lineage} · generation ${selected.generation} · ${formatUsage(selected.usage)}`);
      inspector.push(`Budget · ${selected.policy.budget ? JSON.stringify(selected.policy.budget) : "open"} · queued ${selected.queued}`);
      if (selected.lastConsultedAt) inspector.push(`Last consultation · ${new Date(selected.lastConsultedAt).toISOString()}`);
      if (selected.error) inspector.push(this.#theme.fg("error", `Unavailable · ${sanitizeInline(selected.error)}`));
      const latest = selected.ledger.at(-1);
      if (latest) inspector.push(`Latest · ${latest.sender} · ${latest.state} · generation ${latest.generation} · ${sanitizeInline(latest.output ?? latest.error ?? latest.question)}`);
    }
    const actions: string[] = [];
    if (this.#mode === "ask") actions.push(`Ask › ${this.#input.getValue()}`);
    if (this.#mode === "confirm-close") actions.push(this.#theme.fg("warning", "Close this advisor and delete its private continuation? Enter confirms · Esc cancels"));
    if (this.#mode === "confirm-reset") actions.push(this.#theme.fg("warning", "Reset this lineage explicitly? Stable ID and cumulative spend remain. Enter confirms · Esc cancels"));
    if (this.#message) actions.push(this.#message);

    const visible = advisorViewport(rosterLines, inspector, actions, roster.findIndex((advisor) => advisor.id === this.#selectedId), layout.contentRows);
    const lines = [frame.header(title, "read-only retained specialists"), frame.top("roster / inspector")];
    for (let index = 0; index < layout.contentRows; index++) lines.push(frame.row(truncateToWidth(visible[index] ?? "", frame.innerWidth, "…")));
    lines.push(frame.bottom());
    lines.push(frame.hint(this.#mode === "list" ? "Esc close · j/k move · Enter latest · a ask · x close · r reset" : "Esc cancel · Enter confirm/submit"));
    return lines.slice(0, rows);
  }

  #selected(): AdvisorSnapshot | undefined {
    if (!this.#isTrusted()) return undefined;
    return this.#manager.list(this.#threadId, this.#isTrusted()).find((advisor) => advisor.id === this.#selectedId);
  }

  #repairSelection(): void {
    if (!this.#isTrusted()) {
      this.#selectedId = undefined;
      return;
    }
    const roster = this.#manager.list(this.#threadId, this.#isTrusted());
    if (!roster.some((advisor) => advisor.id === this.#selectedId)) this.#selectedId = roster[0]?.id;
  }

  async #ask(question: string): Promise<void> {
    const advisor = this.#selected();
    if (!advisor) return;
    this.#mode = "list";
    this.#message = "Consulting…";
    this.#tui.requestRender();
    try {
      const result = await this.#manager.consult({ threadId: this.#threadId, advisorId: advisor.id, question, sender: "human", trusted: this.#isTrusted() });
      if (result.ok) {
        this.#answer = { advisorName: result.advisorName, text: result.output || "(no advisor output)" };
        this.#answerScroll = 0;
        this.#mode = "answer";
        this.#message = undefined;
      } else this.#message = this.#theme.fg("error", `Error · ${sanitizeInline(result.error ?? "consultation failed")}`);
    } catch (error) {
      this.#message = this.#theme.fg("error", `Error · ${sanitizeInline(error instanceof Error ? error.message : String(error))}`);
    }
    this.#tui.requestRender();
  }

  #showLatest(): void {
    const advisor = this.#selected();
    const latest = advisor?.ledger.at(-1);
    if (!advisor || !latest) return;
    this.#answer = {
      advisorName: advisor.name,
      text: latest.output ?? latest.error ?? latest.question,
    };
    this.#answerScroll = 0;
    this.#mode = "answer";
  }

  #scrollAnswer(delta: number): void {
    const max = Math.max(0, this.#answerTotal - this.#answerRows);
    this.#answerScroll = Math.max(0, Math.min(max, this.#answerScroll + delta));
  }

  #renderAnswer(frame: ReturnType<typeof createDashboardFrame>, contentRows: number, rows: number): string[] {
    const answer = this.#answer!;
    const body = renderWorkflowMarkdown(boundedHeadTailText(answer.text, 16 * 1024, "advisor answer"), frame.innerWidth);
    this.#answerRows = Math.max(0, contentRows - 1);
    this.#answerTotal = body.length;
    this.#answerScroll = Math.min(this.#answerScroll, Math.max(0, body.length - this.#answerRows));
    const end = Math.min(body.length, this.#answerScroll + this.#answerRows);
    const range = this.#answerRows ? `${this.#answerScroll + 1}–${end}` : "0";
    const visible = [
      this.#theme.fg("dim", `Answer ${range}/${body.length} · j/k/PgUp/PgDn · g/G`),
      ...body.slice(this.#answerScroll, end),
    ];
    const lines = [
      frame.header(`Advisor answer · ${sanitizeInline(answer.advisorName)}`, "read-only specialist"),
      frame.top("answer detail"),
    ];
    for (let index = 0; index < contentRows; index++) lines.push(frame.row(truncateToWidth(visible[index] ?? "", frame.innerWidth, "")));
    lines.push(frame.bottom(), frame.hint("Esc back · j/k scroll · PgUp/PgDn · g/G"));
    return lines.slice(0, rows);
  }

  async #confirm(): Promise<void> {
    if (!this.#isTrusted()) {
      this.#message = this.#theme.fg("error", "Advisors are disabled because this project is untrusted.");
      this.#mode = "list";
      this.#tui.requestRender();
      return;
    }
    const advisor = this.#selected();
    if (!advisor) return;
    const action = this.#mode;
    this.#mode = "list";
    try {
      if (action === "confirm-close") await this.#manager.close(this.#threadId, advisor.id, this.#isTrusted());
      else await this.#manager.reset(this.#threadId, advisor.id, this.#isTrusted());
      this.#message = action === "confirm-close" ? "Advisor closed." : "Advisor lineage reset explicitly.";
    } catch (error) {
      this.#message = this.#theme.fg("error", error instanceof Error ? error.message : String(error));
    }
    this.#repairSelection();
    this.#tui.requestRender();
  }
}

export async function openAdvisorsDashboard(ctx: ExtensionCommandContext, manager: AdvisorsDashboardManager): Promise<void> {
  const trusted = ctx.isProjectTrusted();
  if (!trusted) {
    ctx.ui.notify("Advisors are disabled for untrusted projects.", "error");
    return;
  }
  const roster = manager.list(ctx.sessionManager.getSessionId(), true);
  if (ctx.mode !== "tui") {
    ctx.ui.notify(roster.length
      ? roster.map((advisor) => `${advisor.id} ${advisor.name} ${advisor.state} ${advisor.policy.harness}/${advisor.policy.model ?? "default"} generation ${advisor.generation} queued ${advisor.queued}`).join("\n")
      : "No advisors are open in this thread.", "info");
    return;
  }
  await ctx.ui.custom<null>((tui, theme, keybindings, done) => new AdvisorsDashboard(
    tui,
    theme,
    keybindings,
    manager,
    ctx.sessionManager.getSessionId(),
    () => ctx.isProjectTrusted(),
    () => done(null),
  ), {
    overlay: true,
    overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" },
  });
}
