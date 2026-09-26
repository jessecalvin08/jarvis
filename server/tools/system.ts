import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { currentStats } from "../stats.js";
import { openTarget } from "./open.js";
import { formatBytes, resolveUserPath } from "./paths.js";
import { defineTool, truncate, type ToolDef } from "./types.js";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// ---------------------------------------------------------------- app launching

interface StartApp {
  Name: string;
  AppID: string;
}
let startApps: { at: number; apps: StartApp[] } | null = null;

/** Every app in the Windows Start menu, including Store apps like WhatsApp and Spotify. */
async function windowsStartApps(): Promise<StartApp[]> {
  if (startApps && Date.now() - startApps.at < 10 * 60_000) return startApps.apps;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
    { timeout: 15_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.trim() || "[]") as StartApp | StartApp[];
  const apps = Array.isArray(parsed) ? parsed : [parsed];
  startApps = { at: Date.now(), apps };
  return apps;
}

const WINDOWS_ALIASES: Record<string, string> = {
  calculator: "calc",
  calc: "calc",
  notepad: "notepad",
  "file explorer": "explorer",
  explorer: "explorer",
  "task manager": "taskmgr",
  settings: "ms-settings:",
  "control panel": "control",
  terminal: "wt",
  "command prompt": "cmd",
  cmd: "cmd",
  powershell: "powershell",
  paint: "mspaint",
  chrome: "chrome",
  "google chrome": "chrome",
  edge: "msedge",
  "microsoft edge": "msedge",
  "vs code": "code",
  vscode: "code",
  "visual studio code": "code",
  word: "winword",
  excel: "excel",
  powerpoint: "powerpnt",
  outlook: "outlook",
  spotify: "spotify:",
  whatsapp: "whatsapp:",
  discord: "discord:",
  teams: "msteams:",
};

function bestMatch(apps: StartApp[], query: string): StartApp | undefined {
  const q = query.toLowerCase().trim();
  const scored = apps
    .map((a) => {
      const n = a.Name.toLowerCase();
      let s = 0;
      if (n === q) s = 100;
      else if (n.startsWith(q)) s = 80 - n.length / 10;
      else if (n.split(/\s+/).includes(q)) s = 70 - n.length / 10;
      else if (n.includes(q)) s = 50 - n.length / 10;
      // Uninstallers and help entries are never what someone means by "open X".
      if (/uninstall|help|readme|documentation|release notes/.test(n)) s -= 60;
      return { a, s };
    })
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s);
  return scored[0]?.a;
}

