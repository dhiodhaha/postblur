<img src="assets/icon.svg" width="64" height="64" alt="">

# Cuekin

Blur nama dan foto profil di screenshot X, TikTok, dan Instagram secara otomatis. Bagikan isinya, bukan akunnya.

Tampilannya sengaja netral, seperti alat privasi biasa. Efeknya mendukung **#CUEKINBUZZER**: akun yang namanya diblur gak dapat kunjungan, follow, atau komen dari orang yang lihat screenshot-nya.

**Semua diproses di perangkat.** Foto tidak pernah diupload. Yang diunduh dari luar cuma model pembaca teks (Tesseract.js) dan font Inter.

## Cara pakai

1. Pilih satu atau beberapa screenshot.
2. Aplikasi membaca teks (OCR), mencari username/nama/mention, lalu mencari foto profil di sebelah kirinya.
3. Cek hasilnya:
   - Tap kotak merah untuk mematikan/menyalakan blur.
   - Tap teks yang kelewat untuk ikut diblur.
   - Nyalakan **Gambar kotak** lalu geser untuk area lain (mis. avatar di video TikTok).
   - Matikan saklar **Blur** untuk membandingkan dengan aslinya.
4. **Simpan foto ini** / **Simpan semua**. Di iPhone akan muncul share sheet, lalu pilih *Simpan Gambar* untuk masuk ke Photos.

## Yang dideteksi

| Pola | Contoh |
|---|---|
| Header X | `Nama ✓ @handle · 2h` (nama + handle) |
| Header IG | `username • Ikuti` |
| Komentar IG/TikTok | baris pertama blok yang diakhiri `2j  12 suka  Balas` / `2d ago Reply` |
| Mention | `@akun` di dalam teks |
| Disukai oleh | `Disukai oleh username` / `Liked by username` |
| Foto profil | gumpalan piksel non-latar di kiri nama |

Deteksi berbasis aturan dan bisa meleset. Selalu cek sebelum share.

## Update

Setelah mengubah `app.js`, `detect.js`, atau `style.css`, naikkan angka `?v=` di `index.html` supaya HP gak pakai file lama dari cache.

## Jalankan

Situs statis tanpa build step:

```sh
python -m http.server 8000
# buka http://localhost:8000
```

Deploy ke GitHub Pages, Cloudflare Pages, Netlify, dll. dengan meng-upload folder ini apa adanya. Butuh HTTPS supaya tombol share di iOS jalan.

## File

- `index.html`, `style.css`: UI
- `app.js`: upload, OCR, editor kanvas, ekspor/share
- `detect.js`: aturan deteksi username & foto profil (bisa dites di Node: `require('./detect.js')`)

## Lisensi

[The Unlicense](LICENSE): domain publik. Bebas dipakai, diubah, disebarkan, bahkan dijual, tanpa izin dan tanpa wajib mencantumkan nama.
