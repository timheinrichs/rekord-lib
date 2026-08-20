import { afterEach, describe, expect, it, vi } from "vitest";
import { devInstall, devUpdate } from "./devUpdate";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("devUpdate", () => {
  it("is null unless the variable is set", () => {
    // Which is every ordinary dev run, and every build.
    expect(devUpdate()).toBeNull();
    vi.stubEnv("VITE_DEV_UPDATE", "");
    expect(devUpdate()).toBeNull();
  });

  it("fakes an ordinary update for any other value", () => {
    vi.stubEnv("VITE_DEV_UPDATE", "1");
    const u = devUpdate();
    expect(u?.severity).toBeNull();
    expect(u?.version).toBeTruthy();
    expect(u?.currentVersion).toBeTruthy();
  });

  it("fakes a critical one on request, so that banner is reachable too", () => {
    vi.stubEnv("VITE_DEV_UPDATE", "critical");
    expect(devUpdate()?.severity).toBe("critical");
  });

  it("says in its own notes that it is a mock", () => {
    // The dialog is the only place these are read; a fake that looks real is a
    // support question waiting to happen.
    vi.stubEnv("VITE_DEV_UPDATE", "1");
    expect(devUpdate()?.notes).toContain("Dev mock");
    expect(devUpdate()?.notes).toContain("REKORD_DEV_UPDATE");
  });
});

describe("devInstall", () => {
  it("reports progress to the end and then fails on purpose", async () => {
    // The progress state is part of what there is to look at; the failure is
    // because there is no artifact, and a silent success would relaunch into
    // the same version.
    const seen: number[] = [];
    await expect(
      devInstall((done, total) => seen.push(total ? done / total : 0), async () => {}),
    ).rejects.toThrow(/nothing to install/);

    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    // Ramped rather than jumping straight to done.
    expect(seen.length).toBeGreaterThan(3);
  });
});
