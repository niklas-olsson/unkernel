// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// llama.cpp: a language model on the guest's Vulkan, which here is this
// browser's WebGPU (guest Vulkan: the base's ICD, .agents/vk.md). ggml's
// Vulkan backend runs every layer on the GPU (-ngl 99); the guest's CPU
// only samples. Debian only (the ICD links glibc).
//
// Nothing of llama.cpp is in the page. Debian 13 has no llama.cpp (forky
// and sid have it, built against glibc 2.43; trixie-backports has only
// ggml), so llama.sh fetches llama.cpp's own release build for Ubuntu on
// arm64 with the Vulkan backend (the URL and SHA-256 below are this app's
// pin; MIT), checks it and unpacks it into ~/.local/share/llama.cpp/<tag>
// (77 MiB) on its first run: the guest's own https over the page's
// network, since github.com sends no CORS headers and serves https only,
// so the page cannot fetch it (download.ts). 29 MiB took 3 s on
// 2026-11-24 (the default Wisp server). It needs libgomp1 and libssl3t64
// besides the Vulkan loader, which the installer puts in, with
// vulkan-tools for the check that the guest sees kwvk. Its shaders (an
// older glslang's) need the translator's rule for member-only NonWritable
// (vk.md, Translator): with a kwvk-naga.wasm from before it, WebGPU refuses
// llama's first submit and the device is lost.
//
// The model is stories260K (Andrej Karpathy's tinyllamas, trained on
// TinyStories; MIT; the GGUF from ggml-org's models repository on Hugging
// Face, which sends CORS headers): F32, 1.1 MiB, fetched by the page into
// the installer (`downloads`, cached in the browser) and kept in the app's
// directory on the data disk. It writes short children's stories, often
// ungrammatical: a demo of the GPU path, not of a useful model. F32
// because quantized models (q4_0, q8_0 ...) abort: ggml's shaders for them
// do not translate to WGSL yet (vk.md, Unsupported). Larger F32 models
// also want the norm shaders' 512-invocation workgroups, which software
// WebGPU (SwiftShader: 256) refuses, so MODEL=stories15M (F32, 94 MiB) and
// other GGUFs (MODEL=PATH or MODEL=https://...) are for a real GPU, and
// untried on one. stories260K has no chat template, so llama-completion
// writes stories without end (no token limit, the context shifted when
// full, end-of-text ignored), or with TURNS=1 continues the text the user
// types (interactive mode); a model with a template gets its chat
// (conversation mode).
// llama-cli of this release is a chat client only.
//
// llama.sh keeps llama's log in llama.log and shows only the device, the
// errors and, at the end, the timings (tokens per second). A loud failure
// of guest Vulkan (a refused pipeline aborts ggml, vk.md, Errors) gets a
// one-line hint. On 2026-11-24 (the tile on the dev server, headless
// Chromium on SwiftShader, one CPU) stories260K loaded in 5.7-8.9 s and
// generated 5.1-6.9 tokens/s (0.25 on the emulated CPU, -ngl 0).
import type { TerminalApp } from "../types.ts";

const VER = "b12674";
const TARBALL = `https://github.com/ggml-org/llama.cpp/releases/download/${VER}/llama-${VER}-bin-ubuntu-vulkan-arm64.tar.gz`;
const TARBALL_MIRROR = `github/ggml-org/llama.cpp/releases/download/${VER}/llama-${VER}-bin-ubuntu-vulkan-arm64.tar.gz`;
const TARBALL_SHA256 = "b909ff920a08a751c79d3d09a335be2b939bc8f73d3bd2841d9fa21dc136b9f8";
const MODELS = "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas";
const MODEL_SHA256 = "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d";
const MODEL_SIZE = 1185376;

