# Reads a sdist's pyproject.toml `[build-system]` table as data and prints it
# as JSON (`null` when absent). Run with `-I` as the package user; the file is
# hostile, so this only parses it with the standard library and executes
# nothing from it. The harness narrows every field again.
import json
import sys
import tomllib


def main(argv):
    try:
        with open(argv[1], "rb") as handle:
            if handle.seek(0, 2) > 1024 * 1024:
                print("null")
                return 0
            handle.seek(0)
            table = tomllib.load(handle).get("build-system")
    except (OSError, tomllib.TOMLDecodeError, RecursionError):
        print("null")
        return 0
    if not isinstance(table, dict):
        print("null")
        return 0
    requires = table.get("requires")
    backend = table.get("build-backend")
    backend_path = table.get("backend-path")
    print(
        json.dumps(
            {
                "requires": [r for r in requires if isinstance(r, str)][:64]
                if isinstance(requires, list)
                else None,
                "backend": backend if isinstance(backend, str) else None,
                "backendPath": [p for p in backend_path if isinstance(p, str)][:8]
                if isinstance(backend_path, list)
                else [],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
