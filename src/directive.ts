// probe-directive.ts
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import path from 'node:path'

export interface ProbeDirectiveOptions {
  /** Local identifier used for calls (default: '__PROBE__') */
  probeIdent?: string
  /** Write as `// #probe(...)` by default; override token if you like */
  directive?: string
  /** Limit transformed files: string | RegExp | (id)=>boolean; default: <cwd>/src/** */
  include?: string | RegExp | ((id: string) => boolean)
  /** Additional exclusions: RegExp | (id)=>boolean; default excludes node_modules + virtual ids */
  exclude?: RegExp | ((id: string) => boolean)
  /** Keep default excludes (node_modules + virtual) even when exclude is provided. Default: true */
  keepDefaultExcludes?: boolean
}

const extsRE = /\.(m|c)?(t|j)sx?$/
const norm = (p: string) => p.replace(/\\/g, '/')
const isVirtual = (id: string) => id.startsWith('\0') || id.includes('?')
const cleanId = (id: string) => id.split('?')[0]

export default createUnplugin((opts: ProbeDirectiveOptions = {}) => {
  const probeIdent = opts.probeIdent ?? '__PROBE__'
  const directive = opts.directive ?? '#probe'
  const cwd = norm(process.cwd())

  // include predicate
  let includePred: (id: string) => boolean
  if (typeof opts.include === 'function') {
    includePred = opts.include
  } else if (opts.include instanceof RegExp) {
    const re = opts.include
    includePred = (id) => re.test(norm(id))
  } else if (typeof opts.include === 'string') {
    const base = norm(path.isAbsolute(opts.include) ? opts.include : path.join(cwd, opts.include))
    const baseWithSlash = base.endsWith('/') ? base : base + '/'
    includePred = (id) => extsRE.test(id) && norm(id).startsWith(baseWithSlash)
  } else {
    const base = norm(path.join(cwd, 'src') + '/')
    includePred = (id) => extsRE.test(id) && norm(id).startsWith(base)
  }

  // default excludes
  const defaultExcludePred = (id: string) =>
    norm(id).includes('/node_modules/') || isVirtual(id)

  // user excludes
  const userExcludePred: (id: string) => boolean =
    opts.exclude
      ? (opts.exclude instanceof RegExp
          ? (id) => (opts.exclude as RegExp).test(norm(id))
          : (opts.exclude as (id: string) => boolean))
      : () => false

  // final exclude predicate (additive by default)
  const keepDefaults = opts.keepDefaultExcludes ?? true
  const excludePred = keepDefaults
    ? (id: string) => defaultExcludePred(id) || userExcludePred(id)
    : userExcludePred

  // full-line directive:  // #probe('label', expr)
  const lineRe = new RegExp(
    String.raw`^(\s*)\/\/\s*${directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\(([\s\S]*?)\)\s*;?\s*$`,
    'gm'
  )

  // prevent duplicate import per file across multiple transform passes
  const injected = new Set<string>()

  return {
    name: 'probe-directive',
    enforce: 'pre',

    transform(code, id) {
      if (!extsRE.test(id)) return
      if (!includePred(id) || excludePred(id)) return

      let mutated = false
      const s = new MagicString(code)

      for (let m; (m = lineRe.exec(code)); ) {
        mutated = true
        const indent = m[1] ?? ''
        const args = m[2] ?? ''
        s.overwrite(m.index, lineRe.lastIndex, `${indent}${probeIdent}(${args});`)
      }

      if (!mutated) return

      const cid = cleanId(id)
      if (!injected.has(cid)) {
        const shebangEnd = code.startsWith('#!') ? (code.indexOf('\n') + 1 || 0) : 0
        s.appendLeft(shebangEnd, `import { probeEmit as ${probeIdent} } from 'vitest-probe';\n`)
        injected.add(cid)
      }

      return { code: s.toString(), map: s.generateMap({ hires: true }) }
    },
  }
})