const LLAMA_SH = String.raw`#!/bin/bash
# llama.cpp with its Vulkan backend on guest Vulkan (kwvk: this page's
# WebGPU). Written by the unkernel launcher's llama.cpp app.
#   ./llama.sh                       stories260K (F32, 1.1 MiB): stories without end
#   TURNS=1 ./llama.sh               the same model continues what you type, a turn at a time
#   MODEL=stories15M ./llama.sh      F32, 94 MiB: better stories, needs a real GPU
#   MODEL=PATH.gguf ./llama.sh       any GGUF here, or MODEL=https://.../x.gguf
#   ./llama.sh ARGS...               more llama-completion arguments (-n 256, --temp 0)
# Quantized models (q4_0, q8_0 ...) abort on guest Vulkan for now: use F32.
set -e
VER=${VER}
URL=${TARBALL}
MURL_GH=${TARBALL_MIRROR}
SHA=${TARBALL_SHA256}
# Downloads try the page's mirror first: plain HTTP to mirror.unkernel.dev is
# answered by the page's fetch() (config.ts DEFAULT_ROUTES), not carried over
# the network relay; then the upstream itself. dl UPSTREAM MIRROR_PATH CURL_ARGS...
MIRROR=http://mirror.unkernel.dev
dl() {
	local up=$1 mp=$2
	shift 2
	curl "$@" "$MIRROR/$mp" || curl "$@" "$up"
}
DIR=$HOME/.local/share/llama.cpp/$VER
LOG=$PWD/llama.log
D='\033[90m' B='\033[1m' R='\033[31m' N='\033[0m'
say() { printf "$D%s$N\n" "$*"; }
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }

# Guest Vulkan: the base's ICD, and a device named kwvk.
[ -e /usr/share/vulkan/icd.d/kw_icd.json ] || die "This guest has no kwvk ICD (/usr/share/vulkan/icd.d/kw_icd.json): the page's kernel bundle has no guest Vulkan."
# Twice: a program after a lost WebGPU device gets a new one.
for try in 1 2; do
	vi=$(vulkaninfo --summary 2>&1) || true
	dev=$(printf '%s\n' "$vi" | sed -n 's/^[[:space:]]*deviceName[[:space:]]*=[[:space:]]*//p' | head -n 1)
	case $dev in *kwvk*) break ;; esac
done
case $dev in
*kwvk*) say "Vulkan device: $dev" ;;
*)
	printf '%s\n' "$vi" | grep -a '^kwvk:' >&2 || true
	die "vulkaninfo names no kwvk device: turn on Guest Vulkan (Settings, Display and sound; it needs WebGPU), then run ./llama.sh again."
	;;
esac

# llama.cpp's release build, once.
if [ ! -x "$DIR/llama-completion" ]; then
	free=$(df -Pk "$HOME" | awk 'NR == 2 { print int($4 / 1024) }')
	[ "$free" -ge 120 ] || die "llama.cpp needs 120 MiB on the disk, $free MiB free."
	printf "$B%s$N\n" "Fetching llama.cpp $VER (Vulkan, arm64: 29 MiB, 77 MiB unpacked) from GitHub"
	rm -rf "$DIR.part" && mkdir -p "$DIR.part"
	dl "$URL" "$MURL_GH" -fL# -o "$DIR.part/llama.tar.gz"
	echo "$SHA  $DIR.part/llama.tar.gz" | sha256sum -c --quiet || { rm -rf "$DIR.part"; die "llama.cpp: wrong SHA-256, deleted"; }
	tar xzf "$DIR.part/llama.tar.gz" -C "$DIR.part" --strip-components=1
	rm "$DIR.part/llama.tar.gz" && mv "$DIR.part" "$DIR"
	say "llama.cpp $VER is in $DIR"
fi

# The model: the page fetched stories260K into models/; else get it here.
M=$MODEL
[ -n "$M" ] || M=stories260K
case $M in
stories260K) F=models/stories260K.gguf MURL=${MODELS}/stories260K.gguf MSHA=${MODEL_SHA256} ;;
stories15M) F=models/stories15M.gguf MURL=${MODELS}/stories15M.gguf MSHA=61b50d457809a5194818fd22e6724b456cd7bb9a6264c52c8110684c53f3704a ;;
http://* | https://*) F=models/$(basename "$(printf %s "$M" | sed 's/[?#].*//')") MURL=$M MSHA= ;;
*) F=$M MURL= MSHA= ;;
esac
if [ ! -s "$F" ]; then
	[ -n "$MURL" ] || die "No model at $F"
	printf "$B%s$N\n" "Fetching $MURL"
	mkdir -p "$(dirname "$F")"
	curl -fL# -o "$F.part" "$MURL"
	[ -z "$MSHA" ] || echo "$MSHA  $F.part" | sha256sum -c --quiet || { rm -f "$F.part"; die "$F: wrong SHA-256, deleted"; }
	mv "$F.part" "$F"
fi
case $(basename "$F") in *[Qq][2-8]_* | *[Ii][Qq][1-4]*) say "A quantized model: these abort on guest Vulkan for now (their shaders do not translate yet); F32 ones run." ;; esac

# A model with a chat template chats; one without continues your text.
if head -c 16777216 "$F" | grep -qa tokenizer.chat_template; then
	say "Chat with $F: type a message and press Enter."
	set -- -cnv -n 128 "$@"
elif [ -n "$TURNS" ]; then
	say "$F continues a story: it starts one, then whatever you type is added to it (Enter), up to 128 tokens a turn."
	set -- -no-cnv -i -n 128 -p "Once upon a time" --in-prefix ' ' "$@"
else
	# Without end: no token limit, the context shifted when it is full, and
	# the end-of-story token not taken, so one story follows another.
	say "$F writes stories without end, one after another (TURNS=1 ./llama.sh: you type and it continues, a turn at a time)."
	set -- -no-cnv -n -1 --context-shift --ignore-eos -p "Once upon a time" "$@"
fi
say "Ctrl-C quits and prints the speed (eval time: tokens per second); in a chat or with TURNS=1 it first stops a reply. The full log: llama.log"
# llama logs to stderr: the device, errors and the timings are shown, the rest stays in llama.log.
SHOW='kwvk|ggml_vulkan: [0-9]+ = |error|failed|abort|lost|load time|prompt eval time|eval time|Interrupted'
# (bash's own "Aborted" line goes to /dev/null: the hint below says more.)
exec 3>&2
set +e
{
	"$DIR/llama-completion" -m "$F" -ngl 99 -fit off -c 512 --temp 0.8 \
		--log-colors off --no-log-prefix --no-log-timestamps "$@" \
		2> >(trap '' INT; tee "$LOG" | grep --line-buffered -aE "$SHOW" >&3)
	st=$?
} 2>/dev/null
wait $! 2>/dev/null
set -e
case $st in
0 | 130) ;; # done, or quit with Ctrl-C
*)
	if grep -qaE 'pipeline creation failed|ErrorInvalidShaderNV|ErrorFeatureNotPresent' "$LOG"; then
		die "Hint: guest Vulkan refused one of this model's shaders (quantized types, or workgroups wider than this WebGPU allows); try an F32 model such as the default stories260K."
	elif grep -qa 'device lost' "$LOG"; then
		die "Hint: the WebGPU device was lost; run ./llama.sh again (it gets a new one)."
	fi
	die "llama-completion ended with status $st (llama.log has its log)."
	;;
esac
`;

