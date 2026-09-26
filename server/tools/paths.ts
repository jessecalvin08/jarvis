import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KnownFolder = "home" | "desktop" | "documents" | "downloads" | "pictures" | "music" | "videos" | "onedrive";

let cached: Promise<Record<KnownFolder, string>> | null = null;

function exists(p: string | undefined): p is string {
  return !!p && fs.existsSync(p);
}

/**
 * Resolves the user's real shell folders. On Windows, Desktop/Documents are often
 * redirected into OneDrive, so asking the shell is the only reliable answer.
 */
export function knownFolders(): Promise<Record<KnownFolder, string>> {
  cached ??= resolveKnownFolders();
  return cached;
}

async function resolveKnownFolders(): Promise<Record<KnownFolder, string>> {
  const home = os.homedir();
  const guess = (name: string) => {
    const oneDrive = process.env.OneDrive ?? path.join(home, "OneDrive");
    for (const p of [path.join(home, name), path.join(oneDrive, name)]) if (exists(p)) return p;
    return path.join(home, name);
  };
  const folders: Record<KnownFolder, string> = {
    home,
    desktop: guess("Desktop"),
    documents: guess("Documents"),
    downloads: guess("Downloads"),
    pictures: guess("Pictures"),
    music: guess("Music"),
    videos: guess(process.platform === "darwin" ? "Movies" : "Videos"),
    onedrive: process.env.OneDrive ?? path.join(home, "OneDrive"),
  };

  if (process.platform === "win32") {
    const script = [
      "$o = [ordered]@{}",
      "$o.desktop = [Environment]::GetFolderPath('Desktop')",
      "$o.documents = [Environment]::GetFolderPath('MyDocuments')",
      "$o.pictures = [Environment]::GetFolderPath('MyPictures')",
      "$o.music = [Environment]::GetFolderPath('MyMusic')",
      "$o.videos = [Environment]::GetFolderPath('MyVideos')",
      "try { $o.downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch {}",
      "$o | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 8000,
        windowsHide: true,
      });
      const shell = JSON.parse(stdout.trim()) as Partial<Record<KnownFolder, string>>;
      for (const [k, v] of Object.entries(shell)) if (exists(v)) folders[k as KnownFolder] = v;
    } catch {
      // Fall back to the guesses above.
    }
  }
  return folders;
}

const ALIASES: Record<string, KnownFolder> = {
  "~": "home",
  home: "home",
  desktop: "desktop",
  documents: "documents",
  document: "documents",
  "my documents": "documents",
  docs: "documents",
  downloads: "downloads",
  download: "downloads",
  pictures: "pictures",
  photos: "pictures",
  images: "pictures",
  music: "music",
  videos: "videos",
  movies: "videos",
  onedrive: "onedrive",
};

/**
 * Turns what the model (or the user) said into an absolute path:
 * "Downloads", "~/Documents/jarvis", "desktop\\notes.txt" and absolute paths all work.
 */
export async function resolveUserPath(input: string): Promise<string> {
  let p = input.trim().replace(/^["']|["']$/g, "");
  if (/^[a-z]+:\/\//i.test(p)) return p; // URL or URI - leave it alone
  const folders = await knownFolders();

  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(folders.home, p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    const [first, ...rest] = p.split(/[\\/]/);
    const alias = ALIASES[first.toLowerCase()];
    p = alias ? path.join(folders[alias], ...rest) : path.join(folders.home, p);
  }
  return path.normalize(p);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
