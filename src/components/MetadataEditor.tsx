import { useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  coverPreview,
  pickImageFile,
  suggestMetadata,
} from "../lib/api";
import {
  formatDuration,
  formatLabel,
  formatSampleRate,
  trackBadges,
} from "../lib/format";
import type {
  CoverInput,
  MbCandidate,
  MetadataSuggestions,
  TrackAnalysis,
  TrackEdit,
  TrackMetadata,
} from "../types";

interface Props {
  track: TrackAnalysis;
  initial?: TrackEdit;
  /** Existing values per field as selection suggestions. */
  fieldOptions?: Record<string, string[]>;
  onClose: () => void;
  onSave: (edit: TrackEdit) => void;
}

interface FormState {
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  genre: string;
  year: string;
  track_number: string;
  catalog_number: string;
  label: string;
}

function toForm(md: TrackMetadata): FormState {
  return {
    title: md.title ?? "",
    artist: md.artist ?? "",
    album: md.album ?? "",
    album_artist: md.album_artist ?? "",
    genre: md.genre ?? "",
    year: md.year ?? "",
    track_number: md.track_number != null ? String(md.track_number) : "",
    catalog_number: md.catalog_number ?? "",
    label: md.label ?? "",
  };
}

function toMetadata(f: FormState, hasCover: boolean): TrackMetadata {
  const s = (v: string) => (v.trim() ? v.trim() : null);
  const n = (v: string) => {
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    title: s(f.title),
    artist: s(f.artist),
    album: s(f.album),
    album_artist: s(f.album_artist),
    genre: s(f.genre),
    year: s(f.year),
    track_number: n(f.track_number),
    catalog_number: s(f.catalog_number),
    label: s(f.label),
    has_cover: hasCover,
  };
}

const FIELDS: { key: keyof FormState; label: string; required?: boolean }[] = [
  { key: "title", label: "Title", required: true },
  { key: "artist", label: "Artist", required: true },
  { key: "album", label: "Album" },
  { key: "album_artist", label: "Album Artist" },
  { key: "genre", label: "Genre" },
  { key: "year", label: "Year" },
  { key: "track_number", label: "Track No." },
  { key: "label", label: "Label" },
  { key: "catalog_number", label: "Catalog no." },
];

