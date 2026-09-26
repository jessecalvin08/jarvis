import { spawn } from "node:child_process";
import path from "node:path";

function detached(cmd: string, args: string[], opts: { verbatim?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: opts.verbatim,
    });
    child.once("error", reject);
    // explorer.exe exits non-zero even on success, so a successful spawn is the signal.
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Opens a file, folder or URL with whatever the OS would use on double-click. */
export async function openTarget(target: string, reveal = false): Promise<void> {
  switch (process.platform) {
    case "win32":
      if (reveal) return detached("explorer.exe", [`/select,"${target.replace(/"/g, "")}"`], { verbatim: true });
      return detached("explorer.exe", [target]);
    case "darwin":
      return detached("open", reveal ? ["-R", target] : [target]);
    default:
      return detached("xdg-open", [reveal ? path.dirname(target) : target]);
  }
}
