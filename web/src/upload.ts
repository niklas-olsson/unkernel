// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Files of the host put into the guest (drop.ts, wayland/paste.ts): each is
// streamed to a program's stdin (vm.spawn() on pipes), so a large one is
// never whole in page memory, and lands in ~/Downloads of the guest's
// default user, or in a given directory (promptDir(): where a terminal's
// shell is), under its own name, or "name (2).ext" where that is taken: an
// upload never replaces a file. It is written to a hidden temporary file
// there first, checked for its size and linked to its name (renamed where
// the file system has no hard links), so a reader never sees a partial file;
// a failed or cut upload leaves nothing.
// readPaths() is the way back (wayland/copyout.ts).
// Only types are imported, so Node can run this module as it is.
import type { KernelHandle } from "./sdk.ts";

/** The longest name kept, UTF-8 bytes (ext4's limit is 255; " (999)" and the rest still fit). */
const NAME_MAX = 200;

// Writes stdin ($2 bytes) as $1 into the directory $3 (default ~/Downloads, made), prints the path it got.
const UPLOAD_SH = `set -e
cd ~
if [ -z "$3" ]; then mkdir -p Downloads; fi
cd "\${3:-Downloads}"
t=$(mktemp ./.upload.XXXXXX)
trap 'rm -f "$t"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$t"
size=$(stat -c %s "$t")
if [ "$size" != "$2" ]; then echo "got $size of $2 bytes" >&2; exit 1; fi
chmod 644 "$t"
case "$1" in
	?*.*) s=\${1%.*} e=.\${1##*.} ;;
	*) s=$1 e= ;;
esac
f=$1 n=1
until ln "$t" "./$f" 2>/dev/null; do
	if [ ! -e "./$f" ] && [ ! -L "./$f" ]; then mv "$t" "./$f"; break; fi
	if [ "$n" -ge 999 ]; then echo "$f (2) to ($n) exist" >&2; exit 1; fi
	n=$((n + 1))
	f="$s ($n)$e"
done
pwd=$(pwd)
printf '%s' "\${pwd%/}/$f"`;

// Prints the directory of the shell that waits at its prompt in the terminal
// of process $1 (none: the console, hvc0: device 229:0), where the user can
// write there; nothing while a program runs in it. The terminal's foreground
// process group leader (tpgid, the 6th field after the name in
// /proc/PID/stat; tty_nr is the 5th) must be a shell run without a script or
// -c (the launcher's terminals run theirs with -lc until the app ends).
const PROMPT_SH = `p=$1
if [ -z "$p" ]; then
	for d in /proc/[0-9]*; do
		read -r s 2>/dev/null <$d/stat || continue
		set -- \${s##*\\) }
		[ "$5" = 58624 ] && [ "$6" = "\${d#/proc/}" ] && p=$6 && break
	done
else
	read -r s 2>/dev/null </proc/$p/stat || exit 0
	set -- \${s##*\\) }
	p=$6
fi
[ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null || exit 0
read -r c 2>/dev/null </proc/$p/comm
case "$c" in sh|ash|bash|dash|zsh|fish|busybox) ;; *) exit 0 ;; esac
first=1
for a in $(tr '\\000' '\\n' </proc/$p/cmdline 2>/dev/null); do
	if [ $first = 1 ]; then first=; continue; fi
	case "$a" in --*) ;; -*c*) exit 0 ;; -*) ;; *) exit 0 ;; esac
done
d=$(readlink /proc/$p/cwd 2>/dev/null) || exit 0
[ -d "$d" ] && [ -w "$d" ] && printf '%s' "$d"
exit 0`;

/** The directory of the shell at its prompt in a terminal (its shell's `pid`; undefined: the console), or null: a program runs in it, or its directory cannot be written. */
export async function promptDir(vm: KernelHandle, pid: number | undefined): Promise<string | null> {
	const r = await vm.exec("/bin/sh", ["-c", PROMPT_SH, "sh", pid === undefined ? "" : String(pid)], { timeout: 5000 });
	return r.stdout || null;
}

