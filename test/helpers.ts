// Shared test timing helpers. One copy, so a ceiling tuned for loaded CI runners can't drift
// between files again.

// A fixed sleep. Only for giving a NEGATIVE assertion its window, or for spacing two stdin writes
// so they read as separate keypresses. A positive assertion waits on its condition (waitFor).
export const tick = () => new Promise((r) => setTimeout(r, 20))

// 15s default, not 3s: the ceiling only bounds failure-detection latency, the condition is polled
// and a passing wait returns as soon as it holds. 3s was repeatedly not enough on a loaded macOS CI
// runner with 40+ test files competing for the event loop. vitest.config.js sets testTimeout above
// this ceiling so a slow wait fails as a waitFor timeout, not as the test being killed mid-render.
export const waitFor = async (fn: () => unknown, timeoutMs = 15000, stepMs = 10) => {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
