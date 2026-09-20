import { detailWaveform } from "./api";
import { createWaveformCache } from "./waveformCache";
import type { Waveform } from "../types";

/**
 * The detail waveforms of the tracks most recently opened.
 *
 * Module scope rather than a hook's state, for the same reason `RowWaveform`'s
 * batcher is: everything that wants one wants the same thing from the same
 * place, and a cache that lives in a component is a cache that is thrown away
 * every time the surface is closed — which for this one means decoding the whole
 * file again to show the same picture.
 *
 * **Two entries, and the number is a memory budget.** A detail waveform is
 * 200 bins a second, so a six-minute track is 72 000 of them and about 1.2 MB
 * as two JavaScript arrays. Two is the open track and the one before it, which
 * is what makes going back cheap without keeping a library's worth of them
 * alive. The promise-sharing and the "a failed decode is not cached" rule come
 * from `createWaveformCache` and are tested there.
 */
const cache = createWaveformCache(2);

/** The detail waveform for one track, decoding it if it is not already here. */
export function detailFor(path: string): Promise<Waveform> {
  return cache.get(path, detailWaveform);
}

/** Called when the file behind a path has been rewritten. */
export function forgetDetail(path: string): void {
  cache.forget(path);
}

/**
 * Called when a scan has finished, for the reason `forgetRowWaveforms` is: the
 * run may have rewritten a tag on any file in the library, and a picture of the
 * bytes as they were is a picture of a file that is no longer there.
 */
export function forgetAllDetail(): void {
  cache.clear();
}
