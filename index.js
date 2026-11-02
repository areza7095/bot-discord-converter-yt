require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

// ====== Konfigurasi ======
const PREFIX = '?bypass';
const SPEED = 2.3;
const SAMPLE_RATE = 44100;
const MAX_BYTES = 9.5 * 1024 * 1024;          // batas aman upload Discord
const MAX_SOURCE_SECONDS = 20 * 60;           // tolak video > 20 menit
const COOLDOWN_MS = 15_000;                   // jeda per user
const PROCESS_TIMEOUT_MS = 5 * 60_000;        // batas waktu tiap proses
const BITRATE_LADDER = [256, 192, 128, 96, 64]; // kbps, dicoba dari yang terbesar

// Flag dasar yt-dlp untuk SEMUA pemanggilan:
// - --force-ipv4: DNS YouTube sering ngasih IPv6 dulu; kalau IPv6 server bolong,
//   yt-dlp diam nyangkut sampai timeout. Set YTDLP_FORCE_IPV4=0 untuk menonaktifkan.
// - --socket-timeout/--retries: jaringan bermasalah langsung gagal, bukan diam 60 detik.
// - --js-runtimes node: YouTube wajib JS runtime; pakai Node yang memang sudah ada.
// - --ffmpeg-location: nunjuk binary dari ffmpeg-static (npm), hilangkan warning "ffmpeg not found".
const YTDLP_COMMON_ARGS = [
    ...(process.env.YTDLP_FORCE_IPV4 === '0' ? [] : ['--force-ipv4']),
    '--socket-timeout', '15',
    '--retries', '3',
    '--js-runtimes', 'node',
    '--ffmpeg-location', ffmpegPath
];

// Pilih yt-dlp sesuai platform & environment:
// 1) YTDLP_PATH di .env (override manual)
// 2) yt-dlp hasil `npm run setup` di folder bin/ sesuai OS (bin/win, bin/linux, bin/mac)
// 3) fallback 'yt-dlp' dari PATH
function resolveYtDlp() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;

    const dirName =
        process.platform === 'win32' ? 'win'
        : process.platform === 'linux' ? 'linux'
        : process.platform === 'darwin' ? 'mac' : null;
    if (dirName) {
        const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const local = path.join(__dirname, 'bin', dirName, binName);
        if (fs.existsSync(local)) {
            if (process.platform !== 'win32') {
                // Exec bit sering hilang saat clone dari Windows, pastikan bisa dieksekusi
                try {
                    fs.chmodSync(local, 0o755);
                } catch (e) {
                    console.warn(`Gagal chmod +x pada ${local}: ${e.message}`);
                }
            }
            return local;
        }
    } else {
        return 'yt-dlp';
    }

    console.warn(`yt-dlp lokal belum diinstall (${path.join('bin', dirName)}) — jalankan "npm run setup". Mencoba "yt-dlp" dari PATH...`);
    return 'yt-dlp';
}
const YTDLP_PATH = resolveYtDlp();

