# 9Router — alur deploy & pin known-good

Dokumen operasional untuk mesin ini (`/home/ubuntu/9router` → PM2 `9router` di port **20128**).

## Known-good saat ini

| Field | Value |
|---|---|
| **Live app binary** | `96e698b6` (see `.openclaw-source-commit`) |
| **Full commit** | `96e698b605d9d76f4609252b9b0d2a077d8499da` |
| **Branch** | `fix/router-thinking-deploy-hardening` |
| **Version** | `0.5.35` |
| **Upstream base** | `decolua/9router` **v0.5.35** (`bc252ea8`) + patch lokal |
| **Pin dir (latest)** | `~/openclaw-backups/9router-known-good-latest` → `9router-known-good-96e698b6` |
| **Pointer** | `~/.9router/KNOWN_GOOD_COMMIT` / `KNOWN_GOOD_PATH` / `KNOWN_GOOD_SHORT` |
| **Health (saat pin)** | `{"ok":true}` · latest upstream `0.5.40` tersedia, live tetap pinned `0.5.35` |

### Stack yang termasuk pin ini

**Upstream v0.5.35 (merge `cf6151aa`)**

- Grok Build protocol / models alignment (#2590 area)
- Grok Imagine video routes, bulk-add API key fix, i18n th/fa
- Quota visibility settings, Kiro/GitHub/alicode fixes, startup perf

**Patch lokal (dipertahankan saat merge)**

- Grok Build CLI Tools harden (endpoint normalize, Test/Apply key semantics, secret redaction)
- Console Log polish (level tags, filters, pause, redact, download)
- Grok CLI usage: gzip `Accept-Encoding: identity` + SuperGrok percent + paid-access guards
- RTK/HEADROOM single `⚙` console summary line
- Provider-owned thinking untuk `Kelas-berat`; Codex `ultra` mencapai wire effort `max`
- Default subagent `ag/gemini-3-flash-agent`; Antigravity `xhigh` mencapai `thinkingLevel: high`
- Deploy artifact unik + SHA-256/`BUILD_ID` verification + smoke-before-pin
- Prior PR stack: #2523 Codex effort, #2572 SuperGrok %, #2571 Grok Build setup, #2534 composer strip, #2554 tunnel SSE, #2604 expiresAt, #2562 Token Saver, #2570 Codex plan labels, #2609 Token-Saver off header, #2584 Antigravity MITM
- Headroom proxy — PM2 `headroom` on `:8787`
- Ops: `ops/deploy-live.sh`, `ops/pin-known-good.sh`, `ops/restore-known-good.sh`

### Tag backup pra-upgrade

- `backup/pre-upgrade-v0.5.35-20260718-040824` → tip sebelum merge (`62695b56`)
- Folder backup: `~/openclaw-backups/upgrade-v0.5.35-20260718-040824/`

## Jangan

| Larangan | Alasan |
|---|---|
| `npm install -g 9router@latest` / `npm update -g 9router` | Menimpa binary yang sudah digabung patch lokal |
| `git reset --hard origin/master` | Membuang 40+ commit lokal |
| Rewrite besar (proxy global, multi-region, re-arsitektur open-sse) | Risiko tinggi; ubah hanya untuk bug/kebutuhan jelas |
| Force-push / reset hard ke remote tanpa backup | Hilangkan known-good & history lokal |
| Deploy tanpa backup di **luar** `node_modules` | `npm i -g` menghapus package dir |
| Deploy tarball stale (SHA lama) tanpa verifikasi | Bisa menginstall artifact salah commit |

## Arsitektur runtime

```text
Source:   /home/ubuntu/9router          (git branch deploy-2584)
Build:    worktree clean → npm run cli:pack → 9router-<ver>.tgz
Install:  npm install -g <tarball-verified> → ~/.npm-global/lib/node_modules/9router
Marker:   app/.openclaw-source-commit = git rev-parse HEAD
Process:  pm2 start/restart 9router     → args: --no-browser --skip-update
Listen:   0.0.0.0:20128
Data:     ~/.9router/                   (db, runtime sqlite, logs)  ← tidak ikut tarball
```

## Deploy dari source (recommended)

### Satu perintah

```bash
/home/ubuntu/9router/ops/deploy-live.sh
# setelah smoke OK:
/home/ubuntu/9router/ops/deploy-live.sh --pin
# atau: /home/ubuntu/9router/ops/pin-known-good.sh
```

Script akan:

1. Cek working tree (warn jika dirty pada file tracked)
2. Backup global install → `~/openclaw-backups/9router-pre-deploy-<timestamp>/`
3. Bersihkan cache webpack production, build CLI, lalu `npm pack` langsung ke direktori backup unik
4. Verifikasi version, SHA-256, dan packaged `BUILD_ID`
5. `npm install -g` artifact yang sama dan cocokkan live `BUILD_ID`
6. Tulis `.openclaw-source-commit` = `git rev-parse HEAD`
7. `pm2 restart 9router` dan poll `GET /api/health`
8. Dengan `--pin`: jalankan smoke provider-thinking, lalu refresh known-good memakai artifact terverifikasi

### Manual (setara) — prefer worktree bersih

```bash
cd /home/ubuntu/9router
COMMIT=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
WT=~/.config/superpowers/worktrees/9router/runtime-$SHORT
PACK=~/openclaw-backups/9router-deploy-$SHORT
mkdir -p "$PACK"

# 1) Backup di LUAR package dir
TS=$(date +%Y%m%d-%H%M%S)
BK=~/openclaw-backups/9router-pre-deploy-$TS
mkdir -p "$BK"
cp -a ~/.npm-global/lib/node_modules/9router "$BK/global-9router"

# 2) Build dari worktree detached (hindari dirty tree)
git worktree add --detach "$WT" "$COMMIT"
ln -sfn /home/ubuntu/9router/node_modules "$WT/node_modules"
ln -sfn /home/ubuntu/9router/cli/node_modules "$WT/cli/node_modules"
( cd "$WT/cli" && npm run pack:cli ) | tee "$PACK/pack.log"
# Cari tarball yang SHA1-nya = baris "shasum:" di pack.log (bukan file stale)
# Salin ke path unik, mis. $PACK/9router-$SHORT-fresh.tgz

# 3) Install + marker
npm install -g "$PACK/9router-$SHORT-fresh.tgz"
echo "$COMMIT" > ~/.npm-global/lib/node_modules/9router/app/.openclaw-source-commit

# 4) Restart + health
pm2 restart 9router --update-env
pm2 save
until curl -sf http://127.0.0.1:20128/api/health; do sleep 3; done
curl -s http://127.0.0.1:20128/api/version
```

### Verifikasi tarball (wajib)

- Artifact normal harus berada di backup deploy unik, bukan path tarball home yang dapat stale.
- Packaged `BUILD_ID` harus sama dengan `cli/app/.next-cli-build/BUILD_ID` hasil build.
- Live `BUILD_ID` setelah install harus sama dengan packaged `BUILD_ID`.
- SHA-256, ukuran, version, dan `BUILD_ID` dicatat di `MANIFEST.txt` backup deploy.
- Tolak ukuran mencurigakan (~13MB pada build penuh biasanya artifact salah/stale).

### Smoke provider-thinking

Smoke ini mengirim dua request model nyata dan membaca payload upstream dari `requestDetails`:

```bash
/home/ubuntu/9router/ops/smoke-thinking.sh --run
```

Ekspektasi default mesin ini:

- `Kelas-berat` diberi effort klien `medium`, lalu upstream menerima effort setting provider yang terpilih: Codex `ultra` → `max`, atau Grok CLI `xhigh` → `xhigh`.
- `ag/gemini-3-flash-agent` tidak diberi effort klien dan upstream Antigravity menerima `thinkingLevel: high` dari setting provider `xhigh`.

`deploy-live.sh --pin` menjalankan smoke ini otomatis sebelum memperbarui known-good.

## Restore known-good

```bash
/home/ubuntu/9router/ops/restore-known-good.sh
# atau pin path eksplisit:
/home/ubuntu/9router/ops/restore-known-good.sh ~/openclaw-backups/9router-known-good-96e698b6
```

Restore memprioritaskan `global-snapshot/9router`. Jika snapshot tidak tersedia,
script membaca `pkg_version` dari `meta/MANIFEST.txt` untuk memilih tarball
kanonis `tarball/9router-<version>.tgz`; pin legacy tanpa manifest hanya diterima
jika tepat satu tarball tersedia.

### Drill restore terakhir — 2026-07-23

- Sumber pin: `~/openclaw-backups/9router-known-good-96e698b6`
- Mode: tarball-only melalui salinan drill tanpa `global-snapshot/9router`
- Artifact terpilih: `tarball/9router-0.5.35.tgz`, berdasarkan `pkg_version` manifest
- Hasil: health `ok`, version `0.5.35`, marker source `96e698b6`, dan smoke provider-thinking `ok`
- Audit mesin: `~/.9router/LAST_RESTORE_DRILL`
- Safety backup dipertahankan di `~/openclaw-backups/9router-pre-restore-20260724-002548`

Drill tidak memperbarui pin dan tidak menjalankan deploy source baru; live tetap
pada known-good `96e698b6`.

Manual:

```bash
pm2 stop 9router
rm -rf ~/.npm-global/lib/node_modules/9router
cp -a ~/openclaw-backups/9router-known-good-latest/global-snapshot/9router \
      ~/.npm-global/lib/node_modules/9router
# atau: npm install -g ~/openclaw-backups/9router-known-good-latest/tarball/9router-0.5.35.tgz
pm2 restart 9router
curl -sf http://127.0.0.1:20128/api/health
```

## Refresh pin (setelah deploy sukses & diuji)

```bash
# Setelah pack/install dari tip yang sama:
TGZ_DEFAULT=~/9router-0.5.35.tgz /home/ubuntu/9router/ops/pin-known-good.sh
# atau:
/home/ubuntu/9router/ops/deploy-live.sh --pin
```

## Update dari upstream tanpa menghapus patch lokal

**Jangan** `npm i -g 9router@latest`.

```bash
git fetch origin --tags
git checkout -b upgrade/vX.Y.Z deploy-2584
git merge origin/master   # resolve konflik; keep local hardens + upstream features
# test fokus → deploy worktree → pin
```

Detail kebijakan ada di evaluasi ops: merge di branch baru, backup tag + DB + global, baru deploy.

## Verifikasi pasca-deploy

```bash
curl -s http://127.0.0.1:20128/api/health
curl -s http://127.0.0.1:20128/api/version
cat ~/.npm-global/lib/node_modules/9router/app/.openclaw-source-commit
git -C ~/9router rev-parse HEAD   # harus sama jika deploy dari tip
pm2 list | grep 9router
```

Smoke opsional:

```bash
# Console Log: GET /api/translator/console-logs  → baris ber-[LEVEL]
# Grok Build: GET /api/cli-tools/grok-build-settings → hasApiKey, no api_key field
# Grok CLI: POST /v1/chat/completions model=gcli/grok-4.5
# Dashboard → Usage (quota gcli)
```

## Merge PR upstream (selektif)

1. `git fetch origin pull/<N>/head:pr-<N>`
2. `git merge pr-<N>` (resolve conflict jika ada)
3. Jalankan unit yang relevan di `tests/`
4. Deploy dari worktree + pin hanya setelah smoke OK
5. Update baris “Known-good saat ini” di dokumen ini

Jangan bulk-merge banyak PR sekaligus tanpa tes.

## Data yang tidak ikut tarball

| Path | Isi |
|---|---|
| `~/.9router/db/` | SQLite connections, keys, usage |
| `~/.9router/runtime/` | better-sqlite3 native, dll. |
| `~/.grok/config.toml` | Grok TUI (bisa diarahkan ke 9Router) |
| PM2 dump | `~/.pm2/dump.pm2` |

Restore known-good **tidak** mengembalikan DB; hanya binary/app CLI.

## Troubleshooting

| Gejala | Tindakan |
|---|---|
| Health gagal >2 menit | `pm2 logs 9router --lines 50`; tunggu cold start next-server |
| Usage Grok “not JSON” | Build harus pakai `Accept-Encoding: identity` di usage gcli; cek proxy connection |
| Fitur hilang setelah update | `restore-known-good.sh` lalu hentikan auto-update npm |
| Port beda | PM2 env/args; historis **20128** |
| Marker ≠ git HEAD | Deploy ulang dari tip, tulis ulang `.openclaw-source-commit` |
