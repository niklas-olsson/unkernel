// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson
import type { KernelHandle } from "../../js/core/instance.ts";

export interface DesktopEntry {
	id: string;
	title: string;
	description: string;
	startupClass: string;
	terminal: boolean;
	cwd: string;
	tryExec: string;
	argv: string[];
}

export interface DesktopEntryCatalog {
	revision: string;
	apps: DesktopEntry[];
}

const utf8 = new TextEncoder();
const MAX_ENTRY = 128 * 1024;
const MAX_ARGV = 32 * 1024;
const MAX_SCAN = 8 * 1024 * 1024;
const HEADER = "\0KW desktop entries\0";
const BUSYBOX = "/run/kw-lower/bin/busybox";

/** Enumerate the directories in precedence order, with one awk process per find batch. */
const SCAN_DESKTOP_ENTRIES = `set -f
data_home=\${XDG_DATA_HOME:-$HOME/.local/share}
data_dirs=\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
prior=$1
locale=\${LC_ALL:-\${LC_MESSAGES:-$LANG}}
batch='BEGIN {
	root = ENVIRON["KW_DESKTOP_ROOT"]
	for (i = 1; i < ARGC; i++) {
		file = ARGV[i]
		printf "%s%c%s%c", substr(file, length(root) + 2), 0, file, 0
		if (!oversized) {
			size = 0
			while ((getline line < file) > 0) {
				size += length(line) + 1
				if (size > ${MAX_ENTRY}) { printf "%c", 127; break }
				print line
			}
			close(file)
		}
		printf "%c", 0
	}
	exit
}'
IFS=:
set -- "$data_home" $data_dirs
unset IFS
# Package database metadata also catches upgrades that rewrite entries in place.
revision=$(
	{
		printf '%s\\0' "$XDG_CURRENT_DESKTOP" "$locale" "$PATH"
		for data do
			case "$data" in /*) ;; *) continue ;; esac
			root=\${data%/}/applications
			printf '%s\\0' "$root"
			[ ! -d "$root" ] || stat -Lc '%d:%i:%y:%z' "$root"
		done
		stat -Lc '%d:%i:%y:%z' /var/lib/dpkg/status /lib/apk/db/installed 2>/dev/null
	} | ${BUSYBOX} cksum
)
printf '\\0KW desktop entries\\0%s\\0%s\\0%s\\0' "$revision" "$XDG_CURRENT_DESKTOP" "$locale"
[ "$prior" != "$revision" ] || exit 0
for data do
	case "$data" in /*) ;; *) continue ;; esac
	root=\${data%/}/applications
	[ -d "$root" ] || continue
	# BusyBox find does not flush two batched -exec actions joined by -o.
	KW_DESKTOP_ROOT="$root" LC_ALL=C find -L "$root" -type f -name '*.desktop' -size +${MAX_ENTRY}c \\
		-exec ${BUSYBOX} awk -v oversized=1 "$batch" {} + 2>/dev/null
	KW_DESKTOP_ROOT="$root" LC_ALL=C find -L "$root" -type f -name '*.desktop' -size -${MAX_ENTRY + 1}c \\
		-exec ${BUSYBOX} awk "$batch" {} + 2>/dev/null
done
exit 0`;

const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };

function unescapeValue(s: string): string {
	return s.replace(/\\([sntr\\])/g, (_, c: string) => escapes[c]!);
}

/** The default key, or the best match for the guest's message locale. */
function localized(values: Map<string, string>, key: string, locale: string): string {
	const m = /^([a-zA-Z]+)(_[A-Z0-9]+)?(?:\.[^@]+)?(@.+)?$/.exec(locale);
	const lang = m?.[1], country = m?.[2], mod = m?.[3];
	const locales = lang ? [
		country && mod && lang + country + mod,
		country && lang + country,
		mod && lang + mod,
		lang,
	] : [];
	for (const variant of locales) {
		if (variant && values.has(`${key}[${variant}]`)) return values.get(`${key}[${variant}]`)!;
	}
	return values.get(key) ?? "";
}

/**
 * Desktop Entry Exec has its own quoting, then field codes. Substitutions
 * are argv data and are never interpreted as shell source.
 */
