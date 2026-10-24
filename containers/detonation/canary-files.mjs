import fs from "node:fs";
import path from "node:path";

/**
 * Root writes the canaries into a home the package user owns, so nothing on
 * the way may be a link the package left there: a symlinked `~/.npmrc` would
 * otherwise have root create and chown a file of the package's choosing.
 * Every component below the home is replaced if it is not a real directory,
 * and the file is created with O_EXCL | O_NOFOLLOW. Package processes are
 * already killed when this runs, so nothing races the checks.
 *
 * @param {{ path: string, content: string, mode: number }[]} files
 * @param {{ home: string, uid: number, gid: number }} owner
 */
export function plantCanaryFiles(files, { home, uid, gid }) {
  for (const file of files) {
    const relative = path.relative(home, file.path);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("canary path outside the package home");
    }
    let dir = home;
    for (const part of path
      .dirname(relative)
      .split(path.sep)
      .filter((p) => p && p !== ".")) {
      dir = path.join(dir, part);
      const stat = lstatOrNull(dir);
      if (stat?.isDirectory()) continue;
      if (stat) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chownSync(dir, uid, gid);
    }
    if (lstatOrNull(file.path)) fs.rmSync(file.path, { recursive: true, force: true });
    const fd = fs.openSync(
      file.path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      file.mode,
    );
    try {
      fs.writeSync(fd, file.content);
      fs.fchownSync(fd, uid, gid);
      fs.fchmodSync(fd, file.mode);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** @param {string} target */
function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}
