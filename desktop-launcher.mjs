import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LITERATURE_WORKBENCH_PORT || 8765);
const appUrl = `http://127.0.0.1:${port}`;
const healthOnly = process.argv.includes("--health-check-only");
const dataDir = path.resolve(process.env.LITERATURE_WORKBENCH_DATA_DIR || path.join(appRoot, "data"));
const chromeProfileDir = path.join(dataDir, "desktop-chrome-profile");

async function healthy() {
  try {
    const response = await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    const result = await response.json();
    return response.ok && result.ok === true;
  } catch { return false; }
}

function notify(message) {
  spawnSync("msg.exe", ["*", message], { windowsHide: true });
}

let startedServer = false;
if (!(await healthy())) {
  fs.mkdirSync(dataDir, { recursive: true });
  const stdout = fs.openSync(path.join(dataDir, "desktop-server.log"), "a");
  const stderr = fs.openSync(path.join(dataDir, "desktop-server-error.log"), "a");
  const server = spawn(process.execPath, [path.join(appRoot, "server.mjs")], {
    cwd: appRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr]
  });
  server.unref();
  startedServer = true;
  for (let attempt = 0; attempt < 50 && !(await healthy()); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

if (!(await healthy())) {
  notify(`Zotero 文献工作台启动失败。请查看 ${path.join(dataDir, "desktop-server-error.log")}`);
  process.exitCode = 2;
} else if (healthOnly) {
  console.log(`WORKBENCH_OK started_server=${startedServer} url=${appUrl}`);
} else {
  const chromeCandidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ];
  const chrome = chromeCandidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) {
    spawn("cmd.exe", ["/c", "start", "", appUrl], { detached: true, stdio: "ignore" }).unref();
  } else {
    fs.mkdirSync(chromeProfileDir, { recursive: true });
    spawn(chrome, [
      `--app=${appUrl}`,
      `--user-data-dir=${chromeProfileDir}`,
      "--start-maximized",
      "--no-first-run"
    ], { detached: true, stdio: "ignore" }).unref();
  }
}
