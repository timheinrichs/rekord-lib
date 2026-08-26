import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "../lib/settings";
import type { UpdateInfo } from "../lib/updater";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.6.1" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const api = vi.hoisted(() => ({
  discogsCredentials: vi.fn(async () => ({
    stored: false,
    unavailable: false,
    kind: null as "token" | "app" | null,
    saved_at: null as number | null,
  })),
  setDiscogsToken: vi.fn(async () => {}),
  setDiscogsAppCredentials: vi.fn(async () => {}),
  clearDiscogsCredentials: vi.fn(async () => {}),
}));
vi.mock("../lib/api", () => ({
  bandcampConnect: vi.fn(),
  bandcampDisconnect: vi.fn(),
  bandcampLogin: vi.fn(),
  pickOutputDir: vi.fn(),
  onScanProgress: vi.fn(async () => () => {}),
  ...api,
}));
vi.mock("../lib/library", () => ({ relocateLibrary: vi.fn() }));
vi.mock("../lib/updater", () => ({
  checkForUpdate: vi.fn(async () => null),
  installUpdate: vi.fn(),
}));

const { default: SettingsView } = await import("./SettingsView");

function update(over: Partial<UpdateInfo>): UpdateInfo {
  return {
    version: "0.6.2",
    currentVersion: "0.6.1",
    notes: undefined,
    severity: null,
    ...over,
  };
}

function renderSettings(pending: UpdateInfo | null) {
  return render(
    <SettingsView
      settings={DEFAULT_SETTINGS}
      onSettingsChange={() => {}}
      account={null}
      onAccountChange={() => {}}
      update={pending}
      onUpdateChange={() => {}}
    />,
  );
}

describe("SettingsView · About", () => {
  it("offers a check when nothing is waiting", () => {
    renderSettings(null);
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeInTheDocument();
  });

  it("keeps an ordinary update quiet", () => {
    const { container } = renderSettings(update({}));
    expect(screen.getByText(/Update available: v0\.6\.2/)).toBeInTheDocument();
    // The pill, not a banner: nothing in the section wears a status colour.
    expect(container.querySelector(".border-danger-500\\/40")).toBeNull();
  });

  it("keeps an important update a pill, but a yellow one", () => {
    // Loud enough to notice, quiet enough not to take the banner: nothing is at
    // risk while it waits.
    const { container } = renderSettings(update({ severity: "important" }));
    expect(
      screen.getByText(/Important update available/),
    ).toBeInTheDocument();
    expect(container.querySelector(".border-danger-500\\/40")).toBeNull();
    expect(container.querySelector(".text-warning-500")).not.toBeNull();
  });

  it("states a critical update as a banner, in danger", () => {
    // A security or data-loss fix has to look different from a nice-to-have,
    // in the same shape the library view states a broken sidecar.
    const { container } = renderSettings(update({ severity: "critical" }));
    const banner = container.querySelector(".border-danger-500\\/40");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Critical update available");
    expect(banner?.textContent).toContain("v0.6.2");
    // Still one accent for the action itself.
    expect(banner?.querySelector("button")).toHaveClass("bg-accent-600");
  });

  it("shows what changed, whatever the severity", () => {
    // The notes are the changelog section for that version — deciding whether
    // to restart now is easier when you can see what you get.
    renderSettings(update({ notes: "### Fixed\n- A data-loss bug." }));
    expect(screen.getByText(/A data-loss bug/)).toBeInTheDocument();
  });

  it("shows no notes block when the release carried none", () => {
    // Every release built before the workflow started passing them.
    const { container } = renderSettings(update({ notes: undefined }));
    // The notes themselves — not there at all rather than there and empty.
    expect(container.querySelector("[data-release-notes]")).toBeNull();
  });
});

