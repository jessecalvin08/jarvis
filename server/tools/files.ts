import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import type { PanelItem } from "../events.js";
import { openTarget } from "./open.js";
import { formatBytes, isInside, knownFolders, resolveUserPath } from "./paths.js";
import { defineTool, truncate, type ToolDef, type ToolOutput } from "./types.js";

const SKIP_DIRS = new Set(
  [
    "node_modules", "appdata", "application data", "$recycle.bin", "system volume information",
    "windows", "program files", "program files (x86)", "programdata", "__pycache__", "venv",
    "site-packages", "library", "cache", "caches", "temp", "tmp",
  ],
);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[_\-.()[\]{},]+/g, " ").replace(/\s+/g, " ").trim();
}

interface Hit {
  path: string;
  name: string;
  isDir: boolean;
  score: number;
  depth: number;
}

async function searchFiles(
  query: string,
  roots: string[],
  kind: "file" | "folder" | "any",
  limit: number,
  signal: AbortSignal,
): Promise<{ hits: Hit[]; scanned: number; timedOut: boolean }> {
  const q = normalizeName(query);
  const tokens = q.split(" ").filter(Boolean);
  const hits: Hit[] = [];
  const deadline = Date.now() + 6000;
  let scanned = 0;
  let timedOut = false;
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));

  for (let qi = 0; qi < queue.length; qi++) {
    if (signal.aborted) break;
    if (Date.now() > deadline || scanned > 250_000) {
      timedOut = true;
      break;
    }
    const { dir, depth } = queue[qi];
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      scanned++;
      if (e.isSymbolicLink()) continue;
      const isDir = e.isDirectory();
      const full = path.join(dir, e.name);
      const name = normalizeName(e.name);
      const stem = normalizeName(path.parse(e.name).name);

      if ((kind === "any" || (kind === "folder") === isDir) && tokens.every((t) => name.includes(t))) {
        let score = 40;
        if (stem === q || name === q) score = 100;
        else if (stem.startsWith(q)) score = 70;
        else if (name.includes(q)) score = 55;
        hits.push({ path: full, name: e.name, isDir, score, depth });
      }
      if (isDir && depth < 7 && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name.toLowerCase())) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
    // Exact hits near the top of the tree are almost always what the user meant.
    if (hits.filter((h) => h.score >= 90).length >= limit) break;
  }
  hits.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return { hits: hits.slice(0, limit * 3), scanned, timedOut };
}

async function describe(p: string): Promise<{ size: number; mtime: Date } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size, mtime: s.mtime };
  } catch {
    return null;
  }
}

