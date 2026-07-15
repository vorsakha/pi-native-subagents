import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isTerminal, JobManager } from "../../src/manager.ts";
import type { JobSnapshot, SendBehavior } from "../../src/types.ts";

type DashboardAction =
  | { type: "steer" | "followUp" | "cancel"; jobId: string }
  | { type: "close" };

export async function openSubagentsDashboard(ctx: ExtensionCommandContext, manager: JobManager): Promise<void> {
  if (ctx.mode !== "tui") {
    const jobs = manager.list();
    ctx.ui.notify(jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session.", "info");
    return;
  }

  for (;;) {
    const action = await ctx.ui.custom<DashboardAction>((tui, theme, _keybindings, done) => {
      let selected = Math.max(0, manager.list().length - 1);
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: DashboardAction) => {
        if (timer) clearInterval(timer);
        done(value);
      };
      timer = setInterval(() => tui.requestRender(), 500);
      return {
        render(width: number): string[] {
          const jobs = manager.list();
          if (jobs.length === 0) selected = 0;
          else selected = Math.max(0, Math.min(selected, jobs.length - 1));
          const chosen = jobs[selected];
          const lines: string[] = [
            theme.fg("accent", theme.bold(" Native Subagents ")),
            theme.fg("dim", " ↑↓ select  s/t takeover-steer  f follow-up  x cancel  esc close"),
            theme.fg("border", "─".repeat(Math.max(1, width))),
          ];
          if (!jobs.length) lines.push(theme.fg("muted", " No jobs in this session."));
          const windowStart = Math.max(0, Math.min(selected - 3, Math.max(0, jobs.length - 8)));
          for (let index = windowStart; index < Math.min(jobs.length, windowStart + 8); index++) {
            const job = jobs[index]!;
            const prefix = index === selected ? "› " : "  ";
            const color = job.status === "failed" ? "error" : job.status === "completed" ? "success" : job.status === "running" ? "accent" : "muted";
            lines.push(theme.fg(color, truncate(`${prefix}${shortId(job.id)} ${job.status.padEnd(9)} ${job.role} · ${job.backend}/${job.model}`, width)));
          }
          if (chosen) {
            lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
            lines.push(theme.fg("accent", truncate(` ${chosen.role} · ${shortId(chosen.id)} · ${chosen.status}`, width)));
            lines.push(theme.fg("dim", truncate(` ${chosen.task.replace(/\s+/g, " ")}`, width)));
            if (chosen.error) lines.push(theme.fg("error", truncate(` ${chosen.error}`, width)));
            const tools = chosen.tools.slice(-3).map((tool) => `${tool.status === "running" ? "…" : tool.status === "failed" ? "×" : "✓"} ${tool.name}${tool.summary ? `: ${tool.summary}` : ""}`);
            if (tools.length) lines.push(...tools.map((line) => theme.fg("muted", truncate(` ${line}`, width))));
            lines.push(theme.fg("dim", " Transcript tail"));
            const transcript = (chosen.output || "(no assistant text yet)").split("\n").slice(-10);
            lines.push(...transcript.map((line) => truncate(` ${line}`, width)));
          }
          return lines;
        },
        invalidate() {},
        dispose() { if (timer) clearInterval(timer); },
        handleInput(data: string) {
          const jobs = manager.list();
          if (data === "\x1b[A" || data === "k") selected = Math.max(0, selected - 1);
          else if (data === "\x1b[B" || data === "j") selected = Math.min(Math.max(0, jobs.length - 1), selected + 1);
          else if (data === "\x1b" || data === "q") return finish({ type: "close" });
          else {
            const job = jobs[selected];
            if (job && (data === "s" || data === "t") && !isTerminal(job.status)) return finish({ type: "steer", jobId: job.id });
            if (job && data === "f" && !isTerminal(job.status)) return finish({ type: "followUp", jobId: job.id });
            if (job && data === "x" && !isTerminal(job.status)) return finish({ type: "cancel", jobId: job.id });
          }
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "90%", minWidth: 60, maxHeight: "90%", anchor: "center", margin: 1 },
    });

    if (!action || action.type === "close") return;
    if (action.type === "cancel") {
      await manager.cancel(action.jobId, "Cancelled from /subagents dashboard");
      continue;
    }
    const behavior: SendBehavior = action.type;
    const message = await ctx.ui.editor(`${action.type === "steer" ? "Steer" : "Queue follow-up for"} ${shortId(action.jobId)}`, "");
    if (message?.trim()) {
      try { await manager.send(action.jobId, message, behavior); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }
}

function shortId(id: string): string { return id.slice(0, 8); }
export function truncateDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}
const truncate = truncateDashboardLine;
function statusLine(job: JobSnapshot): string { return `${job.id} ${job.status} ${job.role} [${job.backend}/${job.model}]`; }
