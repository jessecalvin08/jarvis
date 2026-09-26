import os from "node:os";
import si from "systeminformation";
import type { Stats } from "./events.js";

let prevCpu = os.cpus().map((c) => c.times);
let disk: Stats["disk"];
let battery: Stats["battery"];
let net: Stats["net"];

function cpuPercent(): number {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = prevCpu[i] ?? t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    idle += d("idle");
    total += d("user") + d("nice") + d("sys") + d("irq") + d("idle");
  });
  prevCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

async function refreshSlow(): Promise<void> {
  try {
    const drives = await si.fsSize();
    const systemMount = process.platform === "win32" ? (process.env.SystemDrive ?? "C:") : "/";
    const d = drives.find((x) => x.mount.toLowerCase().startsWith(systemMount.toLowerCase())) ?? drives[0];
    if (d) disk = { used: d.used, total: d.size, mount: d.mount };
  } catch {
    /* not critical */
  }
  try {
    const b = await si.battery();
    battery = b.hasBattery ? { percent: b.percent, charging: b.isCharging } : undefined;
  } catch {
    /* not critical */
  }
}

async function refreshNet(): Promise<void> {
  try {
    const all = await si.networkStats("*");
    net = all.reduce((acc, n) => ({ rx: acc.rx + Math.max(0, n.rx_sec ?? 0), tx: acc.tx + Math.max(0, n.tx_sec ?? 0) }), { rx: 0, tx: 0 });
  } catch {
    /* not critical */
  }
}

export function startStats(onStats: (s: Stats) => void): void {
  void refreshSlow();
  setInterval(() => void refreshSlow(), 60_000).unref();
  setInterval(() => void refreshNet(), 3_000).unref();
  setInterval(() => onStats(currentStats()), 2_000).unref();
}

export function currentStats(): Stats {
  return {
    cpu: cpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    disk,
    battery,
    net,
    uptime: os.uptime(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
  };
}
