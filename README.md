# vitest-probe

A tiny probe you can drop into your codebase to *observe internals in tests*—without breaking encapsulation or shipping debug code to production.

* `probeEmit(label, value)` — sprinkle in your code where you want visibility.
* `getProbe({ … })` — in tests, get a scoped, timeout-safe stream of those emissions.
* **Parallel-safe** via `AsyncLocalStorage`: each test can isolate its own scope with `probe.run(...)`.
* **Zero prod overhead** when you define `__TEST__ = false` in your production build (DCE removes calls).

---

## Why?

Unit tests often need to “peek” at intermediate values or call non-public helpers. Exposing internals just for tests or writing elaborate harnesses creates maintenance drag.

This library gives you **assertion-like** tracepoints that:

* stay **purely observational**
* are **scoped to the current test**
* are **compiled away** in production bundles

---

## Install

```bash
npm i -D vitest-probe
# or
pnpm add -D vitest-probe
# or
yarn add -D vitest-probe
```

> Requires **Node 16+** (uses `AsyncLocalStorage`). Designed for Vitest/Jest (Node env).

---

## Quick start

### 1) Wire the compile-time flag

Tell your test runner to inline `__TEST__ = true` and your production build to inline `__TEST__ = false`.

#### Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
  define: { __TEST__: true }, // enables probe during tests
})
```

#### Production build (pick one)

**Vite**

```ts
// vite.config.ts
export default {
  define: { __TEST__: false }, // lets tree-shaking drop probeEmit calls
}
```

**tsup**

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'
export default defineConfig({
  define: { __TEST__: 'false' },
  minify: true,
})
```

**esbuild**

```bash
esbuild src/index.ts --bundle --minify --format=esm \
  --define:__TEST__=false --outfile=dist/index.js
```

**Rollup**

```ts
import replace from '@rollup/plugin-replace'
export default {
  // ...
  plugins: [replace({ preventAssignment: true, values: { __TEST__: 'false' } })],
}
```

> **Heads-up:** `tsc` alone does **not** remove calls. Use a bundler/minifier (above), or see “TS-only builds” below.

---

### 2) Instrument your code

```ts
// src/my-service.ts
import { probeEmit } from 'vitest-probe'

export class MyService {
  async doStuff(n: number) {
    const mid = n * 2
    __TEST__ && probeEmit('mid', mid)   // stripped in prod

    await new Promise(r => setTimeout(r, 5))

    const done = mid + 1
    __TEST__ && probeEmit('done', done) // stripped in prod
    return done
  }
}
```

> The `__TEST__ &&` guard helps bundlers drop the entire statement.

### 3) Consume emissions in tests (parallel-safe)

```ts
// tests/my-service.test.ts
import { it, expect } from 'vitest'
import { MyService } from '../src/my-service'
import { getProbe } from 'vitest-probe'

it.concurrent('emits scoped values', async () => {
  const svc = new MyService()
  const probe = getProbe<{ label: 'mid'|'done'; value: number }>({ timeoutMs: 200 })

  await probe.run(async () => {
    const p = svc.doStuff(10)
    expect(await probe.next()).toEqual({ label: 'mid',  value: 20 })
    expect(await probe.next()).toEqual({ label: 'done', value: 21 })
    await p
  })

  probe.dispose()
})
```

Each `getProbe()` instance uses a unique `AsyncLocalStorage` scope; only emissions produced within its `probe.run(...)` block are delivered to that probe—so `it.concurrent(...)` stays clean.

---

## API

### `probeEmit(label, value): void`

Emit an observation. Purely side-effect-free; safe to remove without changing behavior. In production builds (with `__TEST__ = false`), calls are eliminated by DCE.

```ts
import { probeEmit } from 'vitest-probe'
probeEmit('parse:tokens', tokens)
```

Tips

* Treat labels as a **typed union** in your module for refactor safety:

  ```ts
  export type ParseLabel = 'parse:tokens'|'parse:ast'|'parse:done'
  ```
* Avoid emitting secrets/PII. Redact if needed.

---

### `getProbe(options?): Probe`

Create a probe bound to a unique async scope.

Options:

