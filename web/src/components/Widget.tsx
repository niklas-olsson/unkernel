// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The desktop's resource widget (#desk-res): a slim right-aligned column
// straight on the wallpaper in the workspace's top right corner, under every
// window (Workspace.tsx; not in compact mode, where a window always covers
// it). A line per resource: its history fading in from the left (stats.ts,
// the last three minutes), then its value and name; the facts are in the
// tooltip. One tint for all (style.css .desk-widget: white, or black on a
// light wallpaper), amber from 85 % and red from 95 %. The disk only with a
// data disk, the network only when on, the GPU and Vulkan only while their
// renderer is loaded. Its button (#desk-res-toggle) hides the lines and
// stays, alone in the corner, to show them again (widget.ts keeps which). It
// takes the light samples; hidden, none. A press on it keeps the focus where
// it is (the terminal).
import { fmtBytes, fmtPct, fmtRate, fmtRateShort } from "../format.ts";
import { KW } from "../kw.ts";
import { useStats, type Point } from "../stats.ts";
import { useStore } from "../store.ts";
import { toggleWidget, useWidget } from "../widget.ts";
import { Spark, type Series } from "./Charts.tsx";
import { diskUse, GPU_STATE, gpuSeries, latest, VK_STATE, vkSeries } from "./Glance.tsx";
import { ActivityIcon, ChevronIcon } from "./icons.tsx";

const LINE = "var(--color-fg)", LINE2 = "var(--color-faint)";

/** A share's tone, as the top bar's meters. */
const tone = (v: number | null) => (v == null ? "" : v >= 0.95 ? "text-err" : v >= 0.85 ? "text-warn" : "");

function Line({ label, value, title, cls = "", points, series, max, fmt }: {
	label: string; value: string; title: string; cls?: string; points: Point[]; series: Series[]; max?: number; fmt: (v: number) => string;
}) {
	return (
		<div title={title} className="flex items-center justify-end gap-3">
			<div className="desk-spark w-24"><Spark bare points={points} height={20} max={max} fmt={fmt} label={label} series={series} /></div>
			<div className="min-w-14 text-right whitespace-nowrap">
				<div className={`font-sans text-[17px] leading-[19px] font-light tabular-nums ${cls || "text-fg"}`}>{value}</div>
				<div className="font-sans text-[10px] leading-[12px] text-faint">{label}</div>
			</div>
		</div>
	);
}

function Lines() {
	const st = useStats("lite");
	const disk = useStore((s) => s.disk);
	const g = !st.waiting && !st.idle ? st.guest : null;
	const why = st.idle ? `not sampled: ${st.idle}` : "waiting for the guest";
	const points = st.points;
	const cpu = g?.derived.cpu ?? null, load = g?.raw.load;
	const m = g?.raw.mem, used = m ? m.total - m.available : 0, mem = m && m.total > 0 ? used / m.total : null;
	const du = diskUse(st, disk), full = du ? du.used / du.size : null;
	const rx = g?.derived.rx ?? null, tx = g?.derived.tx ?? null;
	const gpu = st.gpu?.state === "ready" || st.gpu?.state === "lost" ? st.gpu : null, gs = gpu && gpuSeries(gpu), gv = gs && latest(points, gs.get);
	const vk = st.vk?.state === "ready" || st.vk?.state === "lost" ? st.vk : null, vs = vk && vkSeries(points), vv = vs && latest(points, vs.get);
	return (
		<div className="flex min-h-0 flex-col gap-2.5 overflow-hidden pr-3.5 pb-1">
			<Line label="CPU" value={cpu != null ? fmtPct(cpu) : "–"} cls={tone(cpu)} title={load ? `CPU · load ${load.one.toFixed(2)}` : `CPU: ${why}`}
				points={points} max={1} fmt={fmtPct} series={[{ get: (p) => p.cpu, label: "busy", color: LINE, area: true }]} />
			<Line label="Memory" value={mem != null ? fmtPct(mem) : "–"} cls={tone(mem)} title={m ? `Memory: ${fmtBytes(used)} of ${fmtBytes(m.total)}` : `Memory: ${why}`}
				points={points} max={m?.total} fmt={fmtBytes} series={[{ get: (p) => p.mem, label: "in use", color: LINE, area: true }]} />
			{du && <Line label="Disk" value={fmtPct(full!)} cls={tone(full)} title={`Data disk: ${fmtBytes(du.used)} of ${fmtBytes(du.size)}${du.exact ? "" : " written"}; the line is its reads and writes`}
				points={points} fmt={fmtRate} series={[{ get: (p) => p.rd, label: "read", color: LINE, area: true }, { get: (p) => p.wr, label: "write", color: LINE2 }]} />}
			{KW.config.net && <Line label="Network" value={rx != null && tx != null ? fmtRateShort(rx + tx) : "–"} title={rx != null && tx != null ? `Network: ↓ ${fmtRate(rx)} · ↑ ${fmtRate(tx)}` : `Network: ${why}`}
				points={points} fmt={fmtRate} series={[{ get: (p) => p.rx, label: "in", color: LINE, area: true }, { get: (p) => p.tx, label: "out", color: LINE2 }]} />}
			{gpu && gs && <Line label="GPU" value={gpu.state !== "ready" ? GPU_STATE[gpu.state] : gv != null ? gs.fmt(gv) : "–"} cls={gpu.state === "lost" ? "text-err" : ""} title={`GPU (guest GL): ${gs.label}`}
				points={points} fmt={gs.fmt} series={[{ get: gs.get, label: gs.label, color: LINE, area: true }]} />}
			{vk && vs && <Line label="Vulkan" value={vk.state !== "ready" ? VK_STATE[vk.state] : vv != null ? vs.fmt(vv) : "–"} cls={vk.state === "lost" ? "text-err" : ""} title={`Vulkan: ${vs.label}`}
				points={points} fmt={vs.fmt} series={[{ get: vs.get, label: vs.label, color: LINE, area: true }]} />}
		</div>
	);
}

export function ResourcesWidget() {
	const on = useWidget();
	const label = on ? "Hide resources" : "Show resources";
	return (
		<aside id="desk-res" aria-label="Resources widget" className="desk-widget flex flex-col select-none"
			onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
			<button id="desk-res-toggle" type="button" title={label} aria-label={label} aria-expanded={on} onClick={toggleWidget}
				className="mr-2 flex size-6 flex-none items-center justify-center self-end rounded-full text-faint transition-colors hover:bg-white/15 hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-white/50 focus-visible:outline-none pointer-coarse:size-(--hit)">
				{on ? <ChevronIcon size={13} /> : <ActivityIcon size={15} />}
			</button>
			{on && <Lines />}
		</aside>
	);
}
