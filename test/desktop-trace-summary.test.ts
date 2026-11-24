// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson
import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileReport, ProfileSite } from "../js/core/profile.ts";
import { summarizeProfile } from "../web/src/trace-summary.ts";

function report(sites: ProfileSite[] = [], fields: Partial<ProfileReport> = {}): ProfileReport {
	return {
		version: 2, hz: 1000, timeSampling: true, insnPeriod: 1000000, durationMs: 0, cpus: 4,
		totals: { user: 0, kernel: 0, idle: 0, insns: 0, dropped: 0, ticks: 0, missed: 0 },
		where: { file: 0, anon: 0, noName: 0, unknown: 0, named: 0, maxFiles: 1024 },
		perCpu: [], comms: [], files: [], pages: [], sites, rows: [], procPages: [],
		...fields,
	};
}

function site(path: string, off: string, timeSamples: number, insnSamples: number, fields: Partial<ProfileSite> = {}): ProfileSite {
	return { path, off, timeSamples, insnSamples, comm: "cumulative-leader", processes: 10, ...fields };
}

test("subtracts cumulative samples by site identity and preserves interval metadata", () => {
	const binary = "/usr/bin/editor";
	const before = report([
		site(binary, "0x40", 30, 7, { tiers: { decoded: 30 } }),
		site("[anon]", "0x40", 1, 1, { pid: 8, tiers: { compiled: 1 } }),
		site("[anon]", "0x40", 4, 0, { pid: 9, tiers: { compiled: 4 } }),
	], { durationMs: 1000, totals: { user: 35, kernel: 9, idle: 4, insns: 8, dropped: 1, ticks: 400, missed: 30 } });
	const after = report([
		site("[anon]", "0x40", 4, 9, { pid: 9, tiers: { compiled: 4 } }),
		site(binary, "0x50", 1, 0, { tiers: { entry: 1 } }),
		site("[anon]", "0x40", 4, 2, { pid: 8, tiers: { compiled: 4 } }),
		site(binary, "0x40", 32, 10, { comm: "another-cumulative-leader", tiers: { decoded: 31, reference: 1 } }),
	], { durationMs: 1250, totals: { user: 41, kernel: 11, idle: 10, insns: 21, dropped: 3, ticks: 420, missed: 35 } });
	assert.deepEqual(summarizeProfile(before, after), {
		version: 2, durationMs: 250, cpus: 4, timeSampling: true, hz: 1000, insnPeriod: 1000000,
		totals: { user: 6, kernel: 2, idle: 6, insns: 13, dropped: 2, ticks: 20, missed: 5 },
		tiers: { decoded: 1, reference: 1, compiled: 3, entry: 1 },
		topUserSites: [
			{ path: "[anon]", off: "0x40", pid: 8, timeSamples: 3, insnSamples: 1 },
			{ path: binary, off: "0x40", timeSamples: 2, insnSamples: 3 },
			{ path: binary, off: "0x50", timeSamples: 1, insnSamples: 0 },
		],
		topInsnSites: [
			{ path: "[anon]", off: "0x40", pid: 9, timeSamples: 0, insnSamples: 9 },
			{ path: binary, off: "0x40", timeSamples: 2, insnSamples: 3 },
			{ path: "[anon]", off: "0x40", pid: 8, timeSamples: 3, insnSamples: 1 },
		],
	});
});

test("returns at most ten positive sites for each ranking and resolves ties consistently", () => {
	const paths = Array.from({ length: 12 }, (_, i) => `/${String(i).padStart(2, "0")}`);
	const sites = paths.map(path => site(path, "0x0", 1, 1));
	const values = [...sites, site("/retired", "0x0", 0, 100)];
	const summary = summarizeProfile(report(), report(values));
	assert.deepEqual(summary.topUserSites.map(s => s.path), paths.slice(0, 10));
	assert.deepEqual(summary.topInsnSites.map(s => s.path), ["/retired", ...paths.slice(0, 9)]);
	assert.deepEqual(summary, summarizeProfile(report(), report(values.toReversed())));
	assert.deepEqual(summarizeProfile(report(values), report(values)).topUserSites, []);
});

test("rejects incompatible settings and regressing counters", () => {
	const start = report([site("/bin/sh", "0x0", 2, 2, { tiers: { decoded: 2 } })], { durationMs: 50 });
	assert.throws(() => summarizeProfile(start, { ...start, cpus: 2 }), /Incompatible profiles: cpus/);
	assert.throws(() => summarizeProfile(start, { ...start, timeSampling: false }), /Incompatible profiles: timeSampling/);
	assert.throws(() => summarizeProfile(start, { ...start, hz: 100 }), /Incompatible profiles: hz/);
	assert.throws(() => summarizeProfile(start, { ...start, insnPeriod: 0 }), /Incompatible profiles: insnPeriod/);
	assert.throws(() => summarizeProfile(start, { ...start, durationMs: 49 }), /counter regressed: durationMs/);
	assert.throws(() => summarizeProfile({ ...start, totals: { ...start.totals, ticks: 2 } }, start), /counter regressed: totals\.ticks/);
	assert.throws(() => summarizeProfile(start, { ...start, sites: [] }), /Profile site disappeared/);
	assert.throws(() => summarizeProfile(start, { ...start, sites: [site("/bin/sh", "0x0", 1, 2)] }), /counter regressed: .*timeSamples/);
	assert.throws(() => summarizeProfile(start, { ...start, sites: [site("/bin/sh", "0x0", 2, 1)] }), /counter regressed: .*insnSamples/);
	assert.throws(() => summarizeProfile(start, { ...start, sites: [site("/bin/sh", "0x0", 3, 3, { tiers: { compiled: 3 } })] }), /counter regressed: .*tier decoded/);
	assert.throws(() => summarizeProfile(start, { ...start, sites: [...start.sites, ...start.sites] }), /Duplicate site in after/);
});

test("preserves elapsed interval and sampler coverage for empty reports", () => {
	const start = report([], { durationMs: 10 });
	const end = report([], { durationMs: 20 });
	const empty = summarizeProfile(start, end);
	assert.equal(empty.durationMs, 10);
	assert.deepEqual(empty.totals, start.totals);
	assert.deepEqual(empty.tiers, {});
	assert.deepEqual(empty.topUserSites, []);
	assert.deepEqual(empty.topInsnSites, []);
	assert.ok(!("timeSamplingError" in empty));

	const failure = "sampler exited";
	const unticked = { ...end, hz: 0, timeSampling: false, timeSamplingError: failure };
	assert.deepEqual(summarizeProfile(start, unticked), {
		...empty, hz: 0, timeSampling: false, timeSamplingError: failure,
	});
	assert.throws(() => summarizeProfile(start, { ...unticked, cpus: 2 }), /Incompatible profiles: cpus/);
	const withTicks = { ...start, totals: { ...start.totals, ticks: 2 } };
	assert.throws(() => summarizeProfile(withTicks, unticked), /Incompatible profiles: hz/);
	const startedFailure = { ...withTicks, durationMs: 25, timeSamplingError: failure };
	assert.equal(summarizeProfile(start, startedFailure).timeSamplingError, failure);
	assert.equal(summarizeProfile(start, startedFailure).timeSampling, true);
});
