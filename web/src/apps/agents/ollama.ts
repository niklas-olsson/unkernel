// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Ollama: its server and `ollama run` with every layer on the guest's Vulkan,
// which here is this browser's WebGPU (guest Vulkan: the base's ICD,
// .agents/vk.md). Ollama 0.40 runs models in llama.cpp's llama-server, so
// the GPU path is ggml's Vulkan backend, as in the llama.cpp app
// (llama.ts). Debian only (the ICD links glibc).
//
// Nothing of Ollama is in the page, and nothing is self-built. Ollama's
// linux-arm64 release has no Vulkan backend (its Dockerfile builds
// llama-server-vulkan for amd64 only) and is 1.6 GiB of zstd, almost all
// CUDA, with the CPU libraries at its end; bin/ollama (the Go binary, 40
// MiB) is its first member. So ollama.sh fetches the archive's first 12 MiB
// (an HTTP range: bin/ollama ends 10.9 MiB in) and keeps bin/ollama, checked
// against the SHA-256 below (taken from the whole archive, whose own SHA-256
// is noted beside it), and the licenses of its Go code (lib/ollama/GO_LICENSE);
// llama-server, libllama and ggml (its Vulkan backend in lib/ollama/vulkan/,
// where Ollama looks for GPU backends) come from llama.cpp's own Vulkan
// build for Ubuntu on arm64 of the tag this Ollama pins (LLAMA_CPP_VERSION
// b12651; Ollama's own build of it adds only a model-loading compatibility
// layer for its library's GGUFs, which a GGUF made here does not need). Both
// MIT. The guest's own https over the page's network, since github.com sends
// no CORS headers (download.ts); 12 + 29 MiB took about 12 s on 2026-11-24,
// 97 MiB unpacked into ~/.local/share/ollama/<version> (only ggml's armv8.0
// CPU variant: the guest's CPU has none of the others' extensions). zstd
// unpacks it; libgomp1 and libssl3t64 are llama-server's.
//
// Three switches make Ollama use kwvk (read in its source at that tag):
// OLLAMA_IGPU_ENABLE=1, as it drops integrated GPUs other than CUDA's and
// kwvk is one; LLAMA_ARG_FIT_TARGET=64, as llama-server's -fit keeps 1 GiB
// of device memory free by default and kwvk's heap was half the guest's RAM
// (498 MiB with 1 GiB; its device-only heap is 4 GiB now, KWVK_HEAP_MB), so it put no layer on the GPU (Ollama's ps:
// "75%/25% CPU/GPU", the log's "offloaded 0/6 layers to GPU"); and
// OLLAMA_NO_CLOUD=1 (no requests to ollama.com). Its discovery runs
// llama-server --list-devices through the Vulkan loader and finds "kwvk
// (WebGPU)" with no other requirement (no memory budget extension, no sysfs).
//
// On a terminal ollama.sh asks which model (its list: Qwen3 0.6B first,
// Qwen3 1.7B, Qwen2.5 0.5B and 1.5B, Qwen2.5-Coder 0.5B, Qwen3.5 0.8B,
// Llama 3.2 1B, SmolLM2 135M, stories260K); MODEL= names one, and Qwen3 0.6B
// is the default without a terminal. The chat models are the registry's
// quantized tags (Q4_K_M, Q8_0 where the registry has no Q4_K_M), which run
// on guest Vulkan since 2026-11-24 (vk.md: Qwen2.5 0.5B Q4_K_M at about 45
// tokens/s on an Apple M4 Pro with llama.cpp; on software WebGPU,
// SwiftShader, they run too, at a tenth of a token a second or less, where
// ggml's 512-wide workgroups run as virtual invocations). On 2026-11-24
// llama.cpp b12651's own Vulkan build (x86-64, natively through
// test/vk/relay.mjs on SwiftShader) ran Ollama's qwen3:0.6b (Q4_K_M) and
// qwen3.5:0.8b (Q8_0) with every layer on kwvk, no pipeline refused and no
// op on the CPU but the token embeddings' lookup (2 graph splits), and sane
// text (the CPU backend's for its first tokens). MODEL=qwen3 (Qwen3 0.6B, qwen3:0.6b, Q4_K_M, 498 MiB, Apache-2.0)
// is a thinking model with tools (THINK=0: no reasoning). MODEL=qwen3.5 is
// Qwen3.5 0.8B as qwen3.5:0.8b-q8_0 (971 MiB with its vision projector,
// which Ollama hands llama-server as --mmproj), not qwen3.5:0.8b: that tag
// adds an MTP draft, for which Ollama starts llama-server with speculative
// decoding (--spec-type draft-mtp), whose gated_delta_net replay pipelines
// guest Vulkan refuses (vk.md, Unsupported). MODEL=smollm2 is SmolLM2 135M
// Instruct (smollm2:135m-instruct-q4_K_M, 100 MiB, Apache-2.0) served as
// smollm2-tools:q4_K_M, the same weights under a ChatML template with a tool
// section. F32 and F16 models run too (stories260K converted to F16 by
// llama-quantize: the same text, 100% GPU; an fp16 tag of the registry when
// MODEL= names one). MODEL=stories260K, as in llama.ts (F32, 1.1 MiB,
// fetched by the page into the installer), the fastest on software WebGPU,
// is made an Ollama model by `ollama create` from a Modelfile (FROM the
// GGUF, num_predict 128), which keeps its F32 weights. Registry models are
// fetched by ollama.sh with curl into Ollama's store (manifest and blobs,
// checked): ollama pull cannot, as it refuses redirects to hosts that
// resolve to non-public addresses, and the page's network answers DNS with
// synthetic ones (198.18.0.0/15). ollama.sh's exit status says why it
// stopped: 3 a download failed, 4 guest Vulkan refused a shader, 5 the
// WebGPU device was lost, 1 anything else. A model with a chat template
// gets `ollama run`'s chat. stories260K has no chat template,
// so Ollama sends the text as it is and the model continues it: ollama.sh
// writes a story from "Once upon a time", then reads the user's own story
// starts, each sent as `ollama run stories260k "TEXT"` (Ollama's generate
// path, the text as it is): `ollama run`'s interactive prompt chats through
// llama-server's chat endpoint, which wraps the text in a chat template
// (three words made 48 prompt tokens) and the story began oddly. A GGUF with
// a chat template, or a library model, gets `ollama run`'s chat.
//
// ollama.sh starts `ollama serve` in its own session, its log in ollama.log,
// checks that Ollama took kwvk as its GPU (its "inference compute" line)
// and, after loading the model, that its layers are on it (llama-server's
// "offloaded N/M layers to GPU", N > 0), and stops with a message otherwise,
// since a model on the CPU would be a misleading demo; it stops the server
// when it ends. A loud failure of guest Vulkan (a refused pipeline aborts
// ggml, vk.md, Errors) gets a one-line hint. On 2026-11-24 (stories260K, the guest in
// headless Chromium on SwiftShader, one CPU, 1 GiB) the server answered
// after 2 s, the model loaded in 7.5-8.5 s and generated 4.5-6.0 tokens/s
// (the same model on the guest's CPU: 43, much faster than on software
// WebGPU).
import type { TerminalApp } from "../types.ts";

