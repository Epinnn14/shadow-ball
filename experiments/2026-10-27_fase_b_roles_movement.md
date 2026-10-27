# Fase B — label posisi + statistik pergerakan

`python run.py roles` -> `exports/roles.parquet`, `exports/formations.json`,
`exports/movement.parquet`, `exports/heatmaps.npz` (data turunan: JANGAN di-commit).

## Cara kerja (sb/roles.py, sb/movement.py)
- Koordinat dinormalkan per tim per babak: tim selalu menyerang ke +x, sisi KIRI tim = y kecil.
  Dicek dengan homography: y = 0 adalah garis samping jauh (atas gambar kamera taktikal), dan tim
  yang menyerang ke kanan kamera punya garis samping jauh di sisi kirinya.
- Kiper: pemain terdalam, < 25 m dari gawang sendiri dan >= 5 m di belakang pemain berikutnya.
- 10 pemain lapangan dicocokkan tiap frame ke 10 slot bentuk rata-rata tim (algoritma Hungarian,
  posisi relatif terhadap centroid tim; gaya Bialkowski dkk. 2014). Tahan terhadap ID track tertukar.
- Bentuk yang MEMBERI NAMA dipasang hanya pada frame saat tim TIDAK menguasai bola (dari v4.1):
  saat menyerang, bek sayap naik dan tim bisa terlihat 2-3-5; saat bertahan, posisi dasar terlihat.
- Lini: bek = 3/4/5 pemain terdalam, dipotong di celah kedalaman terbesar (bek empat diberi
  keunggulan 3 m); sisanya dipisah di setiap celah >= 5 m (sehingga 4-2-3-1, 4-4-1-1 terbaca).
- Nama: bek LB/CB/RB (LWB/RWB bila 5); gelandang LM/RM (lebar), CDM/CM/CAM (kedalaman);
  penyerang LW/RW (lebar), ST (CF untuk yang lebih dalam dari dua penyerang tengah).
  Nama kembar diberi sisi: LCB/RCB, LCDM/RCDM, LCM/CM/RCM.
- Pergerakan per posisi per 5 menit: jarak, lari intensitas tinggi (> 19,8 km/h), sprint
  (> 25,2 km/h selama >= 1 dtk), kecepatan puncak (persentil 99), posisi rata-rata, cakupan;
  heatmap 21 x 14 per posisi per babak. Kecepatan > 11 m/s dianggap glitch tracking.

## Hasil

| Tim / babak | Formasi saat bertahan |
| --- | --- |
| Barcelona babak 1 | 4-2-3-1 |
| Athletic babak 1 | 4-4-2 |
| Barcelona babak 2 | 4-2-1-3 |
| Athletic babak 2 | 4-5-1 |

Cek kewajaran (tanpa ground truth): pemain lapangan 9,5-12 km per posisi sepanjang laga,
kecepatan puncak 25-31 km/h, cakupan peran 86-94% frame. Kiper hanya 19-26% (kamera taktikal
sering tidak memperlihatkan area gawang) -> statistik kiper tidak bisa dipercaya.

## Batasan
- Label = peran taktis dalam bentuk rata-rata, bukan posisi resmi pemain; tanpa nama pemain.
- Barça babak 2 sempat terbaca 5-1-1-3 sebelum keunggulan bek empat dinaikkan dari 2 ke 3 m:
  kasus perbatasan (gelandang bertahan turun di antara bek tengah).
- Jarak adalah perkiraan BAWAH saat pemain hilang dari tracking (lihat kolom `coverage`).