function when(d: Date): string {
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const findFiles = defineTool({
  name: "find_files",
  category: "files",
  description:
    "Search the user's computer for files or folders by name (Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive and the home folder). " +
    "Matching is case-insensitive and every word must appear in the name, so 'resume pdf' finds 'Jesse_Resume_2026.pdf'. " +
    "Use this whenever the user asks to pull up, open or find something and you don't know the exact path. Results appear on the HUD automatically.",
  schema: z.object({
    query: z.string().min(1).describe("Words from the file or folder name, e.g. 'resume', 'tax 2025 pdf', 'jarvis'"),
    in: z.string().optional().describe("Optional folder to search in, e.g. 'Downloads' or 'D:\\Projects'. Defaults to all personal folders."),
    kind: z.enum(["file", "folder", "any"]).optional().describe("Restrict to files or folders. Default any."),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
  }),
  summarize: (i) => `Searching for "${i.query}"${i.in ? ` in ${i.in}` : ""}`,
  async run(input, ctx) {
    const limit = input.limit ?? 10;
    const folders = await knownFolders();
    let roots: string[];
    if (input.in) {
      roots = [await resolveUserPath(input.in)];
    } else {
      const personal = [folders.desktop, folders.documents, folders.downloads, folders.pictures, folders.videos, folders.music, folders.onedrive];
      roots = [...new Set([...personal, folders.home])];
    }
    const { hits, scanned, timedOut } = await searchFiles(input.query, roots, input.kind ?? "any", limit, ctx.signal);

    // Among equally good name matches, the most recently modified is usually the one meant.
    const detailed = await Promise.all(hits.map(async (h) => ({ ...h, info: await describe(h.path) })));
    detailed.sort(
      (a, b) => b.score - a.score || (b.info?.mtime.getTime() ?? 0) - (a.info?.mtime.getTime() ?? 0) || a.depth - b.depth,
    );
    const top = detailed.slice(0, limit);

    if (!top.length) {
      return `No files or folders matching "${input.query}" (scanned ${scanned} entries${timedOut ? ", search hit its time limit" : ""}). Try fewer or different words, or a specific folder.`;
    }
    const items: PanelItem[] = top.map((h) => ({
      label: h.name,
      value: h.isDir ? "folder" : h.info ? formatBytes(h.info.size) : "",
      detail: `${path.dirname(h.path)}${h.info ? ` · ${when(h.info.mtime)}` : ""}`,
      path: h.path,
      status: "info",
    }));
    ctx.emit({ type: "panel", panel: { id: "files", title: `Search · ${input.query}`, subtitle: `${top.length} match${top.length === 1 ? "" : "es"}`, items } });
    const lines = top.map(
      (h, i) => `${i + 1}. ${h.isDir ? "[folder]" : "[file]"} ${h.path}${h.info ? ` (${h.isDir ? "" : formatBytes(h.info.size) + ", "}modified ${when(h.info.mtime)})` : ""}`,
    );
    return `Found ${top.length} match(es):\n${lines.join("\n")}`;
  },
});

const openPath = defineTool({
  name: "open_path",
  category: "files",
  description:
    "Open a file, folder or URL on the user's screen with its default app (folders open in File Explorer, PDFs in the PDF viewer, URLs in the browser). " +
    "Accepts absolute paths, known folder names like 'Downloads' or 'Documents/jarvis', and http(s) URLs. Set reveal=true to highlight a file in its folder instead of opening it.",
  schema: z.object({
    path: z.string().min(1).describe("Absolute path, known-folder path like 'Downloads', or a URL"),
    reveal: z.boolean().optional().describe("Show the file selected in File Explorer instead of opening it"),
  }),
  summarize: (i) => `${i.reveal ? "Revealing" : "Opening"} ${i.path}`,
  async run(input) {
    const target = await resolveUserPath(input.path);
    const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
    if (!isUrl) {
      try {
        await fs.access(target);
      } catch {
        return `Nothing exists at ${target}. Use find_files to locate it first.`;
      }
    } else if (!/^(https?|mailto|ms-settings|spotify|whatsapp|discord|msteams|steam|zoommtg|tel|ms-[a-z-]+):/i.test(target)) {
      return `Refusing to open unrecognised URI scheme: ${target}`;
    }
    await openTarget(target, input.reveal);
    return `${input.reveal ? "Revealed" : "Opened"} ${target}`;
  },
});

const listDirectory = defineTool({
  name: "list_directory",
  category: "files",
  description: "List what is inside a folder (names, sizes, dates). Accepts absolute paths or known folders like 'Downloads'. Results appear on the HUD automatically.",
  schema: z.object({
    path: z.string().min(1).describe("Folder path, e.g. 'Downloads' or 'C:\\Users\\me\\Projects'"),
    sort: z.enum(["name", "recent", "size"]).optional().describe("Sort order (default: recent first)"),
    limit: z.number().int().min(1).max(300).optional(),
  }),
  summarize: (i) => `Listing ${i.path}`,
  async run(input, ctx) {
    const dir = await resolveUserPath(input.path);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 2000)
        .map(async (e) => ({ name: e.name, isDir: e.isDirectory(), info: await describe(path.join(dir, e.name)) })),
    );
    const sort = input.sort ?? "recent";
    rows.sort((a, b) => {
      if (sort === "name") return Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name);
      if (sort === "size") return (b.info?.size ?? 0) - (a.info?.size ?? 0);
      return (b.info?.mtime.getTime() ?? 0) - (a.info?.mtime.getTime() ?? 0);
    });
    const shown = rows.slice(0, input.limit ?? 60);
    ctx.emit({
      type: "panel",
      panel: {
        id: "files",
        title: path.basename(dir) || dir,
        subtitle: `${rows.length} item${rows.length === 1 ? "" : "s"} · ${dir}`,
        items: shown.slice(0, 25).map((r) => ({
          label: r.name,
          value: r.isDir ? "folder" : r.info ? formatBytes(r.info.size) : "",
          detail: r.info ? when(r.info.mtime) : undefined,
          path: path.join(dir, r.name),
        })),
      },
    });
    const lines = shown.map((r) => `${r.isDir ? "[folder]" : "[file]  "} ${r.name}${r.info ? `  ${r.isDir ? "" : formatBytes(r.info.size) + "  "}${when(r.info.mtime)}` : ""}`);
    return `${dir} contains ${rows.length} items${rows.length > shown.length ? ` (showing ${shown.length})` : ""}:\n${lines.join("\n")}`;
  },
});