const VER = "v0.40.18";
// bin/ollama of ollama-linux-arm64.tar.zst at VER (sha256 63f01dae3b65641866991e75e2aecb7aed8a4041f4c2c3c7d92862c5a47ebed6).
const OLLAMA_BIN_SHA256 = "3f64b5190c9c7b58feefdad2846e2f157274586b2ed82b06589bd66d2b256051";
const LLAMA = "b12651";
const LLAMA_SHA256 = "138f97d9d448b7a55c4b839366bba6e2ac7fba634f9160c9a4775a2051a1c7cb";
const MODELS = "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas";
const MODEL_SHA256 = "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d";
const MODEL_SIZE = 1185376;
/** The story model's (MODEL=stories260K) Ollama name, as ollama.sh creates it (`SERVE=1 ./ollama.sh` writes the name it serves to ollama.ready). */
export const OLLAMA_MODEL = "stories260k";
/** Its context length in tokens (the GGUF's llama.context_length, as `ollama show` gives it). */
export const OLLAMA_MODEL_CTX = 2048;
/** Whether it does tool calls through Ollama's OpenAI-compatible endpoint: no, it has no chat template. */
export const OLLAMA_MODEL_TOOLS = false;

const OLLAMA_SH = String.raw`#!/bin/bash
# Ollama with llama.cpp's Vulkan backend on guest Vulkan (kwvk: this page's
# WebGPU). Written by the unkernel launcher's Ollama app.
#   ./ollama.sh                     asks which model (on a terminal); Enter: Qwen3 0.6B (Q4_K_M, 498 MiB): a small thinking chat model with tools
#   MODEL=qwen3-1.7b ./ollama.sh    Qwen3 1.7B (Q4_K_M, 1296 MiB): better answers and tool calls (fx's default); guest memory 3 GiB or more
#   MODEL=qwen ./ollama.sh          Qwen2.5 0.5B Instruct (Q4_K_M, 379 MiB): no thinking, tool calls
#   MODEL=qwen1.5 ./ollama.sh       Qwen2.5 1.5B Instruct (Q4_K_M, 940 MiB): better at tool calls
#   MODEL=qwen-coder ./ollama.sh    Qwen2.5-Coder 0.5B Instruct (Q4_K_M, 379 MiB): a small coding chat model
#   MODEL=qwen3.5 ./ollama.sh       Qwen3.5 0.8B (Q8_0, 971 MiB with its vision projector): newer, a thinking model with tools
#   MODEL=llama3.2 ./ollama.sh      Llama 3.2 1B Instruct (Q8_0, 1259 MiB): tool calls too
#   MODEL=smollm2 ./ollama.sh       SmolLM2 135M Instruct (Q4_K_M, 100 MiB): the fastest; simple answers (as smollm2-tools, with a tool-call template)
#   MODEL=stories260K ./ollama.sh   stories260K (F32, 1.1 MiB): a story, then you type story starts; the fastest on software WebGPU
#   MODEL=PATH.gguf ./ollama.sh     another GGUF here (ollama create)
#   TEMP=0 ./ollama.sh              the sampling temperature as the model's default (a derived model NAME-tN)
#   THINK=0 ./ollama.sh             a thinking model (Qwen3, Qwen3.5) answers without reasoning first (as /set nothink)
#   SERVE=1 ./ollama.sh             the server only, for other programs: once the model is on kwvk,
#                                   its Ollama name goes to ollama.ready; Ctrl-C stops the server
#   MODEL=NAME ./ollama.sh          another model of Ollama's registry ([user/]name[:tag], fetched by curl)
# The server runs while this script does: ollama.log has its log. Software
# WebGPU (SwiftShader) runs the chat models too, at a token every few seconds.
# Mixture-of-experts models abort on guest Vulkan (a refused pipeline), and
# so does speculative decoding of Qwen3.5 (the qwen3.5 tags with a draft).
set -e
VER=${VER}
URL=https://github.com/ollama/ollama/releases/download/$VER/ollama-linux-arm64.tar.zst
BIN_SHA=${OLLAMA_BIN_SHA256}
LLAMA=${LLAMA}
LURL=https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-vulkan-arm64.tar.gz
LSHA=${LLAMA_SHA256}
# Downloads try the page's mirror first: plain HTTP to mirror.unkernel.dev is
# answered by the page's fetch() (config.ts DEFAULT_ROUTES), not carried over
# the network relay; then the upstream itself. dl UPSTREAM MIRROR_PATH CURL_ARGS...
MIRROR=http://mirror.unkernel.dev
dl() {
	local up=$1 mp=$2
	shift 2
	curl "$@" "$MIRROR/$mp" || curl "$@" "$up"
}
DIR=$HOME/.local/share/ollama/$VER
OLLAMA=$DIR/bin/ollama
LOG=$PWD/ollama.log
READY=$PWD/ollama.ready
rm -f "$READY"
D='\033[90m' B='\033[1m' R='\033[31m' N='\033[0m'
say() { printf "$D%s$N\n" "$*"; }
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }
# Exit status: 3 a download failed, 4 guest Vulkan refused a shader, 5 the
# WebGPU device was lost, 1 anything else.
fail() { local st=$1; shift; printf "$R%s$N\n" "$*" >&2; exit $st; }

# No MODEL= on a terminal: ask. Enter takes the first; a number, or any
# other name ollama.sh takes (an Ollama name, a .gguf).
pick_model() {
	local i=0 k l ans
	printf "$B%s$N\n" "Which model? (Enter: 1; or type an Ollama name or a .gguf path; MODEL=... skips this)"
	while IFS='|' read -r k l; do
		i=$((i + 1))
		printf '  %d) %s\n' $i "$l"
	done <<MENU
$1
MENU
	printf '> '
	read -r ans || ans=
	[ -n "$ans" ] || ans=1
	case $ans in
	[0-9] | [0-9][0-9])
		MODEL=$(printf '%s\n' "$1" | sed -n "$ans"p | cut -d'|' -f1)
		[ -n "$MODEL" ] || die "No such choice: $ans"
		;;
	*) MODEL=$ans ;;
	esac
}
if [ -z "$MODEL" ] && [ -z "$SERVE" ] && [ -t 0 ]; then
	pick_model 'qwen3|Qwen3 0.6B (498 MiB): thinks before it answers (THINK=0: not), tools
qwen3-1.7b|Qwen3 1.7B (1296 MiB): the best here; guest memory 3 GiB or more
qwen|Qwen2.5 0.5B (379 MiB): general chat, no thinking
qwen1.5|Qwen2.5 1.5B (940 MiB): better at tool calls
qwen-coder|Qwen2.5-Coder 0.5B (379 MiB): code
qwen3.5|Qwen3.5 0.8B (971 MiB, Q8_0): newer, thinks; untried in Ollama on guest Vulkan
llama3.2|Llama 3.2 1B (1259 MiB, Q8_0)
smollm2|SmolLM2 135M (100 MiB): the fastest; simple answers
stories260K|stories260K (1.1 MiB): stories only; the fastest on software WebGPU'
fi

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
	die "vulkaninfo names no kwvk device: turn on Guest Vulkan (Settings, Display and sound; it needs WebGPU), then run ./ollama.sh again."
	;;
esac

# Ollama, once: its own linux-arm64 build has no Vulkan backend and is 1.6 GiB
# (CUDA), so only its first files (bin/ollama and the licenses of its Go
# code) are taken from the archive's first 12 MiB; llama-server and ggml
# come from llama.cpp's Vulkan build of the tag this Ollama pins ($LLAMA).
if [ ! -x "$OLLAMA" ] || [ ! -e "$DIR/lib/ollama/vulkan/libggml-vulkan.so" ]; then
	free=$(df -Pk "$HOME" | awk 'NR == 2 { print int($4 / 1024) }')
	[ "$free" -ge 150 ] || die "Ollama needs 150 MiB on the disk, $free MiB free."
	rm -rf "$DIR.part" && mkdir -p "$DIR.part/lib/ollama/vulkan" && cd "$DIR.part"
	printf "$B%s$N\n" "Fetching Ollama $VER (arm64: the first 12 MiB of its archive, 40 MiB unpacked) from GitHub"
	dl "$URL" "github/ollama/ollama/releases/download/$VER/ollama-linux-arm64.tar.zst" -fL# -r 0-12582911 -o head.tar.zst || { cd - >/dev/null; rm -rf "$DIR.part"; fail 3 "Download failed: $URL"; }
	{ zstd -dc head.tar.zst 2>/dev/null | tar x --occurrence=1 bin/ollama lib/ollama/GO_LICENSE; } 2>/dev/null || true
	echo "$BIN_SHA  bin/ollama" | sha256sum -c --quiet 2>/dev/null || { cd - >/dev/null; rm -rf "$DIR.part"; die "Ollama: no bin/ollama with the right SHA-256 in the download, deleted"; }
	rm head.tar.zst
	printf "$B%s$N\n" "Fetching llama.cpp $LLAMA (Vulkan, arm64: 29 MiB, 57 MiB of it kept) from GitHub"
	dl "$LURL" "github/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-vulkan-arm64.tar.gz" -fL# -o llama.tar.gz || { cd - >/dev/null; rm -rf "$DIR.part"; fail 3 "Download failed: $LURL"; }
	echo "$LSHA  llama.tar.gz" | sha256sum -c --quiet || { cd - >/dev/null; rm -rf "$DIR.part"; die "llama.cpp: wrong SHA-256, deleted"; }
	# llama-server and what it loads; of ggml's CPU variants only armv8.0
	# (the guest's CPU has no dotprod, fp16 arithmetic or SVE).
	p=llama-$LLAMA
	tar xzf llama.tar.gz -C lib/ollama --strip-components=1 --wildcards "$p/LICENSE" "$p/llama-server" \
		"$p/libllama.so*" "$p/libllama-common.so*" "$p/libllama-server-impl.so" "$p/libmtmd.so*" \
		"$p/libggml.so*" "$p/libggml-base.so*" "$p/libggml-cpu-armv8.0_1.so" "$p/libggml-vulkan.so"
	mv lib/ollama/libggml-vulkan.so lib/ollama/vulkan/
	rm llama.tar.gz
	cd - >/dev/null && mv "$DIR.part" "$DIR"
	say "Ollama $VER is in $DIR"
fi

# The server, here only: its own session (Ctrl-C in ollama run stays
# there), stopped when this script ends.
export OLLAMA_HOST=127.0.0.1:11434
# kwvk is an integrated GPU, which Ollama drops unless told.
export OLLAMA_IGPU_ENABLE=1
# llama-server keeps 1 GiB of device memory free by default, more than kwvk
# had (half the guest's RAM; its device-only heap is 4 GiB now, KWVK_HEAP_MB), and put every layer on the CPU.
export LLAMA_ARG_FIT_TARGET=64
# No ollama.com (cloud models, recommendations).
export OLLAMA_NO_CLOUD=1
# The model stays loaded while the server runs.
export OLLAMA_KEEP_ALIVE=-1
PIDF=$PWD/ollama.pid
if [ -s "$PIDF" ] && grep -qa 'ollama' "/proc/$(cat "$PIDF")/cmdline" 2>/dev/null; then
	say "Stopping the server an earlier run left"
	kill "$(cat "$PIDF")" 2>/dev/null || true
	for i in $(seq 50); do kill -0 "$(cat "$PIDF")" 2>/dev/null || break; sleep 0.2; done
fi
! curl -fs "$OLLAMA_HOST/api/version" >/dev/null 2>&1 || die "Another server answers on $OLLAMA_HOST (an ollama serve of yours?): stop it, then run ./ollama.sh again."
serve() {
	setsid "$OLLAMA" serve >"$LOG" 2>&1 </dev/null &
	SRV=$!
	echo $SRV >"$PIDF"
}
serve
stop() {
	rm -f "$READY"
	kill $SRV 2>/dev/null || return 0
	for i in $(seq 50); do kill -0 $SRV 2>/dev/null || break; sleep 0.2; done
	kill -9 $SRV 2>/dev/null || true
	rm -f "$PIDF"
}
trap stop EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
say "Starting the server (ollama serve; its log: ollama.log)"
# Ollama gives its GPU discovery (a llama-server it starts) 30 s. A first
# start, with the libraries just unpacked and nothing of them in memory, can
# take longer here; the next start is faster, so the server is started again.
for try in 1 2 3; do
	for i in $(seq 300); do
		grep -qa 'msg="inference compute"' "$LOG" && curl -fs "$OLLAMA_HOST/api/version" >/dev/null 2>&1 && break
		kill -0 $SRV 2>/dev/null || { tail -n 5 "$LOG" >&2; die "ollama serve ended (ollama.log has its log)."; }
		sleep 0.2
	done
	gpu=$(grep -a 'msg="inference compute"' "$LOG" | grep -a 'library=Vulkan' | grep -a kwvk | head -n 1)
	[ -z "$gpu" ] && [ $try -lt 3 ] && grep -qa 'timed out' "$LOG" || break
	say "Ollama's GPU discovery timed out (a cold start): starting the server again"
	kill $SRV 2>/dev/null || true
	for i in $(seq 50); do kill -0 $SRV 2>/dev/null || break; sleep 0.2; done
	kill -9 $SRV 2>/dev/null || true
	serve
done
if [ -z "$gpu" ]; then
	grep -aE 'msg="inference compute"|dropping integrated|failure during|timed out' "$LOG" >&2 || true
	die "Ollama did not take kwvk as its GPU, and would run on the CPU: see ollama.log."
fi
say "Ollama's GPU: $(printf '%s\n' "$gpu" | sed -n 's/.*description="\([^"]*\)".* type=\([^ ]*\) total="\([^"]*\)".*/\1 (Vulkan, \2, \3)/p')"

# A model of Ollama's registry, fetched as ollama pull would store it, but
# by curl: ollama pull refuses redirects to hosts that resolve to non-public
# addresses, and the page's network gives every host name one (198.18.0.0/15).
# The manifest goes, byte for byte, where Ollama reads manifests
# (manifests/registry.ollama.ai/NAMESPACE/NAME/TAG), each blob it names to
# blobs/sha256-HEX, checked against its digest.
fetch_model() {
	local ref=$1 path tag store reg man d f mir
	path=$(printf '%s' "$ref" | sed 's/:[^/]*$//')
	tag=$(printf '%s' "$ref" | sed -n 's/^.*:\([^/]*\)$/\1/p')
	[ -n "$tag" ] || tag=latest
	case $path in */*) ;; *) path=library/$path ;; esac
	store=$OLLAMA_MODELS
	[ -n "$store" ] || store=$HOME/.ollama/models
	reg=https://registry.ollama.ai/v2/$path
	man=$store/manifests/registry.ollama.ai/$path/$tag
	mkdir -p "$store/blobs" "$(dirname "$man")"
	printf "$B%s$N\n" "Fetching $path:$tag from Ollama's registry"
	# The mirror has the library's models (library/NAME); others come from the registry only.
	case $path in library/*) mir=ollama/v2/$path ;; *) mir=no-mirror/$path ;; esac
	dl "$reg/manifests/$tag" "$mir/manifests/$tag" -fsSL -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' -o "$man.part" ||
		{ rm -f "$man.part"; fail 3 "Download failed: the manifest of $path:$tag ($reg/manifests/$tag): no such model or tag, or no network."; }
	# Room for it? A full data disk fails the download midway, and a write the
	# browser's storage refuses turns the disk read-only until the next boot.
	local need have
	need=$((($(grep -o '"size" *: *[0-9]*' "$man.part" | sed 's/.*: *//' | paste -sd+ - | sed 's/^$/0/')) / 1048576))
	have=$(($(df -Pk "$store" | awk 'NR==2 {print $4}') / 1024))
	[ "$have" -gt $((need + 64)) ] ||
		{ rm -f "$man.part"; fail 3 "No room for $path:$tag: it is $need MiB and $store has $have MiB free. Remove models you do not use ($OLLAMA list, $OLLAMA rm NAME) or raise the disk size (Settings)."; }
	for d in $(grep -o '"digest" *: *"sha256:[0-9a-f]\{64\}"' "$man.part" | sed 's/.*sha256://; s/"$//'); do
		f=$store/blobs/sha256-$d
		if [ -s "$f" ] && echo "$d  $f" | sha256sum -c --quiet >/dev/null 2>&1; then continue; fi
		dl "$reg/blobs/sha256:$d" "$mir/blobs/sha256:$d" -fL# -C - -o "$f.part" || {
			touch "$store/.w" 2>/dev/null && rm -f "$store/.w" || fail 3 "Download failed: the disk under $store has turned read-only (a failed write: the browser's storage for this site is probably full). Restart the machine, then free space before running ./ollama.sh again."
			fail 3 "Download failed: blob sha256:$d of $path:$tag ($(df -Ph "$store" | awk 'NR==2 {print $4}') free on its disk; run ./ollama.sh again to resume)."
		}
		echo "$d  $f.part" | sha256sum -c --quiet >/dev/null 2>&1 || { rm -f "$f.part"; fail 3 "Download failed: blob sha256:$d of $path:$tag has the wrong SHA-256, deleted (run ./ollama.sh again)."; }
		mv "$f.part" "$f"
	done
	grep -q '"digest"' "$man.part" || { rm -f "$man.part"; fail 3 "Download failed: $reg/manifests/$tag is not a manifest."; }
	mv "$man.part" "$man"
}

# The model: Qwen3 0.6B by default, from Ollama's registry (its quantized
# tags); stories260K from the page (models/), made an Ollama model once.
M=$MODEL
[ -n "$M" ] || M=qwen3
BASE=
case $M in
stories260K) F=models/stories260K.gguf NAME=stories260k ;;
qwen3) F= NAME=qwen3:0.6b ;;
qwen3-1.7b) F= NAME=qwen3:1.7b ;;
qwen) F= NAME=qwen2.5:0.5b ;;
qwen1.5) F= NAME=qwen2.5:1.5b ;;
qwen-coder) F= NAME=qwen2.5-coder:0.5b ;;
# Not qwen3.5:0.8b: its MTP draft makes Ollama run speculative decoding,
# whose gated_delta_net replay pipelines guest Vulkan refuses.
qwen3.5) F= NAME=qwen3.5:0.8b-q8_0 ;;
llama3.2) F= NAME=llama3.2:1b ;;
# (A tag of its own: an older smollm2-tools was made from the fp16 weights.)
smollm2) F= NAME=smollm2-tools:q4_K_M BASE=smollm2:135m-instruct-q4_K_M ;;
*.gguf) F=$M NAME=$(basename "$M" .gguf | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._\n-' -) ;;
*) F= NAME=$M ;;
esac
if [ -n "$F" ]; then
	[ -s "$F" ] || die "No model at $F"
	if ! "$OLLAMA" show "$NAME" >/dev/null 2>&1; then
		say "Making the Ollama model $NAME from $F (ollama create: weights kept as they are)"
		mkdir -p models
		printf 'FROM %s\nPARAMETER num_predict 128\n' "$(realpath "$F")" >"models/$NAME.Modelfile"
		out=$("$OLLAMA" create "$NAME" -f "models/$NAME.Modelfile" 2>&1) || { printf '%s\n' "$out" | tail -n 3 >&2; die "ollama create failed"; }
	fi
else
	if [ -n "$BASE" ]; then
		# Ollama's SmolLM2 template declares no tools, so Ollama refuses requests
		# that carry them (fx's all do): the same weights under a ChatML template
		# with Qwen2.5's tool section (<tool_call> JSON), which Ollama parses.
		"$OLLAMA" show "$BASE" >/dev/null 2>&1 || fetch_model "$BASE"
		if ! "$OLLAMA" show "$NAME" >/dev/null 2>&1; then
			mkdir -p models
			{
				printf 'FROM %s\nTEMPLATE """' "$BASE"
				cat <<'TPL'
{{- if .Messages }}
{{- if or .System .Tools }}<|im_start|>system
{{- if .System }}
{{ .System }}
{{- end }}
{{- if .Tools }}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{{- range .Tools }}
{"type": "function", "function": {{ .Function }}}
{{- end }}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
{{- end }}<|im_end|>
{{ end }}
{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 -}}
{{- if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{ if .Content }}{{ .Content }}
{{- else if .ToolCalls }}<tool_call>
{{ range .ToolCalls }}{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
{{ end }}</tool_call>
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
{{- else if eq .Role "tool" }}<|im_start|>user
<tool_response>
{{ .Content }}
</tool_response><|im_end|>
{{ end }}
{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant
{{ end }}
{{- end }}
{{- else }}
{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ end }}{{ .Response }}{{ if .Response }}<|im_end|>{{ end }}
TPL
				printf '"""\nPARAMETER stop <|im_start|>\nPARAMETER stop <|im_end|>\n'
			} >"models/$NAME.Modelfile"
			out=$("$OLLAMA" create "$NAME" -f "models/$NAME.Modelfile" 2>&1) || { printf '%s\n' "$out" | tail -n 3 >&2; die "ollama create failed"; }
		fi
	fi
	"$OLLAMA" show "$NAME" >/dev/null 2>&1 || fetch_model "$NAME"
	"$OLLAMA" show "$NAME" >/dev/null 2>&1 || die "Ollama does not see $NAME after its download (ollama.log has the server's log)."
fi
# TEMP=N: the same model with that sampling temperature as its default (a
# derived Ollama model, the weights shared), for clients that send none, as fx.
if [ -n "$TEMP" ]; then
	TN=$(printf '%s' "$NAME" | tr ':' '-')-t$TEMP
	if ! "$OLLAMA" show "$TN" >/dev/null 2>&1; then
		mkdir -p models
		printf 'FROM %s\nPARAMETER temperature %s\n' "$NAME" "$TEMP" >"models/$TN.Modelfile"
		out=$("$OLLAMA" create "$TN" -f "models/$TN.Modelfile" 2>&1) || { printf '%s\n' "$out" | tail -n 3 >&2; die "ollama create failed"; }
	fi
	NAME=$TN
fi

hint() {
	if grep -qaE 'pipeline creation failed|ErrorInvalidShaderNV|ErrorFeatureNotPresent' "$LOG"; then
		grep -aE '^kwvk:|pipeline creation failed' "$LOG" | tail -n 2 >&2
		fail 4 "Hint: guest Vulkan refused one of this model's shaders (WebGPU cannot run some of llama.cpp's: mixture-of-experts models, speculative decoding of Qwen3.5, some bf16 norms on software WebGPU). Try the default, MODEL=qwen3."
	elif grep -qa 'device lost' "$LOG"; then
		fail 5 "Hint: the WebGPU device was lost; run ./ollama.sh again (it gets a new one)."
	fi
	grep -aE 'kwvk:|ggml_vulkan:.*(failed|error)|error' "$LOG" | tail -n 5 >&2 || true
	die "$1 (ollama.log has the server's log)."
}

# Load it now, and check that its layers are on kwvk: a model on the CPU
# would be a misleading demo.
say "Loading $NAME on kwvk"
t0=$(date +%s%N)
r=$(curl -s "$OLLAMA_HOST/api/generate" -d "{\"model\":\"$NAME\",\"keep_alive\":-1}") || true
t1=$(date +%s%N)
case $r in *'"done":true'*) ;; *) hint "Loading $NAME failed: $(printf '%s' "$r" | head -c 300)" ;; esac
off=$(grep -ao 'offloaded [0-9]*/[0-9]* layers to GPU' "$LOG" | tail -n 1)
case $off in
'') die "$NAME: no layer on kwvk (ollama.log has no offload line)." ;;
'offloaded 0/'*) die "$NAME loaded on the CPU, not on kwvk ($off): see ollama.log." ;;
esac
# (llama.cpp prints that line on a CPU-only run too: the weights must be in a Vulkan buffer.)
grep -qa 'Vulkan0 model buffer size' "$LOG" || die "$NAME loaded on the CPU, not on kwvk (no Vulkan0 model buffer): see ollama.log."
# The load time (the request above: the weights read and uploaded, the
# first pipelines made), to compare GPUs and builds; ollama run --verbose
# prints the eval rate (tokens per second) after each reply.
say "On kwvk: $off ($("$OLLAMA" ps | awk 'NR == 2 { for (i = 1; i <= NF; i++) if ($i == "GPU" || $i ~ /GPU$/) { print $(i - 1), $i; exit } }')), loaded in $(( (t1 - t0) / 100000000 / 10 )).$(( (t1 - t0) / 100000000 % 10 )) s"

# SERVE=1: the server only (another app talks to it), until this script is
# stopped; the traps above stop the server.
if [ -n "$SERVE" ]; then
	trap 'exit 130' INT
	echo "$NAME" >"$READY"
	printf "$B%s$N\n" "Ready: $NAME on http://$OLLAMA_HOST (Ollama's API; OpenAI's at /v1). Ctrl-C stops the server."
	wait $SRV
	die "ollama serve ended (ollama.log has its log)."
fi

set +e
# A model with a chat template chats (ollama run). One without continues
# text: each line goes to ollama run NAME "TEXT" (Ollama's generate path,
# the text as it is), since ollama run's own prompt chats through
# llama-server's chat endpoint, which wraps the text in a chat template the
# model never saw. (Its stdin is not the terminal: with a prompt, ollama run
# adds what it reads from a stdin that is not one.)
if [ -n "$F" ] && ! head -c 16777216 "$F" | grep -qa tokenizer.chat_template; then
	# Ctrl-C stops a reply (ollama run) and this script goes on.
	trap : INT
	printf "$B%s$N\n" "A story from \"Once upon a time\" (the speed after it: eval rate, tokens per second):"
	"$OLLAMA" run --verbose "$NAME" "Once upon a time" </dev/null || hint "ollama run failed"
	say "Now you: type the start of a story (a few words: \"The little dragon\") and press Enter, and it goes on from there, 128 tokens at most. It has no chat template: it continues text, it does not answer questions. Ctrl-C stops a reply; Ctrl-D or /bye quits and stops the server."
	while IFS= read -e -r -p $'\001\033[1m\002>>> \001\033[0m\002' line; do
		case $line in /bye) break ;; '') continue ;; esac
		history -s "$line"
		"$OLLAMA" run --verbose "$NAME" "$line" </dev/null
		st=$?
		[ $st -eq 0 ] || [ $st -eq 130 ] || hint "ollama run failed"
	done
	echo
else
	# THINK=0: a thinking model (Qwen3, Qwen3.5) answers without its reasoning
	# first, which is most of a reply's tokens; THINK=1 asks for it.
	TA=
	case $THINK in 0 | false | no | off) TA=--think=false ;; '') ;; *) TA=--think=true ;; esac
	say "Type a message and press Enter. Ctrl-D or /bye quits and stops the server."
	"$OLLAMA" run --verbose $TA "$NAME" || hint "ollama run failed"
fi
`;

