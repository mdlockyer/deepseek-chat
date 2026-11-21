/**
 * 始终以模块方式启动的 Worker：Pyodide 不支持经典 Worker，而 rspack 会把 new Worker 的
 * type 改成 undefined。rspack.config.ts 把 `ModuleWorker from ./module-worker.js` 登记为 Worker
 * 语法，所以 new ModuleWorker(new URL('./worker.ts', import.meta.url)) 同样会打包 worker.ts。
 * 导入路径必须与该登记完全一致。
 *
 * Declared as a function rather than `class extends Worker` so importing this module never touches
 * the `Worker` global: the slice's tests import it under Node, where `Worker` does not exist.
 */
export const ModuleWorker = function ModuleWorker(url: URL, options?: WorkerOptions): Worker {
  return new Worker(url, { ...options, type: 'module' })
} as unknown as new (url: URL, options?: WorkerOptions) => Worker
