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

  it("does not repeat the severity the UI already states", () => {
    // The tag beside the version and the banner in settings say it; the raw
    // marker line underneath would say it a second time.
    const { container } = render(
      <ReleaseNotes notes={"**Severity:** critical\n\n### Fixed\n- A bug."} />,
    );
    expect(container.textContent).not.toMatch(/Severity/i);
    expect(screen.getByText("A bug.")).toBeInTheDocument();
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

  it("renders nothing when the marker was all there was", () => {
    const { container } = render(<ReleaseNotes notes="**Severity:** critical" />);
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