export default function MetadataEditor({
  track,
  initial,
  fieldOptions,
  onClose,
  onSave,
}: Props) {
  const [suggestions, setSuggestions] = useState<MetadataSuggestions | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(
    toForm(initial?.metadata ?? track.metadata),
  );
  const [cover, setCover] = useState<CoverInput>(
    initial?.cover ?? (track.metadata.has_cover ? { kind: "keep" } : { kind: "none" }),
  );
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverLoading, setCoverLoading] = useState(false);

  // Load suggestions.
  useEffect(() => {
    let active = true;
    setLoading(true);
    suggestMetadata(track.path)
      .then((s) => active && setSuggestions(s))
      .catch((e) => console.error(e))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [track.path]);

  // Load cover preview when the cover source changes.
  useEffect(() => {
    let active = true;
    if (cover.kind === "none") {
      setCoverUrl(null);
      return;
    }
    setCoverLoading(true);
    coverPreview(track.path, cover)
      .then((url) => active && setCoverUrl(url))
      .catch(() => active && setCoverUrl(null))
      .finally(() => active && setCoverLoading(false));
    return () => {
      active = false;
    };
  }, [cover, track.path]);

  const set = (key: keyof FormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Guessed value per field (filename first, otherwise best MB match).
  const guesses = useMemo(() => {
    const g: Partial<Record<keyof FormState, string>> = {};
    const best = suggestions?.candidates[0];
    const fromMd = (md: TrackMetadata | undefined) => md;
    const fg = fromMd(suggestions?.filename_guess);
    const pick = (
      key: keyof FormState,
      fgVal?: string | number | null,
      mbVal?: string | number | null,
    ) => {
      const v = fgVal ?? mbVal;
      if (v != null && String(v).trim()) g[key] = String(v);
    };
    pick("title", fg?.title, best?.title);
    pick("artist", fg?.artist, best?.artist);
    pick("album", fg?.album, best?.album);
    pick("genre", null, best?.genre);
    pick("year", null, best?.year);
    pick("track_number", fg?.track_number, best?.track_number);
    return g;
  }, [suggestions]);

  const applyCandidate = (c: MbCandidate) => {
    setForm((f) => ({
      ...f,
      title: c.title ?? f.title,
      artist: c.artist ?? f.artist,
      album: c.album ?? f.album,
      genre: c.genre ?? f.genre,
      year: c.year ?? f.year,
      track_number: c.track_number != null ? String(c.track_number) : f.track_number,
    }));
    if (c.release_id) setCover({ kind: "musicbrainz", release_id: c.release_id });
  };

  const chooseFile = async () => {
    const path = await pickImageFile();
    if (path) setCover({ kind: "file", path });
  };

  // Title & Artist are required fields.
  const canSave = !!form.title.trim() && !!form.artist.trim();

  const handleSave = () => {
    if (!canSave) return;
    const hasCover = cover.kind !== "none" && coverUrl != null;
    onSave({ metadata: toMetadata(form, hasCover), cover });
  };

  const coverKind = cover.kind;
  // Compatibility/metadata status badges (same as the library table).
  const statusBadges = trackBadges(track, initial);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-[80vw] max-w-[80vw] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-lg font-medium">Metadata</h2>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_220px]">
          {/* Fields */}
          <div className="flex flex-col gap-3">
            {FIELDS.map(({ key, label, required }) => {
              const guess = guesses[key];
              const showGuess = guess && guess !== form[key];
              const missing = required && !form[key].trim();
              const opts = fieldOptions?.[key] ?? [];
              const listId = opts.length ? `edit-dl-${key}` : undefined;
              return (
                <label key={key} className="flex flex-col gap-1 text-sm">
                  <span className="text-fg-muted">
                    {label}
                    {required && <span className="ml-0.5 text-danger-500">*</span>}
                  </span>
                  <div className="flex gap-2">
                    <input
                      value={form[key]}
                      list={listId}
                      onChange={(e) => set(key, e.target.value)}
                      className={`flex-1 rounded-lg border bg-surface-2 px-3 py-2 outline-none focus:border-accent-500 ${
                        missing ? "border-danger-500/60" : "border-border-strong"
                      }`}
                    />
                    {listId && (
                      <datalist id={listId}>
                        {opts.map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                    )}
                    {showGuess && (
                      <button
                        onClick={() => set(key, guess!)}
                        title={`Apply suggestion: ${guess}`}
                        className="max-w-[40%] truncate rounded-lg border border-accent-600/40 bg-accent-600/10 px-2 py-1 text-xs text-accent-300 hover:bg-accent-600/20"
                      >
                        ↩ {guess}
                      </button>
                    )}
                  </div>
                </label>
              );
            })}

            {/* File path (read-only) + reveal in Finder — last field */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-muted">Path</span>
              <div className="flex gap-2">
                <input
                  value={track.path}
                  disabled
                  readOnly
                  className="flex-1 truncate rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-fg-subtle outline-none"
                  title={track.path}
                />
                <button
                  onClick={() => void revealItemInDir(track.path)}
                  className="shrink-0 rounded-lg border border-border-strong px-3 py-2 text-xs text-fg-muted hover:border-accent-500 hover:text-accent-400"
                >
                  Open in Finder
                </button>
              </div>
            </label>
          </div>

          {/* Cover */}
          <div className="flex flex-col gap-3">
            <span className="text-sm text-fg-muted">Cover</span>
            <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-border-strong bg-surface-2">
              {coverLoading ? (
                <span className="text-xs text-fg-subtle">Loading…</span>
              ) : coverUrl ? (
                <img src={coverUrl} className="h-full w-full object-cover" alt="Cover" />
              ) : (
                <span className="text-xs text-fg-subtle">No cover</span>
              )}
            </div>
            <div className="flex flex-col gap-1 text-sm">
              {track.metadata.has_cover && (
                <CoverRadio
                  checked={coverKind === "keep"}
                  onChange={() => setCover({ kind: "keep" })}
                  label="Keep existing"
                />
              )}
              <CoverRadio
                checked={coverKind === "musicbrainz"}
                onChange={() => {
                  const rid = suggestions?.candidates.find((c) => c.release_id)?.release_id;
                  if (rid) setCover({ kind: "musicbrainz", release_id: rid });
                }}
                disabled={!suggestions?.candidates.some((c) => c.release_id)}
                label="From MusicBrainz"
              />
              <CoverRadio
                checked={coverKind === "file"}
                onChange={chooseFile}
                label="From file…"
              />
              <CoverRadio
                checked={coverKind === "none"}
                onChange={() => setCover({ kind: "none" })}
                label="No cover"
              />
            </div>

            {/* Read-only track info (same as the library table columns). */}
            <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
              <InfoRow
                label="Format"
                value={`${formatLabel(
                  track.audio.codec,
                  track.audio.container,
                  track.audio.bits_per_sample,
                )} · ${formatSampleRate(track.audio.sample_rate)}`}
              />
              <InfoRow
                label="Length"
                value={formatDuration(track.audio.duration_secs)}
              />
              <div className="flex flex-col gap-1">
                <span className="text-fg-muted">Status</span>
                <div className="flex flex-wrap gap-1.5">
                  {statusBadges.length ? (
                    statusBadges.map((b, i) => (
                      <span
                        key={i}
                        title={b.title}
                        className={`rounded-full px-2 py-0.5 text-xs ring-1 ${b.className}`}
                      >
                        {b.label}
                      </span>
                    ))
                  ) : (
                    <span className="text-fg-subtle">–</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* MusicBrainz candidates */}
        <div className="border-t border-border px-5 py-3">
          <p className="mb-2 text-xs text-fg-muted">
            {loading
              ? "Searching for suggestions…"
              : suggestions?.candidates.length
                ? "MusicBrainz matches (click to apply):"
                : "No MusicBrainz matches – confirm fields manually."}
          </p>
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
            {suggestions?.candidates.map((c, i) => (
              <button
                key={i}
                onClick={() => applyCandidate(c)}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-accent-600 hover:bg-accent-600/5"
              >
                <span className="truncate">
                  <span className="text-fg">{c.artist ?? "?"}</span>
                  <span className="text-fg-subtle"> – </span>
                  <span className="text-fg">{c.title ?? "?"}</span>
                  {c.album && (
                    <span className="text-fg-subtle"> · {c.album}</span>
                  )}
                  {c.year && <span className="text-fg-subtle"> ({c.year})</span>}
                </span>
                <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-muted">
                  {c.score}%
                </span>
              </button>
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
          {!canSave && (
            <span className="mr-auto text-xs text-danger-500">
              Title and Artist are required.
            </span>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:border-border-strong"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-40"
          >
            Confirm
          </button>
        </footer>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span className="truncate text-right text-fg" title={value}>
        {value}
      </span>
    </div>
  );
}

function CoverRadio({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 ${disabled ? "opacity-40" : "cursor-pointer"}`}
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="h-3.5 w-3.5"
      />
      <span>{label}</span>
    </label>
  );
}
