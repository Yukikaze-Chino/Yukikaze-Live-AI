import { spawnSync } from "node:child_process";

export function cleanFontFamilyName(value) {
  return String(value || "")
    .replace(/\s*\((?:TrueType|OpenType|All res)\)\s*;?$/i, "")
    .replace(/\s*;$/, "")
    .split(/\s*&\s*/)[0]
    .trim();
}

export function normalizeFontFamilies(values) {
  const families = new Map();
  for (const value of values || []) {
    const family = cleanFontFamilyName(value);
    if (!family) continue;
    const key = family.toLocaleLowerCase();
    if (!families.has(key)) families.set(key, family);
  }
  return [...families.values()].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

function parsePowerShellJson(stdout) {
  const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class FontLibrary {
  listInstalledFonts() {
    if (process.platform !== "win32") return [];
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();",
      "Add-Type -AssemblyName System.Drawing;",
      "$families = [System.Drawing.Text.InstalledFontCollection]::new().Families.Name;",
      "$registry = @(",
      "  Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -ErrorAction SilentlyContinue;",
      "  Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -ErrorAction SilentlyContinue",
      ") | ForEach-Object { $_.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object Name };",
      "@($families + $registry) | ConvertTo-Json -Compress",
    ].join(" ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`无法读取 Windows 字体：${result.stderr}`);
    }
    return normalizeFontFamilies(parsePowerShellJson(result.stdout));
  }
}
