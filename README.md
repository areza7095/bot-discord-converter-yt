# bypassong

A Discord bot that turns YouTube links into **2.3×-speed, pitch-shifted `.ogg` (Vorbis)** audio files — ready to play in voice channels, with automatic bitrate tuning so every file fits Discord's upload limit.

> Command: `?bypass <youtube-url>`
> Example: `?bypass https://www.youtube.com/watch?v=dQw4w9WgXcQ`

## Features

- **2.3× speed + pitch up** — not just faster playback, the pitch is shifted up too (classic "nightcore" effect), rendered at 44.1 kHz.
- **Auto bitrate ladder** — tries 256 → 192 → 128 → 96 → 64 kbps and picks the highest one that fits **Discord's 9.5 MB upload limit**.
- **Length guard** — rejects videos longer than **20 minutes** and live streams (no duration to check).
- **Queue + cooldown** — one heavy job at a time (15 s per-user cooldown), with a 5-minute per-job timeout so nothing hangs forever.
- **Safe filenames** — output is saved as `<sanitized-title>_2.3x.ogg`.
- **Temp file retention** — leftover audio/work files are auto-deleted after a configurable number of days (default **3**).
- **Cross-platform** — runs on Ubuntu/Linux, Windows, and macOS; `yt-dlp` and `ffmpeg` are fetched automatically by the setup scripts (see below).

## Requirements

