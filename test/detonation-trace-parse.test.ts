import { describe, expect, test } from "vitest";
import {
  createStepEventBuffer,
  dedupeKey,
  eventTier,
  fitEvents,
} from "../containers/detonation/event-budget.mjs";
import { isBrowserTargeted } from "../containers/detonation/manifest.mjs";
import {
  createLineJoiner,
  createTraceReader,
  isNoiseEvent,
  normalizePath,
  parseMissingExec,
  parseStraceLine,
} from "../containers/detonation/trace-parse.mjs";
import type { HarnessEvent } from "../server/lib/detonation/types";

// Lines below were captured from `strace -f -qq -y -s 256 -e signal=none -e trace=...`
// running Node 22 and dash as uid 10001 inside the detonation image.
const TARGET = "pkg@1.0.0:postinstall";

function parse(line: string): HarnessEvent | null {
  return parseStraceLine(line, "lifecycle", TARGET);
}

describe("parseStraceLine exec", () => {
  test("parses execve path and argv with step, target, pid, and via", () => {
    expect(
      parse(
        `27    execve("/usr/bin/curl", ["curl", "-s", "http://127.0.0.1:9/x"], 0xaaaaf78eb608 /* 7 vars */) = 0`,
      ),
    ).toEqual({
      step: "lifecycle",
      target: TARGET,
      pid: 27,
      via: "syscall",
      kind: "exec",
      path: "/usr/bin/curl",
      argv: ["curl", "-s", "http://127.0.0.1:9/x"],
    });
  });

  test("keeps shell metacharacters inside quoted argv intact", () => {
    const event = parse(
      `26    execve("/usr/bin/sh", ["sh", "-c", "curl -s http://127.0.0.1:9/x || true; echo hi > /tmp/o; rm /tmp/o"], 0x37248620 /* 7 vars */) = 0`,
    );
    expect(event).toMatchObject({
      kind: "exec",
      argv: ["sh", "-c", "curl -s http://127.0.0.1:9/x || true; echo hi > /tmp/o; rm /tmp/o"],
    });
  });

  test("drops PATH-search misses but exposes them through parseMissingExec", () => {
    const miss = `26    execve("/usr/local/sbin/sh", ["sh", "-c", "true"], 0x37248620 /* 7 vars */) = -1 ENOENT (No such file or directory)`;
    expect(parse(miss)).toBeNull();
    expect(parseMissingExec(miss, "lifecycle", TARGET)).toMatchObject({
      kind: "exec",
      path: "/usr/local/sbin/sh",
      argv: ["sh", "-c", "true"],
    });
    expect(
      parseMissingExec(
        `27    execve("/usr/bin/curl", ["curl"], 0xaaaaf78eb608 /* 7 vars */) = 0`,
        "lifecycle",
        TARGET,
      ),
    ).toBeNull();
  });

  test("marks strace -s truncation on long arguments and bounds them", () => {
    const long = "x".repeat(256);
    const event = parse(
      `29    execve("/usr/local/bin/node", ["node", "-e", "console.log('${long}"...], 0x37248620 /* 7 vars */) = 0`,
    );
    expect(event?.kind).toBe("exec");
    if (event?.kind !== "exec") return;
    expect(event.argv).toHaveLength(3);
    expect(event.argv[2]).toHaveLength(256);
  });

  test("caps argv at 16 items", () => {
    const items = Array.from({ length: 20 }, (_, index) => `"a${index}"`).join(", ");
    const event = parse(`30    execve("/bin/echo", [${items}], 0x1 /* 1 var */) = 0`);
    expect(event?.kind === "exec" && event.argv.length).toBe(16);
  });

  test("bounds the joined argv to 2 KiB", () => {
    const items = Array.from({ length: 16 }, () => `"${"y".repeat(256)}"`).join(", ");
    const event = parse(`30    execve("/bin/echo", [${items}], 0x1 /* 1 var */) = 0`);
    if (event?.kind !== "exec") throw new Error("expected exec");
    expect(event.argv.join("").length).toBe(2048);
    expect(event.argv).toHaveLength(8);
  });

  test("resolves a relative exec path and an fexecve of a dirfd", () => {
    expect(
      parseStraceLine(
        `31    execve("./payload", ["./payload"], 0x1 /* 1 var */) = 0`,
        "lifecycle",
        TARGET,
        "/tmp/stage",
      ),
    ).toMatchObject({ kind: "exec", path: "/tmp/stage/payload" });
    expect(
      parse(`31    execveat(5</tmp/.x/bin>, "", ["x"], 0x1 /* 1 var */, AT_EMPTY_PATH) = 0`),
    ).toMatchObject({ kind: "exec", path: "/tmp/.x/bin" });
  });

  test("reports arguments strace could not read as unreadable", () => {
    expect(parse(`19    execve(0xffffe5baceb0, 0xffffe5bad270, 0xffffe5bad288) = 0`)).toMatchObject(
      {
        kind: "exec",
        path: "[unreadable]",
        argv: ["[unreadable]"],
      },
    );
  });
});

