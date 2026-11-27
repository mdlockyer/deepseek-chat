/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 是否随构建打包 Pyodide（dist/pyodide/），见 rspack.config.ts */
declare const __PYODIDE_LOCAL__: boolean

/** 开发构建（rspack serve）；生产构建为 false，相关代码被剔除 */
declare const __DEV__: boolean
