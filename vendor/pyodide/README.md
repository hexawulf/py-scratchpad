# vendor/pyodide

Pyodide's own licence file, kept here so it can be published **alongside** the runtime
files it covers — `dist/pyodide/<version>/LICENSE`, next to the `.wasm`, the `.mjs` and
`python_stdlib.zip`. The MPL-2.0 asks for exactly that: a recipient of the Source Code
Form gets the licence with it.

The binaries themselves are **not** in this repository. They come out of the pinned
`pyodide` npm package at build time; `build/pyodide.ts` copies them, and this `LICENSE`,
into `dist/`. See `.gitignore`.

| | |
|---|---|
| Upstream | <https://github.com/pyodide/pyodide> |
| Licence | MPL-2.0 (verbatim, no project-specific additions) |
| Fetched from | `https://raw.githubusercontent.com/pyodide/pyodide/314.0.7/LICENSE` |
| sha256 | `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5` |

When the pinned Pyodide version moves, re-fetch this file for the new tag and update the
sha256 above. The MPL text does not change between releases, but the check is what proves
that rather than assuming it.
