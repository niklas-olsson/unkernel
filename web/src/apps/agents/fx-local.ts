// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx (local model): the fx coding agent (fx.ts) talking to a model that
// this browser tab's GPU runs: Ollama's server on guest Vulkan, as in the
// Ollama app (ollama.ts: Ollama -> llama.cpp's llama-server -> Vulkan, the
// base's ICD kwvk -> WebGPU; .agents/vk.md). Debian only, as Ollama.
//
// Nothing of Ollama is repeated here: the app writes the Ollama app's own
// files (ollama.sh, its README) and downloads into that app's directory,
// installs its packages (and jq), and fx-local.sh runs `SERVE=1 ./ollama.sh`
// there in the background: ollama.sh installs Ollama and llama.cpp's Vulkan
// build on its first run, starts `ollama serve` on kwvk, makes or pulls the
// model, checks that its layers are on kwvk and writes the model's name to
// ollama.ready. Both apps share that directory's ollama.pid, so one server
// runs at a time. fx comes from the kw layer's shim, as for the fx app.
//
// fx's side is a custom connection named "local" (protocol
// openai-chat-completions, http://127.0.0.1:11434/v1, auth none; fields as
// fx.sh/docs/configure-fx/custom-model-connections describes them for fx
// 0.0.17, whose strict parsing rejects unknown ones). It lives in an
// app-private FX_HOME (~/.apps/fx-local/fx-home): the user's ~/.fx (the fx
// app's sign-in and settings) is not touched. fx-local.sh merges the
// connection into that settings.json with jq on every run (fx's own saved
// preferences there stay), and selects it per run with FX_PROVIDER=local and
// FX_MODEL, with FX_AUTO_UPGRADE=0 and FX_PERMISSION_MODE=full-access (fx
// runs its tool calls without asking: a small model's turns are slow enough,
// and the guest is the sandbox; an FX_PERMISSION_MODE of the caller's
// stays). The server's OLLAMA_CONTEXT_LENGTH and
// the connection's context_window agree: CTX, by default the model's
// trained context (8192 for SmolLM2) but 16384 for Qwen2.5 and Qwen3 (of
// 32768 and 40960: device memory; Qwen3's KV cache is 112 KiB a token, 1.75
// GiB at 16384), and context_window never above what Ollama's /api/show
// reports for the model; supports_tool_use is what /api/show's capabilities
// say ("tools": from the model's template), or OLLAMA_MODEL_TOOLS for the
// Ollama app's own default, or TOOLS=0|1.
//
// On a terminal fx-local.sh asks which model; the first and default is
// Qwen3 1.7B (Q4_K_M, 1296 MiB, Ollama's library tag qwen3:1.7b; ollama.sh's
// MODEL=qwen3-1.7b; guest memory 3 GiB or more), a thinking model with tools
// (it thinks before its answers here; THINK=0 turns that off). The models
// are the registry's quantized
// tags, which run on guest Vulkan since 2026-11-24 (ollama.ts). Qwen3 0.6B
// (MODEL=qwen3, 498 MiB) is the quicker choice: fx 0.0.17 on it (Ollama
// 0.40.18 and llama.cpp b12651 on the host's CPU, temperature 0, no
// thinking, 2026-11-24) wrote a requested file with a real write_file call
// (one task tried). Qwen2.5 0.5B (MODEL=qwen) made real tool calls in two
// tasks of three, Qwen2.5-Coder 0.5B (MODEL=qwen-coder) in none (JSON in a
// code block instead), and on a real GPU (the user's, 2026-11-24) Qwen2.5
// 0.5B answered fx but described or invented tool results more often than
// it called a tool (all three as fp16 tags then). fx needs tools: it sends
// its tools with every request whatever supports_tool_use says, and Ollama
// answers a model without them with HTTP 400 ("does not support tools":
// SmolLM2 135M, the user's first run on a real GPU, 2026-11-24, where it did
// load; and the Ollama app's story model, which has no chat template). So
// fx-local.sh stops before fx with such a model (SmolLM2 is served under a
// template of ollama.sh's with a tool section). On software WebGPU
// (SwiftShader) the models run, at a token every few seconds: too slow for
// fx's prompts. The model runs at temperature 0 (TEMP=), and a thinking
// model reasons before its answers unless THINK=0 (reasoning_effort "none").
import type { TerminalApp } from "../types.ts";
import ollama, { OLLAMA_MODEL, OLLAMA_MODEL_CTX, OLLAMA_MODEL_TOOLS } from "./ollama.ts";

