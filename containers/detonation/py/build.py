# Builds the reviewed sdist with its own PEP 517 backend, the code that
# `pip install <sdist>` executes (setup.py for setuptools):
#   build.py <backend> <backend-path-json> <outdir>
# Run by the image's interpreter with the sdist root as cwd and only the
# prepared build requirements on PYTHONPATH. The backend reference and paths
# were checked by the harness; paths stay inside the sdist root.
import importlib
import json
import os
import sys


def load_observer():
    log = os.environ.get("DRYDOCK_HOOK_LOG")
    if not log:
        return
    path = "/opt/drydock/py/observe.py"
    try:
        with open(path) as handle:
            exec(compile(handle.read(), path, "exec"), {"__name__": "_drydock_observe"})
    except Exception:
        pass


def main(argv):
    load_observer()
    reference, backend_path, outdir = argv[1], json.loads(argv[2]), argv[3]
    root = os.getcwd()
    for entry in reversed(backend_path):
        sys.path.insert(0, os.path.join(root, entry))
    module, _, attr = reference.partition(":")
    backend = importlib.import_module(module)
    for part in filter(None, attr.split(".")):
        backend = getattr(backend, part)
    os.makedirs(outdir, exist_ok=True)
    backend.build_wheel(outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