describe("SettingsView · Discogs", () => {
  const nothingStored = {
    stored: false,
    unavailable: false,
    kind: null,
    saved_at: null,
  } as const;

  beforeEach(() => {
    api.discogsCredentials.mockClear();
    api.setDiscogsToken.mockClear();
    api.setDiscogsAppCredentials.mockClear();
    api.clearDiscogsCredentials.mockClear();
    api.discogsCredentials.mockResolvedValue(nothingStored);
  });

  it("stores a token in the Keychain, and forgets it", async () => {
    const user = userEvent.setup();
    renderSettings(null);

    const token = screen.getByLabelText("Personal access token");
    await user.type(token, "tok-123");
    await user.click(screen.getByRole("button", { name: "Save to Keychain" }));

    expect(api.setDiscogsToken).toHaveBeenCalledWith("tok-123");
    // Written once: the field does not keep a copy for the next render.
    await waitFor(() => expect(token).toHaveValue(""));
  });

  it("cannot store an empty token", async () => {
    renderSettings(null);
    expect(
      screen.getByRole("button", { name: "Save to Keychain" }),
    ).toBeDisabled();
  });

  it("still takes a registered app's key and secret", async () => {
    // The older way in stays reachable: whoever already registered a Discogs
    // application should not have to start over with a token.
    const user = userEvent.setup();
    renderSettings(null);

    await user.click(
      screen.getByRole("button", { name: /already registered/i }),
    );
    await user.type(screen.getByLabelText("Consumer key"), "key-123");
    await user.type(screen.getByLabelText("Consumer secret"), "secret-456");
    await user.click(screen.getByRole("button", { name: "Save key + secret" }));

    expect(api.setDiscogsAppCredentials).toHaveBeenCalledWith(
      "key-123",
      "secret-456",
    );
  });

  it("cannot save a half filled pair", async () => {
    const user = userEvent.setup();
    renderSettings(null);

    await user.click(
      screen.getByRole("button", { name: /already registered/i }),
    );
    const save = screen.getByRole("button", { name: "Save key + secret" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Consumer key"), "key-123");
    expect(save).toBeDisabled();
  });

  it("says which credential is stored, and since when", async () => {
    api.discogsCredentials.mockResolvedValue({
      stored: true,
      unavailable: false,
      kind: "token",
      saved_at: Date.UTC(2026, 6, 21, 12, 0, 0),
    });
    renderSettings(null);

    expect(await screen.findByText("Stored in the Keychain")).toBeInTheDocument();
    // The form and the date answer "which one is in there" — the question the
    // consumer key used to answer, at the price of showing it.
    expect(
      screen.getByText(/personal access token · 2026-07-21/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Personal access token")).toBeNull();
  });

  it("says so without a date when the Keychain kept none", async () => {
    // A credential stored by a version before the date existed. The label is
    // beside the point; the credential is what matters.
    api.discogsCredentials.mockResolvedValue({
      stored: true,
      unavailable: false,
      kind: "app",
      saved_at: null,
    });
    renderSettings(null);

    expect(await screen.findByText("consumer key + secret")).toBeInTheDocument();
  });

  it("never renders stored credential material", async () => {
    // The regression this whole change exists for: the consumer key used to be
    // rendered next to the badge, which put it on every screenshot of this
    // screen. The status deliberately carries more than its type allows — an
    // older backend, a widened payload — because a mock shaped like the new
    // type could not fail this test, and the point is that the view ignores
    // credential material even when it is handed some.
    api.discogsCredentials.mockResolvedValue({
      stored: true,
      unavailable: false,
      kind: "app",
      saved_at: Date.UTC(2026, 6, 21, 12, 0, 0),
      key: "key-123",
      token: "tok-123",
    } as never);
    const { container } = renderSettings(null);

    await screen.findByText("Stored in the Keychain");
    expect(container.textContent).not.toContain("key-123");
    expect(container.textContent).not.toContain("tok-123");
  });

  it("removes a stored credential on request", async () => {
    const user = userEvent.setup();
    api.discogsCredentials.mockResolvedValue({
      stored: true,
      unavailable: false,
      kind: "token",
      saved_at: Date.UTC(2026, 6, 21, 12, 0, 0),
    });
    renderSettings(null);

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(api.clearDiscogsCredentials).toHaveBeenCalled();
  });

  it("says so when the Keychain will not answer, and asks again", async () => {
    // Fails closed: nothing falls back to the settings file, so the way out is
    // entering the credential again — which needs the form to be there. The
    // suggestions themselves keep working, anonymously.
    api.discogsCredentials.mockResolvedValue({
      stored: false,
      unavailable: true,
      kind: null,
      saved_at: null,
    });
    renderSettings(null);

    expect(
      await screen.findByText(/Keychain could not be read/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Personal access token")).toBeInTheDocument();
  });

  it("treats a rejected read as a Keychain that said no", async () => {
    api.discogsCredentials.mockRejectedValue(new Error("denied"));
    renderSettings(null);

    expect(
      await screen.findByText(/Keychain could not be read/),
    ).toBeInTheDocument();
  });
});
