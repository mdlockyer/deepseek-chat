import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
/** 开发诊断：流式请求时序的落盘位置，见 devServer.setupMiddlewares */
const STREAM_TRACE_FILE = path.join(tmpdir(), 'deepseek-chat-stream-trace.jsonl')
/**
 * PYODIDE_LOCAL=1 ships Pyodide with the build (dist/pyodide/, from vendor/pyodide/ prepared by
 * scripts/fetch-pyodide.mjs). The desktop app sets it; the web build loads Pyodide from jsDelivr.
 */
const pyodideLocal = process.env.PYODIDE_LOCAL === '1'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

/** 轨迹只含大小与时间，远小于此；超过即拒绝 */
const STREAM_TRACE_MAX_BYTES = 64 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 开发诊断端点：开发服务器监听所有网卡，只接受本机的 POST，请求体须为不超过上限的 JSON，
 * 作为一行交给 `append`。
 */
export const createStreamTraceHandler =
  (append: (line: string) => void) => (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number) => {
      res.statusCode = status
      res.end()
    }
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      reply(403)
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      reply(405)
      return
    }
    let body = ''
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) {
        return
      }
      body += chunk.toString('utf8')
      if (body.length > STREAM_TRACE_MAX_BYTES) {
        tooLarge = true
        body = ''
        reply(413)
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        return
      }
      try {
        // 重新序列化：只写入合法的 JSON，且保证一行
        append(`${JSON.stringify(JSON.parse(body))}\n`)
      } catch {
        reply(400)
        return
      }
      reply(204)
    })
  }

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './app/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    // ModuleWorker runs workers with `{ type: 'module' }`, where `importScripts` throws.
    workerChunkLoading: 'import',
    clean: true,
  },
  optimization: {
    // Keep dev-server / HMR modules inline inside the worker instead of splitting a JSONP vendor
    // chunk shared with `main`, while keeping normal async chunk splitting for `main`.
    splitChunks: {
      chunks: (chunk) =>
        !chunk.canBeInitial() && [...chunk.runtime].every((name) => name === 'main'),
    },
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: {
      'css/module': { namedExports: false },
      // `new ModuleWorker(new URL(...))` bundles a worker like `new Worker(...)`. rspack rewrites
      // `{ type: 'module' }` to `{ type: undefined }` for `new Worker`, but Pyodide refuses classic
      // workers, so ModuleWorker (slices/python/src/module-worker.ts) forces type 'module' itself.
      // The specifier must match the import in kernel.ts exactly.
      javascript: { worker: ['ModuleWorker from ./module-worker.js', '...'] },
    },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './app/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __PYODIDE_LOCAL__: JSON.stringify(pyodideLocal),
      __DEV__: JSON.stringify(dev),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        ...(pyodideLocal ? [{ from: path.resolve(root, 'vendor/pyodide'), to: 'pyodide' }] : []),
      ],
    }),
  ],
  performance: { hints: false },
  devServer: {
    port: 8090,
    // 开发诊断：应用把每次流式请求的时序 POST 到这里，逐行追加到临时文件（只有大小与时间，没有内容）
    setupMiddlewares: (middlewares) => [
      {
        name: 'stream-trace',
        path: '/__dev/stream-trace',
        middleware: createStreamTraceHandler((line) => appendFileSync(STREAM_TRACE_FILE, line)),
      },
      ...middlewares,
    ],
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
