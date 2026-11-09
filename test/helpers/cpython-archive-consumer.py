"""List the entries pip would install from archives, without extracting them.

Run with `python3 -I` by test/helpers/archive-consumers.mjs. Reads a JSON job
list on stdin, each `{"kind": "sdist" | "wheel", "path": "<archive file>"}`,
and prints one JSON result per job. Archive bytes are only read and hashed:
nothing is extracted to disk and no member is ever executed or imported.

sdist mirrors pip 25.1's `untar_file`: when every member shares a leading
directory, strip it from member names and from hardlink targets under the same
directory, apply `tarfile.data_filter` (pip falls back to `tar_filter` only on
the three CPython patch releases whose filter rejected valid links), then replay
`extractall` against an in-memory tree. Wheel mirrors pip's `install_wheel`: `namelist()` minus directories,
`os.path.normpath`, a traversal check, then `open(getinfo(name)).read()`.
An sdist with neither `pyproject.toml` nor `setup.py` at its top is refused,
as pip refuses to build it.
Any exception is a refused install, reported as `ok: false`.
"""

import hashlib
import json
import posixpath
import sys
import tarfile
import zipfile

# A destination that does not exist, so `data_filter`'s realpath checks stay
# lexical and never consult the host filesystem.
DEST = "/nonexistent-drydock-differential/dest"


def split_leading_dir(path):
    path = path.lstrip("/").lstrip("\\")
    if "/" in path and (
        ("\\" in path and path.find("/") < path.find("\\")) or "\\" not in path
    ):
        return path.split("/", 1)
    if "\\" in path:
        return path.split("\\", 1)
    return [path, ""]


def has_leading_dir(paths):
    common = None
    for path in paths:
        prefix, _rest = split_leading_dir(path)
        if not prefix:
            return False
        if common is None:
            common = prefix
        elif prefix != common:
            return False
    return True


class Tree:
    """The extraction directory: relative path -> ("file", bytes) | ("dir",) | ("symlink", target)."""

    def __init__(self):
        self.nodes = {}

    def resolve(self, rel, depth=0):
        # Parents are resolved through symlinks, as the OS would when tarfile
        # opens the target path; the leaf itself is handled by the caller.
        if depth > 32:
            raise OSError("too many levels of symbolic links")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        out = []
        for index, part in enumerate(parts):
            if part == "..":
                if not out:
                    raise OSError("path escapes destination")
                out.pop()
                continue
            out.append(part)
            current = "/".join(out)
            node = self.nodes.get(current)
            if node and node[0] == "symlink" and index < len(parts) - 1:
                target = node[1]
                if target.startswith("/"):
                    raise OSError("absolute symlink in path")
                base = "/".join(out[:-1])
                joined = posixpath.join(base, target) if base else target
                resolved = self.resolve(joined, depth + 1) if joined else ""
                # tarfile only creates parents that do not exist, so a symlink
                # parent whose target is missing or a file fails the member.
                if resolved and self.nodes.get(resolved) != ("dir",):
                    raise OSError("symlink parent is not a directory: " + current)
                out = resolved.split("/") if resolved else []
        return "/".join(out)

    def ensure_parents(self, rel):
        parts = rel.split("/")[:-1]
        for index in range(len(parts)):
            current = "/".join(parts[: index + 1])
            node = self.nodes.get(current)
            if node is None:
                self.nodes[current] = ("dir",)
            elif node[0] != "dir":
                raise OSError("not a directory: " + current)

    def write_file(self, rel, data):
        target = self.resolve(rel)
        # Opening an existing symlink for writing follows it.
        for _ in range(32):
            node = self.nodes.get(target)
            if not node or node[0] != "symlink":
                break
            base = posixpath.dirname(target)
            target = self.resolve(posixpath.join(base, node[1]) if base else node[1])
        if not target:
            raise OSError("cannot write the destination root")
        self.ensure_parents(target)
        node = self.nodes.get(target)
        if node and node[0] == "dir":
            raise IsADirectoryError(target)
        self.nodes[target] = ("file", data)

    def mkdir(self, rel):
        target = self.resolve(rel)
        if not target:
            return
        self.ensure_parents(target)
        node = self.nodes.get(target)
        if node and node[0] != "dir":
            raise FileExistsError(target)
        self.nodes[target] = ("dir",)

    def symlink(self, rel, link):
        target = self.resolve(posixpath.dirname(rel)) if "/" in rel else ""
        leaf = posixpath.join(target, posixpath.basename(rel)) if target else rel
        self.ensure_parents(leaf)
        node = self.nodes.get(leaf)
        if node and node[0] == "dir":
            raise IsADirectoryError(leaf)
        self.nodes[leaf] = ("symlink", link)

    def read(self, rel):
        target = self.resolve(rel)
        for _ in range(32):
            node = self.nodes.get(target)
            if not node or node[0] != "symlink":
                break
            base = posixpath.dirname(target)
            target = self.resolve(posixpath.join(base, node[1]) if base else node[1])
        node = self.nodes.get(target)
        return node[1] if node and node[0] == "file" else None


