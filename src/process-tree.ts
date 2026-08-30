import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  terminate(graceMs?: number): Promise<void>;
}

export function spawnManaged(
  command: string,
  args: string[],
  options: Omit<SpawnOptionsWithoutStdio, "stdio" | "shell" | "detached"> = {},
): ManagedProcess {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    ...options,
    shell: false,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let terminating: Promise<void> | undefined;
  let escalate: (() => void) | undefined;
  const signalTree = (signal: NodeJS.Signals) => {
    if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };

  return {
    child,
    terminate(graceMs = 3_000) {
      if (terminating) {
        if (graceMs <= 0) escalate?.();
        return terminating;
      }
      terminating = new Promise<void>((resolve, reject) => {
        const pid = child.pid;
        if (!pid) return resolve();
        if (process.platform === "win32") {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          let done = false;
          let forceStarted = false;
          let forceTimer: NodeJS.Timeout | undefined;
          let forceWatchdog: NodeJS.Timeout | undefined;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            escalate = undefined;
            if (forceTimer) clearTimeout(forceTimer);
            if (forceWatchdog) clearTimeout(forceWatchdog);
            if (error) reject(error);
            else resolve();
          };
          const gentle = spawn("taskkill", ["/pid", String(pid), "/t"], { shell: false, stdio: "ignore" });
          const force = () => {
            if (done || forceStarted) return;
            forceStarted = true;
            if (forceTimer) clearTimeout(forceTimer);
            try { gentle.kill("SIGKILL"); } catch { /* gentle taskkill already gone */ }
            const forced = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false, stdio: "ignore" });
            forced.once("close", (code) => {
              if (code === 0) finish();
              else finish(new Error(`Failed to terminate process tree ${pid}: taskkill /f exited ${code ?? "without a status"}`));
            });
            forced.once("error", (error) => {
              try { child.kill("SIGKILL"); } catch { /* already gone */ }
              finish(new Error(`Failed to prove process tree ${pid} terminated: ${error.message}`));
            });
            forceWatchdog = setTimeout(() => {
              try { forced.kill("SIGKILL"); } catch { /* taskkill already gone */ }
              try { child.kill("SIGKILL"); } catch { /* child already gone */ }
              finish(new Error(`Timed out proving process tree ${pid} terminated after taskkill /f`));
            }, 1_000);
          };
          escalate = force;
          gentle.once("close", (code) => { if (code === 0) finish(); });
          gentle.once("error", () => { try { child.kill(); } catch { /* continue to forced cleanup */ } });
          forceTimer = setTimeout(force, graceMs);
          if (graceMs <= 0) force();
          return;
        }

        let graceTimer: NodeJS.Timeout | undefined;
        let fallbackTimer: NodeJS.Timeout | undefined;
        let pollTimer: NodeJS.Timeout | undefined;
        let done = false;
        let forced = false;
        const groupAlive = () => {
          try { process.kill(-pid, 0); return true; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
        };
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          escalate = undefined;
          if (graceTimer) clearTimeout(graceTimer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (pollTimer) clearInterval(pollTimer);
          if (error) reject(error);
          else resolve();
        };
        const check = () => { if (!groupAlive()) finish(); };
        const force = () => {
          if (done || forced) return;
          forced = true;
          if (graceTimer) clearTimeout(graceTimer);
          signalTree("SIGKILL");
          fallbackTimer = setTimeout(() => {
            check();
            if (!done) finish(new Error(`Failed to terminate process group ${pid}: descendants remain after SIGKILL`));
          }, 1_000);
        };
        escalate = force;

        // A detached process group can outlive its leader. Resolve only after
        // the OS reports that the whole group is absent. If SIGKILL cannot
        // establish that proof within the bound, reject cleanup instead.
        signalTree("SIGTERM");
        check();
        if (done) return;
        // These timers intentionally stay referenced. Teardown is part of the
        // public lifecycle contract; allowing Node to exit while it is pending
        // produces exit code 13 for callers awaiting top-level completion.
        pollTimer = setInterval(check, 25);
        graceTimer = setTimeout(force, graceMs);
        if (graceMs <= 0) force();
      });
      return terminating;
    },
  };
}
