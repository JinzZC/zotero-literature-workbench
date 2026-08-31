// Heuristic release guard: inspect only tracked files, never private runtime data.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const staged = process.argv.includes("--staged");
const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const paths = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const issues = [];
for (const file of paths) {
  const normalized = file.replaceAll("\\", "/");
  if (/(^|\/)(?:data|artifacts|node_modules|\.obsidian|\.claudian|credentials|\.git)(?:\/|$)/i.test(normalized)
      || /(^|\/)\.env(?:$|\.(?!example$))/i.test(normalized)
      || /\.(?:pdf|zip|dpapi|log|sqlite|sqlite3|db|pem|p12|key)$/i.test(normalized)) {
    issues.push(`${file}: runtime, attachment or credential path`);
    continue;
  }
  const content = staged ? git(["show", `:${file}`]) : fs.readFileSync(file, "utf8");
  const secretPatterns = [
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  if (secretPatterns.some(pattern => pattern.test(content))) issues.push(`${file}: possible credential`);
  const portable = content.replace(/\\+/g, "/");
  for (const match of portable.matchAll(/[A-Za-z]:\/Users\/([^/\s"';]+)/g)) {
    if (!["your-name", "username", "<user>"].includes(match[1])) issues.push(`${file}: personal user directory`);
  }
  // Catch literal per-item mapping objects; fixtures should use clear placeholders.
  if (/"[A-Z0-9]{8}"\s*:\s*(?:"|\{)/.test(content)) issues.push(`${file}: possible personal item mapping`);
}
if (issues.length) {
  console.error(issues.join("\n")); // Report locations only, never print matched secrets.
  process.exitCode = 1;
} else {
  console.log(`Public release check: OK (${paths.length} tracked files; ${staged ? "index" : "working tree"})`);
}
