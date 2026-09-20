import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AddToPlaylistDialog from "./AddToPlaylistDialog";
import type { Playlist } from "../types";

/**
 * The picker, as a component: pure props in, callbacks out, no backend.
 *
 * The menu it replaced had no test of its own, which was defensible while it
 * was a list of buttons. A dialog has behaviour — an empty state that skips a
 * step, a commit that has to close, and an Escape that means two different
 * things depending on where the caret is — and the last of those is the one
 * that would otherwise be found by a person pressing Escape over a half-typed
 * name.
 */
const playlist = (id: number, name: string, track_count = 0): Playlist => ({
  id,
  name,
  created_ms: id,
  updated_ms: id,
  track_count,
});

function setup(over: Partial<Parameters<typeof AddToPlaylistDialog>[0]> = {}) {
  const props = {
    playlists: [playlist(1, "Warmup"), playlist(2, "Peak"), playlist(3, "Full")],
    gains: { 1: 2, 2: 1, 3: 0 },
    count: 2,
    onAdd: vi.fn(),
    onCreate: vi.fn(),
    suggestName: (base: string) => base,
    onClose: vi.fn(),
    ...over,
  };
  render(<AddToPlaylistDialog {...props} />);
  return { user: userEvent.setup(), ...props };
}

describe("AddToPlaylistDialog", () => {
  it("is a dialog with a name of its own", () => {
    // `e2e/menus.spec.ts` selects on `role="dialog"` to measure where the panel
    // lands in a real window, so a silent rename would make it measure nothing.
    setup();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add to playlist");
  });

  it("says what each playlist would gain, and refuses the one with nothing to", () => {
    // The wording is the affordance, and it is also the answer to "are these
    // already in there?" — see docs/PLAYLISTS.md.
    setup();
    expect(screen.getByRole("button", { name: /Warmup/ })).toHaveTextContent("+2");
    expect(screen.getByRole("button", { name: /Peak/ })).toHaveTextContent(
      "+1 of 2",
    );
    const full = screen.getByRole("button", { name: /Full/ });
    expect(full).toHaveTextContent("already in");
    expect(full).toBeDisabled();
  });

  it("commits once and leaves", async () => {
    const { user, onAdd, onClose } = setup();
    await user.click(screen.getByRole("button", { name: /Warmup/ }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("makes a new playlist from the footer, not from the end of the list", async () => {
    const { user, onCreate, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "New playlist" }));
    const field = screen.getByLabelText("New playlist name");
    expect(field).toHaveValue("New playlist");

    await user.clear(field);
    await user.type(field, "Warm-up 2{Enter}");
    expect(onCreate).toHaveBeenCalledExactlyOnceWith("Warm-up 2");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("will not create a playlist with no name", async () => {
    const { user, onCreate } = setup();
    await user.click(screen.getByRole("button", { name: "New playlist" }));
    const field = screen.getByLabelText("New playlist name");
    await user.clear(field);
    await user.type(field, "   ");

    expect(screen.getByRole("button", { name: "Create and add" })).toBeDisabled();
    await user.type(field, "{Enter}");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("gives Escape to the field before the dialog", async () => {
    // Two meanings for one key. Without `stopPropagation` in the field, a
    // keystroke meant to undo a half-typed name closes the whole dialog —
    // which is the regression `Overlay`'s new Escape makes possible.
    const { user, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "New playlist" }));
    await user.type(screen.getByLabelText("New playlist name"), "Warm{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "New playlist" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens on its only action when there is nothing to pick from", async () => {
    // A picker with nothing to pick is a create dialog, so it skips the step
    // that would otherwise stand between the user and the only thing to do.
    setup({ playlists: [], gains: {} });
    expect(
      screen.queryByRole("button", { name: "New playlist" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/No playlists yet/)).toBeInTheDocument();
    expect(screen.getByLabelText("New playlist name")).toHaveFocus();
  });

  it("counts the selection in words, singular included", () => {
    setup({ count: 1, gains: { 1: 1, 2: 1, 3: 0 } });
    expect(screen.getByText("1 track selected")).toBeInTheDocument();
  });
});
