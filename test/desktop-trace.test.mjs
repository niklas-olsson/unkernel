// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the unkernel contributors
import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTrace } from "../web/src/desktop-trace.ts";

const report = () => ({
	version: 2, durationMs: 0, hz: 100, cpus: 2, timeSampling: true, insnPeriod: 1000000,
	totals: { user: 0, kernel: 0, idle: 0, insns: 0, dropped: 0, ticks: 0, missed: 0 }, sites: [],
});
const guest = (profile) => ({ profile, exited: new Promise(() => {}) });

test("a failed or pending snapshot can never mix consecutive desktop captures", async () => {
	let next = Promise.withResolvers();
	const { api } = createDesktopTrace(guest(() => next.promise), {}, new EventTarget(), false);
	const first = api.start();
	await assert.rejects(api.start(), /already active/);
	next.reject(Error("worker stopped"));
	await assert.rejects(first, /worker stopped/);
	next = Promise.withResolvers();
	const second = api.start("app");
	next.resolve(report());
	await second;
	next = Promise.withResolvers();
	const end = api.stop();
	await assert.rejects(api.start(), /taking a profile/);
	next.reject(Error("export failed"));
	await assert.rejects(end, /export failed/);
	next = { promise: Promise.resolve(report()) };
	await api.start();
	assert.deepEqual((await api.stop()).profile.topUserSites, []);
});

test("the bounded trace counts overflow and keeps both snapshot brackets", async () => {
	const { api, onCommit } = createDesktopTrace(guest(report), {}, new EventTarget(), false);
	const commit = { conn: 2, surface: 5, root: 5, format: "gpu", width: 16, height: 32, gpu: { resource: 7 }, damage: [0, 0, 16, 32] };
	onCommit(commit);
	await api.start("typing");
	onCommit(commit);
	for (let i = 0; i < 2100; i++) api.mark("key");
	const trace = await api.stop();
	const instants = trace.traceEvents.filter(e => e.ph === "i");
	assert.equal(instants.length, 2048);
	assert.equal(trace.droppedEvents, 53);
	assert.deepEqual(instants[0].args, { conn: 2, surface: 5, root: 5, format: "gpu", width: 16, height: 32, damageRects: 1, resource: 7, imageAvailable: false });
	const [initial, workload, final] = trace.traceEvents.filter(e => e.ph === "X");
	assert.equal(initial.ts + initial.dur, workload.ts);
	assert.equal(workload.ts + workload.dur, final.ts);
	assert.ok(instants.every(e => e.ts >= workload.ts && e.ts <= final.ts));
	await api.start();
	assert.equal((await api.stop()).droppedEvents, 0);
});

test("records packaging and the GL status at stop without starting the renderer", async () => {
	const glBundleSha256 = "a".repeat(64);
	const vm = guest(report);
	const target = new EventTarget();
	for (const [requested, state] of [[false, "off"], [true, "unavailable"]]) {
		const { api } = createDesktopTrace(vm, { glBundleSha256: null }, target, requested);
		await api.start();
		const trace = await api.stop();
		assert.equal(trace.build.glBundleSha256, null);
		assert.deepEqual(trace.gl, { state, webgl: null });
	}

	let reads = 0;
	let status = { state: "idle", webgl: null };
	vm.gl = { get status() { reads++; return status; } };
	const { api } = createDesktopTrace(vm, { glBundleSha256 }, target, true);
	assert.equal(reads, 0);
	await api.start();
	assert.equal(reads, 0);
	const idle = await api.stop();
	assert.equal(reads, 1);
	assert.equal(idle.build.glBundleSha256, glBundleSha256);
	assert.deepEqual(idle.gl, { state: "idle", webgl: null });

	await api.start();
	assert.equal(reads, 1);
	status = { state: "ready", webgl: "ANGLE (NVIDIA, GeForce RTX 4060, D3D11)" };
	const active = await api.stop();
	assert.equal(reads, 2);
	assert.deepEqual(active.gl, status);
});
