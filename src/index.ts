import { AsyncLocalStorage } from 'node:async_hooks'

export type ProbeEvent<L extends string = string, V = unknown> = {
  label: L
  value: V
}

// Compile-time constant. Set to true in vitest config; false in prod builds.
declare const __TEST__: boolean

type InternalEvent = ProbeEvent & { __scope?: symbol }
type Subscriber = (e: InternalEvent) => void

let subscribers: Set<Subscriber> | undefined
const als = new AsyncLocalStorage<{ scope: symbol }>()

const currentScope = () => als.getStore()?.scope

// --- probeEmit ---------------------------------------------------------------
let _emitImpl: <L extends string, V>(label: L, value: V) => void
if (__TEST__) {
  _emitImpl = (label, value) => {
    if (!subscribers || subscribers.size === 0) return
    const e: InternalEvent = { label, value, __scope: currentScope() }
    for (const s of subscribers) {
      try { s(e) } catch { /* swallow to not break others */ }
    }
  }
} else {
  _emitImpl = () => { /* no-op in prod */ }
}

/** Call inside your app code. Stripped in prod builds. */
export const probeEmit = _emitImpl

// --- getProbe (scoped, timeout-safe) ----------------------------------------
export function getProbe<L extends string = string, V = unknown>(opts?: {
  /** Default per-item timeout (ms). Default 1000. */
  timeoutMs?: number
  /** Filter which events this probe receives. */
  filter?: (e: ProbeEvent<L, V>) => boolean
  /** Max buffered events (oldest dropped when exceeded). Default 100. */
  bufferSize?: number
}) {
  if (!__TEST__) {
    const fail = async () => { throw new Error('getProbe() used outside tests') }
    return {
      next: fail as (timeoutMs?: number) => Promise<ProbeEvent<L, V>>,
      dispose() {/* noop */},
      run<T>(fn: () => T | Promise<T>) { return fn() },
      [Symbol.asyncIterator]() { return { next: fail } as AsyncIterator<ProbeEvent<L, V>> },
    } as const
  }

  if (!subscribers) subscribers = new Set()

  const bufferSize = opts?.bufferSize ?? 100
  const timeoutDefault = opts?.timeoutMs ?? 1000
  const scope = Symbol('probe-scope')
  const queue: ProbeEvent<L, V>[] = []
  const pending: Array<{
    resolve: (e: ProbeEvent<L, V>) => void
    reject: (err: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  const sub: Subscriber = (e) => {
    if (e.__scope !== scope) return
    const ev = { label: e.label as L, value: e.value as V }
    if (opts?.filter && !opts.filter(ev)) return
    const p = pending.shift()
    if (p) { clearTimeout(p.timer); p.resolve(ev) }
    else { if (queue.length >= bufferSize) queue.shift(); queue.push(ev) }
  }

  subscribers.add(sub)

  const next = (timeoutMs?: number) =>
    new Promise<ProbeEvent<L, V>>((resolve, reject) => {
      if (queue.length) { resolve(queue.shift() as ProbeEvent<L, V>); return }
      const ms = timeoutMs ?? timeoutDefault
      const timer = setTimeout(() => {
        const i = pending.findIndex(x => x.resolve === resolve)
        if (i !== -1) pending.splice(i, 1)
        reject(new Error(`Probe timeout after ${ms}ms`))
      }, ms)
      pending.push({ resolve, reject, timer })
    })

  const dispose = () => {
    subscribers?.delete(sub)
    for (const p of pending.splice(0)) { clearTimeout(p.timer); p.reject(new Error('Probe disposed')) }
    queue.length = 0
  }

  /** Run your code under this probe’s async scope (isolates parallel tests). */
  const run = <T>(fn: () => T | Promise<T>) => als.run({ scope }, fn)

  const asyncIterator: AsyncIterator<ProbeEvent<L, V>> = {
    next: async () => ({ value: await next(), done: false }),
  }

  return {
    next,
    dispose,
    run,
    [Symbol.asyncIterator]: () => asyncIterator,
  } as const
}
