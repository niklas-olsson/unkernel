// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Whether the desktop's resource widget (components/Widget.tsx) is shown:
// changed by its own button, kept in localStorage `kw.widget`
// ("1": shown; hidden by default).
import { useSyncExternalStore } from "react";
import { store } from "./prefs.ts";
import { createStore } from "./store.ts";

const $ = createStore<{ on: boolean }>({ on: store("widget") === "1" });

export const useWidget = (): boolean => useSyncExternalStore($.subscribe, () => $.get().on);

export function toggleWidget(): void {
	const on = !$.get().on;
	$.set({ on });
	store("widget", on ? "1" : "0");
}
