// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// About: credits, the licenses (/licenses.md, vite.config.ts
// unkernel:licenses) and the build (vite.config.ts's __KW_BUILD__: the base
// bundle's Linux release and where it came from; the distro image, the
// store's distro). AboutInfo is Settings' About section (Settings.tsx), which
// the top bar's Control Center (ControlCenter.tsx) and the prefix, a (keys.ts),
// open (openAbout()).
import type { ReactNode } from "react";
import { openSection } from "../sysapps.ts";
import { FORK_REPO, PAGE_COMMIT, PAGE_COMMIT_URL, REPO } from "../config.ts";
import { useStore } from "../store.ts";
import { Triangle } from "./icons.tsx";

const B = __KW_BUILD__;

const day = (iso: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

const A = ({ href, children }: { href: string; children: ReactNode }) => (
	<a href={href} target="_blank" rel="noopener" className="text-fg underline decoration-line-strong underline-offset-3 hover:decoration-fg">{children}</a>
);

function Row({ k, children }: { k: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-faint">{k}</dt>
			<dd className="min-w-0 break-words text-muted">{children}</dd>
		</>
	);
}

/** Open Settings on About (the top bar's Control Center, and the prefix, a). */
export function openAbout(): void {
	openSection("about");
}

/** The build and the credits (Settings' About section). */
export function AboutInfo() {
	const distro = useStore((s) => s.distro);
	return (
		<div id="about" className="leading-relaxed select-text">
			<p className="text-muted"><b className="font-semibold text-fg">unkernel</b>: Linux compiled to WebAssembly, running unmodified aarch64 user space in your browser tab.</p>
			<dl className="mt-4 grid grid-cols-[8ch_1fr] gap-x-4 gap-y-1 tabular-nums">
				<Row k="source"><A href={REPO}>github.com/pithings/unkernel</A></Row>
				{FORK_REPO && <Row k="fork"><A href={FORK_REPO}>{FORK_REPO.replace(/^https:\/\//, "")}</A></Row>}
				<Row k="kernel">Linux {B.linux || "?"}{B.kernel && <span className="text-faint">, {B.kernel === "local" ? "local build" : <A href={`${REPO}/releases/tag/${B.kernel}`}>{B.kernel}</A>}</span>}</Row>
				<Row k="distro">{distro ? <>{distro.image || distro.name}<span className="text-faint">, {distro.url}</span></> : "none (base shell)"}</Row>
				<Row k="commit">{PAGE_COMMIT_URL ? <A href={PAGE_COMMIT_URL}>{PAGE_COMMIT}</A> : PAGE_COMMIT || "dev"}{B.date && <span className="text-faint">, {day(B.date)}</span>}</Row>
			</dl>
			<p className="mt-4 text-[12px] text-muted">
				Built on <A href="https://kernel.org/">Linux</A>, <A href="https://github.com/joelseverin/linux-wasm">linux-wasm</A>,{" "}
				<A href="https://gitlab.freedesktop.org/virgl/virglrenderer">virglrenderer</A>, <A href="https://mesa3d.org/">Mesa</A>,{" "}
				<A href="https://emscripten.org/">Emscripten</A>, <A href="https://github.com/pithings/wland">wland</A>,{" "}
				<A href="https://wterm.dev/">wterm</A>, <A href="https://alpinelinux.org/">Alpine</A> and <A href="https://www.debian.org/">Debian</A>.
			</p>
			<p className="mt-5 border-t border-line pt-3 text-[12px] text-muted">
				Made with <span className="text-fg" aria-label="love">♥</span> by <A href="https://x.com/_pi0_">Pooya Parsa</A> (<A href="https://github.com/pi0">pi0</A>){" "}
				<span className="text-faint">· <A href={`${REPO}#-credits`}>full credits</A> · <A href="/licenses.md">licenses</A></span><br />
				sponsored by <A href="https://vercel.com/open-source-program"><span className="inline-flex items-center gap-1"><Triangle size={10} />Vercel</span></A>
			</p>
		</div>
	);
}
