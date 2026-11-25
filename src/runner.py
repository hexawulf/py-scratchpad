"""Running the user's buffer inside Pyodide, in the two modes the UI offers.

This file is loaded as text (``?raw``) by ``src/pyodide.worker.ts`` and exec'd
once into the interpreter's globals, which defines ``pyscratch_run``. Every
later Run is one call of it. It is a separate file, not a string literal in the
worker, so ``tests/pyrunner.test.ts`` can load the identical source into the
``pyodide`` npm package under Node and check the behaviour there.

Three things make the output look like a terminal rather than like a sandbox:

**The two modes.** ``script`` compiles the whole buffer in ``exec`` mode, which
is what ``python3 file.py`` does: an expression on a line of its own produces
no output. ``repl`` compiles each *top-level statement* on its own in
``single`` mode — the mode the ``>>>`` prompt uses — so a bare expression goes
through :func:`sys.displayhook` and prints its ``repr``, while ``None`` prints
nothing. That is what makes an exercise file of bare arithmetic show its
answers. The default ``sys.displayhook`` already behaves exactly right, so
nothing here replaces it.

**One namespace per run.** Every call builds a fresh ``__main__``-shaped dict,
so a name defined by the last Run is gone — as it would be on a second
``python3 file.py``. Passing one dict as both globals and locals is also what
makes the ``repl`` mode behave like the prompt.

**Tracebacks that name the buffer.** The buffer is not a file, so three things
have to be arranged by hand: the filename is passed to :func:`compile`, the
source is registered in :mod:`linecache` so the offending line and its caret
can be shown, and the frames above the user's code — this module's ``exec``
call, and whatever Pyodide used to get here — are stripped off the front of
every traceback in the chain. What is left has the editor's own line numbers,
which is what makes a "line N" reference clickable in the output panel.
"""

import ast
import builtins
import linecache
import sys
import traceback

#: Modules that cannot exist in a browser tab, each with the reason in one
#: line. A raw ``ModuleNotFoundError`` traceback for ``import turtle`` tells a
#: beginner nothing about *why* it will never work here.
UNAVAILABLE_MODULES = {
    "tkinter": "tkinter needs a desktop window system, and a browser tab is not one — "
    "so there is no way to open a window here.",
    "_tkinter": "tkinter needs a desktop window system, and a browser tab is not one — "
    "so there is no way to open a window here.",
    "turtle": "turtle draws through tkinter, which needs a desktop window system — "
    "so turtle graphics cannot run in a browser tab.",
    "curses": "curses drives a real terminal, and this output panel is not one.",
}

#: What :func:`pyscratch_run` reports back to the worker.
STATUS_OK = "ok"
STATUS_ERROR = "error"
STATUS_INTERRUPT = "interrupt"
STATUS_EXIT = "exit"

MODE_REPL = "repl"
MODE_SCRIPT = "script"


def _fresh_namespace(filename):
    """A namespace shaped like the one ``python3 file.py`` runs in.

    ``builtins`` is passed as the module rather than as its ``__dict__``,
    which is what CPython puts in ``__main__``; ``__spec__`` and ``__loader__``
    are present and ``None`` for the same reason.
    """
    return {
        "__name__": "__main__",
        "__file__": filename,
        "__doc__": None,
        "__package__": None,
        "__spec__": None,
        "__loader__": None,
        "__builtins__": builtins,
    }


def _register_source(source, filename):
    """Let :mod:`traceback` show the offending line of a buffer that is not a file.

    Refuses to overwrite absolute stdlib/filesystem paths and returns whether
    an entry was registered so ``pyscratch_run`` can evict it after the run.
    """
    if not filename or filename.startswith("/") or filename in linecache.cache:
        return False
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    return True


