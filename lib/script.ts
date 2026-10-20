// Whether node was started with the module at `moduleUrl` (pass its
// import.meta.url), so `npm start` and `npm run smoke` run main() and an
// import from a test does not. Real paths on both sides: started through a
// symlink, node resolves the module to its real path but leaves argv as typed,
// and a path with `#`, `%` or `[` in it does not survive being made into a URL
// by hand. A string comparison would then skip main() and exit 0 in silence.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function startedAsScript(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