* `timeoutMs?: number` – default timeout for `next()` (default **1000ms**).
* `filter?: (e) => boolean` – per-probe filter for events.
* `bufferSize?: number` – max buffered events (**100**). Oldest are dropped if exceeded.

Returns a **Probe**:

#### `await probe.next(timeoutMs?)`

Resolves with the next `{ label, value }` emitted within the probe’s scope. Rejects on timeout.

```ts
const e = await probe.next()       // uses default timeout
const e2 = await probe.next(500)   // override per call
```

#### `probe.run(fn)`

Run `fn` inside the probe’s `AsyncLocalStorage` scope. Only emissions within this call chain are delivered to this probe.

```ts
await probe.run(async () => {
  await svc.doWork()
})
```

> **Do not** nest different probes’ `run()` around the same code region; only the innermost scope receives events.

#### `probe[Symbol.asyncIterator]()`

Use as an async iterator (infinite; prefer `next()` with explicit expectations):

```ts
for await (const e of probe) {
  // break once you’ve asserted what you need
  break
}
```

#### `probe.dispose()`

Unsubscribe and reject any pending `next()` calls. Call in `afterEach()` to avoid leaks.

---

## Patterns & examples

### Filter by label

```ts
const probe = getProbe({ filter: e => e.label === 'ast', timeoutMs: 200 })
await probe.run(async () => {
  await parser.parse('a,b,c')
  expect(await probe.next()).toEqual({ label: 'ast', value: expect.any(Object) })
})
probe.dispose()
```

### Parallel tests

```ts
it.concurrent('A', async () => {
  const probe = getProbe({ timeoutMs: 200 })
  await probe.run(async () => {
    await svc.doStuff(10)
    expect(await probe.next()).toEqual({ label: 'mid', value: 20 })
  })
  probe.dispose()
})

it.concurrent('B', async () => {
  const probe = getProbe({ timeoutMs: 200 })
  await probe.run(async () => {
    await svc.doStuff(5)
    expect(await probe.next()).toEqual({ label: 'mid', value: 10 })
  })
  probe.dispose()
})
```

### Typed labels, end-to-end

```ts
// src/math.ts
export type MathLabel = 'integrate:area'|'integrate:sum'
export function integrate(...) {
  __TEST__ && probeEmit<MathLabel, unknown>('integrate:sum', acc)
}
```

```ts
// tests/math.test.ts
const probe = getProbe<{ label: MathLabel; value: number }>()
```

---

## TS-only builds (no bundler)

If you don’t bundle/minify your production output, the simplest approach is to keep calls but make them cheap no-ops:

```ts
// This package already no-ops when __TEST__ is false.
// Ensure __TEST__ exists (as a global ambient type) to keep TypeScript happy:
declare const __TEST__: boolean
```

Or use **path swapping** to import a noop module in prod:

```
src/testing/test-probe.ts        // real
src/testing/test-probe.noop.ts   // noop
```

```ts
// tsconfig.test.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "vitest-probe": ["src/testing/test-probe.ts"] }
  }
}
// tsconfig.prod.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "vitest-probe": ["src/testing/test-probe.noop.ts"] }
  }
}
```

---

## FAQ

**Q: Will this work under `jsdom`?**
Yes—Vitest’s `environment: 'node'` is recommended. `jsdom` tests still run in Node; `AsyncLocalStorage` works.

**Q: Does `tsc` remove `probeEmit()`?**
No. Use a bundler/minifier with `define { __TEST__: false }` for DCE, or accept no-op calls in prod.

**Q: What about worker threads / child processes?**
Each Node process/thread has its own subscriber set and `AsyncLocalStorage`. If you spawn workers, they’ll need their own probes (usual test isolation applies).

**Q: Is putting `probeEmit()` in source “OK”?**
Yes, if it’s compile-time gated, side-effect free, and scoped. Treat it like `assert()` or a tracepoint.


## TypeScript types

This package is written in TypeScript and ships types. You can narrow labels via generics:

```ts
const probe = getProbe<{ label: 'ast'|'done'; value: unknown }>()
```

---

## License

MIT © Nicola Dal Pont
