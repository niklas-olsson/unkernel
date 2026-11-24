// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson
import type { TerminalApp } from "../types.ts";
import { chromiumCommand, chromiumRuntime } from "../browsers/chromium.ts";

export default {
	id: "discord",
	title: "Discord",
	desc: "Discord in a Debian Chromium window. The first launch can take several minutes.",
	icon: "D",
	colors: ["#5865f2", "#3730a3"],
	...chromiumRuntime,
	// Chromium derives this ID from the app URL and the Default profile.
	waylandIds: ["chrome-discord.com__app-Default"],
	get commands() {
		// A separate persistent profile gives the Discord window its own browser process and lifetime.
		return [chromiumCommand('--user-data-dir="${XDG_CONFIG_HOME:-$HOME/.config}/unkernel-discord" --app=https://discord.com/app')];
	},
} satisfies TerminalApp;