- **Node.js ≥ 18** (uses the built-in `fetch` in `install.js`)
- A **Discord bot token** — create one at the [Discord Developer Portal](https://discord.com/developers/applications) and enable the **Message Content Intent** (Bot → Privileged Gateway Intents), otherwise the bot can't read commands.
- `ffmpeg` and `yt-dlp` are **not** installed manually:
  - `ffmpeg` comes from the `ffmpeg-static` npm package during `npm install`.
  - `yt-dlp` is downloaded by `npm run setup` into `bin/<os>/` for your OS/arch.

## Installation

### Ubuntu / Linux server

```bash
git clone https://github.com/areza7095/bot-discord-converter-yt.git
cd bot-discord-converter-yt

npm install            # dependencies + ffmpeg (Linux build)
cp .env.example .env
nano .env              # set DISCORD_TOKEN (and optionally AUDIO_RETENTION_DAYS)

npm run setup          # downloads yt-dlp for your OS/arch into bin/linux/, then verifies ffmpeg
npm start
```

### Windows

```powershell
git clone https://github.com/areza7095/bot-discord-converter-yt.git
cd bot-discord-converter-yt

npm install
copy .env.example .env
notepad .env           # set DISCORD_TOKEN

npm run setup          # downloads yt-dlp.exe into bin\win\, then verifies ffmpeg
npm start
```

### What `npm run setup` does

1. Detects OS and CPU architecture:
   | Platform | Saved to | Source |
   |---|---|---|
   | Windows x64 | `bin/win/yt-dlp.exe` | `yt-dlp.exe` |
   | Linux x64 | `bin/linux/yt-dlp` | `yt-dlp_linux` |
   | Linux arm64 | `bin/linux/yt-dlp` | `yt-dlp_linux_aarch64` |
   | Linux armv7l | `bin/linux/yt-dlp` | `yt-dlp_linux_armv7l` |
   | macOS | `bin/mac/yt-dlp` | `yt-dlp_macos` |
2. Downloads from the official [yt-dlp GitHub releases](https://github.com/yt-dlp/yt-dlp/releases), sets the executable bit on non-Windows, and verifies it with `--version`.
3. Verifies `ffmpeg` (from `ffmpeg-static`) is installed and runnable — prints a clear message if you still need to run `npm install`.

Already installed? It skips the download. Use `npm run setup:force` to re-download and update `yt-dlp`.

> All binaries live in `bin/` which is **gitignored** — nothing large ever gets committed.

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | Bot token. The bot refuses to start without it. |
| `AUDIO_RETENTION_DAYS` | `3` | Files in `temp/` and leftover `ytogg-*` work dirs in the system temp folder older than **N days** are deleted automatically (at startup, then every 24 h). Set `0` to disable. |
| `YTDLP_PATH` | *(optional)* | Override the yt-dlp binary path. Leave empty to use `bin/<os>/…` from `npm run setup`, falling back to `yt-dlp` on your `PATH`. |
| `YTDLP_FORCE_IPV4` | *(optional)* | Set to `0` to disable the default `--force-ipv4` flag (only relevant if you move to an IPv6-only network). |

## npm scripts

| Command | What it runs |
|---|---|
| `npm run setup` | `node install.js` — install/update yt-dlp + verify ffmpeg |
| `npm run setup:force` | Same, but re-downloads yt-dlp even if present |
| `npm start` | `node index.js` — run the bot |
| `npm run dev` | `nodemon index.js` — auto-restart on file changes |

### Running under PM2 (optional, on your server)

```bash
pm2 start index.js --name bypassong
pm2 save
pm2 startup   # follow the printed command to enable boot-time start
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `yt-dlp lokal belum diinstall … jalankan "npm run setup"` | You skipped setup — run `npm run setup`. |
| `⚠️ ffmpeg-static belum terinstall` during setup | `npm install` hasn't been run yet (or failed). Run it, then `npm run setup` again. |
| `Cannot find module 'discord.js'` | Dependencies missing → `npm install`. |
| Bot replies `❌ Terjadi kesalahan saat memproses link…` and log shows `yt-dlp melebihi batas waktu` | Network problem reaching YouTube. The bot already forces IPv4 (`--force-ipv4`) because broken IPv6 routes cause silent hangs; also check `--socket-timeout` behavior in `index.js`. |
| `Sign in to confirm you're not a bot` from yt-dlp | Your server IP is rate-limited by YouTube — see yt-dlp's [wiki on authentication](https://github.com/yt-dlp/yt-dlp/wiki/Authentication). |
| Video rejected as too long / live stream | Working as intended: max 20 minutes, live streams are skipped. |
| Want a custom yt-dlp build | Set `YTDLP_PATH` in `.env`. |

## Project structure

```
├── index.js          # bot logic: command, queue, download, 2.3× conversion, retention cleanup
├── install.js        # cross-platform yt-dlp installer + ffmpeg verifier (npm run setup)
├── .env.example      # environment variable template
├── bin/              # yt-dlp binaries (gitignored, created by npm run setup)
├── temp/             # legacy temp outputs (gitignored, cleaned by retention)
└── ffmpeg / yt-dlp   # provided by ffmpeg-static (npm) and install.js
```

## How retention works

On startup and then every **24 hours**, the bot scans:

1. the project's `temp/` folder, and
2. `ytogg-*` folders in the OS temp directory (leftovers from crashed runs),

and deletes anything older than `AUDIO_RETENTION_DAYS` (default 3 days). Active job folders only live for seconds, so they are never affected.

## License

[ISC](https://opensource.org/licenses/ISC) — see `package.json`.

---

<details>
<summary><b> Bahasa Indonesia (ringkasan)</b></summary>

**bypassong** — bot Discord yang mengubah link YouTube menjadi audio `.ogg` (Vorbis) berkecepatan **2.3× + nada naik**, dengan bitrate otomatis supaya selalu muat di limit upload Discord (9,5 MB).

**Perintah:** `?bypass <link youtube>`

**Fitur utama:**
- Auto bitrate 256→64 kbps, nolak video > 20 menit & live stream
- Cooldown 15 detik per user, antrian satu proses, timeout 5 menit
- File sisa otomatis dihapus setelah **3 hari** (atur di `AUDIO_RETENTION_DAYS`, `0` = mati)
- Cross-platform (Ubuntu/Windows/macOS)

**Install di Ubuntu server:**
```bash
git clone https://github.com/areza7095/bot-discord-converter-yt.git
cd bot-discord-converter-yt
npm install          # dependensi + ffmpeg
cp .env.example .env # isi DISCORD_TOKEN
npm run setup        # unduh yt-dlp ke bin/linux/ + verifikasi ffmpeg
npm start
```

**Variabel `.env`:** `DISCORD_TOKEN` (wajib), `AUDIO_RETENTION_DAYS` (default 3), `YTDLP_PATH` (opsional), `YTDLP_FORCE_IPV4` (isi `0` buat matiin paksa IPv4).

**Catatan:** yt-dlp dipaksa `--force-ipv4` karena IPv6 yang rusak bikin proses diam sampai timeout; Node.js ≥ 18 wajib.

</details>
