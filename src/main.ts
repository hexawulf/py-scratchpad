import './style.css'

// Scaffold placeholder. The CodeMirror editor and localStorage autosave land in
// build step 2 (see docs/PLAN.md §9).
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="shell">
    <h1>py-scratchpad</h1>
    <p>Browser-only Python scratchpad. Your code never leaves this tab.</p>
    <p class="muted">Scaffold is up. Editor arrives in build step 2.</p>
  </main>
`
