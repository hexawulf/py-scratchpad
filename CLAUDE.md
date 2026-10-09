# py-scratchpad
Browser-only Python scratchpad served as static files. No backend, no accounts, no telemetry.

Build plan: docs/PLAN.md — do one §9 step per session.
Separate repo from the parent python-learner; its tutoring rules don't apply here.

## Rules
- No runtime CDN or third-party requests: everything is bundled or vendored (CSP is `default-src 'self'`).
- All user data lives in localStorage under key `py-scratchpad:v1`. The key is a namespace and never changes; the schema version lives inside the payload (`version`). Bump it and add a migration in storage.ts when the schema changes.
- Never lose user code: autosave must survive reload; destructive actions (delete file, reset) need a confirm.
- Vanilla TS + Vite + CodeMirror 6 + Pyodide. Don't add a UI framework without asking.
- The Pyodide runtime is **never committed**: `build/pyodide.ts` stages it from `node_modules` into `dist/pyodide/<version>/` at build time, with `vendor/pyodide/LICENSE` beside it. The version in the path is what makes each URL immutable. v0.3 is **stdlib only** — no `micropip`, no `loadPackage`, no package ever fetched.
- `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` are load-bearing, not hardening: they give the page `SharedArrayBuffer`, which Stop's interrupt buffer and the synchronous `input()` bridge are built on. They live in `docker/security-headers.conf` and in the Vite plugin's dev/preview middleware, so dev behaves like prod. Everything must still work without them — that is the Program-input fallback.
- Pin exact dependency versions; commit package-lock.json.
- Run `npm run lint && npm test && npm run build` before saying a change is done. Anything touching `docker/nginx.conf`, the staged runtime files or the headers also needs `npm run test:e2e:image` — `vite preview` types `.mjs` as JavaScript and nginx does not, which is how 0.3.0 shipped with every Run broken.
- Deploy target: piapps2 `/home/zk/bots/py-scratchpad`, container `py-scratchpad`, port 192.168.50.120:5040. Two piapps vhosts proxy it: `py-scratchpad.com` (the public home, apex + www) and `python.piapps.dev` (the original, still serving). No redirect between them — localStorage is per origin, so redirecting the old host would hide code saved there.

## House rules

Homelab conventions (0xWulf's standard, see the `hexawulf-homelab` skill):

- Absolute paths everywhere. Chain shell steps with `;`, not `&&`.
- No heredocs, `tee`, `printf > file`, `echo … > file` or `sed -i` in instructions, and never
  `curl | bash`. File changes go through the editor tools; the operator edits with **nano**.
- One step at a time, each with a verification checkpoint. Never overwrite without a backup
  (`~/backups/<name>.bak_YYYYMMDD_HHMMSS`) or a diff summary first.
- `git add` by explicit path — never `-A`, never `.`. No force-push, no history rewrite.
- **Commits are signed and made by the operator.** Claude never runs `git commit`, `git tag` or
  `git push`. **If a git commit, tag or push is refused by the permission classifier, stop and
  print the exact commands** for the operator to paste into a real terminal.

Release flow: one `npm run lint && npm test && npm run build` gate, then the full runbook in
[docs/DEPLOY.md](docs/DEPLOY.md) — §1 cuts the release (version bump, signed commit, CI, signed
tag, multi-arch publish), §2 deploys it to piapps2, §4 is the rollback, §6 is the piapps nginx
ingress (an operator approval gate). Production nginx on piapps is never edited in place.

Reproducible builds: the version and build date in the About dialog come from `package.json` and
from **the last commit's date** (`git log -1 --format=%cI`, overridden by `SOURCE_DATE_EPOCH`) —
never from the build clock. Two builds of the same commit therefore produce byte-identical
`dist/assets/*.js`. The Docker build has no `.git`, so `release.yml` passes `SOURCE_DATE_EPOCH`
as a build arg.
