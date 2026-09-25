import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ONE_PASSWORD_AGENT_SOCK = path.join(
  os.homedir(),
  "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
);

let cachedEnv: NodeJS.ProcessEnv | undefined;

/**
 * Raycast does not launch through a login shell, so PATH and SSH_AUTH_SOCK may be missing.
 * Extend PATH with the usual locations and fall back to the 1Password SSH agent socket.
 */
function gitEnv(): NodeJS.ProcessEnv {
  if (cachedEnv) return cachedEnv;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // /bin matters too: git-lfs runs its helpers through `sh` looked up via PATH (and reports a
  // missing sh as a missing "git-lfs"), while macOS only ships /bin/sh.
  const dirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];
  env.PATH = [...new Set([...dirs, ...(env.PATH ?? "").split(":")].filter(Boolean))].join(":");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_SSH_COMMAND = env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes";
  if (!env.SSH_AUTH_SOCK && fs.existsSync(ONE_PASSWORD_AGENT_SOCK)) {
    env.SSH_AUTH_SOCK = ONE_PASSWORD_AGENT_SOCK;
  }
  cachedEnv = env;
  return env;
}

export interface GitOptions {
  /** Defaults to 15s; network operations should pass a higher value. */
  timeoutMs?: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git in `cwd` and return trimmed stdout. Throws GitError with stderr detail on failure. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      env: gitEnv(),
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const stderr = (err.stderr ?? "").trim();
    const reason = err.killed ? "timed out" : stderrReason(stderr) || err.message;
    throw new GitError(`git ${args[0]}: ${reason}`, args, stderr);
  }
}

/**
 * The line of stderr that explains a failure. Commands like clone print progress ("Cloning
 * into …") to stderr before the actual error, so the first line is often just noise: prefer
 * the last `fatal:`/`error:` line, else the last non-empty one.
 */
function stderrReason(stderr: string): string | undefined {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.findLast((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1);
}

/** Run an arbitrary command with the same environment fixes as git. */
export async function run(
  command: string,
  args: string[],
  options: GitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: gitEnv(),
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}
