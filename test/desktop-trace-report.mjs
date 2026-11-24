// SPDX-License-Identifier: MIT
// Copyright 2026 the unkernel contributors
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const usage = "Usage: node test/desktop-trace-report.mjs TRACE.json";
const tiers = ["none", "entry", "reference", "decoded", "compiled", "budget"];
const profileSpans = new Map([
	["start snapshot", "startSnapshot"],
	["end snapshot", "endSnapshot"],
	["summarize snapshots", "summarizeSnapshots"],
]);

function requireField(condition, field) {
	if (!condition) throw new Error(`Invalid trace field: ${field}`);
}

function object(value, field) {
	requireField(value !== null && typeof value === "object" && !Array.isArray(value), field);
	return value;
}

function count(value, field) {
	requireField(Number.isSafeInteger(value) && value >= 0, field);
	return value;
}

function boolean(value, field) {
	requireField(typeof value === "boolean", field);
	return value;
}

function savedText(value, field) {
	if (value === undefined || value === null) return null;
	requireField(typeof value === "string", field);
	return value;
}

function boundedText(text, limit) {
	return text !== null && text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function glObservation(value) {
	if (value === undefined) return undefined;
	const gl = object(value, "gl");
	requireField(["off", "unavailable", "idle", "loading", "ready", "lost", "failed"].includes(gl.state), "gl.state");
	return { state: gl.state, webgl: savedText(gl.webgl, "gl.webgl") };
}

function bundleDigest(value) {
	requireField(value == null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)), "build.glBundleSha256");
	return value;
}

function coverage(sites, metric, total, field) {
	requireField(Array.isArray(sites) && sites.length <= 10, field);
	let shown = 0;
	for (const [index, site] of sites.entries()) {
		const row = `${field}[${index}]`;
		shown += count(object(site, row)[metric], `${row}.${metric}`);
		requireField(shown <= total && Number.isSafeInteger(shown), field);
	}
	return { sites: sites.length, shownSamples: shown, totalSamples: total, percent: total ? shown / total * 100 : null };
}

function hostEvents(events, dropped, label) {
	requireField(Array.isArray(events), "traceEvents");
	const input = { keydown: 0, pointerdown: 0, wheel: 0, other: 0 };
	const result = {
		records: events.length, retained: 0, dropped: count(dropped, "droppedEvents"),
		input, waylandSurfaceCommits: 0, marks: 0, otherInstants: 0,
		spansMs: { startSnapshot: null, endSnapshot: null, summarizeSnapshots: null, workload: null },
	};
	for (const [index, event] of events.entries()) {
		const field = `traceEvents[${index}]`;
		object(event, field);
		requireField((event.ph === "X" || event.ph === "i") && typeof event.cat === "string" &&
			typeof event.name === "string" && Number.isFinite(event.ts), field);
		if (event.ph === "X") {
			const durationMs = count(event.dur, `${field}.dur`) / 1000;
			const span = event.cat === "profile" ? profileSpans.get(event.name) :
				event.cat === "workload" && event.name === label ? "workload" : undefined;
			if (span !== undefined) {
				requireField(result.spansMs[span] === null, field);
				result.spansMs[span] = durationMs;
			}
			continue;
		}
		result.retained++;
		if (event.cat === "input") input[Object.hasOwn(input, event.name) ? event.name : "other"]++;
		else if (event.cat === "wayland" && event.name === "surface commit observed") result.waylandSurfaceCommits++;
		else if (event.cat === "mark") result.marks++;
		else result.otherInstants++;
	}
	return result;
}

function summarize(trace) {
	object(trace, "root");
	if (trace.schemaVersion !== 1) throw new Error("Expected desktop trace schemaVersion 1");
	requireField(typeof trace.label === "string" && trace.label.length >= 1 && trace.label.length <= 128, "label");
	const build = object(trace.build, "build");
	const profile = object(trace.profile, "profile");
	if (profile.version !== 2) throw new Error("Expected desktop trace profile version 2");
	const totals = object(profile.totals, "profile.totals");
	const savedTiers = object(profile.tiers, "profile.tiers");
	const cpus = count(profile.cpus, "profile.cpus");
	requireField(cpus > 0, "profile.cpus");
	return {
		schemaVersion: trace.schemaVersion,
		label: trace.label,
		build: {
			commit: savedText(build.commit, "build.commit"),
			dirty: build.dirty == null ? null : boolean(build.dirty, "build.dirty"),
			kernel: savedText(build.kernel, "build.kernel"),
			kernelAsset: savedText(build.kernelAsset, "build.kernelAsset"),
			linux: savedText(build.linux, "build.linux"),
			imageId: savedText(build.imageId, "build.imageId"),
			transport: savedText(build.transport, "build.transport"),
			glBundleSha256: bundleDigest(build.glBundleSha256),
		},
		gl: glObservation(trace.gl),
		scope: "Whole guest across the snapshot interval. File-backed sites combine processes.",
		cpus,
		durationMs: count(profile.durationMs, "profile.durationMs"),
		sampling: {
			timeEnabled: boolean(profile.timeSampling, "profile.timeSampling"),
			hz: count(profile.hz, "profile.hz"),
			instructionPeriod: count(profile.insnPeriod, "profile.insnPeriod"),
			timeError: boundedText(savedText(profile.timeSamplingError, "profile.timeSamplingError"), 128),
		},
		topUserSites: coverage(profile.topUserSites, "timeSamples", count(totals.user, "profile.totals.user"), "profile.topUserSites"),
		topInsnSites: coverage(profile.topInsnSites, "insnSamples", count(totals.insns, "profile.totals.insns"), "profile.topInsnSites"),
		tiers: Object.fromEntries(tiers.filter(tier => Object.hasOwn(savedTiers, tier))
			.map(tier => [tier, count(savedTiers[tier], `profile.tiers.${tier}`)])),
		counters: {
			kernelTimeSamples: count(totals.kernel, "profile.totals.kernel"),
			idleTimeSamples: count(totals.idle, "profile.totals.idle"),
			ticks: count(totals.ticks, "profile.totals.ticks"),
			missedTicks: count(totals.missed, "profile.totals.missed"),
			ringDroppedSamples: count(totals.dropped, "profile.totals.dropped"),
		},
		hostEvents: hostEvents(trace.traceEvents, trace.droppedEvents, trace.label),
	};
}

try {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { help: { type: "boolean", short: "h" } },
	});
	if (values.help) {
		console.log(`${usage}\nSummarize a saved desktop trace as JSON. The trace is read-only.`);
	} else {
		if (positionals.length !== 1) throw new Error(usage);
		const input = await readFile(positionals[0], "utf8");
		let trace;
		try {
			trace = JSON.parse(input);
		} catch {
			throw new Error("Invalid JSON in desktop trace");
		}
		console.log(JSON.stringify(summarize(trace), null, 2));
	}
} catch (error) {
	console.error(`Desktop trace report: ${boundedText(error.message, 256)}`);
	process.exitCode = 1;
}