async function launchWindows(name: string): Promise<string> {
  const alias = WINDOWS_ALIASES[name.toLowerCase().trim()];
  try {
    const app = bestMatch(await windowsStartApps(), name);
    if (app) {
      await openTarget(`shell:AppsFolder\\${app.AppID}`);
      return `Launched ${app.Name}.`;
    }
  } catch {
    // Get-StartApps unavailable; fall through to the alias table.
  }
  const target = alias ?? name;
  if (target.endsWith(":")) {
    await openTarget(target);
    return `Launched ${name}.`;
  }
  if (!/^[\w .+-]+$/.test(target)) return `Couldn't find an app called "${name}".`;
  await new Promise<void>((resolve, reject) => {
    // Verbatim so cmd sees `start "" "name"` exactly; the regex above keeps quotes and metacharacters out.
    const child = spawn("cmd.exe", ["/c", `start "" "${target}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return `Asked Windows to start "${target}". If nothing opened, the app may not be installed under that name.`;
}

const launchApp = defineTool({
  name: "launch_app",
  category: "apps",
  description:
    "Launch an installed application by name, e.g. 'Spotify', 'WhatsApp', 'Chrome', 'VS Code', 'Calculator', 'Settings', 'Task Manager'. " +
    "On Windows this searches the Start menu, so Store apps work too. To open a website use open_path with the URL instead.",
  schema: z.object({ name: z.string().min(1).describe("App name as the user said it") }),
  summarize: (i) => `Launching ${i.name}`,
  async run({ name }) {
    if (isWin) return launchWindows(name);
    if (isMac) {
      await execFileAsync("open", ["-a", name], { timeout: 10_000 });
      return `Launched ${name}.`;
    }
    const child = spawn(name.toLowerCase().replace(/\s+/g, "-"), [], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
    child.unref();
    return `Launched ${name}.`;
  },
});

// ---------------------------------------------------------------- shell

const runCommand = defineTool({
  name: "run_command",
  category: "system",
  description:
    `Run a ${isWin ? "PowerShell" : "shell"} command on the user's computer and return its output. Use for things no other tool covers: ` +
    "git, npm, checking processes, disk usage, network info, installing packages, moving or renaming files. The user confirms before it runs.",
  schema: z.object({
    command: z.string().min(1).describe(isWin ? "PowerShell command" : "bash command"),
    cwd: z.string().optional().describe("Working folder (defaults to the home folder)"),
    timeoutSeconds: z.number().int().min(1).max(600).optional().describe("Default 60"),
  }),
  risky: true,
  summarize: (i) => `Run: ${i.command}${i.cwd ? `  (in ${i.cwd})` : ""}`,
  async run(input, ctx) {
    const cwd = input.cwd ? await resolveUserPath(input.cwd) : undefined;
    const [cmd, args] = isWin
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", input.command]]
      : ["/bin/bash", ["-lc", input.command]];
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: cwd ?? process.env.HOME ?? process.env.USERPROFILE,
        timeout: (input.timeoutSeconds ?? 60) * 1000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        signal: ctx.signal,
      });
      const out = [stdout.trim(), stderr.trim() && `stderr:\n${stderr.trim()}`].filter(Boolean).join("\n");
      return truncate(out || "(command finished with no output)", 15_000);
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string; killed?: boolean };
      const detail = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join("\n") || e.message;
      return truncate(`Command failed${e.killed ? " (timed out)" : ` (exit ${e.code})`}:\n${detail}`, 15_000);
    }
  },
});

// ---------------------------------------------------------------- status, media, power

const systemStatus = defineTool({
  name: "system_status",
  category: "system",
  description: "Get live CPU, memory, disk, battery, network and uptime figures for this computer.",
  schema: z.object({}),
  summarize: () => "Reading system vitals",
  async run(_input, ctx) {
    const s = currentStats();
    const items = [
      { label: "CPU", value: `${s.cpu}%`, status: s.cpu > 85 ? ("bad" as const) : ("ok" as const) },
      { label: "Memory", value: `${formatBytes(s.memUsed)} / ${formatBytes(s.memTotal)}` },
      ...(s.disk ? [{ label: `Disk ${s.disk.mount}`, value: `${formatBytes(s.disk.total - s.disk.used)} free of ${formatBytes(s.disk.total)}` }] : []),
      ...(s.battery ? [{ label: "Battery", value: `${Math.round(s.battery.percent)}%${s.battery.charging ? " ⚡" : ""}` }] : []),
      { label: "Uptime", value: `${Math.floor(s.uptime / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m` },
    ];
    ctx.emit({ type: "panel", panel: { id: "vitals", title: "System diagnostics", subtitle: s.host, layout: "metrics", items } });
    return items.map((i) => `${i.label}: ${i.value}`).join("\n");
  },
});

// Virtual-key codes for the media keys, sent through WScript.Shell.
const WIN_MEDIA_KEYS: Record<string, number> = { mute: 173, volume_down: 174, volume_up: 175, next: 176, previous: 177, play_pause: 179 };