def _compile_statements(source, filename, mode):
    """Compile the whole buffer *before* running any of it.

    Returns a list of code objects. In ``script`` mode that is one object for
    the whole buffer; in ``repl`` mode it is one per top-level statement, each
    compiled from a one-statement :class:`ast.Interactive` so that ``single``
    mode's display behaviour applies.

    Compiling everything up front is what makes "a SyntaxError anywhere is
    reported before anything runs" true: in ``repl`` mode a buffer whose last
    line does not parse must not first print the output of the lines above it.
    :func:`ast.parse` raises on any syntax error in one pass, and the
    per-statement :func:`compile` catches the few errors CPython only reports
    at compile time, such as a ``return`` outside a function.
    """
    if mode == MODE_SCRIPT:
        return [compile(source, filename, "exec")]

    tree = ast.parse(source, filename, "exec")
    return [compile(ast.Interactive(body=[stmt]), filename, "single") for stmt in tree.body]


def _strip_runtime_frames(exc, filename):
    """Drop the frames above the user's code, through the whole exception chain.

    Iterative to avoid :exc:`RecursionError` on deep ``__cause__`` chains.
    Strips frames up to and including :func:`pyscratch_run` (so a buffer named
    ``<exec>`` never collides with the runner), falling back to leading
    non-buffer frames.
    """
    runner_code = pyscratch_run.__code__
    seen = set()
    stack = [exc]

    while stack:
        current = stack.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))

        tb = current.__traceback__
        probe = tb
        after_runner = None
        while probe is not None:
            if probe.tb_frame.f_code is runner_code:
                after_runner = probe.tb_next
                break
            probe = probe.tb_next

        if after_runner is not None:
            tb = after_runner
        else:
            while tb is not None and tb.tb_frame.f_code.co_filename != filename:
                tb = tb.tb_next
        current.__traceback__ = tb

        if current.__context__ is not None:
            stack.append(current.__context__)
        if current.__cause__ is not None:
            stack.append(current.__cause__)


def _format_traceback(exc, filename):
    _strip_runtime_frames(exc, filename)
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))


def _format_syntax_error(exc):
    """A SyntaxError block: the ``File "…", line N`` header, the line, the caret.

    :func:`traceback.format_exception_only` produces all of it from the
    exception's own attributes, so this needs no traceback and no linecache.
    """
    return "".join(traceback.format_exception_only(type(exc), exc))


def _explain_missing_module(exc):
    """One friendly line for an import that can never succeed here."""
    name = getattr(exc, "name", None) or "?"
    root = name.split(".")[0]
    if root in UNAVAILABLE_MODULES:
        return UNAVAILABLE_MODULES[root]
    return (
        f"No module named {name!r}. py-scratchpad runs the Python standard library only: "
        "there is no pip and no network access here, so third-party packages such as "
        "numpy or requests cannot be installed."
    )


def pyscratch_run(source, filename, mode):
    """Run ``source`` once and report how it ended.

    Output goes to ``sys.stdout`` and ``sys.stderr``, which the worker has
    pointed at the output panel; this returns only a status string, so nothing
    has to be converted across the JS boundary.
    """
    saved_stdout = sys.stdout
    saved_stderr = sys.stderr
    saved_stdin = sys.stdin
    saved_displayhook = sys.displayhook
    registered = _register_source(source, filename)

    try:
        try:
            codes = _compile_statements(source, filename, mode)
        except (SyntaxError, ValueError) as exc:
            saved_stderr.write(_format_syntax_error(exc))
            return STATUS_ERROR

        namespace = _fresh_namespace(filename)

        for code in codes:
            try:
                exec(code, namespace)  # noqa: S102 - running the user's buffer is the point
            except KeyboardInterrupt:
                # Stop was pressed and the interrupt buffer delivered a SIGINT.
                saved_stderr.write("KeyboardInterrupt\n")
                return STATUS_INTERRUPT
            except SystemExit as exc:
                code_value = exc.code
                if code_value not in (None, 0):
                    saved_stderr.write(f"SystemExit: {code_value}\n")
                return STATUS_EXIT
            except ModuleNotFoundError as exc:
                saved_stderr.write(_explain_missing_module(exc) + "\n")
                return STATUS_ERROR
            except BaseException as exc:  # noqa: BLE001 - the buffer may raise anything
                saved_stderr.write(_format_traceback(exc, filename))
                return STATUS_ERROR

        return STATUS_OK
    finally:
        sys.stdout = saved_stdout
        sys.stderr = saved_stderr
        sys.stdin = saved_stdin
        sys.displayhook = saved_displayhook
        if registered:
            linecache.cache.pop(filename, None)
