#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Niklas Olsson
// Runs the browser input adapter and real wland wasm against a minimal Wayland
// client on an in-memory link. No dev server, kernel, guest image, or VM.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPage } from "../../web/test/lib.mjs";

async function browserProbe(createInput, createEngine, ROLE_POPUP) {
	const guest = document.querySelector("#guest");
	const other = document.querySelector("#other");
	const popup = document.querySelector("#popup");
	const conn = 1, surface = 6, pointer = 7, touch = 8, popupSurface = 9;
	const hit = { conn, surface, root: surface };
	const buttons = [], otherButtons = [], touchEvents = [], defaults = [];
	const globals = new Map();
	const u32 = (...words) => new Uint8Array(new Uint32Array(words).buffer);
	const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));
	function string(value) {
		const data = new TextEncoder().encode(value);
		const padded = new Uint8Array((data.length + 4) & ~3);
		padded.set(data);
		return bytes(u32(data.length + 1), padded);
	}
	function request(id, opcode, ...args) {
		const data = bytes(...args.map((arg) => typeof arg === "string" ? string(arg) : u32(arg)));
		return bytes(u32(id, ((data.length + 8) << 16) | opcode), data);
	}
	let link;
	const engine = await createEngine({
		wasm: "/wland/wland.wasm",
		onEvent() {},
		link: {
			start(callbacks) { link = callbacks; },
			send(data) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				for (let frame = 0; frame < data.length;) {
					if (data[frame] !== 1) throw new Error("Expected a Wayland wire frame");
					const id = view.getUint32(frame + 1, true);
					const end = frame + 9 + view.getUint32(frame + 5, true);
					for (let off = frame + 9; off < end;) {
						const object = view.getUint32(off, true);
						const word = view.getUint32(off + 4, true);
						const opcode = word & 0xffff;
						if (object === 2 && opcode === 0) {
							const name = view.getUint32(off + 8, true);
							const length = view.getUint32(off + 12, true);
							const iface = new TextDecoder().decode(data.subarray(off + 16, off + 15 + length));
							globals.set(iface, name);
						}
						if (object === pointer && opcode === 3) {
							(id === conn ? buttons : otherButtons).push([view.getUint32(off + 16, true), view.getUint32(off + 20, true)]);
						}
						if (id !== conn && object === touch) touchEvents.push(opcode);
						off += word >>> 16;
					}
					frame = end;
				}
			},
		},
	});
	engine.start();
	link.onOpen();
	function addClient(id) {
		link.onMessage(bytes([3], u32(id)).buffer);
		function send(...requests) {
			const wire = bytes(...requests);
			link.onMessage(bytes([1], u32(id, wire.length), wire).buffer);
		}
		send(request(1, 1, 2)); // wl_display.get_registry
		send(
			request(2, 0, globals.get("wl_compositor"), "wl_compositor", 1, 4),
			request(2, 0, globals.get("wl_seat"), "wl_seat", 1, 5),
			request(4, 0, surface), // wl_compositor.create_surface
			request(5, 0, pointer), // wl_seat.get_pointer
		);
		return send;
	}
	const sendGuest = addClient(conn);
	const sendOther = addClient(conn + 1);
	sendGuest(request(4, 0, popupSurface));
	window.bindTouch = () => sendOther(request(5, 2, touch));
	const surfaceOf = (el) => el === guest ? hit : el === other ? { ...hit, conn: conn + 1 } :
		el === popup ? { ...hit, surface: popupSurface, role: ROLE_POPUP } : null;
	const input = createInput({
		engine,
		container: guest,
		autoFocus: false,
		view: {
			surfaceOf,
			surfaceAt: (x, y) => {
				const under = surfaceOf(document.elementFromPoint(x, y));
				return under && { ...under, x, y };
			},
			canvas: (id) => id === conn ? guest : other,
			hitTarget: (id, sid) => id === conn ? (sid === popupSurface ? popup : guest) : other,
		},
	});
	for (const type of ["contextmenu", "auxclick"]) {
		document.addEventListener(type, (ev) => defaults.push([type, ev.target.id, ev.button, ev.defaultPrevented]));
	}
	// Match the page's WM interaction: take over after a delivered press.
	window.takeGrab = (pointerId) => input.grab(pointerId);
	document.addEventListener("pointerdown", (ev) => { window.lastPointer = ev.pointerId; });
	window.dropCapture = () => {
		if (!guest.hasPointerCapture(lastPointer)) throw new Error("Expected mouse capture");
		guest.releasePointerCapture(lastPointer);
	};
	window.cancelPointer = () => guest.dispatchEvent(new PointerEvent("pointercancel", {
		bubbles: true, pointerType: "mouse", pointerId: lastPointer,
	}));
	window.commitPopup = () => {
		if (!guest.hasPointerCapture(lastPointer)) throw new Error("Expected parent capture before popup");
		input.handle({ type: "commit", role: ROLE_POPUP, conn, surface: popupSurface });
	};
	window.read = () => ({ buttons: buttons.splice(0), otherButtons: otherButtons.splice(0),
		touch: touchEvents.splice(0), defaults: defaults.splice(0) });
	window.ready = true;
}

