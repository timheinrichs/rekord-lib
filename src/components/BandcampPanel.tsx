import { useState } from "react";
import {
  bandcampCollection,
  bandcampConnect,
  bandcampDisconnect,
  bandcampDownload,
  bandcampLogin,
  pickOutputDir,
} from "../lib/api";
import type { BandcampAccount, BandcampItem } from "../types";

interface Props {
  defaultDir: string | null;
  onClose: () => void;
  /** Heruntergeladene Dateien in die Track-Liste übernehmen. */
  onImport: (paths: string[]) => void;
}

type DlState = "idle" | "loading" | "done" | "error";

export default function BandcampPanel({ defaultDir, onClose, onImport }: Props) {
  const [account, setAccount] = useState<BandcampAccount | null>(null);
  const [items, setItems] = useState<BandcampItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(defaultDir);
  const [dl, setDl] = useState<Record<string, DlState>>({});

  const openLogin = async () => {
    setError(null);
    try {
      await bandcampLogin();
    } catch (e) {
      setError(String(e));
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const acc = await bandcampConnect();
      setAccount(acc);
      const coll = await bandcampCollection();
      setItems(coll);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const coll = await bandcampCollection();
      setItems(coll);
      if (coll.length === 0) {
        setError("Sammlung kam leer zurück (siehe Dev-Log für Details).");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await bandcampDisconnect().catch(() => {});
    setAccount(null);
    setItems([]);
    setDl({});
  };

  const chooseDir = async () => {
    const dir = await pickOutputDir();
    if (dir) setDestDir(dir);
  };

  const download = async (item: BandcampItem) => {
    if (!item.download_page_url) return;
    let dir = destDir;
    if (!dir) {
      dir = await pickOutputDir();
      if (!dir) return;
      setDestDir(dir);
    }
    setDl((s) => ({ ...s, [item.key]: "loading" }));
    try {
      const res = await bandcampDownload(item.key, item.download_page_url, dir);
      if (res.success) {
        setDl((s) => ({ ...s, [item.key]: "done" }));
        onImport(res.files);
      } else {
        setDl((s) => ({ ...s, [item.key]: "error" }));
        setError(res.error ?? "Download fehlgeschlagen");
      }
    } catch (e) {
      setDl((s) => ({ ...s, [item.key]: "error" }));
      setError(String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-medium">Bandcamp</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-100">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {!account ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <p className="max-w-md text-sm text-neutral-400">
                Melde dich in deinem Bandcamp-Konto an und übernimm anschließend
                die Sitzung. Es wird kein Passwort gespeichert – nur die
                Login-Sitzung des Browserfensters genutzt (nur für selbst
                gekaufte Musik).
              </p>
              <div className="flex gap-3">
                <button
                  onClick={openLogin}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500"
                >
                  1 · Bei Bandcamp anmelden
                </button>
                <button
                  onClick={connect}
                  disabled={busy}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? "Verbinde…" : "2 · Verbindung herstellen"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
                <span className="text-neutral-300">
                  Verbunden als{" "}
                  <span className="font-medium text-emerald-400">
                    {account.username || account.fan_id}
                  </span>
                </span>
                <button
                  onClick={refresh}
                  disabled={busy}
                  className="rounded-lg border border-neutral-700 px-3 py-1.5 hover:border-sky-500 disabled:opacity-50"
                >
                  {busy ? "Lädt…" : `Sammlung aktualisieren (${items.length})`}
                </button>
                <button
                  onClick={chooseDir}
                  className="truncate rounded-lg border border-neutral-700 px-3 py-1.5 hover:border-sky-500"
                  title={destDir ?? "Download-Ordner wählen"}
                >
                  {destDir ? `Ordner: ${destDir}` : "Download-Ordner wählen"}
                </button>
                <button
                  onClick={disconnect}
                  className="ml-auto rounded-lg border border-neutral-700 px-3 py-1.5 hover:border-red-500 hover:text-red-400"
                >
                  Abmelden
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {items.map((item) => {
                  const state = dl[item.key] ?? "idle";
                  return (
                    <div
                      key={item.key}
                      className="flex items-center gap-3 rounded-lg border border-neutral-800 p-2"
                    >
                      {item.art_url ? (
                        <img
                          src={item.art_url}
                          className="h-12 w-12 shrink-0 rounded object-cover"
                          alt=""
                        />
                      ) : (
                        <div className="h-12 w-12 shrink-0 rounded bg-neutral-800" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-neutral-100" title={item.title}>
                          {item.title}
                        </p>
                        <p className="truncate text-xs text-neutral-500">
                          {item.band_name}
                        </p>
                      </div>
                      <button
                        onClick={() => download(item)}
                        disabled={!item.download_page_url || state === "loading"}
                        className="shrink-0 rounded-lg bg-sky-600/90 px-3 py-1.5 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
                        title={
                          item.download_page_url
                            ? "Verlustfrei laden & importieren"
                            : "Nicht ladbar"
                        }
                      >
                        {state === "loading"
                          ? "Lädt…"
                          : state === "done"
                            ? "✓ Importiert"
                            : state === "error"
                              ? "Fehler"
                              : "Laden"}
                      </button>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <p className="col-span-full py-6 text-center text-sm text-neutral-500">
                    Keine Einträge geladen.
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
