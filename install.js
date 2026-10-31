#!/usr/bin/env node
/**
 * installer yt-dlp per platform.
 * Jalankan sekali sebelum `npm start` (atau ulangi dengan --force untuk update):
 *
 *   npm run setup
 *
 * Download yt-dlp resmi dari GitHub releases ke folder sesuai OS:
 *   Windows x64        -> bin/win/yt-dlp.exe
 *   Linux x64          -> bin/linux/yt-dlp
 *   Linux arm64        -> bin/linux/yt-dlp        (file: yt-dlp_linux_aarch64)
 *   Linux arm (v7)     -> bin/linux/yt-dlp        (file: yt-dlp_linux_armv7l)
 *   macOS (Intel/Arm)  -> bin/mac/yt-dlp
 *
 * Butuh Node >= 18.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

if (typeof fetch === 'undefined') {
    console.error('install.js butuh Node >= 18 (global fetch). Node saat ini:', process.version);
    process.exit(1);
}

const force = process.argv.includes('--force');
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

function pickTarget() {
    const os = process.platform;
    if (os === 'win32') {
        return { dir: 'win', file: 'yt-dlp.exe', url: `${BASE}/yt-dlp.exe` };
    }
    if (os === 'linux') {
        let file = 'yt-dlp_linux';
        if (process.arch === 'arm64') file = 'yt-dlp_linux_aarch64';
        else if (process.arch === 'arm') file = 'yt-dlp_linux_armv7l';
        return { dir: 'linux', file: 'yt-dlp', url: `${BASE}/${file}` };
    }
    if (os === 'darwin') {
        return { dir: 'mac', file: 'yt-dlp', url: `${BASE}/yt-dlp_macos` };
    }
    console.error(`OS "${os}" tidak didukung. Install yt-dlp manual lalu set YTDLP_PATH di .env.`);
    process.exit(1);
}

async function download(url, dest) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} saat unduh ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error(`File hasil unduhan terlalu kecil (${buf.length} byte) — mungkin respons error: ${buf.toString('utf8', 0, 200)}`);
    await fs.promises.writeFile(dest, buf);
}

function checkBinary(p) {
    return new Promise((resolve) => {
        const cp = spawn(p, ['--version'], { windowsHide: true });
        let out = '';
        const t = setTimeout(() => { cp.kill('SIGKILL'); resolve(null); }, 20_000);
        cp.stdout.on('data', d => (out += d));
        cp.stderr.on('data', d => (out += d));
        cp.on('error', () => { clearTimeout(t); resolve(null); });
        cp.on('close', () => { clearTimeout(t); resolve(out.trim() || null); });
    });
}

(async () => {
    const target = pickTarget();
    const dir = path.join(__dirname, 'bin', target.dir);
    const dest = path.join(dir, target.file);

    await fs.promises.mkdir(dir, { recursive: true });

    if (!force) {
        const ver = fs.existsSync(dest) ? await checkBinary(dest) : null;
        if (ver) {
            console.log(`✅ yt-dlp sudah terinstall di ${dest} (v${ver}) — lewati. Pakai --force untuk update.`);
            return;
        }
    }

    console.log(`⬇️  Mengunduh ${target.url} ...`);
    try {
        await download(target.url, dest);
    } catch (e) {
        console.error('❌ Gagal mengunduh:', e.message);
        console.error(`   Alternatif: unduh manual ke ${dest}, lalu set YTDLP_PATH di .env.`);
        process.exit(1);
    }

    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(dest, 0o755);
        } catch (e) {
            console.warn(`⚠️ Gagal chmod +x pada ${dest}: ${e.message}`);
        }
    }

    const ver = await checkBinary(dest);
    if (!ver) {
        console.error('❌ yt-dlp terunduh tapi gagal dijalankan. Cek output di atas.');
        process.exit(1);
    }
    console.log(`✅ yt-dlp siap: ${dest} (v${ver})`);
})().catch(e => {
    console.error('❌ install.js error:', e);
    process.exit(1);
});
