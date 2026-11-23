// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson

import assert from "node:assert/strict";
import test from "node:test";
import { desktopEntryCommand, listDesktopEntries, parseDesktopEntries } from "../src/desktop-entries.ts";

function scan(entries: [string, string][], desktop = "unkernel:Other", locale = "fr_CA.UTF-8") {
	const records = entries.flatMap(([id, body]) => [id, `/apps/${id}`, body]);
	return parseDesktopEntries(["profile output\n", "KW desktop entries", "test revision", desktop, locale, ...records, ""].join("\0")).apps;
}

const application = (keys: string) => `[Desktop Entry]\nType=Application\nName=Test Application\nExec=foo %U\n${keys}`;

test("uses XDG precedence, including masked and nested entries, and filters visibility", () => {
	const apps = scan([
		["same.desktop", "[Desktop Entry]\nHidden=true"],
		["same.desktop", application("")],
		["nested/editor.desktop", application("Name[fr_CA]=Éditeur\nOnlyShowIn=unkernel;")],
		["nested-editor.desktop", application("")],
		["delegate.desktop", application("NoDisplay=true")],
		["hidden.desktop", application("NotShowIn=unkernel;")],
		["hidden-other.desktop", application("OnlyShowIn=GNOME;")],
		["allowed.desktop", application("NotShowIn=Other;\nOnlyShowIn=unkernel;")],
		["link.desktop", "[Desktop Entry]\nType=Link\nName=Link\nURL=https://example.com"],
		["activation.desktop", "[Desktop Entry]\nType=Application\nName=No Exec\nDBusActivatable=true"],
	]);
	assert.deepEqual(apps.map((a) => a.id), ["nested-editor.desktop", "allowed.desktop"]);
	assert.equal(apps[0]!.title, "Éditeur");
});

test("expands plain Exec into guest arguments and keeps guest text out of shell source", () => {
	const [app] = scan([["spaced editor.desktop", String.raw`[Desktop Entry]
Type=Application
Name=Text %f Editor
Name[fr]=Éditeur "rapide"
Icon=edit icon
Path=/work tree
Terminal=true
TryExec=/opt/my editor
Exec="/opt/my editor" --flag "a b" "" "one\\\\two" "literal\\$value" "a ; b" %u %i %c %k x%%y %m
[Desktop Action Other]
Exec=ignore`]]);
	assert.deepEqual(app!.argv, [
		"/opt/my editor", "--flag", "a b", "", "one\\two", "literal$value", "a ; b",
		"--icon", "edit icon", 'Éditeur "rapide"', "/apps/spaced editor.desktop", "x%y",
	]);
	assert.equal(app!.terminal, true);
	const command = desktopEntryCommand(app!);
	assert.deepEqual(command.args.slice(4), ["terminal", "/work tree", "/opt/my editor", ...app!.argv]);
	assert.doesNotMatch(command.args[2]!, /spaced editor|a ; b/);
	assert.equal(desktopEntryCommand({ ...app!, terminal: false }).args[4], "wayland");
});

test("rejects incomplete entries and invalid Exec field codes", () => {
	const values = ['foo "broken', "foo %z", "foo token%F", "foo %F %u", "foo token%i", "../foo", "foo=bar"];
	assert.deepEqual(scan(values.map((exec, i) => [`${i}.desktop`, `[Desktop Entry]\nType=Application\nName=Name\nExec=${exec}`])), []);
	assert.throws(() => parseDesktopEntries("\0KW desktop entries\0test revision\0desktop\0en\0file.desktop\0/app/file.desktop"), /incomplete/);
});

test("keeps the catalog when the guest reports the same revision", async () => {
	const previous = { revision: "123 456", apps: scan([["editor.desktop", application("")]]) };
	const calls: string[][] = [];
	const vm = {
		async exec(_file: string, args: string[]) {
			calls.push(args);
			return { exitCode: 0, signal: null, stdout: "\0KW desktop entries\0" + previous.revision + "\0\0C\0", stderr: "" };
		},
	} as Parameters<typeof listDesktopEntries>[0];
	assert.equal(await listDesktopEntries(vm, previous), previous);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.at(-1), previous.revision);
});
