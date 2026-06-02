import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		openSync: vi.fn(),
		writeSync: vi.fn(),
		closeSync: vi.fn(),
	};
});

import {
	__resetState,
	activeTitle,
	FRAME_INTERVAL_MS,
	SPINNER_FRAMES,
	startSpinner,
	stopSpinner,
} from "./title-spinner.js";

function primeFs(): { open: Mock; write: Mock; close: Mock } {
	(fs.openSync as unknown as Mock).mockReturnValue(11);
	(fs.writeSync as unknown as Mock).mockReturnValue(0);
	(fs.closeSync as unknown as Mock).mockReturnValue(undefined);
	return {
		open: fs.openSync as unknown as Mock,
		write: fs.writeSync as unknown as Mock,
		close: fs.closeSync as unknown as Mock,
	};
}

function bytesAt(write: Mock, callIndex: number): string {
	return String(write.mock.calls[callIndex][1]);
}

function titleSetBody(write: Mock, callIndex: number): string {
	return bytesAt(write, callIndex)
		.replace(/^\x1b\]0;/, "")
		.replace(/\x07$/, "");
}

beforeEach(() => {
	__resetState();
	(fs.openSync as unknown as Mock).mockReset();
	(fs.writeSync as unknown as Mock).mockReset();
	(fs.closeSync as unknown as Mock).mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	__resetState();
});

describe("activeTitle", () => {
	it("returns the spinner glyph alone when no label is given", () => {
		expect(activeTitle(0)).toBe(SPINNER_FRAMES[0]);
	});
	it("renders `<glyph> <label>` with a single separating space", () => {
		expect(activeTitle(0, "my session")).toBe(`${SPINNER_FRAMES[0]} my session`);
		expect(activeTitle(3, "my session")).toBe(`${SPINNER_FRAMES[3]} my session`);
	});
	it("wraps frame index modulo SPINNER_FRAMES.length", () => {
		expect(activeTitle(SPINNER_FRAMES.length)).toBe(activeTitle(0));
		expect(activeTitle(SPINNER_FRAMES.length + 3)).toBe(activeTitle(3));
	});
});

describe("SPINNER_FRAMES", () => {
	it("rotates a 3-of-4 cluster — the missing dot walks the 2×2 grid clockwise", () => {
		expect(SPINNER_FRAMES).toEqual(["⠴", "⠦", "⠖", "⠲"]);
		for (const f of SPINNER_FRAMES) expect(f).toMatch(/^[⠀-⣿]$/);
	});
});

describe("startSpinner / stopSpinner", () => {
	it("start does not write synchronously — the first glyph lands on the first tick", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		expect(write).not.toHaveBeenCalled();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 0)).toBe(`${SPINNER_FRAMES[0]} demo`);
	});

	it("ticks `<glyph> <label>` every FRAME_INTERVAL_MS, advancing through SPINNER_FRAMES", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 0)).toBe(`${SPINNER_FRAMES[0]} demo`);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 1)).toBe(`${SPINNER_FRAMES[1]} demo`);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 2)).toBe(`${SPINNER_FRAMES[2]} demo`);
	});

	it("re-reads the label getter each tick — a mid-animation rename appears on the next frame", () => {
		const { write } = primeFs();
		let label = "old";
		startSpinner(() => label);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 0)).toBe(`${SPINNER_FRAMES[0]} old`);
		label = "new";
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 1)).toBe(`${SPINNER_FRAMES[1]} new`);
	});

	it("wraps the frame index back to 0 after SPINNER_FRAMES.length ticks", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * (SPINNER_FRAMES.length + 1));
		expect(titleSetBody(write, 0)).toBe(`${SPINNER_FRAMES[0]} demo`);
		expect(titleSetBody(write, SPINNER_FRAMES.length)).toBe(`${SPINNER_FRAMES[0]} demo`);
	});

	it("stop clears the interval and writes the plain label (no glyph)", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
		const before = write.mock.calls.length;
		stopSpinner(() => "final");
		expect(write).toHaveBeenCalledTimes(before + 1);
		expect(titleSetBody(write, before)).toBe("final");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
		expect(write).toHaveBeenCalledTimes(before + 1);
	});

	it("stop falls back to the start getter when called without one", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		const before = write.mock.calls.length;
		stopSpinner();
		expect(titleSetBody(write, before)).toBe("demo");
	});

	it("startSpinner is idempotent — a second call while running keeps the first getter", () => {
		const { write } = primeFs();
		startSpinner(() => "a");
		startSpinner(() => "b");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(write).toHaveBeenCalledOnce();
		expect(titleSetBody(write, 0)).toBe(`${SPINNER_FRAMES[0]} a`);
	});

	it("stopSpinner is idempotent — call without an active ticker does NOT write", () => {
		const { write } = primeFs();
		stopSpinner(() => "x");
		expect(write).not.toHaveBeenCalled();
	});

	it("__resetState clears any pending interval without writing", () => {
		const { write } = primeFs();
		startSpinner(() => "demo");
		__resetState();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
		expect(write).not.toHaveBeenCalled();
	});
});
