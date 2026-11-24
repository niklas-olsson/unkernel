// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The wallpaper layer (desktop.ts has the state): the first child of #app,
// under everything in it (z-index -1 in #app's stacking context, so over
// #app's own background, the default wallpaper, and under the desktop, the
// top bar and the Dock). Out of the flow, so it takes no part in the
// workspace's size; no pointer events, no backdrop filter, nothing that
// changes while windows move: a still layer. A new wallpaper fades in over
// the one before, which goes once the fade is over; a photo gets the dim
// (a black overlay) over it. Nothing is drawn for the default.
// WallpaperCredit: the photo's credit, its author's name linking to its
// Unsplash page, small and faint in the page's bottom right corner (Dock.tsx
// renders it in #dock's strip, under the pill; in compact mode, where the pill
// reaches the corner, Workspace.tsx does in #workspace, under every window;
// style.css .wp-credit, tinted by data-wallpaper). From the photo's data at hand (desktop.ts Shown.photo: the
// curated list, More's list, the cache's header), no request; none for
// presets, the default or a photo without an author.
import { useEffect, useRef, useState } from "react";
import { photoLink, startDesktop, useDesktop, type Shown } from "../desktop.ts";

/** How long a new wallpaper takes to fade in (style.css .wp-in), and a margin. */
const FADE_MS = 600;

export function Wallpaper() {
	const shown = useDesktop((s) => s.shown);
	const dim = useDesktop((s) => s.prefs.dim);
	const [layers, setLayers] = useState<{ id: number; s: Shown }[]>([]);
	const seq = useRef(0);

	useEffect(startDesktop, []);
	useEffect(() => {
		if (!shown) return;
		const id = ++seq.current;
		setLayers((l) => [...l.slice(-1), { id, s: shown }]);
		const t = setTimeout(() => setLayers((l) => l.filter((x) => x.id >= id)), FADE_MS);
		return () => clearTimeout(t);
	}, [shown]);

	const photo = !!shown?.url;
	if (!layers.length || shown?.key === "default" && layers.length === 1) return null;
	return (
		<div id="wallpaper" aria-hidden="true" className="wallpaper">
			{layers.map(({ id, s }, i) => s.key === "default" ? <div key={id} className={i ? "wp-in wp-default" : "wp-default"} />
				: s.url ? <img key={id} src={s.blurUrl ?? s.url} alt="" draggable={false} className={i ? "wp-in" : undefined} />
				: <div key={id} className={i ? "wp-in" : undefined} style={{ background: s.css }} />)}
			{photo && <div className="wp-dim" style={{ backgroundColor: `rgb(0 0 0 / ${Math.round(dim * 100)}%)` }} />}
		</div>
	);
}

export function WallpaperCredit() {
	const photo = useDesktop((s) => (s.shown?.url ? s.shown.photo : undefined));
	if (!photo?.author) return null;
	return (
		<a className="wp-credit" href={photoLink(photo)} target="_blank" rel="noopener noreferrer" title={`Photo by ${photo.author} on Unsplash`}
			draggable={false}>{photo.author}</a>
	);
}
