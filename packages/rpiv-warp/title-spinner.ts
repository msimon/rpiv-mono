/**
 * rpiv-warp — Tab-title activity spinner.
 *
 * Warp's per-tab "moving dots" animation is NOT part of the OSC 777 cli-agent
 * protocol — it's a side effect of the foreground process continuously
 * rewriting its terminal title via OSC 0 (`\x1b]0;<title>\x07`). Ticking
 * braille glyphs through the title every ~160ms while a turn is in flight
 * animates the indicator (same mechanism in iTerm2, Ghostty, tmux, Windows
 * Terminal — terminal-side, not Warp-specific).
 *
 * Label strategy: the spinner shows the LIVE session label — the agent's
 * session name when set, else the repo (`basename(cwd)`) — supplied by
 * `index.ts` as a getter and re-read on every tick. This matters because Pi
 * auto-generates the session name in the background *during* a turn; reading
 * it live means the new name lands in the tab within one frame instead of
 * being clobbered.
 *
 *   on agent_start(getLabel)   → start ticking
 *   while running, every 160ms → OSC 0  (`<glyph> <getLabel()>`)
 *   on agent_end(getLabel)     → OSC 0  (`<getLabel()>`, no glyph)
 *
 * On stop we WRITE the current label rather than restoring a title-stack
 * snapshot (no CSI 22/23): a snapshot taken at turn start cannot reflect a
 * name set mid-turn, and explicit writes are robust on terminals that don't
 * implement the title stack.
 *
 * Module state: a single in-flight ticker. `startSpinner`/`stopSpinner` are
 * idempotent. The timer is `unref()`d so a stray interval cannot block exit.
 * `__resetState` is the test-cleanup contract (timer-only; no I/O).
 */

import { writeOSC0 } from "./warp-notify.js";

// ---------------------------------------------------------------------------
// Constants — tunable at one site
// ---------------------------------------------------------------------------

/**
 * 2×2-dot rotation, inverted: three of four dots in the cell's middle
 * sub-grid (dots 2,5,3,6) stay lit, one rotates as a moving "gap"
 * clockwise from top-left → top-right → bottom-right → bottom-left.
 *
 *   ⠴   ⠦   ⠖   ⠲      (gap at TL, TR, BR, BL)
 *
 * Reads as a 3-dot cluster with a hole spinning around it. All four
 * frames share the same monospace width, so the title suffix doesn't
 * shimmer (vs Claude Code's variable-width `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`,
 * anthropics/claude-code#17887).
 *
 * At FRAME_INTERVAL_MS = 160, the 4-frame cycle completes every ~640ms
 * (~1.5 Hz) — relaxed pulse, deliberately slower than typical CLI
 * spinners (80–100ms) so the tab indicator reads as ambient activity
 * rather than urgency.
 */
export const SPINNER_FRAMES: readonly string[] = ["⠴", "⠦", "⠖", "⠲"];

/** Tick rate — slower than typical CLI spinners (~80ms); reads as ambient. */
export const FRAME_INTERVAL_MS = 160;

// ---------------------------------------------------------------------------
// Pure formatter — no I/O
// ---------------------------------------------------------------------------

export function activeTitle(frameIndex: number, label: string = ""): string {
	const glyph = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
	return label ? `${glyph} ${label}` : glyph;
}

// ---------------------------------------------------------------------------
// Module state — one ticker at a time; idempotent start/stop
// ---------------------------------------------------------------------------

interface Ticker {
	timer: ReturnType<typeof setInterval>;
	frame: number;
	getLabel: () => string;
}

let active: Ticker | undefined;

function tick(): void {
	if (!active) return;
	writeOSC0(activeTitle(active.frame, active.getLabel()));
	active.frame = (active.frame + 1) % SPINNER_FRAMES.length;
}

// ---------------------------------------------------------------------------
// Public API — wired from index.ts agent-loop boundaries
// ---------------------------------------------------------------------------

export function startSpinner(getLabel: () => string = () => ""): void {
	if (active) return;
	const timer = setInterval(tick, FRAME_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();
	active = { timer, frame: 0, getLabel };
}

export function stopSpinner(getLabel?: () => string): void {
	if (!active) return;
	const label = getLabel ?? active.getLabel;
	clearInterval(active.timer);
	active = undefined;
	writeOSC0(label());
}

export function __resetState(): void {
	if (active) clearInterval(active.timer);
	active = undefined;
}
