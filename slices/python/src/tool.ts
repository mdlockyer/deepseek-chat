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

const NATIVE_DESCRIPTION =
  'Run Python code in a persistent sandboxed Python 3 REPL on the local machine. Variables, imports, and functions persist across calls; returns stdout/stderr, trailing expression repr, traceback, and any images/files.'

const WEB_DESCRIPTION =
  "Run Python code in a persistent Python 3 REPL (Pyodide, running in the user's browser). Variables, imports, and functions persist across calls; returns stdout/stderr, trailing expression repr, traceback, and any images/files."

const PYTHON_SHARED_INSTRUCTIONS = [
  'Any matplotlib figure or object passed to `show(img, ...)` (PIL image, numpy array, image bytes, file path, or figure) is shown to the user and attached back to you right after the tool result (up to 6 images per call, downscaled to 1024 px; convert OpenCV BGR arrays to RGB first; older images may be dropped in later turns to keep requests compact, so call `show()` again if needed).',
  'To give the user a generated file (CSV, PNG, PDF, etc.), write it to disk and call Python’s `present_file(path, name=None, mime_type=None)`. It appears as a downloadable card in chat (at most 10 files of 50 MB each per call) and opens in File Preview when supported. Put independent calculation steps in one call.',
]

export const buildPythonInstructions = (engine: 'native' | 'web'): string =>
  [
    'Python (`python`):',
    engine === 'native'
      ? 'You have a persistent, sandboxed local Python 3 REPL: variables, imports, and functions stay alive across calls in this conversation, and top-level `await` works. By design, the sandbox has no network access, no shell/subprocess execution, and no access to the user’s filesystem outside its per-session scratch directory and a read-only `uploads/` folder (which automatically mounts both user attachments and your latest presented files; check `os.listdir("uploads")`).'
      : 'You have a persistent Python 3 REPL running locally in the browser via Pyodide: variables, imports, and functions stay alive across calls, and top-level `await` works. `numpy`, `pandas`, `scipy`, `sympy`, `matplotlib`, and other Pyodide packages auto-load; install pure-Python packages with `import micropip; await micropip.install("name")`. There is no shell, subprocess, or host filesystem access, and HTTP goes through the browser via `from pyodide.http import pyfetch` (CORS applies).',
    ...PYTHON_SHARED_INSTRUCTIONS,
  ].join('\n')

export const buildPythonTool = (engine: 'native' | 'web'): PythonToolDefinition => ({
  name: PYTHON_TOOL_NAME,
  description: engine === 'native' ? NATIVE_DESCRIPTION : WEB_DESCRIPTION,
  input_schema: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', description: 'Python code to run.' } },
  },
})
