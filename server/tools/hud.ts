import { z } from "zod";
import { defineTool, type ToolDef } from "./types.js";

const showPanel = defineTool({
  name: "show_panel",
  category: "display",
  description:
    "Put a holographic card on the user's HUD. Use it for anything structured you'd otherwise have to read out: figures, lists, comparisons, steps, " +
    "search findings, schedules. Speak only the headline and let the card carry the detail. " +
    "layout 'metrics' shows big numbers in a grid; 'list' shows rows. Items with a path or URL become clickable.",
  schema: z.object({
    title: z.string().min(1).max(80),
    subtitle: z.string().max(160).optional(),
    layout: z.enum(["list", "metrics"]).optional(),
    items: z
      .array(
        z.object({
          label: z.string().max(120),
          value: z.string().max(80).optional(),
          detail: z.string().max(400).optional(),
          status: z.enum(["ok", "warn", "bad", "info"]).optional(),
          path: z.string().max(1000).optional().describe("File path or URL to open when clicked"),
        }),
      )
      .min(1)
      .max(24),
  }),
  summarize: (i) => `Displaying "${i.title}"`,
  async run(input, ctx) {
    ctx.emit({ type: "panel", panel: input });
    return "Displayed on the HUD.";
  },
});

const timers = new Map<string, NodeJS.Timeout>();

const setTimer = defineTool({
  name: "set_timer",
  category: "display",
  description: "Set a countdown timer or reminder. When it fires, Jarvis announces the message out loud. Timers don't survive a restart.",
  schema: z.object({
    minutes: z.number().min(0.1).max(24 * 60).describe("Minutes from now"),
    message: z.string().min(1).max(200).describe("What to say when it fires, e.g. 'Time to leave for the gym, sir.'"),
  }),
  summarize: (i) => `Timer: ${i.minutes} min · ${i.message}`,
  async run({ minutes, message }, ctx) {
    const id = `t${Date.now()}`;
    const due = new Date(Date.now() + minutes * 60_000);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        ctx.emit({ type: "announce", text: message });
      }, minutes * 60_000),
    );
    ctx.emit({
      type: "panel",
      panel: { id: "timers", title: "Timer set", layout: "metrics", items: [{ label: message, value: due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), status: "info" }] },
    });
    return `Timer set for ${due.toLocaleTimeString()}.`;
  },
});

export const hudTools: ToolDef[] = [showPanel, setTimer];
