# Third-party licenses

rekord-lib itself is MIT licensed (see [LICENSE](LICENSE)). The application
bundles and depends on third-party software under its own licenses. This file
lists the notable components; it is a curated overview, not an exhaustive
dependency dump.

## Bundled binaries (shipped inside the app)

### FFmpeg — `ffmpeg` / `ffprobe`

**Important:** the FFmpeg binaries are **not** covered by rekord-lib's MIT
license. FFmpeg is licensed under the **LGPL v2.1+** or **GPL v2+**, depending
on how the specific build was compiled and which components it includes. The
binaries in `src-tauri/binaries/` are prebuilt and redistributed as-is.

- Project: https://ffmpeg.org
- Licensing: https://ffmpeg.org/legal.html

If you redistribute rekord-lib, make sure the FFmpeg build you ship complies
with its license (e.g. provide the corresponding source/build information for
LGPL/GPL builds).

## Fonts (bundled via @fontsource)

| Font | License | Link |
| --- | --- | --- |
| Inter | SIL Open Font License 1.1 | https://github.com/rsms/inter |
| JetBrains Mono | SIL Open Font License 1.1 | https://github.com/JetBrains/JetBrainsMono |

## Frameworks & libraries

### Frontend (npm)

| Package | License |
| --- | --- |
| Tauri (`@tauri-apps/*`) | MIT OR Apache-2.0 |
| React / React DOM | MIT |
| Vite | MIT |
| Tailwind CSS | MIT |

### Backend (Rust crates)

| Crate | License |
| --- | --- |
| tauri, tauri-plugin-* | MIT OR Apache-2.0 |
| lofty | MIT OR Apache-2.0 |
| rusty-chromaprint | MIT OR Apache-2.0 |
| reqwest | MIT OR Apache-2.0 |
| image | MIT OR Apache-2.0 |
| zip | MIT |
| trash | MIT OR Apache-2.0 |
| serde / serde_json | MIT OR Apache-2.0 |

## Generating a complete list

For a full, machine-generated breakdown of every transitive dependency:

- Rust: `cargo tree` (or install [`cargo-about`](https://github.com/EmbarkStudios/cargo-about)
  and run `cargo about generate about.hbs`).
- npm: `npm ls --all` (or a tool like `license-checker`).

These are intentionally not committed so this file stays readable and current.
