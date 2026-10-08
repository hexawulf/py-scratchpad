# py-scratchpad
Browser-only Python scratchpad served as static files. No backend, no accounts, no telemetry.

Build plan: docs/PLAN.md — do one §9 step per session.
Separate repo from the parent python-learner; its tutoring rules don't apply here.

## Rules
- No runtime CDN or third-party requests: everything is bundled or vendored (CSP is `default-src 'self'`).
- All user data lives in localStorage under key `py-scratchpad:v1`; bump the version and write a migration when the schema changes.
- Never lose user code: autosave must survive reload; destructive actions (delete file, reset) need a confirm.
- Vanilla TS + Vite + CodeMirror 6. Don't add a UI framework without asking.
- Pin exact dependency versions; commit package-lock.json.
- Run `npm run lint && npm test && npm run build` before saying a change is done.
- Deploy target: piapps2 `/home/zk/bots/py-scratchpad`, container `py-scratchpad`, port 192.168.50.120:5040, vhost python.piapps.dev on piapps.
