/**
 * When Electron is launched from Finder/Dock on macOS, the process inherits a
 * minimal launchd environment (e.g. PATH=/usr/bin:/bin:…). Spawning the user's
 * login shell and merging `env` restores the same variables as in Terminal
 * (Homebrew, nvm, exports from ~/.zprofile, etc.).
 *
 * Ported from craft-agents-oss `apps/electron/src/main/shell-env.ts`.
 */

import { execSync } from 'node:child_process';

const shouldSkipEnvVar = (key: string): boolean => key.startsWith('VITE_');

export function loadShellEnv(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    console.info('[shell-env] skip: dev server URL set (already have a dev shell environment)');
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  console.info(`[shell-env] loading environment from ${shell}`);

  try {
    const output = execSync(`${shell} -l -i -c 'echo __ENV_START__ && env'`, {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: shell,
        TERM: 'xterm-256color',
        TMPDIR: process.env.TMPDIR,
        APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const envSection = output.split('__ENV_START__')[1] || '';
    let count = 0;
    for (const line of envSection.trim().split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq);
        if (shouldSkipEnvVar(key)) continue;
        process.env[key] = line.slice(eq + 1);
        count += 1;
      }
    }
    console.info(`[shell-env] merged ${String(count)} variables into process.env`);
  } catch (err) {
    console.warn('[shell-env] failed to load shell environment:', err);
    const fallbackPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ];
    const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    const newPath = [...fallbackPaths, ...currentPath.split(':')]
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .join(':');
    process.env.PATH = newPath;
    console.warn('[shell-env] applied PATH fallback');
  }
}
