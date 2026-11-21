import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Node test hooks:
 * - resolve `./x.js` to `./x.ts` / `./x.tsx` (the source uses .js specifiers, as rspack does);
 * - compile `.tsx` with rspack's bundled SWC (Node's type stripping does not handle JSX);
 * - stub CSS: `*.module.css` maps each class name to itself, plain `.css` is empty.
 */

const { experiments } = createRequire(import.meta.url)('@rspack/core')

Object.assign(globalThis, {
  __API_ORIGIN__: 'https://api.deepseek.com',
  __PYODIDE_LOCAL__: false,
})

const CSS_MODULE_STUB =
  'export default new Proxy({}, { get: (_target, name) => (typeof name === "string" ? name : undefined) })'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.startsWith('file:')
    ) {
      const target = new URL(specifier, context.parentURL)
      if (!existsSync(fileURLToPath(target))) {
        for (const ext of ['.ts', '.tsx']) {
          const candidate = new URL(`${specifier.slice(0, -3)}${ext}`, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) {
            return nextResolve(candidate.href, context)
          }
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) {
      return nextLoad(url, context)
    }
    if (url.endsWith('.module.css')) {
      return { format: 'module', source: CSS_MODULE_STUB, shortCircuit: true }
    }
    if (url.endsWith('.css')) {
      return { format: 'module', source: '', shortCircuit: true }
    }
    if (url.endsWith('.tsx')) {
      const filename = fileURLToPath(url)
      const { code } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
        filename,
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'automatic' } },
          target: 'es2022',
        },
        module: { type: 'es6' },
        sourceMaps: 'inline',
      })
      return { format: 'module', source: code, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
