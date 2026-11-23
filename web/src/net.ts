// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's guest network: the SDK's NetStack over Wisp servers, with the
// plain-HTTP hosts of the route table (config.ts DEFAULT_ROUTES) answered by
// fetch() (the SDK's fetchRoutes()).
import { DEFAULT_WISP_SERVERS, NetStack, fetchRoutes, wispBackend, type NetSpec } from "./sdk.ts";

/** Guest-visible host name to base URL; null or empty: none. */
type Routes = Record<string, string> | null;

interface BrowserNetOptions {
	enabled: boolean;
	servers: string[] | null;
	routes: Routes;
	udp?: boolean;
}

/**
 * The page's network: a NetStack whose backend is the fastest of the Wisp
 * servers (default: the SDK's DEFAULT_WISP_SERVERS; the project's server
 * accepts only page origins on its allow list), or none when `enabled` is
 * false (config.ts: `?net=0`, `?wisp=0`; `?wisp=URL[,URL...]` sets `servers`;
 * `routes` is config.ts DEFAULT_ROUTES unless `?routes=0`).
 */
export function browserNet(opts: BrowserNetOptions & { log?: (m: string) => void }): NetStack | undefined {
	if (!opts.enabled) return undefined;
	const wisp = wispBackend(opts.servers ?? [...DEFAULT_WISP_SERVERS], { udp: opts.udp, log: opts.log });
	const backend = opts.routes && Object.keys(opts.routes).length ? fetchRoutes(wisp, opts.routes, { log: opts.log }) : wisp;
	return new NetStack({ backend, log: opts.log });
}

/** The same network as a spec, for worker mode (?worker=1): the worker builds the NetStack and opens the WebSocket. */
export function browserNetSpec(opts: BrowserNetOptions): NetSpec | undefined {
	if (!opts.enabled) return undefined;
	return { kind: "net", backend: { kind: "wisp", servers: opts.servers ?? [...DEFAULT_WISP_SERVERS], udp: opts.udp, routes: opts.routes ?? undefined } };
}
