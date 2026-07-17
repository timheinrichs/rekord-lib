import { useEffect, useMemo, useState } from "react";
import {
  coverPreview,
  pickImageFile,
  suggestMetadata,
} from "../lib/api";
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
    has_cover: hasCover,
  };
}

const FIELDS: { key: keyof FormState; label: string; required?: boolean }[] = [
  { key: "title", label: "Titel", required: true },
  { key: "artist", label: "Artist", required: true },
  { key: "album", label: "Album" },
  { key: "album_artist", label: "Album-Artist" },
  { key: "genre", label: "Genre" },
  { key: "year", label: "Jahr" },
  { key: "track_number", label: "Track-Nr." },
];

export default function MetadataEditor({ track, initial, onClose, onSave }: Props) {
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

  // Vorschläge laden.
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

  // Cover-Vorschau bei Änderung der Cover-Quelle laden.
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

  // Vermuteter Wert (Dateiname zuerst, sonst bester MB-Treffer) je Feld.
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

  // Titel & Artist sind Pflichtfelder.
  const canSave = !!form.title.trim() && !!form.artist.trim();

  const handleSave = () => {
    if (!canSave) return;
    const hasCover = cover.kind !== "none" && coverUrl != null;
    onSave({ metadata: toMetadata(form, hasCover), cover });
  };

  const coverKind = cover.kind;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="truncate text-sm font-medium" title={track.file_name}>
            Metadaten · {track.file_name}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100"
          >
            ✕
          </button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_220px]">
          {/* Felder */}
          <div className="flex flex-col gap-3">
            {FIELDS.map(({ key, label, required }) => {
              const guess = guesses[key];
              const showGuess = guess && guess !== form[key];
              const missing = required && !form[key].trim();
              return (
                <label key={key} className="flex flex-col gap-1 text-sm">
                  <span className="text-neutral-400">
                    {label}
                    {required && <span className="ml-0.5 text-rose-400">*</span>}
                  </span>
                  <div className="flex gap-2">
                    <input
                      value={form[key]}
                      onChange={(e) => set(key, e.target.value)}
                      className={`flex-1 rounded-lg border bg-neutral-800 px-3 py-2 outline-none focus:border-sky-500 ${
                        missing ? "border-rose-500/60" : "border-neutral-700"
                      }`}
                    />
                    {showGuess && (
                      <button
                        onClick={() => set(key, guess!)}
                        title={`Vorschlag übernehmen: ${guess}`}
                        className="max-w-[40%] truncate rounded-lg border border-sky-600/40 bg-sky-600/10 px-2 py-1 text-xs text-sky-300 hover:bg-sky-600/20"
                      >
                        ↩ {guess}
                      </button>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          {/* Cover */}
          <div className="flex flex-col gap-3">
            <span className="text-sm text-neutral-400">Cover</span>
            <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-neutral-700 bg-neutral-800">
              {coverLoading ? (
                <span className="text-xs text-neutral-500">Lädt…</span>
              ) : coverUrl ? (
                <img src={coverUrl} className="h-full w-full object-cover" alt="Cover" />
              ) : (
                <span className="text-xs text-neutral-500">Kein Cover</span>
              )}
            </div>
            <div className="flex flex-col gap-1 text-sm">
              {track.metadata.has_cover && (
                <CoverRadio
                  checked={coverKind === "keep"}
                  onChange={() => setCover({ kind: "keep" })}
                  label="Vorhandenes behalten"
                />
              )}
              <CoverRadio
                checked={coverKind === "musicbrainz"}
                onChange={() => {
                  const rid = suggestions?.candidates.find((c) => c.release_id)?.release_id;
                  if (rid) setCover({ kind: "musicbrainz", release_id: rid });
                }}
                disabled={!suggestions?.candidates.some((c) => c.release_id)}
                label="Von MusicBrainz"
              />
              <CoverRadio
                checked={coverKind === "file"}
                onChange={chooseFile}
                label="Aus Datei…"
              />
              <CoverRadio
                checked={coverKind === "none"}
                onChange={() => setCover({ kind: "none" })}
                label="Kein Cover"
              />
            </div>
          </div>
        </div>

        {/* MusicBrainz-Kandidaten */}
        <div className="border-t border-neutral-800 px-5 py-3">
          <p className="mb-2 text-xs text-neutral-400">
            {loading
              ? "Suche Vorschläge…"
              : suggestions?.candidates.length
                ? "MusicBrainz-Treffer (klicken zum Übernehmen):"
                : "Keine MusicBrainz-Treffer – Felder manuell bestätigen."}
          </p>
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
            {suggestions?.candidates.map((c, i) => (
              <button
                key={i}
                onClick={() => applyCandidate(c)}
                className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 px-3 py-2 text-left text-sm hover:border-sky-600 hover:bg-sky-600/5"
              >
                <span className="truncate">
                  <span className="text-neutral-100">{c.artist ?? "?"}</span>
                  <span className="text-neutral-500"> – </span>
                  <span className="text-neutral-100">{c.title ?? "?"}</span>
                  {c.album && (
                    <span className="text-neutral-500"> · {c.album}</span>
                  )}
                  {c.year && <span className="text-neutral-500"> ({c.year})</span>}
                </span>
                <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  {c.score}%
                </span>
              </button>
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-neutral-800 px-5 py-3">
          {!canSave && (
            <span className="mr-auto text-xs text-rose-400">
              Titel und Artist sind Pflichtfelder.
            </span>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
          >
            Bestätigen
          </button>
        </footer>
      </div>
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
