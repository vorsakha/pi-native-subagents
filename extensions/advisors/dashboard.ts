import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { AdvisorConsultResult, AdvisorSnapshot } from "../../src/advisors.ts";
import { createDashboardFrame, dashboardLayout, dashboardOverlayRows, isFullscreenTui } from "../dashboard-style.ts";
import { formatUsage, sanitizeInline, shortId } from "../subagents/render.ts";

export interface AdvisorsDashboardManager {
  list(): AdvisorSnapshot[];
  subscribe(listener: (advisor: AdvisorSnapshot) => void): () => void;
  consult(request: {
    threadId: string;
    advisorId: string;
    question: string;
    sender: "human";
  }): Promise<AdvisorConsultResult>;
  close(threadId: string, advisorId: string): Promise<AdvisorSnapshot>;
  reset(threadId: string, advisorId: string): Promise<AdvisorSnapshot>;
}

type Mode = "list" | "ask" | "confirm-close" | "confirm-reset";

export class AdvisorsDashboard implements Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #manager: AdvisorsDashboardManager;
  readonly #threadId: string;
  readonly #done: () => void;
  readonly #unsubscribe: () => void;
  #selectedId?: string;
  #mode: Mode = "list";
  #input = new Input();
  #message?: string;
  #focused = false;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, manager: AdvisorsDashboardManager, threadId: string, done: () => void) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#manager = manager;
    this.#threadId = threadId;
    this.#done = done;
    this.#selectedId = manager.list()[0]?.id;
    this.#unsubscribe = manager.subscribe(() => {
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
    const roster = this.#manager.list();
    const index = Math.max(0, roster.findIndex((advisor) => advisor.id === this.#selectedId));
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#selectedId = roster[Math.max(0, index - 1)]?.id;
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#selectedId = roster[Math.min(roster.length - 1, index + 1)]?.id;
    else if (matchesKey(data, "a") && this.#selected()) {
      this.#mode = "ask";
      this.#input = new Input();
      this.#message = undefined;
    } else if (matchesKey(data, "x") && this.#selected()) this.#mode = "confirm-close";
    else if (matchesKey(data, "r") && this.#selected()) this.#mode = "confirm-reset";
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const rows = dashboardOverlayRows(this.#tui.terminal.rows, isFullscreenTui(this.#tui));
    const layout = dashboardLayout(width, rows);
    const frame = createDashboardFrame(this.#theme, width, this.#focused);
    const roster = this.#manager.list();
    const selected = this.#selected();
    const title = `Thread advisors · ${roster.length}/${16}`;
    const content: string[] = [];
    if (!roster.length) content.push(this.#theme.fg("dim", "No advisors. Use /advisor open <name> <description>."));
    for (const advisor of roster) {
      const marker = advisor.id === this.#selectedId ? "❯" : " ";
      const state = advisor.state === "unavailable" ? "!" : advisor.state === "consulting" ? "↻" : advisor.state === "idle" ? "●" : "○";
      content.push(`${marker} ${state} ${sanitizeInline(advisor.name)} · ${advisor.state} · ${advisor.policy.harness} · q${advisor.queued}`);
    }
    if (selected) {
      content.push("─");
      content.push(`${selected.name} · ${shortId(selected.id)} · owner ${shortId(selected.threadId)}`);
      content.push(`Route · ${selected.policy.harness}/${selected.policy.model ?? "default"} · read-only · profile ${selected.policy.profile ?? "none"}`);
      content.push(`Lineage · ${selected.lineage} · generation ${selected.generation} · ${formatUsage(selected.usage)}`);
      content.push(`Budget · ${selected.policy.budget ? JSON.stringify(selected.policy.budget) : "open"} · queued ${selected.queued}`);
      if (selected.lastConsultedAt) content.push(`Last consultation · ${new Date(selected.lastConsultedAt).toISOString()}`);
      if (selected.error) content.push(this.#theme.fg("error", `Unavailable · ${sanitizeInline(selected.error)}`));
      const latest = selected.ledger.at(-1);
      if (latest) content.push(`Latest · ${latest.sender} · ${latest.state} · generation ${latest.generation} · ${sanitizeInline(latest.output ?? latest.error ?? latest.question)}`);
    }
    if (this.#mode === "ask") content.push(`Ask › ${this.#input.getValue()}`);
    if (this.#mode === "confirm-close") content.push(this.#theme.fg("warning", "Close this advisor and delete its private continuation? Enter confirms · Esc cancels"));
    if (this.#mode === "confirm-reset") content.push(this.#theme.fg("warning", "Reset this lineage explicitly? Stable ID and cumulative spend remain. Enter confirms · Esc cancels"));
    if (this.#message) content.push(this.#message);

    const visible = content.slice(0, layout.contentRows);
    const lines = [frame.header(title, "read-only retained specialists"), frame.top("roster / inspector")];
    for (let index = 0; index < layout.contentRows; index++) lines.push(frame.row(truncateToWidth(visible[index] ?? "", frame.innerWidth, "…")));
    lines.push(frame.bottom());
    lines.push(frame.hint(this.#mode === "list" ? "Esc close · j/k move · a ask · x close · r reset" : "Esc cancel · Enter confirm/submit"));
    return lines.slice(0, rows);
  }

  #selected(): AdvisorSnapshot | undefined {
    return this.#manager.list().find((advisor) => advisor.id === this.#selectedId);
  }

  #repairSelection(): void {
    const roster = this.#manager.list();
    if (!roster.some((advisor) => advisor.id === this.#selectedId)) this.#selectedId = roster[0]?.id;
  }

  async #ask(question: string): Promise<void> {
    const advisor = this.#selected();
    if (!advisor) return;
    this.#mode = "list";
    this.#message = "Consulting…";
    this.#tui.requestRender();
    try {
      const result = await this.#manager.consult({ threadId: this.#threadId, advisorId: advisor.id, question, sender: "human" });
      this.#message = result.ok ? `Answer · ${sanitizeInline(result.output)}` : this.#theme.fg("error", `Error · ${sanitizeInline(result.error ?? "consultation failed")}`);
    } catch (error) {
      this.#message = this.#theme.fg("error", `Error · ${sanitizeInline(error instanceof Error ? error.message : String(error))}`);
    }
    this.#tui.requestRender();
  }

  async #confirm(): Promise<void> {
    const advisor = this.#selected();
    if (!advisor) return;
    const action = this.#mode;
    this.#mode = "list";
    try {
      if (action === "confirm-close") await this.#manager.close(this.#threadId, advisor.id);
      else await this.#manager.reset(this.#threadId, advisor.id);
      this.#message = action === "confirm-close" ? "Advisor closed." : "Advisor lineage reset explicitly.";
    } catch (error) {
      this.#message = this.#theme.fg("error", error instanceof Error ? error.message : String(error));
    }
    this.#repairSelection();
    this.#tui.requestRender();
  }
}

export async function openAdvisorsDashboard(ctx: ExtensionCommandContext, manager: AdvisorsDashboardManager): Promise<void> {
  const roster = manager.list();
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
    () => done(null),
  ), {
    overlay: true,
    overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" },
  });
}