const TEXT_LIMIT = 30_000;
const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg"> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const readFile = defineTool({
  name: "read_file",
  category: "files",
  description:
    "Read the contents of a file so you can summarise or answer questions about it. Handles text/code files, PDF and Word (.docx) documents, and PNG/JPEG images. " +
    "Use open_path instead when the user just wants to see the file on screen.",
  schema: z.object({
    path: z.string().min(1).describe("Absolute path or known-folder path to the file"),
    maxChars: z.number().int().min(500).max(100_000).optional().describe(`Max characters to return (default ${TEXT_LIMIT})`),
  }),
  summarize: (i) => `Reading ${path.basename(i.path)}`,
  async run(input): Promise<ToolOutput> {
    const file = await resolveUserPath(input.path);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return `${file} is a folder. Use list_directory instead.`;
    const max = input.maxChars ?? TEXT_LIMIT;
    const ext = path.extname(file).toLowerCase();

    if (ext === ".pdf") {
      if (stat.size > 60 * 1024 * 1024) return `PDF is too large to read (${formatBytes(stat.size)}).`;
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      const body = text.trim() || "(no extractable text - this PDF is probably scanned images)";
      return `PDF: ${file} (${totalPages} pages)\n\n${truncate(body, max)}`;
    }
    if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.default.extractRawText({ path: file });
      return `Word document: ${file}\n\n${truncate(value.trim(), max)}`;
    }
    if (IMAGE_TYPES[ext]) {
      if (stat.size > 4.5 * 1024 * 1024) return `Image is too large to send to the model (${formatBytes(stat.size)}). Open it with open_path instead.`;
      const data = (await fs.readFile(file)).toString("base64");
      return { text: `Image: ${file}`, images: [{ mediaType: IMAGE_TYPES[ext], data }] };
    }
    if (stat.size > 25 * 1024 * 1024) return `File is too large to read (${formatBytes(stat.size)}).`;
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) {
      return `${file} is a binary file (${formatBytes(stat.size)}), so it can't be read as text. Use open_path to open it in its app.`;
    }
    return `File: ${file} (${formatBytes(stat.size)})\n\n${truncate(buf.toString("utf8"), max)}`;
  },
});

const writeFile = defineTool({
  name: "write_file",
  category: "files",
  description:
    "Create or overwrite a text file (notes, code, drafts, lists) inside the user's home folder, or append to one. The user confirms before it runs.",
  schema: z.object({
    path: z.string().min(1).describe("Where to write, e.g. 'Documents/notes/todo.md' or an absolute path inside the home folder"),
    content: z.string().describe("The full text to write"),
    append: z.boolean().optional().describe("Append instead of overwriting"),
  }),
  risky: true,
  summarize: (i) => `${i.append ? "Append" : "Write"} ${formatBytes(Buffer.byteLength(i.content))} to ${i.path}`,
  async run(input) {
    const file = await resolveUserPath(input.path);
    if (!isInside(file, config.home)) return `Refusing to write outside the home folder: ${file}`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (input.append) await fs.appendFile(file, input.content, "utf8");
    else await fs.writeFile(file, input.content, "utf8");
    return `${input.append ? "Appended to" : "Wrote"} ${file} (${formatBytes(Buffer.byteLength(input.content))}).`;
  },
});

export const fileTools: ToolDef[] = [findFiles, openPath, listDirectory, readFile, writeFile];