# CPython releases whose `data_filter` raised LinkOutsideDestinationError on
# valid links (cpython#107845); pip retries with `tar_filter` only on these.
LAX_FILTER_RELEASES = {(3, 9, 17), (3, 10, 12), (3, 11, 4)}


def pip_filter(member, path):
    try:
        return tarfile.data_filter(member, path)
    except tarfile.LinkOutsideDestinationError:
        if sys.version_info[:3] in LAX_FILTER_RELEASES:
            return tarfile.tar_filter(member, path)
        raise


def sdist_entries(path):
    with tarfile.open(path, "r:gz", encoding="utf-8") as tar:
        members = tar.getmembers()
        if has_leading_dir([member.name for member in members]):
            # pip edits the members in place, so `_find_link_target` below
            # looks links up by the stripped names too.
            for member in members:
                name_lead, member.name = split_leading_dir(member.name)
                if member.islnk():
                    link_lead, link_rest = split_leading_dir(member.linkname)
                    if link_lead == name_lead:
                        member.linkname = link_rest
        tree = Tree()
        for original in members:
            member = pip_filter(original, DEST)
            if member is None:
                continue
            # tarfile strips a trailing slash before writing the member.
            name = member.name.rstrip("/")
            if member.isreg():
                data = tar.extractfile(original).read()
                tree.write_file(name, data)
            elif member.isdir():
                tree.mkdir(name)
            elif member.issym():
                tree.symlink(name, member.linkname)
            elif member.islnk():
                # makelink: os.link to the already-extracted target, else the
                # bytes of the archive member the link names.
                data = tree.read(member.linkname)
                if data is None:
                    data = tar.extractfile(tar._find_link_target(member)).read()
                tree.write_file(name, data)
            else:
                raise tarfile.SpecialFileError(member)
        # pip refuses a source tree with neither build file at its top.
        if not any(tree.read(name) is not None for name in ("pyproject.toml", "setup.py")):
            raise ValueError("neither 'setup.py' nor 'pyproject.toml' found")
        return tree


def wheel_entries(path):
    tree = Tree()
    with zipfile.ZipFile(path, allowZip64=True) as archive:
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            normed = posixpath.normpath(name)
            if normed.startswith("/") or normed == ".." or normed.startswith("../"):
                raise ValueError("wheel file installs outside the target directory")
            with archive.open(archive.getinfo(name)) as handle:
                tree.write_file(normed, handle.read())
    return tree


def serialize(tree):
    entries = []
    for rel, node in sorted(tree.nodes.items()):
        if node[0] == "file":
            entries.append(
                {"path": rel, "type": "file", "sha256": hashlib.sha256(node[1]).hexdigest()}
            )
        elif node[0] == "symlink":
            entries.append({"path": rel, "type": "symlink", "target": node[1]})
    return entries


def run(job):
    try:
        tree = sdist_entries(job["path"]) if job["kind"] == "sdist" else wheel_entries(job["path"])
        return {"ok": True, "entries": serialize(tree)}
    except Exception as error:  # every failure is a refused install
        return {"ok": False, "error": type(error).__name__ + ": " + str(error)[:200]}


def main():
    jobs = json.load(sys.stdin)
    results = [run(job) for job in jobs]
    json.dump(
        {"python": ".".join(str(part) for part in sys.version_info[:3]), "results": results},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
