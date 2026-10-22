# Runs one PyPI detonation step's package code in the run's environment:
#   run.py import <module>
#   run.py entry <module> <attr> <script-name>   (calls the entry point with --help)
# Names arrive as arguments, already checked against a dotted-identifier
# grammar by the harness, and are never evaluated as code. Started with `-P`, so
# this script's own directory is not on sys.path.
import importlib
import sys


def main(argv):
    mode = argv[1]
    if mode == "import":
        importlib.import_module(argv[2])
        return 0
    if mode == "entry":
        module, attr, name = argv[2], argv[3], argv[4]
        target = importlib.import_module(module)
        for part in attr.split("."):
            target = getattr(target, part)
        sys.argv = [name, "--help"]
        return target()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
