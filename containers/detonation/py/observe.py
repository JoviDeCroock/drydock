# Audit-hook observer for PyPI detonation steps, loaded by a root-written
# `.pth` that sorts before any package `.pth`. It runs inside the package's own
# interpreter as the package user, so everything it records is tamperable: the
# harness keeps only its DNS events when strace is attached (strace cannot see
# names) and uses the rest as a fallback. It must never change package
# behavior, so every path swallows its own errors.
import os
import sys


def _install(log_path):
    import json

    fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC)
    getcwd = os.getcwd
    busy = [False]
    # Interpreter and harness files: every start reads them.
    quiet = ("/usr/", "/lib/", "/work/venv/", "/opt/drydock/", "/proc/self/", "/dev/", "/etc/ld.so")

    def emit(event):
        event["pid"] = os.getpid()
        try:
            os.write(fd, (json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8", "replace"))
        except Exception:
            pass

    def text(value):
        if isinstance(value, bytes):
            return value.decode("utf-8", "replace")
        if isinstance(value, os.PathLike):
            value = os.fspath(value)
            return value.decode("utf-8", "replace") if isinstance(value, bytes) else value
        return value if isinstance(value, str) else None

    def absolute(path):
        if path.startswith("/"):
            return path
        try:
            return os.path.join(getcwd(), path)
        except Exception:
            return path

    def argv_of(args):
        if isinstance(args, (list, tuple)):
            return [str(text(arg) if text(arg) is not None else arg)[:256] for arg in args[:16]]
        value = text(args)
        return ["/bin/sh", "-c", value[:256]] if value is not None else []

    def hook(event, args):
        if busy[0]:
            return
        busy[0] = True
        try:
            if event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex"):
                host = text(args[0]) if args else None
                if host:
                    emit({"kind": "dns", "hostname": host[:253]})
            elif event == "socket.connect":
                sock, address = args[0], args[1]
                family = getattr(sock, "family", None)
                if isinstance(address, tuple) and len(address) >= 2:
                    name = "inet6" if family is not None and int(family) == 10 else "inet"
                    port = address[1] if isinstance(address[1], int) else None
                    emit({"kind": "connect", "family": name, "address": str(address[0])[:256], "port": port})
                elif text(address):
                    emit({"kind": "connect", "family": "unix", "address": text(address)[:256], "port": None})
            elif event == "subprocess.Popen":
                executable, argv = args[0], argv_of(args[1])
                path = text(executable) or (argv[0] if argv else None)
                if path:
                    emit({"kind": "exec", "path": path[:512], "argv": argv})
            elif event == "os.system":
                command = text(args[0])
                if command is not None:
                    emit({"kind": "exec", "path": "/bin/sh", "argv": ["/bin/sh", "-c", command[:256]]})
            elif event in ("os.exec", "os.posix_spawn"):
                path = text(args[0])
                if path:
                    emit({"kind": "exec", "path": path[:512], "argv": argv_of(args[1])})
            elif event == "open":
                path = text(args[0])
                if path:
                    path = absolute(path)
                    if not path.startswith(quiet):
                        mode = args[1] if len(args) > 1 and isinstance(args[1], str) else "r"
                        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
                        writes = any(c in mode for c in "wax+") or (flags & (os.O_WRONLY | os.O_RDWR))
                        emit({"kind": "file", "op": "write" if writes else "read", "path": path[:512]})
        except Exception:
            pass
        finally:
            busy[0] = False

    sys.addaudithook(hook)
    emit({"kind": "loaded"})


try:
    _log = os.environ.get("DRYDOCK_HOOK_LOG")
    if _log:
        _install(_log)
except Exception:
    pass