const mediaControl = defineTool({
  name: "media_control",
  category: "apps",
  description: "Control media playback and volume: play/pause, next, previous track, volume up/down, mute. Works with Spotify, YouTube in the browser, etc.",
  schema: z.object({
    action: z.enum(["play_pause", "next", "previous", "volume_up", "volume_down", "mute"]),
    steps: z.number().int().min(1).max(25).optional().describe("How many volume steps (each ~2%). Default 5."),
  }),
  summarize: (i) => `Media: ${i.action.replace("_", " ")}`,
  async run({ action, steps }) {
    const times = action.startsWith("volume") ? (steps ?? 5) : 1;
    if (isWin) {
      const key = WIN_MEDIA_KEYS[action];
      const script = `$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${key}) }`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, windowsHide: true });
      return `Done: ${action}.`;
    }
    if (isMac) {
      const scripts: Record<string, string> = {
        volume_up: `set volume output volume ((output volume of (get volume settings)) + ${times * 2})`,
        volume_down: `set volume output volume ((output volume of (get volume settings)) - ${times * 2})`,
        mute: "set volume output muted not (output muted of (get volume settings))",
        play_pause: 'tell application "Spotify" to playpause',
        next: 'tell application "Spotify" to next track',
        previous: 'tell application "Spotify" to previous track',
      };
      await execFileAsync("osascript", ["-e", scripts[action]], { timeout: 10_000 });
      return `Done: ${action}.`;
    }
    const cmds: Record<string, string[]> = {
      play_pause: ["playerctl", "play-pause"],
      next: ["playerctl", "next"],
      previous: ["playerctl", "previous"],
      volume_up: ["pactl", "set-sink-volume", "@DEFAULT_SINK@", `+${times * 2}%`],
      volume_down: ["pactl", "set-sink-volume", "@DEFAULT_SINK@", `-${times * 2}%`],
      mute: ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"],
    };
    const [c, ...a] = cmds[action];
    await execFileAsync(c, a, { timeout: 10_000 });
    return `Done: ${action}.`;
  },
});

const powerAction = defineTool({
  name: "power_action",
  category: "system",
  description: "Lock the computer, or put it to sleep, restart or shut it down. Sleep/restart/shutdown ask the user to confirm first.",
  schema: z.object({ action: z.enum(["lock", "sleep", "restart", "shutdown"]) }),
  risky: (i) => i.action !== "lock",
  summarize: (i) => `${i.action[0].toUpperCase()}${i.action.slice(1)} the computer`,
  async run({ action }) {
    const plans: Record<string, Record<string, string[]>> = {
      win32: {
        lock: ["rundll32.exe", "user32.dll,LockWorkStation"],
        sleep: ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
        restart: ["shutdown.exe", "/r", "/t", "10"],
        shutdown: ["shutdown.exe", "/s", "/t", "10"],
      },
      darwin: {
        lock: ["pmset", "displaysleepnow"],
        sleep: ["pmset", "sleepnow"],
        restart: ["osascript", "-e", 'tell app "System Events" to restart'],
        shutdown: ["osascript", "-e", 'tell app "System Events" to shut down'],
      },
      linux: {
        lock: ["loginctl", "lock-session"],
        sleep: ["systemctl", "suspend"],
        restart: ["systemctl", "reboot"],
        shutdown: ["systemctl", "poweroff"],
      },
    };
    const [cmd, ...args] = (plans[process.platform] ?? plans.linux)[action];
    await execFileAsync(cmd, args, { timeout: 15_000, windowsHide: true });
    return `${action} initiated.`;
  },
});

const lookAtScreen = defineTool({
  name: "look_at_screen",
  category: "system",
  description: "Take a screenshot of the user's main screen so you can see what they're looking at (errors, pages, documents, games). Use when they say 'look at this', 'what's on my screen', 'read this error'.",
  schema: z.object({}),
  providers: ["anthropic"],
  summarize: () => "Capturing the screen",
  async run() {
    const screenshot = (await import("screenshot-desktop")).default;
    const img = await screenshot({ format: "jpg" });
    if (img.length > 4.8 * 1024 * 1024) return "Screenshot is too large to send (over 5 MB).";
    return { text: "Screenshot of the user's main display:", images: [{ mediaType: "image/jpeg", data: img.toString("base64") }] };
  },
});

export const systemTools: ToolDef[] = [launchApp, runCommand, systemStatus, mediaControl, powerAction, lookAtScreen];