export default {
	id: "llama",
	title: "llama.cpp",
	desc: "A language model on the GPU: llama.cpp's Vulkan backend on this browser's WebGPU (guest Vulkan); a tiny story model (1.1 MiB) and llama.cpp (29 MiB) on first run",
	// A llama's head and neck in profile, its ears up (crafted).
	icon: { svg: '<path d="M8.6 6.4 8.4 2.6Q8.5 1.6 9.3 2.2l1.3 3.4h1l.6-3.3q.4-.8 1 .1l.1 3.8q1.1.7 1.9 1.8l2.2 1.1q1 .5.6 1.6l-.4 1q-.4.7-1.2.5l-3-.6v9.9H8.2v-9.7q-1-1.2-.9-2.9.1-1.6 1.3-2.5Z"/><circle cx="12.2" cy="8.4" r=".8" fill="#ac162c"/>' },
	colors: ["#ac162c", "#14532d"],
	needs: { net: true, vk: true },
	packages: { debian: ["libvulkan1", "vulkan-tools", "libgomp1", "libssl3t64", "curl", "ca-certificates"] },
	terminal: "window",
	files: {
		"llama.sh": { content: LLAMA_SH, mode: 0o755 },
		README: "llama.cpp runs this model on the guest's Vulkan, which is this browser's WebGPU\n" +
			"(guest Vulkan in Options): every layer on the GPU (-ngl 99). stories260K is a\n" +
			"tiny F32 story model (1.1 MiB): expect odd children's stories, without end\n" +
			"until Ctrl-C. Quantized\n" +
			"models (q4_0 ...) abort on guest Vulkan for now; F32 ones run. More to try:\n" +
			"  MODEL=stories15M ./llama.sh           (F32, 94 MiB; needs a GPU, not software WebGPU)\n" +
			"  MODEL=https://.../model-f32.gguf ./llama.sh\n" +
			"  TURNS=1 ./llama.sh                    (you type, it continues: 128 tokens a turn)\n" +
			"  ./llama.sh --temp 0 -n 64             (more llama-completion arguments)\n" +
			"  ~/.local/share/llama.cpp/" + VER + "/llama-bench -m models/stories260K.gguf -ngl 99\n",
	},
	downloads: [{ url: `${MODELS}/stories260K.gguf`, sha256: MODEL_SHA256, size: MODEL_SIZE, path: "models/stories260K.gguf", cors: true }],
	commands: ["cat README", "./llama.sh"],
} satisfies TerminalApp;
