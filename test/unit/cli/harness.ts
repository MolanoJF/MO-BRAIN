// test/unit/cli/harness.ts
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'mobrain');

export type Cli = Awaited<ReturnType<typeof cliWorld>>;

/** A temp HOME, a stub-bin dir first on PATH, and a log of every stub call. */
export async function cliWorld() {
  const root = await mkdtemp(join(tmpdir(), 'mb-cli-'));
  const home = join(root, 'home'); const stubs = join(root, 'stubs'); const log = join(root, 'calls.log');
  await mkdir(home, { recursive: true }); await mkdir(stubs);
  await writeFile(log, '');
  const env: Record<string, string> = {
    HOME: home, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log, USER: 'tester', LANG: 'C',
    // A path with no checkout, so the real repo never leaks into a test. Tests that
    // need a stack host pass their own MOBRAIN_REPO.
    MOBRAIN_REPO: join(root, 'no-repo'),
  };
  return {
    root, home, stubs, env,
    /** Write a stub binary. `body` runs after the call is logged; "$@" holds the args. */
    async stub(name: string, body = 'exit 0') {
      const p = join(stubs, name);
      await writeFile(p, `#!/usr/bin/env bash\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"\n${body}\n`);
      await chmod(p, 0o755);
    },
    async calls(name?: string): Promise<string[][]> {
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => l.split('\x1f'));
      return name ? lines.filter((l) => l[0] === name).map((l) => l.slice(1)) : lines;
    },
    async run(args: string[], extraEnv: Record<string, string> = {}) {
      const p = Bun.spawn(['bash', BIN, ...args], { env: { ...env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe', cwd: root });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, code };
    },
    async runnerEnv(url = 'http://mb.test', key = 'mbk_test') {
      await mkdir(join(home, '.config', 'mobrain'), { recursive: true });
      await writeFile(join(home, '.config', 'mobrain', 'runner.env'), `MOBRAIN_URL=${url}\nMOBRAIN_API_KEY=${key}\n`);
    },
  };
}

/** A curl stub body: route on the URL; print body then "\n<code>" like -w '\n%{http_code}'. */
export function curlRoutes(routes: [pattern: string, code: number, body: string][]): string {
  const cases = routes.map(([p, code, body]) => `  *'${p}'*) printf '%s\\n%s' '${body.replaceAll("'", "'\\''")}' ${code}; exit 0;;`).join('\n');
  return `url="\${@: -1}"\ncase "$url" in\n${cases}\n  *) printf 'not routed\\n404'; exit 0;;\nesac`;
}