/** The Ollama app's directory, which holds its ollama.sh, models, log and pid file. */
const OLLAMA_DIR = (ollama as TerminalApp).dir ?? `~/.apps/${ollama.id}`;
const inOllama = (p: string) => (p.startsWith("/") || p.startsWith("~/") ? p : `${OLLAMA_DIR}/${p}`);

const FX_LOCAL_SH = String.raw`#!/bin/bash
# fx, the coding agent, on a model this page's GPU runs: the Ollama app's
# server (SERVE=1 ollama.sh) on guest Vulkan (kwvk: this browser's WebGPU),
# as fx's custom connection "local". Written by the unkernel launcher's
# "fx (local model)" app.
#   ./fx-local.sh                       asks which model (on a terminal); Enter: Qwen3 1.7B (Q4_K_M, 1296 MiB): tool calls; guest memory 3 GiB or more
#   MODEL=qwen3 ./fx-local.sh           Qwen3 0.6B (Q4_K_M, 498 MiB): quicker, weaker at tool calls
#   MODEL=qwen1.5 ./fx-local.sh         Qwen2.5 1.5B Instruct (Q4_K_M, 940 MiB): tool calls, no thinking
#   MODEL=qwen ./fx-local.sh            Qwen2.5 0.5B Instruct (Q4_K_M, 379 MiB): calls tools, seldom well
#   MODEL=qwen3.5 ./fx-local.sh         Qwen3.5 0.8B (Q8_0, 971 MiB): newer; untried with fx
#   MODEL=llama3.2 ./fx-local.sh        Llama 3.2 1B Instruct (Q8_0, 1259 MiB)
#   MODEL=smollm2 ./fx-local.sh         SmolLM2 135M Instruct (Q4_K_M, 100 MiB): the fastest; tool calls through a template of ours, seldom right
#   MODEL=qwen-coder ./fx-local.sh      Qwen2.5-Coder 0.5B Instruct (379 MiB): better code, but rarely calls fx's tools
#   MODEL=PATH.gguf|NAME ./fx-local.sh  another model, as ollama.sh takes it
#   CTX=N                               the context length (server and fx; default: the model's, at most 16384)
#   TEMP=N                              the sampling temperature (default 0; TEMP=model for the model's own)
#   THINK=0                             stop a thinking model (Qwen3, Qwen3.5) reasoning before answers: quicker turns (default: it thinks)
#   TOOLS=0|1                           declare tool use off or on (default: what Ollama reports)
#   FX_PERMISSION_MODE=auto|ask         fx's permission mode (default here: full-access, no questions before tool calls)
# fx's settings for this: FX_HOME=$PWD/fx-home (your ~/.fx is not touched).
set -e
OLLAMA_DIR="${OLLAMA_DIR.replace(/^~(?=\/)/, "$HOME")}"
HOST=127.0.0.1:11434
FXH=$PWD/fx-home
D='\033[90m' B='\033[1m' R='\033[31m' N='\033[0m'
say() { printf "$D%s$N\n" "$*"; }
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }

# fx first: the kw layer's shim installs it into ~/.local/bin on its first
# call (any call: it then runs fx with the same arguments).
if [ "$(command -v fx)" = /usr/lib/kw/bin/fx ] && [ ! -x "$HOME/.local/bin/fx" ]; then
	printf "$B%s$N\n" "Installing fx (the kw shim: ~/.local/bin/fx)"
	fx --version >/dev/null || true
	[ -x "$HOME/.local/bin/fx" ] || die "fx did not install (it needs the network): run fx in a terminal to see why."
fi
command -v fx >/dev/null || die "No fx on PATH."
command -v jq >/dev/null || die "No jq (the launcher installs it): sudo apt-get install jq"
[ -x "$OLLAMA_DIR/ollama.sh" ] || die "No $OLLAMA_DIR/ollama.sh (the launcher writes it): start this app from the launcher."

# The model, and the context length the server starts with (Ollama cannot
# change it later), which fx's context_window matches.

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
if [ -z "$MODEL" ] && [ -t 0 ]; then
	pick_model 'qwen3-1.7b|Qwen3 1.7B (1296 MiB): tool calls; guest memory 3 GiB or more
qwen3|Qwen3 0.6B (498 MiB): quicker, weaker at tool calls
qwen1.5|Qwen2.5 1.5B (940 MiB): tool calls, no thinking
qwen|Qwen2.5 0.5B (379 MiB): calls tools, seldom well
qwen3.5|Qwen3.5 0.8B (971 MiB, Q8_0): newer; untried with fx
llama3.2|Llama 3.2 1B (1259 MiB, Q8_0)
smollm2|SmolLM2 135M (100 MiB): the fastest; tool calls seldom right
qwen-coder|Qwen2.5-Coder 0.5B (379 MiB): better code, rarely calls tools'
fi
[ -n "$MODEL" ] || MODEL=qwen3-1.7b
case $MODEL in
*.gguf) [ ! -e "$MODEL" ] || MODEL=$(realpath "$MODEL") ;;
esac
case $MODEL in
stories260K) c=${OLLAMA_MODEL_CTX} ;;
smollm2) c=8192 ;;
qwen3 | qwen3-1.7b | qwen | qwen-coder | qwen1.5 | llama3.2 | qwen3.5) c=16384 ;;
*) c=8192 ;;
esac
[ -n "$CTX" ] || CTX=$c
case $CTX in '' | *[!0-9]*) die "CTX=$CTX: a number of tokens" ;; esac
# Temperature 0 unless TEMP says otherwise: fx sends none, and a small model
# calls tools more steadily without sampling noise.
[ -n "$TEMP" ] || TEMP=0
[ "$TEMP" != model ] || TEMP=
export TEMP
export MODEL OLLAMA_CONTEXT_LENGTH=$CTX

# The server: ollama.sh in the Ollama app's directory, in the background
# (a background job of this script ignores Ctrl-C, which fx uses); stopped
# when this script ends (its traps stop ollama serve).
mkdir -p "$FXH" work
rm -f "$OLLAMA_DIR/ollama.ready"
say "Starting Ollama on kwvk (the Ollama app's ollama.sh, SERVE=1; context $CTX tokens; its log: $OLLAMA_DIR/ollama.log)"
(cd "$OLLAMA_DIR" && SERVE=1 exec ./ollama.sh) </dev/null &
OSH=$!
stop() {
	kill -0 $OSH 2>/dev/null || return 0
	say "Stopping the Ollama server"
	kill $OSH 2>/dev/null || true
	for i in $(seq 100); do kill -0 $OSH 2>/dev/null || return 0; sleep 0.2; done
	kill -9 $OSH 2>/dev/null || true
}
trap stop EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
trap 'exit 130' INT
until [ -s "$OLLAMA_DIR/ollama.ready" ]; do
	if ! kill -0 $OSH 2>/dev/null; then
		st=0
		wait $OSH || st=$?
		# ollama.sh's status: 3 a download failed, 4 a shader refused, 5 device lost.
		case $st in
		3) say "A download failed (above: which); run ./fx-local.sh again to resume it." ;;
		4) say "Guest Vulkan cannot run one of $MODEL's shaders: try the default, Qwen3 1.7B (./fx-local.sh), or MODEL=qwen3." ;;
		esac
		die "ollama.sh stopped before the model was ready (exit $st; above: why)."
	fi
	sleep 0.5
done
NAME=$(head -n 1 "$OLLAMA_DIR/ollama.ready")

# What Ollama knows of the model: its trained context, and whether its
# template takes tools (capabilities).
info=$(curl -fs "$HOST/api/show" -d "$(jq -nc --arg m "$NAME" '{model: $m}')") || info='{}'
trained=$(printf '%s' "$info" | jq -r '[(.model_info // {}) | to_entries[] | select(.key | endswith(".context_length")) | .value][0] // empty' 2>/dev/null) || trained=
WIN=$CTX
if [ -n "$trained" ] && [ "$trained" -lt "$CTX" ]; then
	say "$NAME was trained on $trained tokens of context: fx gets $trained (CTX=$trained next time)."
	WIN=$trained
fi
OUT=$((WIN / 4))
[ $OUT -le 2048 ] || OUT=2048
if [ -n "$TOOLS" ]; then
	case $TOOLS in 0 | false | no) T=false ;; *) T=true ;; esac
elif [ "$NAME" = ${OLLAMA_MODEL} ]; then
	T=${OLLAMA_MODEL_TOOLS}
else
	T=$(printf '%s' "$info" | jq -r '(.capabilities // []) | index("tools") != null' 2>/dev/null) || T=false
	[ "$T" = true ] || T=false
fi

# fx's connection "local", merged into the app-private settings.json: the
# rest of the file (preferences fx saved there) stays. Long timeouts: a
# first reply waits for fx's whole prompt to go through the GPU.
S=$FXH/settings.json
{ [ -s "$S" ] && jq -e 'type == "object"' "$S" >/dev/null 2>&1; } || echo '{}' >"$S"
# Thinking (Qwen3, Qwen3.5: Ollama's capability "thinking") stays on unless
# THINK=0: the reasoning before each answer is most of a turn's tokens, and
# counts in the reply's limit. fx sends the connection's per-model request
# fields with each request, and Ollama takes reasoning_effort "none" for no
# thinking.
NOTHINK=false
if printf '%s' "$info" | jq -e '(.capabilities // []) | index("thinking") != null' >/dev/null 2>&1; then
	case $THINK in 0 | false | no | off) NOTHINK=true; say "$NAME: thinking off (THINK=0)." ;; *) say "$NAME thinks before it answers (THINK=0 turns that off: quicker turns)." ;; esac
fi
jq --arg m "$NAME" --arg url "http://$HOST/v1" --argjson win "$WIN" --argjson out "$OUT" --argjson tools "$T" --argjson nothink "$NOTHINK" '
	.provider = "local"
	| .providers.local = ((.providers.local // {}) * {
		protocol: "openai-chat-completions",
		base_url: $url,
		auth: {type: "none"},
		timeouts: {first_response_ms: 1800000, stall_ms: 1800000},
		model_metadata: {($m): {context_window: $win, max_output_tokens: $out, supports_tool_use: $tools, supports_vision: false}}
	})
	| (if $nothink then .providers.local.model_metadata[$m].request = {reasoning_effort: "none"}
	   else del(.providers.local.model_metadata[$m].request) end)
	| .models.local = $m' "$S" >"$S.new"
mv "$S.new" "$S"

printf "$B%s$N\n" "fx on $NAME: context $WIN tokens, replies up to $OUT, tool use $T (the connection local in $S)"
# fx sends its tools with every request, and Ollama refuses them (HTTP 400)
# for a model whose template takes none.
[ "$T" = true ] || die "$NAME cannot call tools (Ollama's capabilities for it), and fx needs them: Ollama would answer its requests with HTTP 400. Run ./fx-local.sh for the default, Qwen3 1.7B, or MODEL= another model with tools; to talk with $NAME without fx: cd $OLLAMA_DIR && MODEL=$MODEL ./ollama.sh"
say "fx works in $PWD/work and runs its tool calls without asking (FX_PERMISSION_MODE=auto or ask to change). Slow: each turn sends fx's whole prompt and tool list through this tab's GPU, so a first reply can take minutes. Quitting fx stops the server."
# fx asks nothing before a tool call (full-access) unless the caller set a mode.
PERM=$FX_PERMISSION_MODE
[ -n "$PERM" ] || PERM=full-access
cd work
trap : INT
set +e
FX_HOME=$FXH FX_PROVIDER=local FX_MODEL=$NAME FX_AUTO_UPGRADE=0 FX_PERMISSION_MODE=$PERM fx
exit $?
`;

