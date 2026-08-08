import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDismiss } from "./useDismiss";

function Popover({ startOpen = true }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <>
      <div ref={ref}>
        <button onClick={() => setOpen((o) => !o)}>toggle</button>
        {open && <div>panel</div>}
      </div>
      <button>outside</button>
    </>
  );
}

describe("useDismiss", () => {
  it("closes on a press outside", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    expect(screen.getByText("panel")).toBeInTheDocument();
    await user.click(screen.getByText("outside"));
    expect(screen.queryByText("panel")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("panel")).not.toBeInTheDocument();
  });

  it("ignores presses inside the wrapped element", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    await user.click(screen.getByText("panel"));
    expect(screen.getByText("panel")).toBeInTheDocument();
  });

  it("lets the toggle button close it without reopening", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    // The button sits inside the ref, so the outside-press handler must not
    // fire — otherwise it would close and the click would reopen.
    await user.click(screen.getByText("toggle"));
    expect(screen.queryByText("panel")).not.toBeInTheDocument();
  });

  it("does nothing while closed", async () => {
    const user = userEvent.setup();
    render(<Popover startOpen={false} />);
    await user.keyboard("{Escape}");
    await user.click(screen.getByText("toggle"));
    expect(screen.getByText("panel")).toBeInTheDocument();
  });
});
