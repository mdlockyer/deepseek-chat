/**
 * Python 内核 Worker：Pyodide 跑在这里，所有代码共用一个持久的 __main__ 命名空间。
 * 主线程先发 { type: 'init', indexURL } 指明 Pyodide 的位置（随应用打包的本地目录或 CDN），
 * 之后每条 { id, code } 执行一段代码，回复格式见 kernel.ts 的 WorkerReply。
 */

type PyProxy = { toJs: () => unknown; destroy: () => void }
type Pyodide = {
  loadPackage: (names: string | string[], options?: object) => Promise<unknown>
  loadPackagesFromImports: (code: string, options?: object) => Promise<unknown>
  runPythonAsync: (code: string) => Promise<unknown>
  globals: { get: (name: string) => (code: string) => Promise<PyProxy> }
}
type PresentedTuple = [string, string, Uint8Array]

const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent) => void) | null
}

const BOOT = `
import sys, os, io, base64, traceback
os.environ.setdefault('MPLBACKEND', 'Agg')
from pyodide.code import eval_code_async

__main_ns = {'__name__': '__main__', '__builtins__': __builtins__}

def __fmt_error(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != '<cell>':
        tb = tb.tb_next
    return ''.join(traceback.format_exception(type(e), e, tb))

__shown = []
__MAX_IMAGES = 6

def __to_pil(obj):
    from PIL import Image
    if isinstance(obj, Image.Image):
        return obj
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return Image.open(io.BytesIO(bytes(obj)))
    if isinstance(obj, (str, os.PathLike)):
        return Image.open(obj)
    if hasattr(obj, 'savefig'):
        buf = io.BytesIO()
        obj.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)
        return Image.open(buf)
    if hasattr(obj, '__array__'):
        import numpy as np
        a = np.asarray(obj)
        if a.dtype != np.uint8:
            a = a.astype('float64')
            lo, hi = float(a.min()), float(a.max())
            a = ((a - lo) / ((hi - lo) or 1) * 255).astype(np.uint8)
        if a.ndim == 3 and a.shape[2] == 1:
            a = a[:, :, 0]
        return Image.fromarray(a)
    raise TypeError('show() takes a PIL image, numpy array, image bytes, file path or matplotlib figure, not ' + type(obj).__name__)

def __encode(img, max_side=1024):
    img = img.copy()
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()

def show(*images, max_side=1024):
    '''Attach images to this call's result so the model (and the user) can see them.'''
    for obj in images:
        __shown.append(__encode(__to_pil(obj), max_side))

__main_ns['show'] = show

__presented = []
__MAX_FILES = 10
__MAX_FILE_BYTES = 50 * 1024 * 1024

def present_file(path, name=None, mime_type=None):
    '''Offer a file from the Python filesystem to the user as a download.'''
    import mimetypes
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) > __MAX_FILE_BYTES:
        raise ValueError('present_file: ' + str(path) + ' is ' + str(len(data)) + ' bytes; the limit is 50 MB')
    if len(__presented) >= __MAX_FILES:
        raise ValueError('present_file: at most 10 files per call')
    name = name or os.path.basename(str(path)) or 'file'
    mime_type = mime_type or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    __presented.append([name, mime_type, data])
    return name + ' (' + str(len(data)) + ' bytes) is ready for the user to download'

__main_ns['present_file'] = present_file

def __collect_figures():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return []
    import warnings
    images = []
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        for num in plt.get_fignums():
            images.append(__encode(__to_pil(plt.figure(num))))
    plt.close('all')
    return images

async def __run_cell(code):
    __shown.clear()
    __presented.clear()
    result = None
    error = None
    try:
        value = await eval_code_async(code, __main_ns, filename='<cell>')
        if value is not None:
            __main_ns['_'] = value
            result = repr(value)
    except BaseException as e:
        error = __fmt_error(e)
    try:
        images = __shown + __collect_figures()
    except BaseException as e:
        images = list(__shown)
        error = (error or '') + __fmt_error(e)
    dropped = max(0, len(images) - __MAX_IMAGES)
    return [result, error, images[:__MAX_IMAGES], dropped, list(__presented)]
`

const quiet = { messageCallback: () => {}, errorCallback: () => {} }
let out: string[] = []
let ready: Promise<Pyodide> | null = null
let executionQueue: Promise<void> = Promise.resolve()

const start = (indexURL: string): Promise<Pyodide> =>
  (async () => {
    const { loadPyodide } = (await import(/* webpackIgnore: true */ `${indexURL}pyodide.mjs`)) as {
      loadPyodide: (options: object) => Promise<Pyodide>
    }
    const py = await loadPyodide({
      indexURL,
      stdout: (text: string) => out.push(`${text}\n`),
      stderr: (text: string) => out.push(`${text}\n`),
    })
    await py.loadPackage('micropip', quiet)
    await py.runPythonAsync(BOOT)
    return py
  })()

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const runCell = async (id: number, code: string) => {
  let py: Pyodide
  try {
    if (!ready) {
      throw new Error('kernel was not initialised')
    }
    py = await ready
  } catch (error) {
    scope.postMessage({ id, ok: false, error: `Failed to start Python: ${errorText(error)}` })
    return
  }
  out = []
  try {
    // 自动加载代码 import 到的 Pyodide 内置包（numpy、pandas、matplotlib 等）
    await py.loadPackagesFromImports(code, quiet)
    // show() 依赖 Pillow，代码里没有 import 时也要加载
    if (/\bshow\s*\(/.test(code)) {
      await py.loadPackage('Pillow', quiet)
    }
  } catch {
    // 加载失败时照常执行，import 报错会出现在结果里
  }
  scope.postMessage({ id, phase: 'running' })
  try {
    const proxy = await py.globals.get('__run_cell')(code)
    const [result, error, images, dropped, presented] = proxy.toJs() as [
      string | null,
      string | null,
      string[],
      number,
      PresentedTuple[],
    ]
    proxy.destroy()
    // bytes 经 toJs 转为 Uint8Array，转移给主线程避免复制
    const files = presented.map(([name, mimeType, bytes]) => ({ name, mimeType, data: bytes }))
    scope.postMessage(
      { id, ok: true, stdout: out.join(''), result, error, images, dropped, files },
      files.map((file) => file.data.buffer as ArrayBuffer)
    )
  } catch (error) {
    scope.postMessage({
      id,
      ok: true,
      stdout: out.join(''),
      result: null,
      error: errorText(error),
      images: [],
    })
  }
}

scope.onmessage = ({ data }: MessageEvent) => {
  if (data.type === 'init') {
    ready ??= start(data.indexURL as string)
    return
  }
  const { id, code } = data as { id: number; code: string }
  // 串行执行每个 cell，避免多个 async onmessage 交错污染 out 与 Python 全局状态。
  executionQueue = executionQueue.then(
    () => runCell(id, code),
    () => runCell(id, code)
  )
}