const README = "fx, the coding agent, talking to a model that runs in this browser tab's GPU:\n" +
	"Ollama's server, llama.cpp's llama-server, Vulkan (the guest's kwvk), WebGPU.\n" +
	"fx-local.sh starts the Ollama app's server (" + OLLAMA_DIR + "/ollama.sh, its log\n" +
	"ollama.log there) with the model on the GPU, runs fx with the connection local,\n" +
	"and stops the server when fx quits. fx's settings for it are in\n" +
	"~/.apps/fx-local/fx-home (FX_HOME): your own ~/.fx is not touched.\n" +
	"\n" +
	"fx-local.sh asks which model (MODEL=NAME skips the question). The first is\n" +
	"Qwen3 1.7B (Q4_K_M, 1296 MiB, fetched once): small, and it can call tools,\n" +
	"which fx needs, though models this small often answer without calling one.\n" +
	"The model runs at temperature 0 (TEMP=N); Qwen3 thinks before it answers\n" +
	"(THINK=0 ./fx-local.sh: no thinking, quicker turns). fx runs its tool calls\n" +
	"(commands, file writes) without asking, in ./work (FX_PERMISSION_MODE=auto\n" +
	"or ask ./fx-local.sh for fx's usual checks). It\n" +
	"needs guest memory of 3 GiB or more (Settings) and a real GPU to be usable\n" +
	"(software WebGPU, SwiftShader, runs it at a token every few seconds).\n" +
	"Others:\n" +
	"  MODEL=qwen3 ./fx-local.sh         (Qwen3 0.6B, 498 MiB: quicker, weaker at\n" +
	"                                     tool calls)\n" +
	"  MODEL=qwen-coder ./fx-local.sh    (Qwen2.5-Coder 0.5B: better code, but\n" +
	"                                     rarely calls fx's tools)\n" +
	"  MODEL=NAME ./fx-local.sh          (another model of Ollama's library with\n" +
	"                                     tools; fx cannot use a model without\n" +
	"                                     tools, such as stories260K)\n" +
	"  MODEL=PATH.gguf ./fx-local.sh     (another GGUF with tools)\n" +
	"  CTX=4096 ./fx-local.sh            (a smaller context: less device memory)\n" +
	"\n" +
	"Slow and limited: every turn sends fx's whole prompt and tool list (thousands\n" +
	"of tokens) through the GPU, so a first reply can take minutes, and models this\n" +
	"small often miss what fx asks of them. Custom connections have no gateway\n" +
	"search, credit checks, /usage, Fast mode or provider order. Not offline: web\n" +
	"search and remote MCP servers still use the network (update checks are off\n" +
	"for this run).\n" +
	"\n" +
	"If it fails: guest Vulkan cannot run some models (mixture-of-experts ones\n" +
	"abort at a refused shader); the driver reports 4 GiB of GPU memory (KWVK_HEAP_MB=N sets it), so a\n" +
	"model and its context that do not fit load partly or not at all on the GPU:\n" +
	"more guest memory (Settings), or a smaller CTX; a lost WebGPU device: run\n" +
	"./fx-local.sh again.\n";

export default {
	id: "fx-local",
	title: "fx (local model)",
	desc: "fx on a model in this browser's GPU: Ollama on guest Vulkan as fx's local connection; asks which model (Qwen3 1.7B, 1296 MiB, guest memory 3 GiB or more; or smaller ones), fetched with Ollama and llama.cpp on first run",
	icon: "𝒇x",
	// fx's tile in the Ollama app's teal.
	colors: ["#0f766e", "#09090b"],
	needs: ollama.needs,
	packages: { debian: [...ollama.packages.debian, "jq"] },
	terminal: "window",
	files: {
		...Object.fromEntries(Object.entries(ollama.files).map(([p, f]) => [inOllama(p), f])),
		"fx-local.sh": { content: FX_LOCAL_SH, mode: 0o755 },
		README,
	},
	downloads: ollama.downloads.map((f) => ({ ...f, path: inOllama(f.path) })),
	commands: ["cat README", "./fx-local.sh"],
} satisfies TerminalApp;