function execArgv(exec: string, name: string, icon: string, path: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "", quoted = false, started = false;
	for (let i = 0; i < exec.length; i++) {
		const c = exec[i]!;
		if (c === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(c)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			if (c === "\\") {
				const next = exec[i + 1];
				if (next === undefined) return;
				if (!quoted || /["`$\\]/.test(next)) {
					token += next;
					i++;
				} else token += c;
			} else token += c;
			started = true;
		}
	}
	if (quoted) return;
	if (started) tokens.push(token);
	const file = tokens.shift();
	if (!file || !validExecutable(file) || file.replaceAll("%%", "").includes("%")) return;
	const argv = [file.replaceAll("%%", "%")];
	let size = utf8.encode(argv[0]!).length + 3, openedFiles = 0;
	if (size > MAX_ARGV) return;
	for (const word of tokens) {
		if (word === "%i") {
			if (icon) {
				size += utf8.encode(icon).length + 12;
				if (size > MAX_ARGV) return;
				argv.push("--icon", icon);
			}
			continue;
		}
		let arg = "";
		for (let i = 0; i < word.length; i++) {
			const c = word[i]!;
			if (size + arg.length >= MAX_ARGV) return;
			if (c !== "%") { arg += c; continue; }
			switch (word[++i]) {
				case "%": arg += "%"; break;
				case "c": arg += name; break;
				case "k": arg += path; break;
				case "F": case "U":
					if (word.length !== 2) return;
					// fall through
				case "f": case "u":
					if (++openedFiles > 1) return;
					break;
				case "d": case "D": case "n": case "N": case "v": case "m": break;
				default: return;
			}
		}
		if (arg || !word) {
			size += utf8.encode(arg).length + 3;
			if (size > MAX_ARGV) return;
			argv.push(arg);
		}
	}
	return argv;
}

function validExecutable(path: string): boolean {
	return !/[=\0]/.test(path) && (path.startsWith("/") || !path.includes("/"));
}

function readEntry(id: string, path: string, source: string, desktops: string[], locale: string): DesktopEntry | undefined {
	if (utf8.encode(source).length > MAX_ENTRY || /[\0\x7f]/.test(source)) return;
	const values = new Map<string, string>();
	let main = false;
	for (const line of source.split("\n")) {
		const s = line.trim(), key = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/.exec(s);
		if (s.startsWith("[")) {
			if (main) break;
			main = s === "[Desktop Entry]";
		} else if (main && key && !values.has(key[1]!)) {
			values.set(key[1]!, unescapeValue(key[2]!));
		}
	}
	const enabled = (key: string) => values.get(key) === "true";
	if (values.get("Type") !== "Application" || enabled("Hidden") || enabled("NoDisplay")) return;
	const only = values.get("OnlyShowIn")?.split(";"), never = values.get("NotShowIn")?.split(";");
	const match = desktops.find((d) => only?.includes(d) || never?.includes(d));
	if (match ? never?.includes(match) : only !== undefined) return;
	const title = localized(values, "Name", locale).trim(), exec = values.get("Exec");
	if (!values.get("Name") || !title || !exec) return;
	const cwd = values.get("Path") ?? "", tryExec = values.get("TryExec") ?? "";
	if ((cwd && !cwd.startsWith("/")) || !validExecutable(tryExec)) return;
	const argv = execArgv(exec, title, values.get("Icon") ?? "", path);
	if (!argv) return;
	return {
		id, title, argv, cwd, tryExec,
		description: (localized(values, "Comment", locale) || localized(values, "GenericName", locale)).slice(0, 512),
		startupClass: values.get("StartupWMClass") ?? "",
		terminal: enabled("Terminal"),
	};
}

/** Parse the ordered scan. Even a hidden entry masks its lower-priority copies. */
export function parseDesktopEntries(out: string): DesktopEntryCatalog {
	const header = out.indexOf(HEADER);
	if (header < 0) throw new Error("The guest returned an incomplete desktop entry list");
	const [revision, desktop, locale, ...entries] = out.slice(header + HEADER.length).split("\0");
	if (!revision || !out.endsWith("\0") || entries.length % 3 !== 1) throw new Error("The guest returned an incomplete desktop entry list");
	const desktops = desktop!.split(":").filter(Boolean);
	const seen = new Set<string>(), apps: DesktopEntry[] = [];
	for (let i = 0; i + 2 < entries.length; i += 3) {
		const id = entries[i]!.replaceAll("/", "-");
		if (seen.has(id)) continue;
		seen.add(id);
		const app = readEntry(id, entries[i + 1]!, entries[i + 2]!, desktops, locale!);
		if (app) apps.push(app);
	}
	return { revision, apps };
}

/** Look up an executable file using the same user's login PATH as the launch. */
const RESOLVE_EXEC = `resolve_exec() {
	case "$1" in
		/*) [ -f "$1" ] && [ -x "$1" ] && executable=$1 ;;
		*)
			path=$PATH:
			while [ -n "$path" ]; do
				dir=\${path%%:*}
				path=\${path#*:}
				case "$dir" in /*) ;; *) dir=$PWD/\${dir:-.} ;; esac
				if [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then
					executable=$dir/$1
					return 0
				fi
			done
			return 1 ;;
	esac
}`;

const CHECK_EXEC = `${RESOLVE_EXEC}
while IFS= read -r -d '' idx && IFS= read -r -d '' file &&
	IFS= read -r -d '' attempt && IFS= read -r -d '' cwd; do
	resolve_exec "$file" || continue
	[ -z "$attempt" ] || [ "$attempt" = "$file" ] || resolve_exec "$attempt" || continue
	[ -z "$cwd" ] || (CDPATH= cd "$cwd") 2>/dev/null || continue
	printf '\\0%s' "$idx"
done`;

/** Fixed shell source for login environment, working directory and terminal status. */
const RUN_DESKTOP_ENTRY = `${RESOLVE_EXEC}
run_app() {
	[ -z "$3" ] || resolve_exec "$3" || { printf 'Executable unavailable: %s\\n' "$3" >&2; return 127; }
	resolve_exec "$4" || { printf 'Executable unavailable: %s\\n' "$4" >&2; return 127; }
	[ -z "$2" ] || CDPATH= cd "$2" || return
	mode=$1
	shift 4
	if [ "$mode" = terminal ]; then
		"$executable" "$@"
	else
		/usr/lib/kw/bin/wland "$executable" "$@"
	fi
}
trap : INT
run_app "$@"
status=$?
[ "$status" -eq 0 ] && exit 0
printf '\\n[Application exited with status %s]\\n' "$status"
exec "\${SHELL:-/bin/sh}" -l`;

export function desktopEntryCommand(app: DesktopEntry): { file: string; args: string[] } {
	return {
		file: BUSYBOX,
		args: ["sh", "-lc", RUN_DESKTOP_ENTRY, "sh", app.terminal ? "terminal" : "wayland", app.cwd, app.tryExec, ...app.argv],
	};
}

export async function listDesktopEntries(
	vm: Pick<KernelHandle, "exec">, previous?: DesktopEntryCatalog,
): Promise<DesktopEntryCatalog> {
	const opts = { timeout: 8000, signal: AbortSignal.timeout(30_000), maxBuffer: MAX_SCAN };
	const scan = await vm.exec(BUSYBOX, ["sh", "-lc", SCAN_DESKTOP_ENTRIES, "sh", previous?.revision ?? ""], opts);
	if (scan.exitCode !== 0) throw new Error("The guest could not read its desktop entries");
	const catalog = parseDesktopEntries(scan.stdout);
	if (previous?.revision === catalog.revision) return previous;
	if (!catalog.apps.length) return catalog;
	const input = catalog.apps.map((app, i) => [i, app.argv[0], app.tryExec, app.cwd].join("\0") + "\0").join("");
	const available = await vm.exec(BUSYBOX, ["sh", "-lc", CHECK_EXEC], { ...opts, input });
	if (available.exitCode !== 0) throw new Error("The guest could not check its installed executables");
	const found = new Set(available.stdout.split("\0").slice(1));
	catalog.apps = catalog.apps.filter((_, i) => found.has(String(i))).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	return catalog;
}
