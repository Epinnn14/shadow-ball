# v4.1 — restart yang tidak terlihat

## Masalah di v4
Dua dari empat restart di jendela publik masih terlambat:
- frame 12989: selama stoppage bola tidak terlihat, lalu muncul lagi sudah melaju 10 m/s.
  Bola diletakkan dan ditendang saat tak terlihat, jadi aturan "diletakkan lalu ditendang" gagal.
- frame 16400: pelempar memegang bola hanya ~0,5 dtk sebelum lemparan ke dalam; syarat
  "diletakkan" waktu itu 20 frame (0,8 dtk).

## Perbaikan (sb/features.py, berlaku untuk semua latch bola mati)
- `reappears_fast`: bola muncul kembali setelah >= 1 dtk tak terlihat dan langsung bergerak
  > 5 m/s -> restart terjadi tanpa terlihat; latch berakhir di situ (dan dihitung restart).
- Syarat "diletakkan" diturunkan dari 20 ke 10 frame (0,4 dtk).
- Perilaku lama tetap bisa dipanggil (`placed_frames=20, unseen_restart=False`) untuk A/B.

## Hasil

| | v4 | v4.1 |
| --- | --- | --- |
| Tendangan restart terdeteksi (laga penuh) | 77 | 92 |
| Porsi D | 44,6% | 42,4% |
| Possession / rata-rata durasi | 273 / 12,9 dtk | 286 / 12,8 dtk |
| Restart publik GT -> model hidup | 12989->13013, 16400->16512, 17838->17889, 18389->18364 | 12989->12979, 16400->16401, 17838->17826, 18389->18364 |
| spellF1 publik | 0,5455 | 0,5455 |
| macroF1 publik | 0,8715 | 0,9001 |
| transF1 publik (±1 dtk) | 0,36 | 0,46 |

A/B bola disembunyikan, masking sama (`scripts/restart_ab.py`, model babak 2):

| rata-rata 8 run | v4 | v4.1 |
| --- | --- | --- |
| spellF1 | 0,464 | 0,473 (lebih baik 2, sama 6, lebih buruk 0) |
| macroF1 | 0,806 | 0,829 (lebih baik 8/8) |

## Keputusan
v4.1 dipakai (tetap `python run.py v4`). Catatan: dua restart publik kini dideteksi
0,4-1 dtk lebih AWAL dari GT; batas sigma model bola (maks 7,4 m) terlalu yakin untuk celah
sangat panjang -> perbaikan nanti.
