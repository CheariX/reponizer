import { Application } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "./util";

const execFileAsync = promisify(execFile);

const TERMINAL_APP_ID = "com.apple.Terminal";

/**
 * Builds the `/usr/bin/open` argv that opens `dir` in the given terminal app.
 *
 * A plain `open -a <App> <folder>` (what `Action.Open` does) only works for terminals
 * that accept an "open folder" Apple event — Terminal.app, iTerm2, and Ghostty. iTerm2
 * and Ghostty open the folder as a tab of the front window, or as a window when none is
 * open; Terminal.app always opens a window (see `openTerminalAppTab`). Most other
 * terminals take the working directory as a launch argument instead, which requires a
 * fresh instance (`open -n`) and therefore a window, or use a URL scheme (Warp).
 */
function openArgs(app: Application | undefined, dir: string): string[] {
  if (!app) return ["-b", TERMINAL_APP_ID, dir];
  const target = app.bundleId ? ["-b", app.bundleId] : ["-a", app.path];
  const id = (app.bundleId ?? "").toLowerCase();
  if (id.startsWith("dev.warp.warp")) {
    return [...target, `warp://action/new_tab?path=${encodeURIComponent(dir)}`];
  }
  switch (id) {
    case "org.alacritty":
    case "io.alacritty":
      return ["-n", ...target, "--args", "--working-directory", dir];
    case "net.kovidgoyal.kitty":
      return ["-n", ...target, "--args", "--single-instance", "--directory", dir];
    case "com.github.wez.wezterm":
      // Without --always-new-process, `start` delegates to an already-running GUI
      // instance and the --cwd can get lost there (wezterm/wezterm#6218).
      return ["-n", ...target, "--args", "start", "--always-new-process", "--cwd", dir];
    default:
      return [...target, dir];
  }
}

/**
 * JXA run by `openTerminalAppTab`. Terminal.app has neither a URL scheme nor a scripting
 * command for tabs, but it provides the "New Terminal Tab at Folder" service (a tab of the
 * front window, or a window when none is open). `NSPerformService` calls it even while the
 * service is disabled in System Settings, without Accessibility or Automation permission.
 * A Terminal that is not running is left to `open`, which starts it in the folder directly.
 */
const TERMINAL_APP_TAB_SCRIPT = `
ObjC.import("AppKit");
function run([bundleId, dir]) {
  // NSArray.count comes back as a string through the bridge; the unwrapped array is a real one.
  if (ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId)).length === 0) {
    return "not-running";
  }
  // Terminal reads the pasteboard after NSPerformService returns, so it cannot be released
  // here; one fixed name keeps a pasteboard per call from piling up in the pasteboard server.
  const pboard = $.NSPasteboard.pasteboardWithName("reponizer.terminal-tab");
  pboard.clearContents;
  pboard.writeObjects($([$.NSURL.fileURLWithPath(dir)]));
  if (!$.NSPerformService("New Terminal Tab at Folder", pboard)) {
    throw new Error("Terminal's “New Terminal Tab at Folder” service is unavailable");
  }
  return "opened";
}`;

/** Opens `dir` as a tab of a running Terminal.app; resolves false when Terminal is not running. */
async function openTerminalAppTab(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      TERMINAL_APP_TAB_SCRIPT,
      TERMINAL_APP_ID,
      dir,
    ]);
    return stdout.trim() === "opened";
  } catch (error) {
    // execFile's own message repeats the command line, script included; osascript's stderr
    // reads "execution error: Error: Error: <message> (-2700)".
    const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
    const reason = stderr.replace(/^execution error: (?:Error: )*/, "").replace(/ \(-?\d+\)$/, "");
    throw new Error(reason || errorMessage(error));
  }
}

/**
 * Env for the `open` call, mimicking a Finder launch: `open` forwards the caller's
 * environment to a freshly launched app, and Raycast's runtime carries a BCP-47
 * `LC_ALL` (e.g. `en_DE-u-hc-h23-…`) that is not a valid POSIX locale — shells in
 * the new terminal would warn "setlocale: cannot change locale". Without the
 * variables the terminal derives its own locale, as it does when started normally.
 */
function launchEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "LANG" && !key.startsWith("LC_")));
}

/**
 * Opens `dir` in the configured terminal app, adapting the launch command to the app:
 * a new tab where the terminal offers one without extra setup, otherwise a new window.
 */
export async function openInTerminal(app: Application | undefined, dir: string): Promise<void> {
  const isTerminalApp = (app ? app.bundleId : TERMINAL_APP_ID)?.toLowerCase() === TERMINAL_APP_ID.toLowerCase();
  if (isTerminalApp && (await openTerminalAppTab(dir))) return;
  await execFileAsync("/usr/bin/open", openArgs(app, dir), { env: launchEnv() });
}
