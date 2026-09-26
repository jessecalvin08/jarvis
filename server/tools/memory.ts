import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { defineTool, type ToolDef } from "./types.js";

interface Fact {
  text: string;
  at: string;
}

const file = path.join(config.vaultDir, "memory.json");

function load(): Fact[] {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { facts: Fact[] }).facts ?? [];
  } catch {
    return [];
  }
}

function save(facts: Fact[]): void {
  fs.writeFileSync(file, JSON.stringify({ facts }, null, 2), "utf8");
}

export function memoryFacts(): string[] {
  return load().map((f) => f.text);
}

const remember = defineTool({
  name: "remember",
  category: "memory",
  description:
    "Save a lasting fact about the user to your long-term memory vault (preferences, people, projects, routines, where things live). " +
    "Use when the user says 'remember…' or shares something you'll clearly need later. One fact per call, written as a short sentence.",
  schema: z.object({ fact: z.string().min(3).max(500).describe("e.g. 'Jesse's resume lives in Documents/Career/resume.pdf'") }),
  summarize: (i) => `Remembering: ${i.fact}`,
  async run({ fact }, ctx) {
    const facts = load();
    if (!facts.some((f) => f.text.toLowerCase() === fact.toLowerCase())) facts.push({ text: fact, at: new Date().toISOString() });
    save(facts.slice(-200));
    ctx.emit({ type: "memory", items: memoryFacts() });
    return `Stored. ${facts.length} facts in memory.`;
  },
});

const forget = defineTool({
  name: "forget",
  category: "memory",
  description: "Delete facts from long-term memory whose text contains the given words.",
  schema: z.object({ match: z.string().min(2).describe("Words that appear in the fact(s) to delete") }),
  summarize: (i) => `Forgetting "${i.match}"`,
  async run({ match }, ctx) {
    const facts = load();
    const keep = facts.filter((f) => !f.text.toLowerCase().includes(match.toLowerCase()));
    save(keep);
    ctx.emit({ type: "memory", items: memoryFacts() });
    const removed = facts.length - keep.length;
    return removed ? `Forgot ${removed} fact(s).` : `Nothing in memory mentions "${match}".`;
  },
});

export const memoryTools: ToolDef[] = [remember, forget];
