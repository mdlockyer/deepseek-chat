import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

Object.assign(globalThis, {
  __API_ORIGIN__: 'https://api.deepseek.com',
  __PYODIDE_LOCAL__: false,
})

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
})
