// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson
import type { ProfileReport, ProfileSite, ProfileTier } from "../../js/core/profile.ts";

type SiteCounts = Pick<ProfileSite, "path" | "off" | "pid" | "timeSamples" | "insnSamples">;
type RankedSite = { key: string; counts: SiteCounts };
type SiteMetric = "timeSamples" | "insnSamples";
const TOP_SITES = 10;

function ranksAbove(a: RankedSite, b: RankedSite, metric: SiteMetric): boolean {
	const difference = a.counts[metric] - b.counts[metric];
	return difference > 0 || (difference === 0 && a.key < b.key);
}

// Keep only the sites that can appear in the output, even for a long capture.
function insertTop(top: RankedSite[], site: RankedSite, metric: SiteMetric): void {
	if (!site.counts[metric]) return;
	const cutoff = top[TOP_SITES - 1];
	if (cutoff && !ranksAbove(site, cutoff, metric)) return;
	const index = top.findIndex(row => ranksAbove(site, row, metric));
	top.splice(index === -1 ? top.length : index, 0, site);
	if (top.length > TOP_SITES) top.pop();
}

const tiersInOrder = ["none", "entry", "reference", "decoded", "compiled", "budget"] as const satisfies readonly ProfileTier[];
const siteKey = (site: ProfileSite) => JSON.stringify([site.path, site.pid ?? null, site.off]);

function delta(before: number, after: number, label: string): number {
	if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0)
		throw new Error(`Invalid profile counter: ${label}`);
	if (after < before) throw new Error(`Profile counter regressed: ${label} (${before} → ${after})`);
	return after - before;
}

/** Subtract cumulative reports from one boot. Keep the histogram in samples. */
export function summarizeProfile(before: ProfileReport, after: ProfileReport) {
	// A sampler failure before its first tick can clear the enabled settings
	// between snapshots. Once it ticks, the SDK retains historical counters.
	const failedBeforeTick = after.timeSamplingError !== undefined &&
		before.timeSampling && before.hz > 0 && !after.timeSampling && after.hz === 0 &&
		(["user", "kernel", "idle", "ticks", "missed"] as const).every(key => before.totals[key] === 0 && after.totals[key] === 0);
	for (const key of ["version", "hz", "timeSampling", "insnPeriod", "cpus"] as const) {
		if (before[key] === after[key] || (failedBeforeTick && (key === "hz" || key === "timeSampling"))) continue;
		throw new Error(`Incompatible profiles: ${key} differs (${before[key]} → ${after[key]})`);
	}
	const durationMs = delta(before.durationMs, after.durationMs, "durationMs");
	const a = before.totals, b = after.totals;
	const totals = {
		user: delta(a.user, b.user, "totals.user"),
		kernel: delta(a.kernel, b.kernel, "totals.kernel"),
		idle: delta(a.idle, b.idle, "totals.idle"),
		insns: delta(a.insns, b.insns, "totals.insns"),
		dropped: delta(a.dropped, b.dropped, "totals.dropped"),
		ticks: delta(a.ticks, b.ticks, "totals.ticks"),
		missed: delta(a.missed, b.missed, "totals.missed"),
	};
	const previous = new Map<string, ProfileSite>();
	for (const site of before.sites) {
		const key = siteKey(site);
		if (previous.has(key)) throw new Error(`Duplicate site in before profile: ${key}`);
		previous.set(key, site);
	}
	const seen = new Set<string>();
	const topUser: RankedSite[] = [], topInsn: RankedSite[] = [];
	const tiers: Partial<Record<ProfileTier, number>> = {};
	for (const site of after.sites) {
		const key = siteKey(site);
		if (seen.has(key)) throw new Error(`Duplicate site in after profile: ${key}`);
		seen.add(key);
		const prev = previous.get(key);
		previous.delete(key);
		const timeSamples = delta(prev?.timeSamples ?? 0, site.timeSamples, `${key} timeSamples`);
		const insnSamples = delta(prev?.insnSamples ?? 0, site.insnSamples, `${key} insnSamples`);
		for (const tier of tiersInOrder) {
			const n = delta(prev?.tiers?.[tier] ?? 0, site.tiers?.[tier] ?? 0, `${key} tier ${tier}`);
			if (n) tiers[tier] = (tiers[tier] ?? 0) + n;
		}
		const { path, off, pid } = site;
		if (timeSamples || insnSamples) {
			const ranked = { key, counts: { path, off, ...(pid === undefined ? {} : { pid }), timeSamples, insnSamples } };
			insertTop(topUser, ranked, "timeSamples");
			insertTop(topInsn, ranked, "insnSamples");
		}
	}
	if (previous.size) throw new Error(`Profile site disappeared: ${previous.keys().next().value}`);

	return {
		version: after.version, durationMs, cpus: after.cpus, timeSampling: after.timeSampling,
		hz: after.hz, insnPeriod: after.insnPeriod, totals, tiers,
		...(after.timeSamplingError === undefined ? {} : { timeSamplingError: after.timeSamplingError }),
		topUserSites: topUser.map(({ counts }) => counts), topInsnSites: topInsn.map(({ counts }) => counts),
	};
}
