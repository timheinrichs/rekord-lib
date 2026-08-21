import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const { default: ReleaseNotes } = await import("./ReleaseNotes");

describe("ReleaseNotes", () => {
  it("renders the marks instead of printing them", () => {
    const { container } = render(
      <ReleaseNotes notes={"### Fixed\n- **A data-loss bug.** In `db::open`."} />,
    );
    expect(screen.getByRole("heading", { name: "Fixed" })).toBeInTheDocument();
    expect(container.querySelector("li")).not.toBeNull();
    expect(screen.getByText("A data-loss bug.").tagName).toBe("STRONG");
    expect(screen.getByText("db::open").tagName).toBe("CODE");
    // The point of the whole component: no syntax left on screen.
    expect(container.textContent).not.toContain("*");
    expect(container.textContent).not.toContain("#");
    expect(container.textContent).not.toContain("`");
  });

  it("opens a web link in the browser", async () => {
    const user = userEvent.setup();
    render(<ReleaseNotes notes="See [the docs](https://rekord.dev/docs)." />);
    await user.click(screen.getByRole("button", { name: "the docs" }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://rekord.dev/docs");
  });

  it("refuses to hand any other scheme to the OS", () => {
    // Release notes arrive over the network. A link that is not http(s) stays
    // text — written out as it was, so the destination is visible rather than
    // silently dropped.
    const { container } = render(
      <ReleaseNotes notes="[click](javascript:alert(1))" />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("[click](javascript:alert(1))");
  });

  it("renders nothing when there is nothing to render", () => {
    // The callers reduce the notes first (`renderableNotes`); a release whose
    // section was only the severity marker arrives here as an empty string.
    const { container } = render(<ReleaseNotes notes="" />);
    expect(container.querySelector("[data-release-notes]")).toBeNull();
  });

  it("shows an unknown construct as its own text rather than dropping it", () => {
    // The `<pre>` this replaced showed everything; nothing may vanish silently.
    const { container } = render(
      <ReleaseNotes notes={"| a | b |\n| --- | --- |"} />,
    );
    expect(container.textContent).toContain("| a | b |");
  });

  it("prints smaller where settings asks it to", () => {
    const { container } = render(<ReleaseNotes notes="- a bullet" size="xs" />);
    expect(container.querySelector("ul")).toHaveClass("text-xs");
  });
});
