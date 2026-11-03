import logger from '@server/logger';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Runs the Claude Code program on this server in print mode (`claude -p`),
 * signed in with the owner's own Claude subscription through
 * CLAUDE_CODE_OAUTH_TOKEN (made with `claude setup-token`) or a
 * `claude login` of the user Seerr runs as. Seerr never reads or stores
 * the token; Claude Code picks it up from the environment itself.
 *
 * Each run has no tools, no MCP servers and no slash commands, and starts in
 * an empty temporary folder so no project files are loaded.
 */

const TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
// Old hardware: don't start more than this many Claude Code runs at once
const MAX_RUNNING = 2;

let running = 0;
const waiting: (() => void)[] = [];

const acquire = async () => {
  if (running >= MAX_RUNNING) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
};

const release = () => {
  running--;
  waiting.shift()?.();
};

// The installer puts Claude Code in ~/.local/bin, which a systemd service's
// PATH usually doesn't include
const findCommand = async () => {
  if (process.env.CLAUDE_CODE_PATH) {
    return process.env.CLAUDE_CODE_PATH;
  }
  const installed = path.join(
    os.homedir(),
    '.local',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  );
  try {
    await fs.access(installed);
    return installed;
  } catch {
    return 'claude';
  }
};

const childEnv = () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  // Make sure the subscription is used, not an API key set for something else
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};

export class ClaudeCodeError extends Error {}

const NOT_INSTALLED =
  "Claude Code isn't installed on the server. See deploy/proxmox/README.md (Claude subscription) for how to set it up.";

const NOT_SIGNED_IN = `Claude Code isn't signed in on the server. Run "claude setup-token" on your own computer and add the token to Seerr's service as ${TOKEN_VARIABLE}.`;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const run = (
  args: string[],
  { input, cwd, timeoutMs }: { input?: string; cwd?: string; timeoutMs: number }
) =>
  new Promise<RunResult>((resolve, reject) => {
    findCommand().then((command) => {
      const child = spawn(command, args, {
        cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new ClaudeCodeError(e.code === 'ENOENT' ? NOT_INSTALLED : e.message)
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new ClaudeCodeError(
              `Claude Code didn't answer within ${Math.round(timeoutMs / 1000)} seconds`
            )
          );
          return;
        }
        resolve({ stdout, stderr, code });
      });

      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    }, reject);
  });

/** Turns Claude Code's `--output-format json` output into the answer text. */
export const readClaudeCodeOutput = ({ stdout, stderr, code }: RunResult) => {
  let output: { is_error?: boolean; result?: string; subtype?: string };
  try {
    output = JSON.parse(stdout.trim());
  } catch {
    const message = (stderr || stdout).trim().split('\n').slice(-3).join(' ');
    throw new ClaudeCodeError(
      /log ?in|authenticat|api key|oauth/i.test(message)
        ? NOT_SIGNED_IN
        : `Claude Code failed${code ? ` (exit code ${code})` : ''}: ${
            message || 'no output'
          }`
    );
  }

  const text = output.result ?? '';
  if (output.is_error || code) {
    throw new ClaudeCodeError(
      /not logged in|\/login|authenticat|invalid api key|oauth/i.test(text)
        ? `${NOT_SIGNED_IN} (${text})`
        : `Claude Code failed: ${text || output.subtype || `exit code ${code}`}`
    );
  }
  return text;
};

/**
 * Sends one prompt to Claude Code and returns the reply text.
 * `model` takes a full model ID or an alias like "opus" or "haiku".
 */
export const askClaudeCode = async ({
  system,
  prompt,
  model,
  timeoutMs = 300_000,
}: {
  system: string;
  prompt: string;
  model: string;
  timeoutMs?: number;
}): Promise<string> => {
  await acquire();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-claude-'));
  const started = Date.now();

  try {
    // A file instead of an argument, since the taste profile can be long
    const systemFile = path.join(folder, 'system-prompt.txt');
    await fs.writeFile(systemFile, system, 'utf8');

    const result = await run(
      [
        '-p',
        '--output-format',
        'json',
        '--model',
        model,
        '--system-prompt-file',
        systemFile,
        '--max-turns',
        '2',
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--effort',
        'low',
      ],
      { input: prompt, cwd: folder, timeoutMs }
    );

    const text = readClaudeCodeOutput(result);
    logger.debug('Claude Code answered', {
      label: 'AI Recommendations',
      model,
      durationMs: Date.now() - started,
    });
    return text;
  } finally {
    release();
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {
      // Leftover temp folders are harmless
    });
  }
};

/** Checks that Claude Code is installed, returning its version. */
export const getClaudeCodeVersion = async () => {
  const result = await run(['--version'], { timeoutMs: 30_000 });
  if (result.code) {
    throw new ClaudeCodeError(
      `Claude Code couldn't start: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
};

/** Whether a long-lived sign-in token was given to Seerr's service. */
export const hasClaudeCodeToken = () => !!process.env[TOKEN_VARIABLE];
