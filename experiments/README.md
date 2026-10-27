# Eksperimen

Satu file per eksperimen: `YYYY-MM-DD_nama.md` berisi ide, konfigurasi, skor publik
(hanya sanity check), jumlah possession, dan keputusan (dipakai / dibuang + alasan).

| Tanggal | Versi | Ide | spellF1 publik | Possessions | Keputusan |
| --- | --- | --- | --- | --- | --- |
| 2026-10-22 | v0 | Baseline panitia (w=50) | 0.3256 | 594 (GT publik: 17 dalam 5 menit) | Lantai, jangan turun di bawah ini |
| 2026-10-22 | v1 | Dead ball + HMM (lihat 2026-10-22_v1_hmm.md) | 0.5125 (noise ±0.36) | 239, rata-rata 16.3 dtk | Submission saat ini |
| 2026-10-24 | v2 | Rekonstruksi bola + v1 (lihat 2026-10-24_v2_ballnet.md) | = v1 tanpa masking; dengan bola disembunyikan 0,444 vs v1 0,419 | 259, rata-rata 15,1 dtk | Cadangan |
| 2026-10-27 | v3 | v2 + pelanggaran/peluit (lihat 2026-10-27_v3_whistle.md) | 0,5091 (macroF1 0,855); disembunyikan 0,445 (macroF1 0,797 vs v2 0,731) | 264, rata-rata 13,1 dtk, D 45% | Cadangan |
| 2026-10-27 | v4 | v3 + bola hidup sejak tendangan restart (lihat 2026-10-27_v4_restart.md) | 0,5455 (macroF1 0,872); disembunyikan 0,464 vs v3 0,445 (tak pernah lebih buruk) | 273, rata-rata 12,9 dtk, D 44,6% | **Submission saat ini** |
