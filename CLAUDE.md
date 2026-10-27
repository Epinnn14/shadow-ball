# Shadow Ball — Phase 1 (More Than A Hack 2027)

Tim 5 orang (K ketua, J, F, R, N). Repo ini menghasilkan file possession untuk Phase 1:
untuk setiap frame video tactical, label H (Barcelona menguasai), A (Athletic), D (bola mati),
atau X (tidak menjawab). Peringkat memakai `spellF1` (possession utuh), tie-break `macroF1`.

## Perintah

```
pip install -r requirements.txt
python run.py cache                 # parse ATD sekali -> cache/tactical_atd.npz (~20 dtk)
python run.py check                 # cek data
python run.py baseline --window 50  # v0, harus cocok 100% dengan baseline panitia
python run.py v1                    # v1, cadangan
python run.py ball-train --cv       # v2: latih model rekonstruksi bola (GPU), validasi silang babak
python run.py v2                    # v2: v1 + bola hasil rekonstruksi (cadangan)
python run.py v3                    # v3: v2 + pelanggaran/peluit (cadangan)
python run.py v4                    # v4.1: v3 + bola hidup sejak tendangan restart -- SUBMISSION SAAT INI
python run.py export                # exports/possession.csv + exports/ball.parquet (JANGAN di-commit)
python run.py roles                 # Fase B: label posisi + pergerakan -> exports/roles.parquet, movement.parquet
python scripts/restart_ab.py        # A/B aturan restart lama vs baru (bola disembunyikan)
python run.py ball-train --train-half 2 && python scripts/mask_test.py   # uji v1 vs v2 bebas bocor
python run.py score                 # skor semua CSV di submissions/ (GT publik 5 menit)
python run.py validate FILE         # validator resmi panitia
python -m pytest -q                 # tes cepat, tanpa data
```

Data dicari di: `MTAH_DATA_DIR` -> `./data` -> `../Dataset Drive`.

## Struktur

- `sb/paths.py` — semua path dan konstanta (N_FRAMES, HALVES, PITCH). Jangan tulis path di tempat lain.
- `sb/atd.py` — parser ATD + `Tracking` (diindeks per frame video, posisi dalam meter).
- `sb/submission.py` — tulis/validasi/skor file submission.
- `sb/baseline.py` — v0 (pemain terdekat + majority window).
- `sb/features.py` — bukti per frame (aktivitas tim, bola keluar sampai restart, jarak tim ke bola).
- `sb/tagging.py` — Smart Tagging ke frame video.
- `sb/hmm.py` — HMM 3 state (H/A/D) + Viterbi.
- `sb/v1.py` — v1: semua parameter di `PARAMS`, masing-masing dengan alasan fisiknya.
- `sb/ballnet.py` — model rekonstruksi bola (transformer kecil atas set pemain, self-supervised
  dengan celah sintetis dari distribusi celah asli; output posisi + ketidakpastian).
- `sb/v2.py` — v1 + bola rekonstruksi untuk bukti kontrol tim (bola mati tetap pakai bola asli).
- `sb/v3.py` — v2 + stoppage tanpa bola keluar garis (peluit tersimpul dari perlambatan kolektif,
  aktivitas 10 dtk, bola diletakkan di dalam lapangan).
- `sb/v4.py` — v3 + bukti "hidup" 5 dtk setelah tendangan restart yang terlihat.
- `sb/roles.py` — label posisi per frame (Hungarian ke bentuk tim saat tidak menguasai bola).
- `sb/movement.py` — jarak, HSR, sprint, kecepatan puncak, posisi rata-rata, heatmap per posisi.
- `sb/export.py` — file kontrak `exports/` (data turunan, tidak di-commit).
- `scripts/mask_test.py` — uji v1/v2/v3/v4 dengan bola disembunyikan ~41% di jendela publik.
- PyTorch dipasang terpisah (versi CUDA dari pytorch.org), butuh Python <= 3.14.
- `games.py`, `evaluation/` — salinan kode panitia (MIT), JANGAN diubah.
- `experiments/` — catatan eksperimen (konfigurasi + skor), satu file per eksperimen.
- `submissions/`, `cache/`, `data/` — tidak di-commit.

## Fakta data yang wajib diingat

- Frame video 0..199318 = baris submission. ATD `frame_id` mulai dari 1: `video_frame = frame_id - 1`.
- Frame dinilai: babak 1 11185..90651, babak 2 110808..190197. Di luar itu tulis X.
- 46 slot track = tracklet, bukan orang; identitas bisa tertukar. Tim per slot ADA di metadata XML
  (`Tracking.teams`: 0 = home/H, 1 = away/A).
- Bola tidak terlihat di ~41% frame yang dinilai. Bola tidak punya kecepatan di file (selalu NaN).
- Koordinat ternormalisasi 0-1; `Tracking` sudah mengubahnya ke meter (105.3 x 68.0).
- Smart Tagging: waktu dalam detik dari frame 0 tactical, `frame = round(detik * 25)`; label berisik.

## Aturan possession (CHALLENGE.md)

- Possession "lengket": saat bola rebutan/liar, tetap milik tim terakhir yang mengontrol.
- Ganti possession hanya saat lawan mendapat kontrol (bukan sentuhan, defleksi, atau duel udara).
- Bola mati = D, bukan possession siapa pun.
- X di frame dinilai: scorer spellF1 mengisinya dengan label sebelumnya di babak yang sama.

## Aturan kerja

- Label HARUS dihasilkan algoritma. Tidak ada koreksi manual pada submission.
- GT publik 5 menit hanya untuk cek kebenaran pipeline, BUKAN untuk memilih parameter
  (panitia membuktikan itu memilih versi yang salah). GT privat tidak pernah dipakai.
- Data pertandingan dan turunannya tidak pernah di-commit; repo final wajib publik.
- Setiap perubahan: tes lulus, `run.py validate` lulus, catat skor di `experiments/`.
- Rencanakan dulu sebelum menulis kode besar; perubahan kecil dan bisa diuji.

## File kontrak antar anggota (lihat dokumen tim)

`teams.parquet` (F), `ball.parquet` (K), `possession.csv` (K), `roles.parquet` (J),
`transitions.parquet` (J), `players.json` (R), `decisions.json` (R).