describe("parseStraceLine files", () => {
  test("classifies open flags as read, write, and create", () => {
    expect(
      parse(`19    openat(AT_FDCWD, "/home/pkg/.npmrc", O_RDONLY|O_CLOEXEC) = 20`),
    ).toMatchObject({ kind: "file", op: "read", path: "/home/pkg/.npmrc" });
    expect(parse(`19    openat(AT_FDCWD, "/tmp/x", O_RDWR|O_CLOEXEC) = 20`)).toMatchObject({
      op: "write",
    });
    expect(
      parse(
        `19    openat(AT_FDCWD, "/home/pkg/.bashrc", O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC, 0666) = 20`,
      ),
    ).toMatchObject({ op: "create", path: "/home/pkg/.bashrc" });
    expect(parse(`19    creat("/tmp/new", 0644) = 3`)).toMatchObject({ op: "create" });
    expect(
      parse(`19    open("/etc/shadow", O_RDONLY) = -1 EACCES (Permission denied)`),
    ).toMatchObject({ op: "read", path: "/etc/shadow" });
  });

  test("decodes strace escapes in paths", () => {
    expect(
      parse(
        `19    openat(AT_FDCWD, "/tmp/a\\"b\\\\c\\n\\342\\234\\223\\t", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = 20`,
      ),
    ).toMatchObject({ op: "create", path: '/tmp/a"b\\c?✓?' });
    expect(parse(`19    openat(AT_FDCWD, "/tmp/\\x41\\x42", O_RDONLY) = 3`)).toMatchObject({
      path: "/tmp/AB",
    });
  });

  test("a parenthesis or comma inside a path does not shift arguments", () => {
    expect(
      parse(`19    renameat(AT_FDCWD, "/tmp/a, b)", AT_FDCWD, "/tmp/c (1)") = 0`),
    ).toMatchObject({ op: "rename", path: "/tmp/c (1)" });
  });

  test("parses delete, rename destination, and chmod", () => {
    expect(parse(`19    unlinkat(AT_FDCWD, "/tmp/renamed", 0) = 0`)).toMatchObject({
      op: "delete",
      path: "/tmp/renamed",
    });
    expect(parse(`19    unlink("/tmp/old") = 0`)).toMatchObject({ op: "delete" });
    expect(
      parse(`19    renameat2(AT_FDCWD, "/tmp/a", AT_FDCWD, "/tmp/b", RENAME_NOREPLACE) = 0`),
    ).toMatchObject({ op: "rename", path: "/tmp/b" });
    expect(parse(`19    rename("/tmp/a", "/tmp/c") = 0`)).toMatchObject({ path: "/tmp/c" });
    expect(parse(`19    fchmodat(AT_FDCWD, "/tmp/renamed", 0755) = 0`)).toMatchObject({
      op: "chmod",
      path: "/tmp/renamed",
    });
    expect(parse(`19    chmod("/tmp/x", 04755) = 0`)).toMatchObject({ op: "chmod" });
  });

  test("drops missing files except under the home directories", () => {
    expect(
      parse(
        `19    openat(AT_FDCWD, "/ctx/package.json", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)`,
      ),
    ).toBeNull();
    expect(
      parse(
        `19    openat(AT_FDCWD, "/home/pkg/.aws/credentials", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)`,
      ),
    ).toMatchObject({ op: "read", path: "/home/pkg/.aws/credentials" });
    expect(
      parse(
        `19    openat(AT_FDCWD, "/root/.npmrc", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      ),
    ).toMatchObject({ path: "/root/.npmrc" });
  });

  test("resolves dirfd-relative opens through the -y annotation", () => {
    expect(
      parse(`19    openat(3</home/pkg>, ".npmrc", O_RDONLY) = 4</home/pkg/.npmrc>`),
    ).toMatchObject({
      kind: "file",
      op: "read",
      path: "/home/pkg/.npmrc",
    });
    expect(
      parse(
        `19    openat(AT_FDCWD</root>, ".ssh/id_rsa", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      ),
    ).toMatchObject({ op: "read", path: "/root/.ssh/id_rsa" });
    expect(parse(`19    unlinkat(7</home/pkg/.ssh>, "known_hosts", 0) = 0`)).toMatchObject({
      op: "delete",
      path: "/home/pkg/.ssh/known_hosts",
    });
    expect(
      parse(`19    renameat2(AT_FDCWD</tmp>, "a", 4</home/pkg>, ".bashrc", 0) = 0`),
    ).toMatchObject({ op: "rename", path: "/home/pkg/.bashrc" });
  });

  test("decodes escaped annotations so a comma or parenthesis in a directory cannot shift arguments", () => {
    expect(
      parse(
        `15    openat(AT_FDCWD</tmp/a,b)\\"c\\74d\\76[e>, "y", O_WRONLY|O_CREAT|O_NOCTTY|O_NONBLOCK, 0666) = 3</tmp/a,b)\\"c\\74d\\76[e/y>`,
      ),
    ).toMatchObject({ op: "create", path: '/tmp/a,b)"c<d>[e/y' });
  });

  test("normalizes paths before matching or clipping", () => {
    expect(
      parse(
        `19    openat(AT_FDCWD, "/home//pkg/./.npmrc", O_RDONLY) = -1 EACCES (Permission denied)`,
      ),
    ).toMatchObject({ path: "/home/pkg/.npmrc" });
    expect(
      parse(`19    openat(AT_FDCWD, "/sys/fs/cgroup//memory.max", O_RDONLY|O_CLOEXEC) = 20`),
    ).toMatchObject({ path: "/sys/fs/cgroup/memory.max" });
    // `..` from a lifecycle cwd reaches a sibling package; above `/` stays at `/`.
    expect(
      parseStraceLine(
        `19    openat(AT_FDCWD, "../lodash/index.js", O_WRONLY|O_TRUNC) = 3`,
        "lifecycle",
        TARGET,
        "/work/app/node_modules/pkg",
      ),
    ).toMatchObject({ op: "write", path: "/work/app/node_modules/lodash/index.js" });
    expect(
      parse(
        `19    openat(5</work/app>, "../../../../etc/shadow", O_RDONLY) = -1 EACCES (Permission denied)`,
      ),
    ).toMatchObject({ path: "/etc/shadow" });
    const padded = `/tmp/${"a/../".repeat(200)}home/../../home/pkg/.npmrc`;
    expect(parse(`19    openat(AT_FDCWD, "${padded}", O_RDONLY) = 3`)).toMatchObject({
      path: "/home/pkg/.npmrc",
    });
    expect(normalizePath("rel/x", null)).toBe("rel/x");
    expect(normalizePath("/home/pkg/", null)).toBe("/home/pkg");
  });

  test("reports what a successful open resolved to, except a process's own /proc/self", () => {
    expect(
      parse(`19    openat(AT_FDCWD</tmp>, "innocent", O_RDONLY|O_CLOEXEC) = 3</home/pkg/.npmrc>`),
    ).toMatchObject({ path: "/home/pkg/.npmrc" });
    expect(
      parse(
        `17    openat(AT_FDCWD</root>, "/proc/self/maps", O_RDONLY|O_CLOEXEC) = 20</proc/17/maps>`,
      ),
    ).toMatchObject({ path: "/proc/self/maps" });
    expect(parse(`19    openat(AT_FDCWD, "/dev/stdin", O_RDONLY) = 3<pipe:[123]>`)).toMatchObject({
      path: "/dev/stdin",
    });
  });

  test("bounds paths to 512 characters", () => {
    const event = parse(`19    openat(AT_FDCWD, "/tmp/${"p".repeat(600)}", O_RDONLY) = 3`);
    expect(event?.kind === "file" && event.path.length).toBe(512);
  });

  test("replaces control characters so escaping cannot inflate the report", () => {
    const event = parse(`31    execve("/bin/echo", ["echo", "a\\1\\33[2Jb"], 0x1 /* 1 var */) = 0`);
    expect(event?.kind === "exec" && event.argv).toEqual(["echo", "a??[2Jb"]);
  });
});

describe("parseStraceLine connect", () => {
  test("parses IPv4, IPv6, and unix sockets", () => {
    expect(
      parse(
        `19    connect(22, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.2.3.4")}, 16) = -1 EINPROGRESS (Operation now in progress)`,
      ),
    ).toMatchObject({ kind: "connect", family: "inet", address: "1.2.3.4", port: 443 });
    expect(
      parse(
        `19    connect(23, {sa_family=AF_INET6, sin6_port=htons(80), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS (Operation now in progress)`,
      ),
    ).toMatchObject({ kind: "connect", family: "inet6", address: "::1", port: 80 });
    expect(
      parse(
        `19    connect(21, {sa_family=AF_UNIX, sun_path="/tmp/nosock"}, 110) = -1 ENOENT (No such file or directory)`,
      ),
    ).toMatchObject({ kind: "connect", family: "unix", address: "/tmp/nosock", port: null });
    expect(
      parse(`19    connect(5, {sa_family=AF_UNIX, sun_path=@"abstract\\0x"}, 20) = 0`),
    ).toMatchObject({ family: "unix", address: "@abstract?x" });
  });

  test("ignores other address families", () => {
    expect(
      parse(`19    connect(5, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, 12) = 0`),
    ).toBeNull();
  });
});

describe("parseStraceLine framing", () => {
  test("ignores untraced calls, signals, exits, and malformed lines", () => {
    expect(parse(`19    close(3)                          = 0`)).toBeNull();
    expect(parse(`19    --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED} ---`)).toBeNull();
    expect(parse(`19    +++ exited with 0 +++`)).toBeNull();
    expect(parse(`garbage`)).toBeNull();
    expect(parse(`19    openat(AT_FDCWD, "/tmp/x", O_RDONLY`)).toBeNull();
  });

  test("parses the unfinished half on its own and skips the resumed half", () => {
    expect(
      parse(`20    openat(AT_FDCWD, "/home/pkg/.npmrc", O_RDONLY|O_CLOEXEC <unfinished ...>`),
    ).toMatchObject({ op: "read", path: "/home/pkg/.npmrc", pid: 20 });
    expect(parse(`20    <... openat resumed>) = 3`)).toBeNull();
  });

  test("the joiner rebuilds interleaved calls so failures stay visible", () => {
    const joiner = createLineJoiner();
    const lines = [
      `20    openat(AT_FDCWD, "/opt/missing", O_RDONLY|O_CLOEXEC <unfinished ...>`,
      `19    rt_sigprocmask(SIG_SETMASK, [],  <unfinished ...>`,
      `20    <... openat resumed>) = -1 ENOENT (No such file or directory)`,
      `19    <... rt_sigprocmask resumed>~[KILL STOP RTMIN RT_1], 8) = 0`,
      `21    execve("/usr/bin/id", ["id"], 0x1 /* 7 vars */ <unfinished ...>`,
    ];
    const joined = [...lines.flatMap((line) => joiner.push(line)), ...joiner.flush()];
    expect(joined).toEqual([
      `20    openat(AT_FDCWD, "/opt/missing", O_RDONLY|O_CLOEXEC ) = -1 ENOENT (No such file or directory)`,
      `19    rt_sigprocmask(SIG_SETMASK, [], ~[KILL STOP RTMIN RT_1], 8) = 0`,
      `21    execve("/usr/bin/id", ["id"], 0x1 /* 7 vars */ <unfinished ...>`,
    ]);
    expect(parse(joined[0] ?? "")).toBeNull();
    expect(parse(joined[2] ?? "")).toMatchObject({ kind: "exec", path: "/usr/bin/id" });
  });
});

describe("createTraceReader", () => {
  function read(lines: string[], cwd = "/work/app/node_modules/pkg") {
    const reader = createTraceReader({ step: "lifecycle", target: TARGET, cwd });
    return [...lines.flatMap((line) => reader.push(line)), ...reader.flush()];
  }
  const LAUNCH = [
    `10    execve("/usr/bin/setpriv", ["setpriv", "--reuid=10001"], 0x1 /* 9 vars */) = 0`,
    `10    execve("/bin/sh", ["/bin/sh", "-c", "cd ~ && cat .npmrc"], 0x1 /* 9 vars */) = 0`,
  ];
  const paths = (events: HarnessEvent[]) =>
    events.map((event) =>
      event.kind === "file" ? `${event.pid} ${event.op} ${event.path}` : null,
    );

  test("skips the harness launch and resolves against the step's cwd", () => {
    expect(paths(read([...LAUNCH, `10    open("package.json", O_RDONLY) = 3`]))).toEqual([
      "10 read /work/app/node_modules/pkg/package.json",
    ]);
  });

  test("follows chdir and passes the directory to a forked child", () => {
    const events = read([
      ...LAUNCH,
      `10    chdir("/home/pkg")                    = 0`,
      `10    clone(child_stack=0xfffff7ee3970, flags=CLONE_VM|CLONE_VFORK|SIGCHLD <unfinished ...>`,
      `10    <... clone resumed>)              = 11`,
      `11    execve("/usr/bin/cat", ["cat", ".npmrc"], 0x1 /* 9 vars */) = 0`,
      `11    open(".npmrc", O_RDONLY) = 3`,
      `11    chdir("..")                    = 0`,
      `11    open("pkg/.aws/credentials", O_RDONLY) = 3`,
      `10    open(".bashrc", O_WRONLY|O_APPEND) = 3`,
    ]);
    expect(paths(events).filter(Boolean)).toEqual([
      "11 read /home/pkg/.npmrc",
      "11 read /home/pkg/.aws/credentials",
      // The child's chdir did not move its parent.
      "10 write /home/pkg/.bashrc",
    ]);
  });

  test("a thread shares its process's directory and reports as that process", () => {
    const events = read([
      ...LAUNCH,
      `10    clone(child_stack=0xffffb3c0e8e0, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID, parent_tid=[12], tls=0xffffb3c0f760, child_tidptr=0xffffb3c0f0f0) = 12`,
      `10    chdir("/root")                    = 0`,
      `12    open(".npmrc", O_RDONLY) = -1 ENOENT (No such file or directory)`,
    ]);
    expect(paths(events)).toEqual(["10 read /root/.npmrc"]);
  });

  test("a forked child's pool thread reports as the child, not the parent", () => {
    const events = read([
      ...LAUNCH,
      `10    clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0xffff) = 11`,
      `11    execve("/usr/local/bin/node", ["node", "/usr/local/bin/npm", "run", "build"], 0x1 /* 9 vars */) = 0`,
      `11    clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID, child_tid=0xffff, parent_tid=0xffff, exit_signal=0, stack=0xffff, stack_size=0x7fff00, tls=0xffff} => {parent_tid=[17]}, 88) = 17`,
      `17    openat(AT_FDCWD</work/app>, "/home/pkg/.npmrc", O_RDONLY|O_CLOEXEC) = 18</home/pkg/.npmrc>`,
    ]);
    expect(events.map((event) => [event.kind, event.pid])).toEqual([
      ["exec", 11],
      ["file", 11],
    ]);
  });

  test("holds a child's lines until its parent's clone returns", () => {
    const events = read([
      ...LAUNCH,
      `10    chdir("/home/pkg")                    = 0`,
      `10    clone3({flags=CLONE_VM|CLONE_VFORK, exit_signal=SIGCHLD, stack=0xffff, stack_size=0x9000}, 88 <unfinished ...>`,
      `13    open(".npmrc", O_RDONLY) = 3`,
      `10    <... clone3 resumed>) = 13`,
    ]);
    expect(paths(events)).toEqual(["13 read /home/pkg/.npmrc"]);
  });

  test("fchdir follows the -y path and the kernel's AT_FDCWD corrects drift", () => {
    const events = read([
      ...LAUNCH,
      `10    fchdir(3</home/pkg/.ssh>)     = 0`,
      `10    open("id_ed25519", O_RDONLY) = 4`,
      `10    openat(AT_FDCWD</root>, "x", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      `10    open(".npmrc", O_RDONLY) = 4`,
    ]);
    expect(paths(events)).toEqual([
      "10 read /home/pkg/.ssh/id_ed25519",
      "10 read /root/x",
      "10 read /root/.npmrc",
    ]);
  });

  test("reports a command the PATH search never found", () => {
    const events = read([
      ...LAUNCH,
      `14    execve("/usr/local/bin/curl", ["curl", "x"], 0x1 /* 9 vars */) = -1 ENOENT (No such file or directory)`,
      `14    execve("/usr/bin/curl", ["curl", "x"], 0x1 /* 9 vars */) = -1 ENOENT (No such file or directory)`,
    ]);
    expect(events).toMatchObject([{ kind: "exec", path: "/usr/bin/curl", pid: 14 }]);
  });
});

describe("event budget", () => {
  const base = { step: "lifecycle", target: TARGET, pid: 1, via: "syscall" } as const;
  const file = (op: "read" | "create", path: string, pid = 1): HarnessEvent => ({
    ...base,
    pid,
    kind: "file",
    op,
    path,
  });
  const exec = (path: string, argv: string[], pid = 1): HarnessEvent => ({
    ...base,
    pid,
    kind: "exec",
    path,
    argv,
  });
  const kept = (events: { event: HarnessEvent }[]) => events.map((entry) => entry.event);

  test("ranks execs, real writes, sensitive paths, network, then scratch and other reads", () => {
    expect(eventTier(exec("/bin/sh", []))).toBe(5);
    expect(eventTier(file("create", "/work/app/node_modules/x/a.js"))).toBe(4);
    expect(eventTier(file("read", "/home/pkg/.npmrc"))).toBe(3);
    expect(eventTier(file("read", "/proc/1/environ"))).toBe(3);
    expect(
      eventTier({ ...base, kind: "connect", family: "inet", address: "1.1.1.1", port: 1 }),
    ).toBe(2);
    expect(eventTier({ ...base, kind: "dns", hostname: "x" })).toBe(1);
    expect(eventTier(file("create", "/tmp/flood-1"))).toBe(0);
    expect(eventTier(file("read", "/work/app/data.json"))).toBe(0);
  });

  test("a /tmp flood is dropped and the credential read after it survives", () => {
    const buffer = createStepEventBuffer();
    for (let index = 0; index < 3000; index += 1) buffer.add(file("create", `/tmp/flood-${index}`));
    buffer.add(file("read", "/home/pkg/.npmrc", 7));
    buffer.add(exec("/usr/bin/cat", ["cat", ".npmrc"]));
    const { events, dropped } = buffer.finish();
    // 300 context events (the cat exec and 299 /tmp creates) plus the protected read.
    expect(events).toHaveLength(301);
    expect(dropped).toBe(2701);
    expect(kept(events).slice(-2)).toMatchObject([
      { kind: "file", path: "/home/pkg/.npmrc" },
      { kind: "exec", path: "/usr/bin/cat" },
    ]);
  });

  test("no flood of another kind can crowd out a signal-bearing event", () => {
    const buffer = createStepEventBuffer();
    for (let index = 0; index < 1000; index += 1) buffer.add(exec(`/bin/x${index}`, []));
    // Distinct pids defeat dedupe on a sensitive path that raises no signal.
    for (let pid = 2; pid < 1000; pid += 1) buffer.add(file("read", "/etc/passwd", pid));
    buffer.add({ ...base, kind: "connect", family: "inet", address: "203.0.113.9", port: 443 });
    buffer.add(file("read", "/home/pkg/.npmrc", 5000));
    buffer.add(exec("/usr/bin/curl", ["curl", "x"]));
    const signals = buffer.finish().events.filter((entry) => entry.category !== null);
    expect(signals.map((entry) => entry.category)).toEqual(["network", "credential", "process"]);
  });

  test("a package manager's own config read is context, its child's is a signal", () => {
    const buffer = createStepEventBuffer();
    buffer.add(exec("/usr/local/bin/npm", ["npm", "run", "build"], 50));
    buffer.add(exec("/usr/local/bin/node", ["node", "/usr/local/bin/npm", "run", "build"], 50));
    buffer.add(file("read", "/home/pkg/.npmrc", 50));
    buffer.add(exec("/usr/local/bin/node", ["node", "steal.js"], 61));
    buffer.add(file("read", "/home/pkg/.npmrc", 61));
    expect(
      buffer.finish().events.map(({ event, category }) => [event.kind, event.pid, category]),
    ).toEqual([
      ["exec", 50, "manager"],
      ["exec", 50, "manager"],
      ["file", 50, null],
      ["exec", 61, null],
      ["file", 61, "credential"],
    ]);
  });

  test("a flood inside one category only drops later events of that category", () => {
    const buffer = createStepEventBuffer({ categoryCap: 4 });
    for (let index = 0; index < 10; index += 1) buffer.add(exec("/usr/bin/curl", [`${index}`]));
    buffer.add(file("read", "/home/pkg/.ssh/id_rsa"));
    const { events, dropped } = buffer.finish();
    expect(events.map((entry) => entry.category)).toEqual([
      "process",
      "process",
      "process",
      "process",
      "credential",
    ]);
    expect(dropped).toBe(6);
  });

  test("dedupe keeps the same credential read from two processes", () => {
    expect(dedupeKey(file("read", "/home/pkg/.npmrc", 1))).not.toBe(
      dedupeKey(file("read", "/home/pkg/.npmrc", 2)),
    );
    expect(dedupeKey(file("create", "/tmp/x", 1))).toBe(dedupeKey(file("create", "/tmp/x", 2)));
    const buffer = createStepEventBuffer();
    buffer.add(file("read", "/home/pkg/.npmrc", 1));
    buffer.add(file("read", "/home/pkg/.npmrc", 2));
    buffer.add(file("read", "/home/pkg/.npmrc", 2));
    expect(buffer.finish().events).toHaveLength(2);
  });

  test("fitting the report drops context and dependency steps first and honors bytes", () => {
    const dependency = { ...base, target: "dep@1.0.0:postinstall" };
    const entries = [
      { event: { ...dependency, kind: "exec", path: "/bin/sh", argv: ["sh"] }, category: null },
      { event: { ...base, kind: "file", op: "read", path: "/work/app/a" }, category: null },
      { event: { ...dependency, kind: "file", op: "read", path: "/work/app/b" }, category: null },
      { event: { ...base, kind: "exec", path: "/bin/sh", argv: ["sh"] }, category: null },
    ] satisfies { event: HarnessEvent; category: null }[];
    const events = kept(entries);
    const preferred = (event: HarnessEvent) => event.target === TARGET;
    const byCount = fitEvents(entries, { maxEvents: 3, maxBytes: 1e6, preferred });
    expect(byCount.dropped).toBe(1);
    expect(byCount.events).toEqual([events[0], events[1], events[3]]);
    const bytesOf = (list: HarnessEvent[]) =>
      list.reduce((sum, event) => sum + JSON.stringify(event).length + 1, 0);
    const byBytes = fitEvents(entries, {
      maxEvents: 10,
      maxBytes: bytesOf([events[0], events[3]]),
      preferred,
    });
    expect(byBytes.events).toEqual([events[0], events[3]]);
    expect(fitEvents(entries, { maxEvents: 10, maxBytes: 1e6, preferred }).dropped).toBe(0);
  });

  test("one step's bulk cannot push another step's evidence out of the report", () => {
    const noisy = { ...base, step: "require", target: "pkg:require" } as const;
    const longArg = "x".repeat(2000);
    const noisyExec = (path: string, argv: string[]): HarnessEvent => ({
      ...noisy,
      kind: "exec",
      path,
      argv,
    });
    const entries: { event: HarnessEvent; category: string | null }[] = [
      ...Array.from({ length: 64 }, (_, index) => ({
        event: noisyExec("/usr/bin/curl", ["curl", `${index}`, longArg]),
        category: "process",
      })),
      ...Array.from({ length: 300 }, (_, index) => ({
        event: noisyExec(`/bin/x${index}`, [longArg]),
        category: null,
      })),
      { event: file("read", "/home/pkg/.npmrc", 9), category: "credential" },
    ];
    const fitted = fitEvents(entries, {
      maxEvents: 2000,
      maxBytes: 64 * 1024,
      preferred: () => true,
    });
    expect(fitted.events.at(-1)).toMatchObject({ path: "/home/pkg/.npmrc" });
    expect(
      fitted.events.some((event) => event.kind === "exec" && event.path === "/usr/bin/curl"),
    ).toBe(true);
  });
});

describe("isNoiseEvent", () => {
  const base = { step: "require", target: "pkg:require", pid: 1, via: "syscall" } as const;
  const read = (path: string): HarnessEvent => ({ ...base, kind: "file", op: "read", path });

  test("drops runtime and dependency reads", () => {
    for (const path of [
      "/usr/local/lib/node_modules/npm/package.json",
      "/lib/aarch64-linux-gnu/libc.so.6",
      "/etc/ld.so.cache",
      "/etc/localtime",
      "/etc/ssl/openssl.cnf",
      "/proc/self/maps",
      "/sys/fs/cgroup/cpu.max",
      "/dev/urandom",
      "/work/app/node_modules/left-pad/index.js",
      "/proc/meminfo",
    ]) {
      expect(isNoiseEvent(read(path)), path).toBe(true);
    }
  });

  test("keeps credential, system, and sibling-path reads", () => {
    for (const path of [
      "/home/pkg/.npmrc",
      "/root/.ssh/id_rsa",
      "/etc/passwd",
      "/proc/1/environ",
      "/work/app/node_modules_evil/x",
    ]) {
      expect(isNoiseEvent(read(path)), path).toBe(false);
    }
  });

  test("keeps writes everywhere except device and self-proc paths", () => {
    const write = (path: string): HarnessEvent => ({ ...base, kind: "file", op: "create", path });
    expect(isNoiseEvent(write("/work/app/node_modules/other/index.js"))).toBe(false);
    expect(isNoiseEvent(write("/usr/local/bin/node"))).toBe(false);
    expect(isNoiseEvent(write("/dev/null"))).toBe(true);
    expect(isNoiseEvent(write("/proc/self/oom_score_adj"))).toBe(true);
    expect(isNoiseEvent(write("/work/.drydock-hooks/0.jsonl"))).toBe(true);
  });

  test("drops the libc nscd probe but keeps execs, dns, and network", () => {
    expect(
      isNoiseEvent({
        ...base,
        kind: "connect",
        family: "unix",
        address: "/var/run/nscd/socket",
        port: null,
      }),
    ).toBe(true);
    expect(
      isNoiseEvent({ ...base, kind: "connect", family: "inet", address: "1.2.3.4", port: 443 }),
    ).toBe(false);
    expect(isNoiseEvent({ ...base, kind: "exec", path: "/usr/bin/curl", argv: ["curl"] })).toBe(
      false,
    );
    expect(isNoiseEvent({ ...base, kind: "dns", hostname: "exfil.example" })).toBe(false);
  });
});

describe("isBrowserTargeted", () => {
  test("recognizes browser fields and a nested browser export condition", () => {
    expect(isBrowserTargeted({ browser: "dist/browser.js" })).toBe(true);
    expect(isBrowserTargeted({ browser: { fs: false } })).toBe(true);
    expect(isBrowserTargeted({ unpkg: "dist/umd.js" })).toBe(true);
    expect(
      isBrowserTargeted({
        exports: { ".": { import: { browser: "./b.mjs", default: "./n.mjs" } } },
      }),
    ).toBe(true);
    expect(isBrowserTargeted({ exports: [{ node: "./n.js" }, { browser: "./b.js" }] })).toBe(true);
  });

  test("treats a Node-only or missing manifest as not browser-targeted", () => {
    expect(isBrowserTargeted(null)).toBe(false);
    expect(isBrowserTargeted({ main: "index.js", browser: false })).toBe(false);
    expect(isBrowserTargeted({ exports: { ".": { node: "./n.js", default: "./n.js" } } })).toBe(
      false,
    );
  });

  test("stops walking a hostile exports tree at its depth bound", () => {
    let deep: Record<string, unknown> = { browser: "./b.js" };
    for (let index = 0; index < 50; index += 1) deep = { [`c${index}`]: deep };
    expect(isBrowserTargeted({ exports: deep })).toBe(false);
  });
});
