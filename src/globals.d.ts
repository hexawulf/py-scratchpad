/**
 * Build-time constants replaced textually by Vite's `define` (see
 * `vite.config.ts`). They exist in `npm run dev` and in the production bundle,
 * but not under vitest, so every reader must guard with `typeof`.
 */

/** `BuildInfo` as a JSON string: version, ISO build date, dependency versions. */
declare const __BUILD_INFO__: string

/** The exact Pyodide version staged into `dist/pyodide/<version>/`. */
declare const __PYODIDE_VERSION__: string

/** `/pyodide/<version>/` — what the worker passes as `indexURL`. */
declare const __PYODIDE_INDEX_URL__: string
