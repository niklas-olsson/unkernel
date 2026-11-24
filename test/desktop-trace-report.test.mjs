// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the unkernel contributors
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./desktop-trace-report.mjs", import.meta.url));
const span = (cat, name, ts, dur) => ({ ph: "X", pid: 1, tid: 1, cat, name, ts, dur });
const instant = (cat, name, ts, args) => ({ ph: "i", s: "t", pid: 1, tid: 1, cat, name, ts, args });

function fixture() {
	return {
		schemaVersion: 1,
		label: "editor",
		build: {
			linux: "7.3.4+", kernel: "local", repo: "", commit: "fixture", dirty: false, date: "",
			bootAsset: "/boot.js", kernelAsset: "/smp.wasm", distro: "debian", distroAsset: "/debian.erofs",
			imageId: "debian-fixture", worker: true, transport: "shared", jit: true, memoryMiB: 2048,
			userAgent: "test",
		},
		pageTimeOriginMs: 100000,
		droppedEvents: 0,
		traceEvents: [
			span("profile", "start snapshot", 0, 2000),
			span("workload", "editor", 2000, 100000),
			instant("input", "keydown", 12000),
			instant("wayland", "surface commit observed", 17000, {
				conn: 2, surface: 5, root: 5, width: 16, height: 32, format: "gpu", damageRects: 1,
				resource: 7, imageAvailable: false,
			}),
			span("profile", "end snapshot", 102000, 3000),
			span("profile", "summarize snapshots", 105000, 1000),
		],
		profile: {
			version: 2, durationMs: 105, hz: 100, cpus: 2, timeSampling: true, insnPeriod: 1000000,
			totals: { user: 8, kernel: 2, idle: 10, insns: 4, dropped: 0, ticks: 20, missed: 0 },
			tiers: { decoded: 8 },
			topUserSites: [{ path: "/bin/editor", off: "0x40", timeSamples: 2, insnSamples: 0 }],
			topInsnSites: [{ path: "[anon]", off: "0x80", pid: 3, timeSamples: 0, insnSamples: 1 }],
		},
	};
}

function runReport(t, contents) {
	const dir = mkdtempSync(join(tmpdir(), "desktop-trace-report-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "trace.json");
	writeFileSync(file, contents);
	const result = spawnSync(process.execPath, [cli, file], { encoding: "utf8", timeout: 5000 });
	assert.ifError(result.error);
	return result;
}

function report(t, trace) {
	const result = runReport(t, JSON.stringify(trace));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout);
}

test("reports sparse ranking coverage against the complete interval totals", t => {
	const trace = fixture();
	trace.build.kernelAsset = `/${"nested/".repeat(20)}smp.wasm`;
	const output = report(t, trace);
	assert.deepEqual(output.topUserSites, { sites: 1, shownSamples: 2, totalSamples: 8, percent: 25 });
	assert.deepEqual(output.topInsnSites, { sites: 1, shownSamples: 1, totalSamples: 4, percent: 25 });
	assert.equal(output.build.kernelAsset, trace.build.kernelAsset);
	assert.equal(output.build.imageId, trace.build.imageId);
	assert.equal(output.build.transport, trace.build.transport);
	assert.equal(Object.hasOwn(output.build, "glBundleSha256"), false);
	assert.equal(Object.hasOwn(output, "gl"), false);
	assert.equal(output.hostEvents.input.keydown, 1);
	assert.equal(output.hostEvents.waylandSurfaceCommits, 1);
	assert.equal(output.hostEvents.retained, 2);
	assert.deepEqual(output.hostEvents.spansMs, {
		startSnapshot: 2, workload: 100, endSnapshot: 3, summarizeSnapshots: 1,
	});
	assert.equal(output.durationMs, 105);
});

test("keeps absent input and each loss counter distinct, with null coverage for zero totals", t => {
	const trace = fixture();
	trace.traceEvents = trace.traceEvents.filter(event => event.cat !== "input");
	trace.droppedEvents = 5;
	Object.assign(trace.profile, { topUserSites: [], topInsnSites: [], tiers: {} });
	Object.assign(trace.profile.totals, { user: 0, insns: 0, missed: 3, dropped: 7 });

	const output = report(t, trace);
	const emptyCoverage = { sites: 0, shownSamples: 0, totalSamples: 0, percent: null };
	assert.deepEqual(output.topUserSites, emptyCoverage);
	assert.deepEqual(output.topInsnSites, emptyCoverage);
	assert.deepEqual(output.hostEvents.input, { keydown: 0, pointerdown: 0, wheel: 0, other: 0 });
	assert.equal(output.hostEvents.waylandSurfaceCommits, 1);
	assert.equal(output.hostEvents.dropped, 5);
	assert.equal(output.counters.missedTicks, 3);
	assert.equal(output.counters.ringDroppedSamples, 7);
});

test("keeps packaged virgl and reported WebGL state independent", t => {
	const digest = "b".repeat(64);
	const rows = [
		[null, "unavailable", null],
		[digest, "off", null],
		[digest, "idle", null],
		[digest, "ready", null],
		[digest, "ready", "ANGLE (Google, SwiftShader Device (Subzero), Vulkan)"],
		[digest, "ready", "ANGLE (NVIDIA, GeForce RTX 4060, D3D11)"],
	];
	for (const [glBundleSha256, state, webgl] of rows) {
		const trace = fixture();
		trace.build.glBundleSha256 = glBundleSha256;
		trace.gl = { state, webgl };
		const output = report(t, trace);
		assert.equal(output.build.glBundleSha256, glBundleSha256);
		assert.deepEqual(output.gl, { state, webgl });
	}
});

test("rejects unrelated JSON, unsupported versions, and malformed data", t => {
	const unsupportedProfile = fixture();
	unsupportedProfile.profile.version = 99;
	const trace = fixture();
	trace.profile.topUserSites[0].timeSamples = -1;
	const cases = [
		[JSON.stringify({ traceEvents: [] }), /schemaVersion 1/],
		[JSON.stringify({ ...fixture(), schemaVersion: 99 }), /schemaVersion 1/],
		[JSON.stringify(unsupportedProfile), /profile version 2/],
		["{", /Invalid JSON/],
		[JSON.stringify(trace), /profile\.topUserSites\[0\]\.timeSamples/],
	];
	for (const [contents, diagnostic] of cases) {
		const result = runReport(t, contents);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, diagnostic);
	}
});
