# 9Router — alur deploy & pin known-good

Dokumen operasional untuk mesin ini (`/home/ubuntu/9router` → PM2 `9router` di port **20128**).

## Known-good saat ini

| Field | Value |
|---|---|
| **Live app binary** | `da8ef60` (feature stack; see `.openclaw-source-commit`) |
| **Ops/docs tip** | `f022094` (DEPLOY.md + `ops/*` scripts) |
| **Version** | `0.5.30` |
| **Pin dir (latest)** | `~/openclaw-backups/9router-known-good-latest` → `9router-known-good-f022094` |
| **Binary-only pin** | `~/openclaw-backups/9router-known-good-da8ef60` |
| **Pointer** | `~/.9router/KNOWN_GOOD_COMMIT` / `KNOWN_GOOD_PATH` / `KNOWN_GOOD_SHORT` |

Stack yang termasuk pin ini:

- PR **#2523** — Codex GPT-5.6 effort (`ultra` → wire `max`)
- PR **#2572** — SuperGrok quota percent parsing
- PR **#2571** — CLI Tools Grok Build → `~/.grok/config.toml`
- Hotfix — Grok CLI billing gzip via proxy
- PR **#2534** — strip `reasoning_effort` for `grok-composer` + thinking **None**

## Jangan

| Larangan | Alasan |
|---|---|
| `npm install -g 9router@latest` / `npm update -g 9router` | Menimpa patch lokal yang belum di upstream |
| Rewrite besar (proxy global, multi-region, re-arsitektur open-sse) | Risiko tinggi; stack sudah stabil — ubah hanya untuk bug/kebutuhan jelas |
| Force-push / reset hard ke remote tanpa backup | Hilangkan known-good & history lokal |
| Deploy tanpa backup di **luar** `node_modules` | `npm i -g` menghapus package dir (termasuk `app.bak*` di dalamnya) |

## Arsitektur runtime

```text
Source:   /home/ubuntu/9router          (git, known-good tip)
Build:    npm run cli:pack              → ~/9router-0.5.30.tgz  (pack-destination ../..)
Install:  npm install -g <tarball>      → ~/.npm-global/lib/node_modules/9router
Process:  pm2 start/restart 9router     → args: --no-browser --skip-update
Listen:   0.0.0.0:20128
Data:     ~/.9router/                   (db, runtime sqlite, logs)
```

## Deploy dari source (recommended)

### Satu perintah

```bash
/home/ubuntu/9router/ops/deploy-live.sh
```

Script akan:

1. Cek working tree (warn jika dirty pada file tracked)
2. Backup global install → `~/openclaw-backups/9router-pre-deploy-<timestamp>/`
3. `npm run cli:pack`
4. `npm install -g` tarball
5. Tulis `.openclaw-source-commit` = `git rev-parse HEAD`
6. `pm2 restart 9router`
7. Poll `GET /api/health` sampai OK (cold start bisa 1–2 menit)
8. Opsional: `--pin` untuk refresh known-good snapshot

### Manual (setara)

```bash
cd /home/ubuntu/9router

# 1) Backup di LUAR package dir
TS=$(date +%Y%m%d-%H%M%S)
BK=~/openclaw-backups/9router-pre-deploy-$TS
mkdir -p "$BK"
cp -a ~/.npm-global/lib/node_modules/9router "$BK/global-9router"

# 2) Build
npm run cli:pack
# output: ~/9router-0.5.30.tgz

# 3) Install + marker
npm install -g ~/9router-0.5.30.tgz
git rev-parse HEAD > ~/.npm-global/lib/node_modules/9router/app/.openclaw-source-commit

# 4) Restart
pm2 restart 9router --update-env
pm2 save

# 5) Health (tunggu cold start)
until curl -sf http://127.0.0.1:20128/api/health; do sleep 3; done
curl -s http://127.0.0.1:20128/api/version
```

## Restore known-good

```bash
/home/ubuntu/9router/ops/restore-known-good.sh
# atau pin path eksplisit:
/home/ubuntu/9router/ops/restore-known-good.sh ~/openclaw-backups/9router-known-good-da8ef60
```

Manual:

```bash
pm2 stop 9router
rm -rf ~/.npm-global/lib/node_modules/9router
cp -a ~/openclaw-backups/9router-known-good-latest/global-snapshot/9router \
      ~/.npm-global/lib/node_modules/9router
# atau: npm install -g ~/openclaw-backups/9router-known-good-latest/tarball/9router-0.5.30.tgz
pm2 restart 9router
curl -sf http://127.0.0.1:20128/api/health
```

## Refresh pin (setelah deploy yang sukses & diuji)

```bash
/home/ubuntu/9router/ops/deploy-live.sh --pin
# atau hanya re-pin tanpa rebuild:
/home/ubuntu/9router/ops/pin-known-good.sh
```

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
# Grok CLI quota (butuh connection + token valid)
# Dashboard → Usage

# Codex ultra
# POST /v1/responses model=cx/gpt-5.6-sol reasoning.effort=ultra

# Composer strip
# model xai/grok-composer-2.5-fast + reasoning_effort tidak boleh 400
```

## Merge PR upstream (selektif)

1. `git fetch origin pull/<N>/head:pr-<N>`
2. `git merge pr-<N>` (resolve conflict jika ada)
3. Jalankan unit yang relevan di `tests/`
4. `./ops/deploy-live.sh --pin` hanya setelah smoke OK
5. Update baris “Known-good saat ini” di dokumen ini

Jangan bulk-merge banyak PR sekaligus.

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
| Health gagal >2 menit | `pm2 logs 9router --lines 50`; cek compile `better-sqlite3` di runtime |
| Usage Grok “not JSON” | Pastikan build ≥ `dac717e`; opsional lepas proxy di connection |
| Fitur hilang setelah update | `restore-known-good.sh` lalu hentikan auto-update |
| Port beda | PM2 env/args; historis **20128** |
