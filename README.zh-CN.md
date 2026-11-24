# deepseek-chat

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 构建的 DeepSeek API 桌面端与网页客户端，使用 [Tauri 2](https://v2.tauri.app/) 打包，并为模型提供浏览器内运行的 Python REPL 工具。

[English](README.md) | 简体中文

使用前需在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 申请自己的 API Key。对话与附件保存在本地 IndexedDB，请求直接发送至 `api.deepseek.com`。

## 下载安装

签名并公证的 macOS 通用版（Apple Silicon 与 Intel，`DeepSeek.app`）`.dmg` 安装包发布在 [GitHub Releases](https://github.com/mdlockyer/deepseek-chat/releases)。

暂未提供 Windows 与 Linux 的预构建安装包，需要从源码构建。

## 本地运行

需要 Node.js 22.12+ 与 pnpm；构建桌面版还需 Rust 1.90+。

```sh
git clone https://github.com/mdlockyer/deepseek-chat.git
cd deepseek-chat
pnpm install
```

以开发模式运行桌面应用：

```sh
pnpm desktop:dev
```

或仅在浏览器中运行（`http://localhost:8090`）：

```sh
pnpm dev
```

生成桌面发布包（输出位于 `src-tauri/target/release/bundle/`）：

```sh
pnpm desktop:build
```

## 说明

开启深度思考后，模型可使用运行在 Web Worker 中的持久化 Python 3 环境（基于 Pyodide）。桌面版内置 `numpy`、`pandas`、`matplotlib`、`Pillow` 与 `micropip`，其他纯 Python 包会在联网时从 jsDelivr 加载；`matplotlib` 图像会内联展示并回传给模型，通过 `present_file()` 导出的文件会触发系统保存对话框。

在桌面版中，API 请求通过 `tauri-plugin-http` 发出以绕过 webview 的 CORS 限制，外部链接在系统默认浏览器中打开，macOS 下可通过 `Cmd+,` 打开设置，API Key 保存在 `~/Library/Application Support/com.mlockyer.deepseekchat/api-key`（`0600` 权限）而非 `localStorage`。

联网搜索（`web_search`）由 [Firecrawl](https://www.firecrawl.dev/) 提供，默认使用无密钥免费每日额度即可开箱使用，也可在设置中添加可选的 Firecrawl API Key 以获得更高限额（桌面端同样保存在 `~/Library/Application Support/com.mlockyer.deepseekchat/` 中）。桌面端的网页读取（`web_scrape`）完全在本地完成（Rust 原生 HTTP + Markdown 协商、多字符集 Readability 正文提取与本地文本型 PDF 解析，遇到纯前端 JS 渲染页面时回退到隔离的隐身子 WebView，并内置 SSRF 内网地址拦截），不消耗 Firecrawl 额度；网页版继续通过 Firecrawl 读取页面。

其余功能与上游一致：多分支对话、附件上传、语音输入、朗读、KaTeX、Mermaid 图表、浅色/深色主题、中英文界面以及 ZIP 历史导出导入。

## 常用命令

```sh
pnpm test          # 运行单元测试
pnpm type          # TypeScript 类型检查
pnpm lint          # oxlint 检查
pnpm format        # oxfmt 格式化
pnpm build         # 构建静态网页到 dist/
```

如需接入其他 API 服务，可在 [rspack.config.ts](rspack.config.ts) 中向 `createConfig()` 传入 `apiOrigin`。

## 许可证

[MIT](LICENSE)
