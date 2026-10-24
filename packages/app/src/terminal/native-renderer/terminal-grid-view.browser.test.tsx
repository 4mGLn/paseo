import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalViewportState } from "./headless-terminal-state";
import { TerminalGridView } from "./terminal-grid-view.native";

const output = "#".repeat(49);
const state: TerminalViewportState = {
  rows: 1,
  cols: 49,
  firstRow: 0,
  oldestRow: 0,
  newestRow: 0,
  grid: [[...output].map((char) => ({ char }))],
  cursor: { row: 0, col: 48, hidden: true },
};

afterEach(cleanup);

describe("native terminal full-width text", () => {
  it.each([9, 11, 12, 14, 18])(
    "fits every character in a full-width ASCII row at %s px",
    async (fontSize) => {
      const view = render(<TerminalGridView state={state} fontSize={fontSize} />);
      const text = view.getByText(output);
      await expect.poll(() => text.clientWidth).toBeGreaterThan(0);
      // The native Text adapter truncates overflowing one-line content. Compare the actual
      // font layout with the available width, rather than asserting a particular CSS policy.
      await expect.poll(() => text.scrollWidth - text.clientWidth).toBeLessThanOrEqual(1);
      const run = text.parentElement!;
      expect(run.getBoundingClientRect().width).toBeCloseTo(text.getBoundingClientRect().width, 1);
      expect(view.getByTestId("terminal-row-0").getAttribute("aria-label")).toBe(output);
    },
  );
});
