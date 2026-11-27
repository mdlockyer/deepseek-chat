import ast
import asyncio
import base64
import contextlib
import inspect
import io
import json
import mimetypes
import os
import shutil
import signal
import sys
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")
mimetypes.init([])

REQ_FD = 3
RESP_FD = 4
MAX_IMAGES = 6
MAX_FILES = 10
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_STDOUT_CHARS = 200_000
RESULT_VAR = "__ds_cell_result__"

__main_ns = {"__name__": "__main__", "__builtins__": __builtins__}
__shown = []
__presented = []
__presented_dir = os.path.join(os.getcwd(), ".deepseek_presented")


class _CappedStringIO(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self._limit = limit
        self._written = 0
        self._truncated = False

    def write(self, s):
        if not s:
            return 0
        remaining = self._limit - self._written
        if remaining <= 0:
            self._truncated = True
            return len(s)
        if len(s) > remaining:
            super().write(s[:remaining])
            self._written += remaining
            self._truncated = True
            return len(s)
        super().write(s)
        self._written += len(s)
        return len(s)


def __fmt_error(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(e), e, tb))


def __to_pil(obj):
    from PIL import Image

    if isinstance(obj, Image.Image):
        return obj
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return Image.open(io.BytesIO(bytes(obj)))
    if isinstance(obj, (str, os.PathLike)):
        return Image.open(obj)
    if hasattr(obj, "savefig"):
        buf = io.BytesIO()
        obj.savefig(buf, format="png", bbox_inches="tight")
        buf.seek(0)
        return Image.open(buf)
    if hasattr(obj, "__array__"):
        import numpy as np

        a = np.asarray(obj)
        if a.dtype != np.uint8:
            a = a.astype("float64")
            lo, hi = float(a.min()), float(a.max())
            a = ((a - lo) / ((hi - lo) or 1) * 255).astype(np.uint8)
        if a.ndim == 3 and a.shape[2] == 1:
            a = a[:, :, 0]
        return Image.fromarray(a)
    raise TypeError(
        "show() takes a PIL image, numpy array, image bytes, file path or matplotlib figure, not "
        + type(obj).__name__
    )


def __encode(img, max_side=1024):
    img = img.copy()
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def show(*images, max_side=1024):
    """Attach images to this call's result so the model (and the user) can see them."""
    for obj in images:
        __shown.append(__encode(__to_pil(obj), max_side))


def present_file(path, name=None, mime_type=None):
    """Offer a file from the Python workspace to the user as a download."""
    src = os.fspath(path)
    st = os.stat(src)
    if st.st_size > MAX_FILE_BYTES:
        raise ValueError(
            f"present_file: {src} is {st.st_size} bytes; the limit is 50 MB"
        )
    if len(__presented) >= MAX_FILES:
        raise ValueError("present_file: at most 10 files per call")
    display_name = name or os.path.basename(src) or "file"
    guessed = mime_type or mimetypes.guess_type(display_name)[0] or "application/octet-stream"
    os.makedirs(__presented_dir, exist_ok=True)
    staged_name = f"{len(__presented):02d}_{os.path.basename(display_name)}"
    staged_path = os.path.join(__presented_dir, staged_name)
    shutil.copyfile(src, staged_path)
    __presented.append(
        {
            "name": display_name,
            "mimeType": guessed,
            "stagedPath": staged_path,
            "size": st.st_size,
        }
    )
    return f"{display_name} ({st.st_size} bytes) is ready for the user to download"


__main_ns["show"] = show
__main_ns["present_file"] = present_file


def __collect_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    import warnings

    images = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for num in plt.get_fignums():
            images.append(__encode(__to_pil(plt.figure(num))))
    plt.close("all")
    return images


def __compile_cell(code):
    tree = ast.parse(code, filename="<cell>", mode="exec")
    has_trailing_expr = False
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = tree.body.pop()
        assign = ast.Assign(
            targets=[ast.Name(id=RESULT_VAR, ctx=ast.Store())],
            value=last_expr.value,
        )
        tree.body.append(assign)
        ast.fix_missing_locations(tree)
        has_trailing_expr = True
    compiled = compile(
        tree,
        "<cell>",
        "exec",
        flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
    )
    return compiled, has_trailing_expr


def __run_cell(code, loop):
    __shown.clear()
    __presented.clear()
    if os.path.isdir(__presented_dir):
        shutil.rmtree(__presented_dir, ignore_errors=True)
    __main_ns.pop(RESULT_VAR, None)

    out_buf = _CappedStringIO(MAX_STDOUT_CHARS)
    result = None
    error = None
    interrupted = False

    try:
        compiled, has_trailing_expr = __compile_cell(code)
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(out_buf):
            coro = eval(compiled, __main_ns)
            if inspect.iscoroutine(coro):
                loop.run_until_complete(coro)
        if has_trailing_expr and RESULT_VAR in __main_ns:
            value = __main_ns.pop(RESULT_VAR)
            if value is not None:
                __main_ns["_"] = value
                result = repr(value)
    except KeyboardInterrupt as e:
        interrupted = True
        error = __fmt_error(e)
    except BaseException as e:
        error = __fmt_error(e)
    finally:
        __main_ns.pop(RESULT_VAR, None)

    try:
        images = __shown + __collect_figures()
    except BaseException as e:
        images = list(__shown)
        error = (error or "") + __fmt_error(e)

    dropped = max(0, len(images) - MAX_IMAGES)
    stdout = out_buf.getvalue()
    if out_buf._truncated:
        stdout += "\n… [stdout truncated by worker]"
    return {
        "stdout": stdout,
        "result": result,
        "error": error,
        "interrupted": interrupted,
        "images": images[:MAX_IMAGES],
        "dropped": dropped,
        "files": list(__presented),
    }


def __main():
    # Ensure SIGINT raises KeyboardInterrupt during cell execution.
    signal.signal(signal.SIGINT, signal.default_int_handler)

    req_file = os.fdopen(REQ_FD, "r", encoding="utf-8", buffering=1)
    resp_file = os.fdopen(RESP_FD, "w", encoding="utf-8", buffering=1)

    def send(payload):
        resp_file.write(json.dumps(payload, ensure_ascii=False) + "\n")
        resp_file.flush()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    send({"type": "ready", "pid": os.getpid()})

    while True:
        try:
            line = req_file.readline()
        except KeyboardInterrupt:
            # Stray SIGINT while idle between cells: ignore and keep waiting.
            continue
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        req_id = req["id"]
        code = req["code"]
        outcome = __run_cell(code, loop)
        outcome["id"] = req_id
        outcome["type"] = "result"
        send(outcome)

    try:
        loop.close()
    except Exception:
        pass


if __name__ == "__main__":
    __main()