export default {
	id: "ollama",
	title: "Ollama",
	desc: "Ollama on the GPU: its server and ollama run on llama.cpp's Vulkan backend, on this browser's WebGPU (guest Vulkan); asks which model (Qwen3 0.6B, 498 MiB, first; SmolLM2 135M, 100 MiB, to Qwen3 1.7B, 1296 MiB), fetched with Ollama (12 MiB) and llama.cpp (29 MiB) on first run",
	// A speech bubble with three dots (crafted).
	icon: { svg: '<path d="M5.5 4h13Q20 4 20 5.5v9q0 1.5-1.5 1.5H11l-4.6 3.7q-.4.3-.4-.2V16h-.5Q4 16 4 14.5v-9Q4 4 5.5 4Z"/><circle cx="8.5" cy="10" r="1.2" fill="#0f766e"/><circle cx="12" cy="10" r="1.2" fill="#0f766e"/><circle cx="15.5" cy="10" r="1.2" fill="#0f766e"/>' },
	colors: ["#0f766e", "#1e1b4b"],
	needs: { net: true, vk: true },
	packages: { debian: ["libvulkan1", "vulkan-tools", "libgomp1", "libssl3t64", "zstd", "curl", "ca-certificates"] },
	terminal: "window",
	files: {
		"ollama.sh": { content: OLLAMA_SH, mode: 0o755 },
		README: "Ollama runs this model on the guest's Vulkan, which is this browser's WebGPU\n" +
			"(guest Vulkan in Options): its server (ollama serve, while ollama.sh runs; its\n" +
			"log: ollama.log) loads every layer on the GPU. ollama.sh asks which model\n" +
			"(Enter: Qwen3 0.6B, Q4_K_M, 498 MiB, fetched once; MODEL=NAME skips the\n" +
			"question): ask it, e.g., Write a Python function that reverses a string.\n" +
			"Qwen3 thinks before it answers: THINK=0 turns that off. The larger models\n" +
			"want more guest memory (Settings: 3 GiB or more for the 1-2 GB ones), and\n" +
			"all a real GPU to be quick (software WebGPU runs them at a token every few\n" +
			"seconds). TEMP=N sets the temperature. Ctrl-D or /bye quits and stops the\n" +
			"server. Others:\n" +
			"  MODEL=qwen3-1.7b ./ollama.sh           (Qwen3 1.7B, 1296 MiB: the best here)\n" +
			"  MODEL=smollm2 ./ollama.sh              (SmolLM2 135M, 100 MiB: the fastest)\n" +
			"  MODEL=stories260K ./ollama.sh          (a tiny F32 story model, 1.1 MiB, no chat\n" +
			"                                          template: type story starts; the\n" +
			"                                          fastest on software WebGPU)\n" +
			"  MODEL=qwen3:4b ./ollama.sh             (any model of Ollama's library)\n" +
			"  MODEL=PATH.gguf ./ollama.sh            (another GGUF, made an Ollama model)\n" +
			"  ~/.local/share/ollama/" + VER + "/bin/ollama ps   (in another tab while it runs: 100% GPU)\n",
	},
	downloads: [{ url: `${MODELS}/stories260K.gguf`, sha256: MODEL_SHA256, size: MODEL_SIZE, path: "models/stories260K.gguf", cors: true }],
	commands: ["cat README", "./ollama.sh"],
} satisfies TerminalApp;