/** A host file's name as one path component of the guest. */
export function guestName(name: string): string {
	// No separators or control characters (a newline would split a uri-list or a pasted line).
	let s = name.replace(/[/\u0000-\u001f\u007f]/g, "_").trim();
	if (s === "" || s === "." || s === "..") s = "file";
	if (new TextEncoder().encode(s).length <= NAME_MAX) return s;
	const dot = s.lastIndexOf("."), ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
	let stem = ext ? s.slice(0, dot) : s;
	while (new TextEncoder().encode(stem + ext).length > NAME_MAX) stem = [...stem].slice(0, -1).join("");
	return stem + ext;
}

/** Single-quoted for a shell where it needs to be (a path typed at a prompt). */
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Put one file into `dir` (absolute; default ~/Downloads: see the top); resolves its absolute path. `onBytes`: bytes sent so far. */
export async function uploadFile(vm: KernelHandle, file: File, opts: { dir?: string; onBytes?: (sent: number) => void } = {}): Promise<string> {
	const name = guestName(file.name);
	const p = await vm.spawn("/bin/sh", ["-c", UPLOAD_SH, "sh", name, String(file.size), opts.dir ?? ""], { pty: false });
	let sent = 0;
	const count = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, c) { sent += chunk.length; c.enqueue(chunk); opts.onBytes?.(sent); },
	});
	const feeding = file.stream().pipeThrough(count).pipeTo(p.stdin).then(() => null, (e: unknown) => {
		// A file that cannot be read (a folder): the script would wait for the rest.
		p.close().catch(() => {});
		return e as Error;
	});
	const [out, err, fed] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), feeding]);
	const end = await p.ended.catch(() => null);
	if (end?.type === "exit" && end.code === 0 && out) return out;
	const why = err.trim() || (fed?.name === "NotFoundError" || fed?.name === "NotReadableError" ? "it cannot be read (folders are not copied)" : fed?.message) || "the guest's program ended";
	throw new Error(`${file.name}: ${why}`);
}

/** The absolute paths a text/uri-list's file: URIs name (others are left out). */
export function uriPaths(list: string): string[] {
	const out: string[] = [];
	for (const l of list.split(/\r?\n/)) {
		if (!/^file:\/\//i.test(l)) continue;
		try {
			const p = decodeURIComponent(l.slice(7).replace(/^[^/]*/, "")).replace(/(.)\/+$/, "$1");
			if (p.startsWith("/") && !p.includes("\0")) out.push(p);
		} catch { /* not a URI */ }
	}
	return out;
}

/** The guest's `paths` as one file for the host: a single file as it is, under its name; a folder or several as a .tar.gz. */
export async function readPaths(vm: KernelHandle, paths: readonly string[]): Promise<{ name: string; blob: Blob }> {
	const base = (p: string) => p.slice(p.lastIndexOf("/") + 1) || "root";
	const dir = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
	const first = paths[0]!;
	const single = paths.length === 1 && (await vm.exec("test", ["-f", first])).exitCode === 0;
	const same = paths.every((p) => dir(p) === dir(first));
	const p = single
		? await vm.spawn("cat", ["--", first], { pty: false })
		: await vm.spawn("tar", ["-czf", "-", "-C", same ? dir(first) : "/", ...paths.map((f) => `./${same ? f.slice(f.lastIndexOf("/") + 1) : f.slice(1)}`)], { pty: false });
	p.stdin.close().catch(() => {});
	const [blob, err] = await Promise.all([new Response(p.stdout).blob(), new Response(p.stderr).text()]);
	const end = await p.ended;
	if (end.type !== "exit" || end.code !== 0) throw new Error(err.trim().split("\n")[0] || "the guest's program failed");
	return { name: single ? base(first) : paths.length === 1 ? `${base(first)}.tar.gz` : "files.tar.gz", blob };
}