// ====== Retensi file sementara ======
// AUDIO_RETENTION_DAYS = umur maksimal file audio/sisa kerjaan dalam hari.
// Default 3 hari; 0 atau negatif = fitur mati.
const TEMP_PROJECT_DIR = path.join(__dirname, 'temp');
const TMP_DIR_PREFIX = 'ytogg-';
const RETENTION_DAYS = (() => {
    const raw = Number(process.env.AUDIO_RETENTION_DAYS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    if (process.env.AUDIO_RETENTION_DAYS !== undefined) {
        console.warn('AUDIO_RETENTION_DAYS tidak valid (harus angka > 0, 0 untuk mati). Retensi dinonaktifkan.');
    }
    return 0;
})();

async function cleanupExpired() {
    if (!RETENTION_DAYS) return;
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    const targets = [];
    try {
        targets.push(...fs.readdirSync(TEMP_PROJECT_DIR).map(f => path.join(TEMP_PROJECT_DIR, f)));
    } catch { /* folder temp belum ada, lewati */ }

    try {
        targets.push(...fs.readdirSync(os.tmpdir())
            .filter(f => f.startsWith(TMP_DIR_PREFIX))
            .map(f => path.join(os.tmpdir(), f)));
    } catch { /* tmp tidak terbaca, lewati */ }

    for (const t of targets) {
        try {
            const st = await fs.promises.stat(t);
            if (st.mtimeMs > cutoffMs) continue;
            await fs.promises.rm(t, { recursive: true, force: true });
            removed++;
        } catch (e) {
            console.warn(`Gagal menghapus ${t}: ${e.message}`);
        }
    }
    if (removed > 0) {
        console.log(`🧹 Retensi: hapus ${removed} entri (umur > ${RETENTION_DAYS} hari).`);
    }
}

if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN belum diisi di file .env');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ====== Utilitas ======

// Jalankan program, kembalikan stdout, dengan timeout
function run(cmd, args, timeout = PROCESS_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { windowsHide: true });
        let out = '', err = '';
        const timer = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error(`${path.basename(cmd)} melebihi batas waktu`));
        }, timeout);

        p.stdout.on('data', d => (out += d));
        p.stderr.on('data', d => (err += d));
        p.on('error', e => { clearTimeout(timer); reject(e); });
        p.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(out.trim());
            else reject(new Error(`${path.basename(cmd)} kode ${code}: ${err.slice(-500)}`));
        });
    });
}

// Validasi URL YouTube dengan parser URL (lebih ketat dari regex)
function parseYouTubeUrl(raw) {
    try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
        if (host !== 'youtube.com' && host !== 'youtu.be') return null;
        return u.toString();
    } catch {
        return null;
    }
}

// Pilih bitrate tertinggi yang diperkirakan muat di batas upload
function pickBitrates(sourceSeconds) {
    const outSeconds = sourceSeconds / SPEED;
    return BITRATE_LADDER.filter(kbps => (kbps * 1000 / 8) * outSeconds * 1.08 <= MAX_BYTES);
}

function convert(input, output, bitrateKbps, title) {
    return new Promise((resolve, reject) => {
        const opts = ['-vn'];
        if (title) opts.push('-metadata', `title=${title}`);
        ffmpeg(input)
            .audioFilters([
                `aresample=${SAMPLE_RATE}`,
                `asetrate=${Math.round(SAMPLE_RATE * SPEED)}`, // kecepatan + nada naik
                `aresample=${SAMPLE_RATE}`
            ])
            .audioCodec('libvorbis')
            .audioBitrate(`${bitrateKbps}k`)
            .audioChannels(2)
            .format('ogg')
            .outputOptions(opts)
            .on('end', resolve)
            .on('error', reject)
            .save(output);
    });
}

// Antrian: satu pekerjaan berat pada satu waktu
let chain = Promise.resolve();
let pending = 0;
function enqueue(task) {
    pending++;
    const p = chain.then(task).finally(() => pending--);
    chain = p.catch(() => {});
    return p;
}

const cooldowns = new Map();

