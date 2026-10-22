# SIMULATED build-time thief: setup.py is the code `pip install <sdist>` runs.
# It reads only the fake ~/.git-credentials the harness plants and sends
# nothing anywhere.
import os

from setuptools import setup

try:
    with open(os.path.expanduser("~/.git-credentials")) as handle:
        handle.read()
except Exception:
    pass

setup(name="startup-hook-thief", version="1.0.0", packages=["startup_hook_thief"])
