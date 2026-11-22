export type PreviewKind =
  | 'html'
  | 'markdown'
  | 'mermaid'
  | 'svg'
  | 'image'
  | 'table'
  | 'code'
  | 'pdf'
  | 'binary'

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  mmd: 'text/vnd.mermaid',
  mermaid: 'text/vnd.mermaid',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  json5: 'application/json',
  jsonl: 'application/json',
  geojson: 'application/geo+json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/tsx',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  py: 'text/x-python',
  pyw: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cc: 'text/x-c++',
  cs: 'text/x-csharp',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  sql: 'application/sql',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  xsl: 'application/xml',
  plist: 'application/xml',
  txt: 'text/plain',
  log: 'text/plain',
  ini: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  tex: 'application/x-tex',
  pdf: 'application/pdf',
}

const CODE_LANG_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  json5: 'json',
  jsonl: 'json',
  geojson: 'json',
  css: 'css',
  scss: 'scss',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  tex: 'latex',
  r: 'r',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  dart: 'dart',
  lua: 'lua',
  scala: 'scala',
  graphql: 'graphql',
  gql: 'graphql',
  hs: 'haskell',
  pl: 'perl',
  m: 'matlab',
  nginx: 'nginx',
  proto: 'protobuf',
  objc: 'objectivec',
  mm: 'objectivec',
}

const TEXT_EXTS = new Set([
  ...Object.keys(CODE_LANG_BY_EXT),
  'txt',
  'log',
  'csv',
  'tsv',
  'conf',
  'cfg',
  'env',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'properties',
  'lock',
])

const RASTER_IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
])

export const getFileExtLower = (name: string): string => {
  const base = name.split('/').pop() ?? name
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile') {
    return lower
  }
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

export const inferMimeType = (pathOrName: string, explicitMime?: string | null): string => {
  const cleaned = explicitMime?.split(';')[0]?.trim().toLowerCase()
  if (cleaned && cleaned !== 'application/octet-stream') {
    return cleaned
  }
  const ext = getFileExtLower(pathOrName)
  return MIME_BY_EXT[ext] ?? cleaned ?? 'application/octet-stream'
}

export const classifyPreviewKind = (name: string, mimeType: string): PreviewKind => {
  const ext = getFileExtLower(name)
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''

  if (ext === 'html' || ext === 'htm' || mime === 'text/html') {
    return 'html'
  }
  if (ext === 'svg' || mime === 'image/svg+xml') {
    return 'svg'
  }
  if (ext === 'mmd' || ext === 'mermaid' || mime === 'text/vnd.mermaid') {
    return 'mermaid'
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || mime === 'text/markdown') {
    return 'markdown'
  }
  if (
    ext === 'csv' ||
    ext === 'tsv' ||
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values'
  ) {
    return 'table'
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return 'pdf'
  }
  if (RASTER_IMAGE_EXTS.has(ext) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) {
    return 'image'
  }
  if (
    TEXT_EXTS.has(ext) ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/geo+json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript' ||
    mime === 'application/sql' ||
    mime === 'application/yaml' ||
    mime === 'application/toml' ||
    mime === 'application/x-sh'
  ) {
    return 'code'
  }
  return 'binary'
}

export const supportsPreviewToggle = (kind: PreviewKind): boolean =>
  kind === 'html' || kind === 'markdown' || kind === 'mermaid' || kind === 'svg' || kind === 'table'

export const isTextPreviewKind = (kind: PreviewKind): boolean =>
  kind === 'html' ||
  kind === 'markdown' ||
  kind === 'mermaid' ||
  kind === 'svg' ||
  kind === 'table' ||
  kind === 'code'

export const getCodeLanguage = (name: string, mimeType: string): string => {
  const ext = getFileExtLower(name)
  if (Object.hasOwn(CODE_LANG_BY_EXT, ext)) {
    return CODE_LANG_BY_EXT[ext]
  }
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === 'application/json' || mime.endsWith('+json')) {
    return 'json'
  }
  if (mime === 'application/xml' || mime.endsWith('+xml')) {
    return 'xml'
  }
  if (mime === 'text/html') {
    return 'html'
  }
  if (mime === 'text/css') {
    return 'css'
  }
  if (mime === 'text/javascript' || mime === 'application/javascript') {
    return 'javascript'
  }
  if (mime === 'text/typescript' || mime === 'application/typescript') {
    return 'typescript'
  }
  if (mime === 'text/markdown') {
    return 'markdown'
  }
  return 'text'
}

export const getTableDelimiter = (name: string, mimeType: string): string => {
  const ext = getFileExtLower(name)
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return ext === 'tsv' || mime === 'text/tab-separated-values' ? '\t' : ','
}

/** RFC-4180 compliant delimited parser (handles quotes, escaped "", and CRLF/LF inside quotes) */
export const parseDelimitedText = (
  input: string,
  delimiter = ',',
  maxRows = 2_000
): { headers: string[]; rows: string[][]; truncated: boolean } => {
  const text = input.replace(/^\uFEFF/, '')
  const allRows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let truncated = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++
      }
      row.push(cell)
      cell = ''
      if (row.length > 1 || row[0] !== '') {
        allRows.push(row)
        // 表头不计入行数上限
        if (allRows.length > maxRows + 1) {
          truncated = true
          break
        }
      }
      row = []
      continue
    }
    cell += ch
  }

  if (!truncated && (cell.length > 0 || row.length > 0)) {
    row.push(cell)
    if (row.length > 1 || row[0] !== '') {
      allRows.push(row)
    }
  }

  if (allRows.length === 0) {
    return { headers: [], rows: [], truncated: false }
  }
  const [first, ...rest] = allRows
  const colCount = Math.max(first.length, ...rest.map((r) => r.length))
  const pad = (r: string[]) =>
    r.length < colCount ? [...r, ...Array<string>(colCount - r.length).fill('')] : r

  return {
    headers: pad(first),
    rows: rest.slice(0, maxRows).map(pad),
    truncated: truncated || rest.length > maxRows,
  }
}