// ====== Bot ======
client.once('clientReady', () => {
    console.log(`Bot siap! Login sebagai ${client.user.tag} (yt-dlp: ${YTDLP_PATH})`);

    // Bersihkan sisa lama sekali saat start, lalu tiap 24 jam
    cleanupExpired().catch(e => console.error('Retensi error:', e.message));
    setInterval(() => cleanupExpired().catch(e => console.error('Retensi error:', e.message)),
        24 * 60 * 60 * 1000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.toLowerCase().startsWith(PREFIX)) return;

    const args = message.content.trim().split(/ +/);
    if (args.shift().toLowerCase() !== PREFIX) return;

    const reply = (content) =>
        message.reply({ content, allowedMentions: { repliedUser: false } });

    const ytUrl = args[0] && parseYouTubeUrl(args[0]);
    if (!ytUrl) {
        return reply(`❌ Harap masukkan link YouTube yang valid! Contoh: \`${PREFIX} https://www.youtube.com/watch?v=...\``);
    }

    // Cooldown per user
    const last = cooldowns.get(message.author.id) || 0;
    const wait = COOLDOWN_MS - (Date.now() - last);
    if (wait > 0) return reply(`⏱️ Tunggu ${Math.ceil(wait / 1000)} detik lagi sebelum memakai perintah ini.`);
    cooldowns.set(message.author.id, Date.now());

    const position = pending;
    const processingMsg = await reply(
        position > 0
            ? `🕒 Masuk antrian (posisi ${position + 1}), mohon tunggu...`
            : `⏳ Sedang mengunduh dan mengedit audio ke ${SPEED}x speed (.ogg), mohon tunggu...`
    );

    const status = (text) => processingMsg.edit(text).catch(() => {});

    await enqueue(async () => {
        let workDir;
        try {
            await status(`⏳ Sedang mengunduh dan mengedit audio ke ${SPEED}x speed (.ogg), mohon tunggu...`);

            // 1) Ambil judul & durasi dulu, tolak lebih awal kalau terlalu panjang
            const info = await run(YTDLP_PATH, [
                ...YTDLP_COMMON_ARGS,
                '--no-playlist', '--encoding', 'utf-8',
                '--print', '%(title)s', '--print', '%(duration)s',
                '--', ytUrl
            ], 60_000);
            const [title, durationRaw] = info.split(/\r?\n/);
            const duration = Number(durationRaw);

            if (!Number.isFinite(duration) || duration <= 0) {
                return status('❌ Tidak bisa menentukan durasi video (mungkin live stream).');
            }
            if (duration > MAX_SOURCE_SECONDS) {
                return status(`❌ Video terlalu panjang (maks ${MAX_SOURCE_SECONDS / 60} menit).`);
            }

            const bitrates = pickBitrates(duration);
            if (bitrates.length === 0) {
                return status('❌ Lagu terlalu panjang, hasilnya pasti melebihi batas upload Discord.');
            }

            const safeTitle =
                title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'audio';

            // 2) Unduh ke folder sementara khusus job ini
            workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytogg-'));
            await run(YTDLP_PATH, [
                ...YTDLP_COMMON_ARGS,
                '-f', 'bestaudio',
                '--no-playlist',
                '-o', path.join(workDir, 'input.%(ext)s'),
                '--', ytUrl
            ]);

            const downloaded = fs.readdirSync(workDir).find(f => f.startsWith('input.'));
            if (!downloaded) throw new Error('File hasil unduhan tidak ditemukan');
            const inputPath = path.join(workDir, downloaded);
            const outputPath = path.join(workDir, 'out.ogg');

            // 3) Konversi; turun bitrate bertahap jika hasil masih kebesaran
            let ok = false;
            for (const kbps of bitrates) {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                await convert(inputPath, outputPath, kbps, title);
                if (fs.statSync(outputPath).size <= MAX_BYTES) { ok = true; break; }
            }
            if (!ok) {
                return status('❌ Hasil melebihi batas upload Discord, bahkan di bitrate terendah.');
            }

            const attachment = new AttachmentBuilder(outputPath, { name: `${safeTitle}_${SPEED}x.ogg` });
            await message.channel.send({
                content: `✅ File audio versi **${SPEED}x speed** dalam format **.ogg** siap!`,
                files: [attachment]
            });
            await processingMsg.delete().catch(() => {});
        } catch (error) {
            console.error(error);
            const msg = /Private video|Sign in|unavailable|age/i.test(error.message)
                ? '❌ Video tidak bisa diakses (privat, dibatasi umur, atau tidak tersedia).'
                : '❌ Terjadi kesalahan saat memproses link YouTube tersebut.';
            await status(msg);
        } finally {
            if (workDir) fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);