const dist = process.env.KW_WLAND_TEST_DIST ?? dirname(fileURLToPath(new URL("../../web/node_modules/wland/dist/engine.mjs", import.meta.url)));
const server = createServer(async (req, res) => {
	try {
		if (req.url.startsWith("/wland/")) {
			const file = req.url.slice(7);
			if (!/^[\w-]+\.(mjs|wasm)$/.test(file)) throw new Error("invalid module path");
			const data = await readFile(join(dist, file));
			res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
			return res.end(data);
		}
		res.setHeader("Content-Type", "text/html");
		res.end(`<div id="guest" style="position:absolute;inset:10px auto auto 10px;width:180px;height:120px;background:#ace"></div>
		<div id="host" style="position:absolute;inset:10px auto auto 210px;width:180px;height:120px;background:#eca"></div>
		<div id="other" style="position:absolute;inset:10px auto auto 410px;width:180px;height:120px;background:#cea"></div>
		<div id="popup" style="position:absolute;inset:10px auto auto 610px;width:180px;height:120px;background:#eac"></div>
		<script type="module">
			import { createInput } from "/wland/input.mjs";
			import { createEngine, ROLE_POPUP } from "/wland/engine.mjs";
			await (${browserProbe.toString()})(createInput, createEngine, ROLE_POPUP);
		</script>`);
	} catch (error) {
		res.writeHead(404);
		res.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let page;
try {
	page = await openPage("wland-mouse");
	await page.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
	await page.waitFor("window.ready", "wland input adapter", 5000);
	await page.evaluate('history.pushState({}, "", "#probe")');
	const guest = 60, host = 260, other = 460, popup = 660, y = 60;
	const mouse = async (type, button, buttons, x = guest) => {
		const response = await page.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
		assert.equal(response.error, undefined);
	};
	const click = async (button, mask, x = guest) => {
		await mouse("mouseMoved", "none", 0, x);
		await mouse("mousePressed", button, mask, x);
		await mouse("mouseReleased", button, 0, x);
	};
	const read = () => page.evaluate("read()");
	const pair = (code) => [[code, 1], [code, 0]];

	for (const [button, mask, dom, code] of [
		["left", 1, 0, 272], ["middle", 4, 1, 274], ["right", 2, 2, 273],
		["back", 8, 3, 275], ["forward", 16, 4, 276],
	]) {
		await click(button, mask);
		const seen = await read();
		assert.deepEqual(seen.buttons, pair(code), button);
		if (button !== "left") assert.ok(seen.defaults.some((e) => e[0] === "auxclick" && e[1] === "guest" && e[2] === dom && e[3]), JSON.stringify(seen));
		if (button === "right") assert.ok(seen.defaults.some((e) => e[0] === "contextmenu" && e[3]), JSON.stringify(seen));
	}
	// Both release orders, including a stationary chord and a captured chord
	// with the cursor over host chrome.
	await mouse("mousePressed", "left", 1);
	await mouse("mousePressed", "right", 3);
	await mouse("mouseReleased", "left", 2);
	await mouse("mouseReleased", "right", 0);
	assert.deepEqual((await read()).buttons, [[272, 1], [273, 1], [272, 0], [273, 0]]);
	await mouse("mousePressed", "left", 1);
	await mouse("mousePressed", "back", 9);
	await mouse("mouseMoved", "left", 9, host);
	await mouse("mouseReleased", "back", 1, host);
	await mouse("mouseReleased", "left", 0, host);
	assert.deepEqual((await read()).buttons, [[272, 1], [275, 1], [275, 0], [272, 0]]);
	assert.equal(await page.evaluate("location.hash"), "#probe", "guest side buttons keep host history");

	await mouse("mouseMoved", "none", 0);
	await mouse("mousePressed", "left", 1);
	assert.equal(await page.evaluate("takeGrab(lastPointer).active"), true);
	await mouse("mousePressed", "right", 3);
	await mouse("mouseReleased", "right", 1);
	await mouse("mouseReleased", "left", 0);
	assert.deepEqual((await read()).buttons, [[272, 1]], "window grab swallows remaining events");

	for (const [label, interrupt] of [
		["pointercancel", "cancelPointer()"],
		["window blur", 'window.dispatchEvent(new Event("blur"))'],
		["capture loss", "dropCapture()"],
	]) {
		await mouse("mouseMoved", "none", 0, host);
		await mouse("mouseMoved", "none", 0);
		await mouse("mousePressed", "left", 1);
		await mouse("mousePressed", "forward", 17);
		assert.deepEqual((await read()).buttons, [[272, 1], [276, 1]], label);
		await page.evaluate(interrupt);
		await mouse("mouseMoved", "left", 17, other);
		let seen = await read();
		assert.deepEqual(seen.buttons, [[272, 0], [276, 0]], label);
		assert.deepEqual(seen.otherButtons, [], label);
		await mouse("mouseReleased", "left", 16, other);
		await mouse("mouseReleased", "forward", 0, other);
		seen = await read();
		assert.deepEqual(seen.buttons, [], label);
		assert.deepEqual(seen.otherButtons, [], label);
		await click("right", 2, other);
		assert.deepEqual((await read()).otherButtons, pair(273), label);
	}

	// The non-mouse PointerEvent path still uses the existing down/up routing.
	await mouse("mouseMoved", "none", 0, host);
	for (const [type, buttons] of [["mousePressed", 1], ["mouseReleased", 0]]) {
		const response = await page.send("Input.dispatchMouseEvent", {
			type, x: guest, y, button: "left", buttons, pointerType: "pen", clickCount: 1,
		});
		assert.equal(response.error, undefined);
	}
	assert.deepEqual((await read()).buttons, pair(272), "pen tap");
	for (const [type, touchPoints] of [["touchStart", [{ x: guest, y }]], ["touchEnd", []]]) {
		const response = await page.send("Input.dispatchTouchEvent", { type, touchPoints });
		assert.equal(response.error, undefined);
	}
	assert.deepEqual((await read()).buttons, pair(272), "touch fallback tap");

	await page.evaluate("bindTouch()");
	for (const [type, touchPoints] of [["touchStart", [{ x: other, y }]], ["touchEnd", []]]) {
		await page.send("Input.dispatchTouchEvent", { type, touchPoints });
	}
	const touch = await read();
	assert.deepEqual(touch.otherButtons, [], "bound touch doesn't send pointer buttons");
	assert.deepEqual(touch.touch, [0, 3, 1, 3], "bound wl_touch down/frame/up/frame");

	// A popup commit voluntarily drops DOM capture. Physical motion onto the
	// new same-client surface must preserve the original held press.
	await mouse("mouseMoved", "none", 0, guest);
	await mouse("mousePressed", "left", 1, guest);
	await page.evaluate("commitPopup()");
	await mouse("mouseMoved", "none", 1, popup);
	assert.deepEqual((await read()).buttons, [[272, 1]], "popup motion keeps the Wayland button pressed");
	await mouse("mouseReleased", "left", 0, popup);
	assert.deepEqual((await read()).buttons, [[272, 0]], "actual release reaches the popup client");

	// Moving out to a different client after the handoff still abandons the
	// old gesture, and the later physical release reaches neither client.
	await mouse("mouseMoved", "none", 0, guest);
	await mouse("mousePressed", "left", 1, guest);
	await page.evaluate("commitPopup()");
	await mouse("mouseMoved", "none", 1, other);
	let crossed = await read();
	assert.deepEqual(crossed.buttons, pair(272), "cross-client exit releases the original press");
	assert.deepEqual(crossed.otherButtons, []);
	await mouse("mouseReleased", "left", 0, other);
	crossed = await read();
	assert.deepEqual(crossed.buttons, []);
	assert.deepEqual(crossed.otherButtons, []);

	await click("right", 2, host);
	await click("middle", 4, host);
	await click("back", 8, host);
	await page.waitFor('location.hash === ""', "host back navigation", 2000);
	await click("forward", 16, host);
	await page.waitFor('location.hash === "#probe"', "host forward navigation", 2000);
	const chrome = await read();
	assert.deepEqual(chrome.buttons, []);
	assert.equal(chrome.defaults.length, 5);
	assert.ok(chrome.defaults.every(([, id, , prevented]) => id === "host" && !prevented), JSON.stringify(chrome));
	assert.deepEqual(page.exceptions, []);
	console.log("PASS wland mouse routing, Wayland button wire, chords, cancellation, capture loss, window grab, popup handoff, bound touch and browser defaults");
} finally {
	await page?.close();
	await new Promise((resolve) => server.close(resolve));
}
