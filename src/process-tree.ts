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
      terminating = new Promise<void>((resolve) => {
        const pid = child.pid;
        if (!pid) return resolve();
        if (process.platform === "win32") {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          let done = false;
          let forceStarted = false;
          let forceTimer: NodeJS.Timeout | undefined;
          let forceWatchdog: NodeJS.Timeout | undefined;
          const finish = () => {
            if (done) return;
            done = true;
            escalate = undefined;
            if (forceTimer) clearTimeout(forceTimer);
            if (forceWatchdog) clearTimeout(forceWatchdog);
            resolve();
          };
          const gentle = spawn("taskkill", ["/pid", String(pid), "/t"], { shell: false, stdio: "ignore" });
          const force = () => {
            if (done || forceStarted) return;
            forceStarted = true;
            if (forceTimer) clearTimeout(forceTimer);
            try { gentle.kill("SIGKILL"); } catch { /* gentle taskkill already gone */ }
            const forced = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false, stdio: "ignore" });
            forced.once("close", finish);
            forced.once("error", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish(); });
            forceWatchdog = setTimeout(() => {
              try { forced.kill("SIGKILL"); } catch { /* taskkill already gone */ }
              try { child.kill("SIGKILL"); } catch { /* child already gone */ }
              finish();
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
        const finish = () => {
          if (done) return;
          done = true;
          escalate = undefined;
          if (graceTimer) clearTimeout(graceTimer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (pollTimer) clearInterval(pollTimer);
          resolve();
        };
        const check = () => { if (!groupAlive()) finish(); };
        const force = () => {
          if (done || forced) return;
          forced = true;
          if (graceTimer) clearTimeout(graceTimer);
          signalTree("SIGKILL");
          fallbackTimer = setTimeout(finish, 250);
        };
        escalate = force;

        // A detached process group can outlive its leader. Never treat the
        // leader's close event as proof that all descendants are gone.
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
