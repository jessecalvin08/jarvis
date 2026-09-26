/** Messages exchanged between the server and the HUD over the WebSocket. */

export interface PanelItem {
  label: string;
  value?: string;
  detail?: string;
  status?: "ok" | "warn" | "bad" | "info";
  /** A local path or URL. The HUD makes the item clickable and opens it. */
  path?: string;
}

export interface Panel {
  id?: string;
  title: string;
  subtitle?: string;
  layout?: "list" | "metrics";
  items: PanelItem[];
}

export interface ToolInfo {
  name: string;
  category: string;
  description: string;
  risky: boolean;
}

export interface Stats {
  cpu: number;
  memUsed: number;
  memTotal: number;
  disk?: { used: number; total: number; mount: string };
  battery?: { percent: number; charging: boolean };
  net?: { rx: number; tx: number };
  uptime: number;
  host: string;
  platform: string;
}

export type ServerEvent =
  | {
      type: "hello";
      assistantName: string;
      userTitle: string;
      model: string;
      setupProblem: string | null;
      speechLang: string;
      wakeWord: string;
      stt: { provider: "browser" | "local" };
      tts: { provider: "browser" | "elevenlabs" | "kokoro" };
      location: string;
      tools: ToolInfo[];
      memory: string[];
      gmail: boolean;
      busy: boolean;
    }
  | { type: "state"; state: "idle" | "thinking" | "working" }
  | { type: "user"; text: string }
  | { type: "delta"; text: string }
  | { type: "turn_end"; text: string; costUsd: number; sessionCostUsd: number }
  | { type: "tool_start"; id: string; name: string; category: string; summary: string }
  | { type: "tool_end"; id: string; ok: boolean; summary: string; ms: number }
  | { type: "approval"; id: string; name: string; summary: string; detail: string }
  | { type: "approval_done"; id: string; approved: boolean }
  | { type: "panel"; panel: Panel }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | { type: "announce"; text: string }
  | { type: "stats"; stats: Stats }
  | { type: "inbox"; unread: number | null; error?: string }
  | { type: "memory"; items: string[] }
  | { type: "tools"; tools: ToolInfo[] }
  | { type: "reset" };

export type ClientEvent =
  | { type: "user"; text: string }
  | { type: "approve"; id: string; approved: boolean }
  | { type: "abort" }
  | { type: "reset" }
  | { type: "open"; path: string };
