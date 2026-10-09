/**
 * Build-time constants replaced textually by Vite's `define` (see
 * `vite.config.ts`). They exist in `npm run dev` and in the production bundle,
 * but not under vitest, so every reader must guard with `typeof`.
 */

/** `BuildInfo` as a JSON string: version, ISO build date, dependency versions. */
declare const __BUILD_INFO__: string
