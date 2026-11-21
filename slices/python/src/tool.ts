export const PYTHON_TOOL_NAME = 'python'

/** Model-visible client tool definition (client tools carry no `type` field). */
export type PythonToolDefinition = {
  readonly name: typeof PYTHON_TOOL_NAME
  readonly description: string
  readonly input_schema: {
    readonly type: 'object'
    readonly required: readonly ['code']
    readonly properties: {
      readonly code: { readonly type: 'string'; readonly description: string }
    }
  }
}

const NATIVE_DESCRIPTION = [
  'Run Python code in a persistent sandboxed Python 3 REPL on the local machine.',
  'Variables, imports and functions persist between calls in this conversation; top-level `await` works.',
  'The result is stdout/stderr, then the repr of the trailing expression, then any traceback.',
  'You can see images: every matplotlib figure, and anything passed to `show(img, ...)` (a PIL image, numpy array, image bytes, file path or matplotlib figure), is sent to you as an image right after the tool result, and also shown to the user. Images are downscaled to 1024 px, at most 6 per call; OpenCV arrays are BGR, so convert with cv2.cvtColor first. Images from earlier calls may be dropped later to keep requests small; call show() again if you need them.',
  'To give the user a file, write it in the current working directory (e.g. out.csv) and call `present_file(path, name=None, mime_type=None)`; it appears as a download in the chat (at most 10 files of 50 MB each per call). You do not see the file contents through this.',
  'Files attached by the user in this conversation are mounted read-only in `uploads/` (check `os.listdir("uploads")`); you can read them directly with pandas, Pillow, csv, etc.',
  "The sandbox has no network access, no shell/subprocess execution, and no access to the user's files outside the per-session scratch workspace and read-only `uploads/`.",
  'Use it for calculation, data analysis, simulations and checking your work. Put independent steps in one call.',
].join(' ')

const WEB_DESCRIPTION = [
  "Run Python code in a persistent Python 3 REPL (Pyodide, running in the user's browser).",
  'Variables, imports and functions persist between calls in this conversation; top-level `await` works.',
  'The result is stdout/stderr, then the repr of the trailing expression, then any traceback.',
  'numpy, pandas, scipy, sympy, matplotlib and other Pyodide packages are imported automatically; install pure-Python packages with `import micropip; await micropip.install("name")`.',
  'You can see images: every matplotlib figure, and anything passed to `show(img, ...)` (a PIL image, numpy array, image bytes, file path or matplotlib figure), is sent to you as an image right after the tool result, and also shown to the user. Images are downscaled to 1024 px, at most 6 per call; OpenCV arrays are BGR, so convert with cv2.cvtColor first. Images from earlier calls may be dropped later to keep requests small; call show() again if you need them.',
  'To give the user a file, write it in the Python filesystem (e.g. /tmp/out.csv) and call `present_file(path, name=None, mime_type=None)`; it appears as a download in the chat (at most 10 files of 50 MB each per call). You do not see the file contents through this.',
  "There is no shell, no subprocess and no access to the user's files.",
  'HTTP goes through the browser: use `from pyodide.http import pyfetch` (CORS applies).',
  'Use it for calculation, data analysis, simulations and checking your work. Put independent steps in one call.',
].join(' ')

export const buildPythonTool = (engine: 'native' | 'web'): PythonToolDefinition => ({
  name: PYTHON_TOOL_NAME,
  description: engine === 'native' ? NATIVE_DESCRIPTION : WEB_DESCRIPTION,
  input_schema: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', description: 'Python code to run.' } },
  },
})
