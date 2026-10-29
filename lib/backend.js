/**
 * ============================================================================
 *  E-PAYROLL PJM  —  PT. Prohaba Jaya Mandiri
 *  Backend (Vercel Function)  (file: lib/backend.js, dipanggil dari api/rpc.js)
 *  Database : Supabase (Postgres)
 *    settings, users, employees, payroll, kasbon, naik_gaji, phk, sessions
 * ============================================================================
 *
 *  Port dari versi Google Apps Script (code_gs.js). Logika kalkulasi tidak diubah:
 *  tiap request memuat semua tabel lewat RPC app_load, aksi berjalan di memori
 *  seperti sebelumnya, lalu semua perubahan dikirim sekaligus lewat RPC app_apply
 *  (satu transaksi; bila aksi gagal, tidak ada data yang berubah).
 *
 *  Login, logout & ganti password ditangani langsung oleh fungsi database
 *  (app_login, app_logout, app_change_password). Akun awal: admin / admin123.
 * ============================================================================
 */

var crypto = require('crypto');

var APP_TITLE = 'E-PAYROLL PJM';
var ALL_STATUSES = ['PKWTT', 'PKWT', 'Probation', 'Resign', 'Dirumahkan', 'PHK'];
var ACTIVE_STATUSES = ['PKWTT', 'PKWT', 'Probation'];
/* Nilai status lama (versi awal aplikasi) otomatis dipetakan ke status baru. */
var STATUS_ALIASES = { tetap: 'PKWTT', kontrak: 'PKWT' };

/* Definisi kolom tiap sheet: [key internal, label header di sheet]
   Kolom baru SELALU ditambahkan di akhir agar data lama tetap sejajar. */
var COLS = {
  Settings: [['key', 'Key'], ['value', 'Value'], ['note', 'Keterangan']],
  Users: [['username', 'Username'], ['displayName', 'Nama'], ['hash', 'Password Hash'], ['salt', 'Salt'], ['createdAt', 'Dibuat']],
  Employees: [
    ['empId', 'ID Karyawan'], ['name', 'Nama Lengkap'], ['email', 'Email'], ['phone', 'No WA/Telepon'],
    ['status', 'Status'], ['dept', 'Departemen'], ['position', 'Jabatan'], ['startDate', 'Tanggal Mulai Bekerja'],
    ['jobSite', 'Job Site'], ['bank', 'Bank'], ['accNo', 'No Rekening'], ['createdAt', 'Dibuat'],
    ['ptkp', 'Status PTKP']
  ],
  Payroll: [
    ['id', 'ID'], ['period', 'Periode'], ['empId', 'ID Karyawan'], ['name', 'Nama'], ['bank', 'Bank'],
    ['accNo', 'No Rekening'], ['jobSite', 'Job Site'], ['gp', 'Gaji Pokok'], ['tl', 'Tunjangan Lapangan'],
    ['thr', 'THR'], ['bruto', 'Penghasilan Bruto'], ['kasLalu', 'Sisa Kasbon Bulan Lalu'],
    ['potKas', 'Potongan Kasbon'], ['sisaKas', 'Sisa Kasbon Bulan Ini'], ['jht', 'BPJS JHT'], ['jp', 'BPJS JP'],
    ['kes', 'BPJS Kesehatan'], ['totalPeng', 'Total Pengurang'], ['thp', 'Gaji Bersih (THP)'],
    ['source', 'Sumber'], ['createdAt', 'Dibuat'],
    // --- Ditambahkan (laporan 3 jenis gaji & konfirmasi). Kosong = otomatis / FINAL ---
    ['status', 'Status Data'], ['kesBase', 'Gaji Setor BPJS Kes (Manual)'], ['taxBaseOv', 'Gaji Setor Pajak (Manual)']
  ],
  Kasbon: [
    ['id', 'ID'], ['empId', 'ID Karyawan'], ['name', 'Nama'], ['reqDate', 'Tgl Pengajuan'], ['amount', 'Nominal'],
    ['status', 'Status'], ['cairDate', 'Tgl Cair'], ['period', 'Periode Cair'], ['note', 'Keterangan'],
    ['createdAt', 'Dibuat']
  ],
  NaikGaji: [
    ['id', 'ID'], ['period', 'Periode'], ['empId', 'ID Karyawan'], ['name', 'Nama'], ['oldSalary', 'Gaji Awal'],
    ['raise', 'Kenaikan'], ['newSalary', 'Gaji Baru'], ['note', 'Keterangan'], ['createdAt', 'Dibuat']
  ],
  PHK: [
    ['id', 'ID'], ['period', 'Periode'], ['empId', 'ID Karyawan'], ['name', 'Nama'], ['phkDate', 'Tanggal PHK'],
    ['reason', 'Alasan PHK'], ['rights', 'Hak Kompensasi'], ['amount', 'Nominal Kompensasi'], ['note', 'Keterangan'],
    ['createdAt', 'Dibuat']
  ],
  Resign: [
    ['id', 'ID'], ['period', 'Periode'], ['empId', 'ID Karyawan'], ['name', 'Nama'], ['resignDate', 'Tanggal Resign'],
    ['gp', 'Gaji Pokok'], ['tl', 'Tunjangan Lapangan'], ['total', 'Total Gaji'], ['monthDays', 'Hari dalam Bulan'],
    ['workDays', 'Hari Kerja s/d Resign'], ['prorata', 'Gaji Prorata'], ['note', 'Keterangan'], ['createdAt', 'Dibuat']
  ]
};
var TEXT_KEYS = {
  Settings: [], Users: ['username'],
  Employees: ['empId', 'phone', 'startDate', 'accNo', 'ptkp'],
  Payroll: ['period', 'empId', 'accNo'],
  Kasbon: ['empId', 'reqDate', 'cairDate', 'period'],
  NaikGaji: ['period', 'empId'],
  PHK: ['period', 'empId', 'phkDate'],
  Resign: ['period', 'empId', 'resignDate']
};
var MONEY_KEYS = {
  Payroll: ['gp', 'tl', 'thr', 'bruto', 'kasLalu', 'potKas', 'sisaKas', 'jht', 'jp', 'kes', 'totalPeng', 'thp', 'kesBase', 'taxBaseOv'],
  Kasbon: ['amount'],
  NaikGaji: ['oldSalary', 'raise', 'newSalary'],
  PHK: ['amount'],
  Resign: ['gp', 'tl', 'total', 'prorata']
};

/* Konstanta kalkulasi & regulasi (bisa diubah dari sheet "Settings" / menu Pengaturan & BPJS) */
var DEFAULT_SETTINGS = [
  ['COMPANY_NAME', 'PT. Prohaba Jaya Mandiri', 'Nama perusahaan (kop slip & PDF)'],
  ['COMPANY_ADDRESS', '', 'Alamat perusahaan (opsional, tampil di kop PDF)'],
  ['JHT_RATE', 0.02, 'Tarif BPJS JHT pekerja (2% x upah, tanpa plafon)'],
  ['JP_RATE', 0.01, 'Tarif BPJS JP pekerja (1% x upah, dengan plafon)'],
  ['JP_CAP', 8939700, 'Plafon batas upah maksimal BPJS JP (Rp)'],
  ['KES_RATE', 0.01, 'Tarif BPJS Kesehatan pekerja (1% x upah, dengan plafon)'],
  ['KES_CAP', 12000000, 'Plafon batas upah maksimal BPJS Kesehatan (Rp)'],
  ['BATCH_LIMIT', 100000000, 'Limit maksimal nominal per batch transfer bank (Rp)'],
  ['UMK_MIN', 0, 'Payroll: batas minimal upah dasar potongan BPJS = UMK/UMP (Rp). 0 = tidak diterapkan'],
  // --- ATURAN GAJI BPJS (laporan, terpisah dari potongan BPJS di Payroll / Gaji Real) ---
  ['RB_UMK', 0, 'Gaji BPJS: batas minimal gaji otomatis = UMK/UMP (Rp). 0 = tidak diterapkan'],
  ['RB_KES_EE', 0.01, 'Gaji BPJS: iuran BPJS Kesehatan pekerja'],
  ['RB_KES_ER', 0.04, 'Gaji BPJS: iuran BPJS Kesehatan pemberi kerja'],
  ['RB_KES_CAP', 12000000, 'Gaji BPJS: plafon upah BPJS Kesehatan (Rp)'],
  ['RB_JHT_EE', 0.02, 'Gaji BPJS: iuran JHT pekerja'],
  ['RB_JHT_ER', 0.037, 'Gaji BPJS: iuran JHT pemberi kerja'],
  ['RB_JP_EE', 0.01, 'Gaji BPJS: iuran JP pekerja'],
  ['RB_JP_ER', 0.02, 'Gaji BPJS: iuran JP pemberi kerja'],
  ['RB_JP_CAP', 10547400, 'Gaji BPJS: plafon upah JP (Rp) - cek surat edaran BPJS terbaru'],
  ['RB_JKK_ER', 0.016, 'Gaji BPJS: iuran JKK pemberi kerja (sesuai tingkat risiko)'],
  ['RB_JKM_ER', 0.003, 'Gaji BPJS: iuran JKM pemberi kerja'],
  // --- ATURAN GAJI PAJAK ---
  ['RT_COMP', 'gp,tl,thr,jkk,jkm,kes', 'Gaji Pajak: komponen yang dihitung (gp,tl,thr,jkk,jkm,kes)']
];
var NUMERIC_SETTINGS = ['JHT_RATE', 'JP_RATE', 'JP_CAP', 'KES_RATE', 'KES_CAP', 'BATCH_LIMIT', 'UMK_MIN',
  'RB_UMK', 'RB_KES_EE', 'RB_KES_ER', 'RB_KES_CAP', 'RB_JHT_EE', 'RB_JHT_ER', 'RB_JP_EE', 'RB_JP_ER', 'RB_JP_CAP', 'RB_JKK_ER', 'RB_JKM_ER'];
var RATE_SETTINGS = /(_RATE|_EE|_ER)$/;
var TAX_COMPS = ['gp', 'tl', 'thr', 'jkk', 'jkm', 'kes'];
/* Nilai lama dari halaman "BPJS & Pajak" (sudah dihapus) dipakai sebagai nilai awal aturan Gaji BPJS bila ada. */
var LEGACY_RB = { RB_JHT_ER: 'JHT_ER_RATE', RB_JP_ER: 'JP_ER_RATE', RB_KES_ER: 'KES_ER_RATE', RB_JKK_ER: 'JKK_RATE', RB_JKM_ER: 'JKM_RATE' };

/* ======================= REFERENSI PAJAK (PPh 21) ========================
   PTKP: PMK 101/PMK.010/2016 (masih berlaku).
   Pemotongan bulanan: Tarif Efektif Rata-rata (TER) PP 58/2023 & PMK 168/2023
   (berlaku sejak 1 Januari 2024). Masa Desember dihitung ulang memakai tarif
   Pasal 17 UU PPh s.t.d.t.d. UU 7/2021 (HPP). Di aplikasi ini PPh 21 hanya
   INFORMASI (estimasi), tidak memotong Gaji Bersih. */
var PTKP = {
  'TK/0': 54000000, 'TK/1': 58500000, 'TK/2': 63000000, 'TK/3': 67500000,
  'K/0': 58500000, 'K/1': 63000000, 'K/2': 67500000, 'K/3': 72000000
};
var TER_CAT = { 'TK/0': 'A', 'TK/1': 'A', 'K/0': 'A', 'TK/2': 'B', 'TK/3': 'B', 'K/1': 'B', 'K/2': 'B', 'K/3': 'C' };
/* [batas atas penghasilan bruto bulanan, tarif %]; null = tanpa batas atas */
var TER = {
  A: [[5400000, 0], [5650000, 0.25], [5950000, 0.5], [6300000, 0.75], [6750000, 1], [7500000, 1.25], [8550000, 1.5],
      [9650000, 1.75], [10050000, 2], [10350000, 2.25], [10700000, 2.5], [11050000, 3], [11600000, 3.5], [12500000, 4],
      [13750000, 5], [15100000, 6], [16950000, 7], [19750000, 8], [24150000, 9], [26450000, 10], [28000000, 11],
      [30050000, 12], [32400000, 13], [35400000, 14], [39100000, 15], [43850000, 16], [47800000, 17], [51400000, 18],
      [56300000, 19], [62200000, 20], [68600000, 21], [77500000, 22], [89000000, 23], [103000000, 24], [125000000, 25],
      [157000000, 26], [206000000, 27], [337000000, 28], [454000000, 29], [550000000, 30], [695000000, 31],
      [910000000, 32], [1400000000, 33], [null, 34]],
  B: [[6200000, 0], [6500000, 0.25], [6850000, 0.5], [7300000, 0.75], [9200000, 1], [10750000, 1.5], [11250000, 2],
      [11600000, 2.5], [12600000, 3], [13600000, 4], [14950000, 5], [16400000, 6], [18450000, 7], [21850000, 8],
      [26000000, 9], [27700000, 10], [29350000, 11], [31450000, 12], [33950000, 13], [37100000, 14], [41100000, 15],
      [45800000, 16], [49500000, 17], [53800000, 18], [58500000, 19], [64000000, 20], [71000000, 21], [80000000, 22],
      [93000000, 23], [109000000, 24], [129000000, 25], [163000000, 26], [211000000, 27], [374000000, 28],
      [459000000, 29], [555000000, 30], [704000000, 31], [957000000, 32], [1405000000, 33], [null, 34]],
  C: [[6600000, 0], [6950000, 0.25], [7350000, 0.5], [7800000, 0.75], [8850000, 1], [9800000, 1.25], [10950000, 1.5],
      [11200000, 1.75], [12050000, 2], [12950000, 3], [14150000, 4], [15550000, 5], [17050000, 6], [19500000, 7],
      [22700000, 8], [26600000, 9], [28100000, 10], [30100000, 11], [32600000, 12], [35400000, 13], [38900000, 14],
      [43000000, 15], [47400000, 16], [51200000, 17], [55800000, 18], [60400000, 19], [66700000, 20], [74500000, 21],
      [83200000, 22], [95600000, 23], [110000000, 24], [134000000, 25], [169000000, 26], [221000000, 27],
      [390000000, 28], [463000000, 29], [561000000, 30], [709000000, 31], [965000000, 32], [1419000000, 33], [null, 34]]
};

/* ============================== DATA STORE ================================ */

/* Nama tabel Supabase untuk tiap "sheet". Kolom DB = key internal dalam snake_case
   (empId -> emp_id). `_row` = identity Postgres, menggantikan nomor baris sheet. */
var TABLES = { Settings: 'settings', Employees: 'employees', Payroll: 'payroll', Kasbon: 'kasbon', NaikGaji: 'naik_gaji', PHK: 'phk', Resign: 'resign' };
var TMP_ROW = 1e12;   // _row sementara untuk baris baru (selalu sesudah baris lama)
var store_ = null;    // { tables: { Name: [rows] }, ops: [...], pending: { _row: insertOp }, tmp: n }

function snake_(k) { return k.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); }

function fromDb_(name, rec) {
  var o = { _row: Number(rec._row) };
  var textKeys = TEXT_KEYS[name] || [];
  COLS[name].forEach(function (c) {
    var k = c[0], v = rec[snake_(k)];
    if (v === null || v === undefined) v = '';
    else if (k === 'createdAt') v = String(v).replace('T', ' ').slice(0, 19);
    else if (textKeys.indexOf(k) >= 0) v = String(v);
    o[k] = v;
  });
  return o;
}

function toDb_(name, obj) {
  var r = {};
  COLS[name].forEach(function (c) {
    var v = obj[c[0]];
    r[snake_(c[0])] = (v === undefined || v === null || v === '') ? null : v;
  });
  return r;
}

function loadStore_(tables) {
  store_ = { tables: {}, ops: [], pending: {}, tmp: 0 };
  Object.keys(TABLES).forEach(function (name) {
    store_.tables[name] = (tables[name] || []).map(function (rec) { return fromDb_(name, rec); });
  });
}

function ensureSetup_() {
  if (readTable_('Settings').length === 0) {
    appendRows_('Settings', DEFAULT_SETTINGS.map(function (s) { return { key: s[0], value: s[1], note: s[2] }; }));
  }
}

/* ============================== TABLE HELPERS ============================= */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
/** Waktu Asia/Jakarta (UTC+7, tanpa DST). */
function jkt_() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString(); }
function now_() { var s = jkt_(); return s.slice(0, 10) + ' ' + s.slice(11, 19); }
function today_() { return jkt_().slice(0, 10); }

function readTable_(name) {
  return store_.tables[name].map(function (r) {
    var o = {};
    Object.keys(r).forEach(function (k) { o[k] = r[k]; });
    return o;
  });
}

function toRow_(name, obj) {
  var r = {};
  COLS[name].forEach(function (c) {
    var v = obj[c[0]];
    r[c[0]] = (v === undefined || v === null) ? '' : v;
  });
  return r;
}

function appendRows_(name, objs) {
  objs.forEach(function (o) {
    var r = toRow_(name, o);
    r._row = TMP_ROW + (++store_.tmp);
    store_.tables[name].push(r);
    var op = { t: TABLES[name], op: 'insert', row: toDb_(name, r) };
    store_.pending[r._row] = op;
    store_.ops.push(op);
  });
}

function updateRow_(name, rowIdx, obj) {
  var r = toRow_(name, obj);
  r._row = rowIdx;
  var t = store_.tables[name];
  for (var i = 0; i < t.length; i++) if (t[i]._row === rowIdx) { t[i] = r; break; }
  if (store_.pending[rowIdx]) store_.pending[rowIdx].row = toDb_(name, r);
  else store_.ops.push({ t: TABLES[name], op: 'update', _row: rowIdx, row: toDb_(name, r) });
}

function deleteRow_(name, rowIdx) {
  store_.tables[name] = store_.tables[name].filter(function (r) { return r._row !== rowIdx; });
  var p = store_.pending[rowIdx];
  if (p) { store_.ops.splice(store_.ops.indexOf(p), 1); delete store_.pending[rowIdx]; }
  else store_.ops.push({ t: TABLES[name], op: 'delete', _row: rowIdx });
}

function deleteRowById_(name, key, id) {
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]) === String(id)) {
      deleteRow_(name, rows[i]._row);
      return true;
    }
  }
  return false;
}

function findById_(name, id) {
  return readTable_(name).filter(function (r) { return String(r.id) === String(id); })[0];
}

function stripRow_(o) { var c = {}; Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; }); return c; }

/* ============================== UTILITIES ================================= */

/** Parser angka rupiah toleran: "Rp 1.500.000", "1,500,000", "1500000" -> 1500000 */
function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : 0;
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  var neg = /^-|^\(/.test(s);
  var t = s.replace(/[Rr][Pp]\.?/g, '').replace(/\s/g, '');
  if (/^\d+[.,]\d{1,2}$/.test(t)) return Math.round(parseFloat(t.replace(',', '.'))) * (neg ? -1 : 1);
  var digits = t.replace(/[^0-9]/g, '');
  var n = digits ? parseInt(digits, 10) : 0;
  return neg ? -n : n;
}

function str_(v) { return String(v == null ? '' : v).trim(); }

function parseDate_(v) {
  if (v instanceof Date) return new Date(v.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  var s = str_(v);
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function validPeriod_(p) {
  p = str_(p);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new Error('Format periode tidak valid (gunakan YYYY-MM).');
  return p;
}

function normKey_(k) { return String(k).replace(/\(.*?\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function mapRow_(raw, aliases) {
  var norm = {}, out = {};
  Object.keys(raw).forEach(function (k) { norm[normKey_(k)] = raw[k]; });
  Object.keys(aliases).forEach(function (f) {
    for (var i = 0; i < aliases[f].length; i++) {
      if (norm.hasOwnProperty(aliases[f][i])) { out[f] = norm[aliases[f][i]]; break; }
    }
  });
  return out;
}

var EMP_ALIASES = {
  empId: ['idkaryawan', 'id', 'empid'],
  name: ['namalengkap', 'nama'],
  email: ['email'],
  phone: ['nowatelepon', 'nowa', 'notelepon', 'telepon', 'wa', 'nohp', 'nowatelp'],
  status: ['status'],
  dept: ['departemen', 'dept', 'department'],
  position: ['jabatan', 'posisi'],
  startDate: ['tanggalmulaibekerja', 'tanggalmulai', 'tglmulai', 'startdate'],
  jobSite: ['jobsite', 'site', 'proyek'],
  bank: ['bank'],
  accNo: ['norekening', 'rekening', 'norek'],
  ptkp: ['statusptkp', 'ptkp']
};
var PAY_ALIASES = {
  empId: ['idkaryawan', 'id', 'empid'],
  gp: ['gajipokok', 'gapok'],
  tl: ['tunjanganlapangan', 'tunjangan', 'tunjlapangan'],
  thr: ['thr'],
  kasLalu: ['sisakasbonbulanlalu', 'sisakasbonlalu', 'kasbonlalu', 'sisakasbon'],
  potKas: ['potongankasbon', 'kasbon', 'potkasbon', 'potongan'],
  jht: ['bpjsjht', 'bpjsjhtpekerja', 'jhtpekerja', 'jht'],
  jp: ['bpjsjp', 'bpjsjppekerja', 'jppekerja', 'jp'],
  kes: ['bpjskesehatan', 'bpjskesehatanpekerja', 'bpjskes', 'kesehatanpekerja', 'kesehatan']
};

/** Import dari URL Google Sheets: file diunduh sebagai CSV oleh api/rpc.js (fetchSheetRows)
 *  sebelum aksi dijalankan, lalu dikirim sebagai `rows`. Sampai di sini berarti gagal dibaca. */
function readSheetRows_(url) {
  throw new Error('Tidak dapat membaca Google Sheets dari URL: ' + str_(url));
}

/* ============================== API DISPATCHER ============================ */

/** Jalankan satu aksi terhadap isi tabel `tables` (hasil app_load).
 *  Hasil: { data, ops } — ops = perubahan untuk app_apply. */
function run(tables, action, payload, username) {
  loadStore_(tables);
  try {
    var fn = ACTIONS[action];
    if (!fn) throw new Error('Aksi tidak dikenal: ' + action);
    ensureSetup_();
    var data = fn(payload || {}, { username: username });
    return { data: data, ops: store_.ops };
  } finally {
    store_ = null;
  }
}

var ACTIONS = {
  snapshot: function (p) { return snapshot_(p); },
  getKasbon: function (p) { return { kasLalu: buildKasbonMap_(validPeriod_(p.period))[str_(p.empId)] || 0 }; },
  lastSalary: function (p) { return lastSalary_(p); },
  saveEmployee: function (p) { return saveEmployee_(p); },
  deleteEmployee: function (p) { return deleteEmployee_(p); },
  importEmployees: function (p) { return importEmployees_(p); },
  savePayroll: function (p) { return savePayroll_(p); },
  deletePayroll: function (p) { if (!deleteRowById_('Payroll', 'id', p.id)) throw new Error('Data payroll tidak ditemukan.'); return true; },
  bulkTemplate: function (p) { return bulkTemplate_(p); },
  bulkUpload: function (p) { return bulkUpload_(p); },
  saveKasbon: function (p) { return saveKasbon_(p); },
  cairKasbon: function (p) { return cairKasbon_(p); },
  deleteKasbon: function (p) { if (!deleteRowById_('Kasbon', 'id', p.id)) throw new Error('Data kasbon tidak ditemukan.'); return true; },
  saveRaise: function (p) { return saveRaise_(p); },
  deleteRaise: function (p) { if (!deleteRowById_('NaikGaji', 'id', p.id)) throw new Error('Data kenaikan gaji tidak ditemukan.'); return true; },
  savePhk: function (p) { return savePhk_(p); },
  deletePhk: function (p) { if (!deleteRowById_('PHK', 'id', p.id)) throw new Error('Data PHK tidak ditemukan.'); return true; },
  saveResign: function (p) { return saveResign_(p); },
  deleteResign: function (p) { if (!deleteRowById_('Resign', 'id', p.id)) throw new Error('Data resign tidak ditemukan.'); return true; },
  updatePayroll: function (p) { return updatePayroll_(p); },
  copyPayroll: function (p) { return copyPayroll_(p); },
  confirmPayroll: function (p) { return confirmPayroll_(p); },
  setReportBase: function (p) { return setReportBase_(p); },
  movePeriod: function (p) { return movePeriod_(p); },
  importReportBase: function (p) { return importReportBase_(p); },
  setPtkp: function (p) { return setPtkp_(p); },
  recalcPeriod: function (p) { return recalcPeriod_(p); },
  saveSettings: function (p) { return saveSettings_(p); }
};

/* ============================== SETTINGS ================================== */

function getSettings_() {
  var S = {}, seen = {};
  DEFAULT_SETTINGS.forEach(function (d) { S[d[0]] = d[1]; });
  readTable_('Settings').forEach(function (r) {
    var k = String(r.key);
    if (NUMERIC_SETTINGS.indexOf(k) >= 0) {
      var n = Number(r.value);
      if (isFinite(n)) S[k] = n;
    } else {
      S[k] = String(r.value == null ? '' : r.value);
    }
    seen[k] = true;
  });
  Object.keys(LEGACY_RB).forEach(function (k) {
    var old = LEGACY_RB[k], n = Number(S[old]);
    if (!seen[k] && seen[old] && isFinite(n)) S[k] = n;
  });
  return S;
}

function saveSettings_(p) {
  var rows = readTable_('Settings');
  var errors = [];
  NUMERIC_SETTINGS.forEach(function (k) {
    if (p[k] === undefined) return;
    var n = Number(p[k]);
    if (!isFinite(n) || n < 0) errors.push(k + ' harus berupa angka >= 0');
    if (RATE_SETTINGS.test(k) && n > 1) errors.push(k + ' harus berupa desimal 0 - 1 (mis. 0.02 untuk 2%)');
    if (k === 'BATCH_LIMIT' && n <= 0) errors.push('BATCH_LIMIT harus lebih dari 0');
  });
  if (p.RT_COMP !== undefined) {
    var comps = str_(p.RT_COMP).split(',').map(str_).filter(String);
    if (comps.some(function (c) { return TAX_COMPS.indexOf(c) < 0; })) errors.push('Komponen Gaji Pajak tidak dikenal.');
    if (!comps.length) errors.push('Pilih minimal satu komponen Gaji Pajak.');
    p.RT_COMP = comps.join(',');
  }
  if (errors.length) throw new Error(errors.join('; '));
  var newRows = [];
  DEFAULT_SETTINGS.forEach(function (d) {
    var k = d[0];
    if (p[k] === undefined) return;
    var val = NUMERIC_SETTINGS.indexOf(k) >= 0 ? Number(p[k]) : str_(p[k]);
    var found = rows.filter(function (r) { return r.key === k; })[0];
    if (found) updateRow_('Settings', found._row, { key: k, value: val, note: found.note || d[2] });
    else newRows.push({ key: k, value: val, note: d[2] });
  });
  appendRows_('Settings', newRows);
  return getSettings_();
}

/* ============================ MASTER KARYAWAN ============================= */

function nextEmpIdFrom_(existingIds) {
  var max = 0;
  existingIds.forEach(function (id) {
    var m = String(id).match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return function () {
    max++;
    var s = String(max);
    while (s.length < 3) s = '0' + s;
    return 'EMP-' + s;
  };
}

/** Normalisasi status PTKP: "k1", "K / 1", "tk/0" -> "K/1", "TK/0". Kosong diperbolehkan. */
function normPtkp_(v) {
  var s = str_(v).toUpperCase().replace(/\s/g, '');
  if (!s) return '';
  var m = s.match(/^(TK|K)\/?([0-3])$/);
  if (!m || !PTKP[m[1] + '/' + m[2]]) throw new Error('Status PTKP "' + v + '" tidak valid. Pilihan: ' + Object.keys(PTKP).join(', '));
  return m[1] + '/' + m[2];
}

function cleanEmp_(e) {
  var o = {
    empId: str_(e.empId), name: str_(e.name), email: str_(e.email), phone: str_(e.phone),
    status: str_(e.status) || 'PKWTT', dept: str_(e.dept), position: str_(e.position),
    startDate: parseDate_(e.startDate), jobSite: str_(e.jobSite),
    bank: str_(e.bank).toUpperCase(), accNo: str_(e.accNo).replace(/\s+/g, ''),
    ptkp: normPtkp_(e.ptkp)
  };
  if (!o.name) throw new Error('Nama Lengkap wajib diisi.');
  var alias = STATUS_ALIASES[o.status.toLowerCase()];
  if (alias) o.status = alias;
  var st = ALL_STATUSES.filter(function (s) { return s.toLowerCase() === o.status.toLowerCase(); })[0];
  if (!st) throw new Error('Status "' + o.status + '" tidak valid. Pilihan: ' + ALL_STATUSES.join(', '));
  o.status = st;
  return o;
}

function saveEmployee_(p) {
  var emps = readTable_('Employees');
  var o = cleanEmp_(p);
  if (o.empId) {
    var cur = emps.filter(function (e) { return e.empId === o.empId; })[0];
    if (!cur) throw new Error('Karyawan ' + o.empId + ' tidak ditemukan.');
    o.createdAt = cur.createdAt;
    updateRow_('Employees', cur._row, o);
    return o;
  }
  var gen = nextEmpIdFrom_(emps.map(function (e) { return e.empId; }));
  o.empId = gen();
  o.createdAt = now_();
  appendRows_('Employees', [o]);
  return o;
}

function deleteEmployee_(p) {
  var id = str_(p.empId);
  var has = function (sheet) { return readTable_(sheet).some(function (r) { return r.empId === id; }); };
  if (has('Payroll') || has('Kasbon') || has('NaikGaji') || has('PHK'))
    throw new Error('Karyawan sudah memiliki riwayat payroll/kasbon/mutasi dan tidak bisa dihapus. Ubah statusnya menjadi Resign/PHK.');
  if (!deleteRowById_('Employees', 'empId', id)) throw new Error('Karyawan tidak ditemukan.');
  return true;
}

function importEmployees_(p) {
  var raws = p.rows && p.rows.length ? p.rows : readSheetRows_(p.url);
  var emps = readTable_('Employees');
  var gen = nextEmpIdFrom_(emps.map(function (e) { return e.empId; }));
  var byId = {}, byKey = {};
  emps.forEach(function (e) {
    byId[e.empId] = e;
    byKey[(e.name + '|' + e.accNo).toLowerCase()] = e;
  });
  var added = 0, updated = 0, errors = [], toAdd = [];
  raws.forEach(function (raw, i) {
    var r = mapRow_(raw, EMP_ALIASES);
    var blank = Object.keys(r).every(function (k) { return str_(r[k]) === ''; });
    if (blank) return;
    try {
      var o = cleanEmp_(r);
      var cur = (o.empId && byId[o.empId]) || byKey[(o.name + '|' + o.accNo).toLowerCase()];
      if (cur) {
        o.empId = cur.empId; o.createdAt = cur.createdAt;
        if (r.ptkp === undefined) o.ptkp = cur.ptkp || '';   // file tanpa kolom PTKP tidak menghapus PTKP lama
        updateRow_('Employees', cur._row, o);
        updated++;
      } else {
        o.empId = gen(); o.createdAt = now_();
        byKey[(o.name + '|' + o.accNo).toLowerCase()] = o;
        toAdd.push(o);
        added++;
      }
    } catch (e) {
      errors.push({ line: i + 2, msg: e.message });
    }
  });
  appendRows_('Employees', toAdd);
  return { added: added, updated: updated, errors: errors };
}

/* ============================ KALKULASI PAYROLL =========================== */

/** Kalkulasi Payroll (Gaji Real).
 *  Potongan BPJS pekerja (JHT, JP, Kesehatan) DIINPUT MANUAL (perhitungan khusus perusahaan),
 *  tidak dihitung dengan rumus persen. */
function calcPayroll_(gp, tl, thr, kasLalu, potKas, jht, jp, kes) {
  gp = num_(gp); tl = num_(tl); thr = num_(thr); kasLalu = num_(kasLalu); potKas = num_(potKas);
  jht = num_(jht); jp = num_(jp); kes = num_(kes);
  if (gp < 0 || tl < 0 || thr < 0 || kasLalu < 0 || potKas < 0 || jht < 0 || jp < 0 || kes < 0) throw new Error('Nominal tidak boleh negatif.');
  if (potKas > kasLalu) throw new Error('Potongan kasbon (' + potKas + ') melebihi sisa kasbon bulan lalu (' + kasLalu + ').');
  var bruto = gp + tl + thr;                                     // 1. Penghasilan Bruto
  var sisaKas = kasLalu - potKas;                                // 2. Sisa Kasbon Bulan Ini
  var totalPeng = potKas + jht + jp + kes;                       // 3. Total Pengurang (BPJS = input manual)
  var thp = bruto - totalPeng;                                   // 4. Gaji Bersih (Take Home Pay)
  return { gp: gp, tl: tl, thr: thr, bruto: bruto, kasLalu: kasLalu, potKas: potKas, sisaKas: sisaKas,
           jht: jht, jp: jp, kes: kes, totalPeng: totalPeng, thp: thp };
}

function terRate_(cat, bruto) {
  var t = TER[cat];
  if (!t) return null;
  for (var i = 0; i < t.length; i++) if (t[i][0] === null || bruto <= t[i][0]) return t[i][1];
  return t[t.length - 1][1];
}

/** Peta { empId: sisa kasbon untuk dipotong pada `period` }.
 *  = sisa kasbon payroll terakhir sebelum `period`
 *  + kasbon yang CAIR sejak bulan payroll terakhir tsb s/d bulan sebelum `period`
 *  (kasbon cair bulan ini mulai dipotong di payroll bulan depan). */
function buildKasbonMap_(period, payAll, kasAll) {
  var best = {};
  (payAll || readTable_('Payroll')).forEach(function (r) {
    if (r.period >= period) return;
    var b = best[r.empId];
    if (!b || r.period > b.period || (r.period === b.period && r._row > b._row)) {
      best[r.empId] = { period: r.period, _row: r._row, sisa: num_(r.sisaKas) };
    }
  });
  var m = {};
  Object.keys(best).forEach(function (k) { m[k] = best[k].sisa; });
  (kasAll || readTable_('Kasbon')).forEach(function (k) {
    if (k.status !== 'Cair' || !k.period || k.period >= period) return;
    var b = best[k.empId];
    if (b && k.period < b.period) return;   // sudah terhitung di payroll sebelumnya
    m[k.empId] = (m[k.empId] || 0) + num_(k.amount);
  });
  return m;
}

function newId_(prefix) { return prefix + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(); }

function buildPayrollRow_(emp, period, c, source, status) {
  return {
    id: newId_('PAY'), period: period, empId: emp.empId, name: emp.name, bank: emp.bank, accNo: emp.accNo,
    jobSite: emp.jobSite, gp: c.gp, tl: c.tl, thr: c.thr, bruto: c.bruto, kasLalu: c.kasLalu,
    potKas: c.potKas, sisaKas: c.sisaKas, jht: c.jht, jp: c.jp, kes: c.kes, totalPeng: c.totalPeng,
    thp: c.thp, source: source, createdAt: now_(), status: status || 'FINAL', kesBase: '', taxBaseOv: ''
  };
}

/** Nilai manual laporan (kosong = otomatis). Dipakai agar override tidak hilang saat baris diganti. */
function blankOr_(v) { return str_(v) === '' ? '' : num_(v); }
function carryOverrides_(row, old) {
  if (!old) return row;
  row.kesBase = blankOr_(old.kesBase); row.taxBaseOv = blankOr_(old.taxBaseOv);
  return row;
}
function prevPeriod_(p) {
  var y = parseInt(p.slice(0, 4), 10), m = parseInt(p.slice(5, 7), 10) - 1;
  if (m === 0) { y--; m = 12; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}

function findEmp_(empId) {
  var id = str_(empId);
  var e = readTable_('Employees').filter(function (x) { return x.empId === id; })[0];
  if (!e) throw new Error('Karyawan "' + id + '" tidak ditemukan di Master Data.');
  return e;
}

/** Peta { empId: tanggal keluar } dari data Resign & PHK. */
function endDates_() {
  var m = {};
  readTable_('PHK').forEach(function (r) { if (r.phkDate) m[r.empId] = r.phkDate; });
  readTable_('Resign').forEach(function (r) { if (r.resignDate) m[r.empId] = r.resignDate; });
  return m;
}
/** Boleh diproses payroll pada `period`: status aktif, atau keluar (Resign/PHK) di periode itu atau sesudahnya
 *  (gaji bulan terakhir tetap dibayar). */
function canPay_(emp, period, ends) {
  if (ACTIVE_STATUSES.indexOf(emp.status) >= 0) return true;
  var end = (ends || endDates_())[emp.empId];
  return !!end && end.slice(0, 7) >= period;
}

function savePayroll_(p) {
  var S = getSettings_();
  var period = validPeriod_(p.period);
  var emp = findEmp_(p.empId);
  if (!canPay_(emp, period)) throw new Error('Karyawan berstatus ' + emp.status + ' tidak dapat diproses payroll periode ini.');
  // Cegah entri ganda: satu karyawan hanya satu baris payroll per periode.
  var existing = readTable_('Payroll').filter(function (r) { return r.period === period && r.empId === emp.empId; });
  if (existing.length && !p.replace) {
    throw new Error('Payroll ' + emp.name + ' untuk periode ini sudah ada. Hapus data lama atau pilih "Ganti data lama".');
  }
  var kasLalu = (p.kasLalu === '' || p.kasLalu == null) ? (buildKasbonMap_(period)[emp.empId] || 0) : p.kasLalu;
  var c = calcPayroll_(p.gp, p.tl, p.thr, kasLalu, p.potKas, p.jht, p.jp, p.kes);
  var row = carryOverrides_(buildPayrollRow_(emp, period, c, 'MANUAL'), existing[0]);
  existing.forEach(function (r) { deleteRow_('Payroll', r._row); });
  appendRows_('Payroll', [row]);
  return row;
}

/* ============================ BULK PAYROLL ENGINE ========================= */

function bulkTemplate_(p) {
  var period = validPeriod_(p.period);
  var payAll = readTable_('Payroll'), kas = buildKasbonMap_(period, payAll), last = {}, ends = endDates_();
  payAll.forEach(function (r) { if (r.period < period && (!last[r.empId] || r.period >= last[r.empId].period)) last[r.empId] = r; });
  return readTable_('Employees')
    .filter(function (e) { return canPay_(e, period, ends); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); })
    .map(function (e) {
      var l = last[e.empId] || {};   // potongan BPJS diisi dari payroll terakhir (tetap bisa diubah)
      return { empId: e.empId, name: e.name, dept: e.dept, jobSite: e.jobSite, bank: e.bank, kasLalu: kas[e.empId] || 0, jht: num_(l.jht), jp: num_(l.jp), kes: num_(l.kes) };
    });
}

function bulkUpload_(p) {
  var S = getSettings_();
  var period = validPeriod_(p.period);
  var raws = p.rows && p.rows.length ? p.rows : readSheetRows_(p.url);
  var emps = {};
  readTable_('Employees').forEach(function (e) { emps[e.empId] = e; });
  var payAll = readTable_('Payroll');
  var kasMap = buildKasbonMap_(period, payAll), ends = endDates_();
  var newRows = [], errors = [], skipped = 0, seen = {};

  raws.forEach(function (raw, i) {
    var r = mapRow_(raw, PAY_ALIASES);
    var line = i + 2;
    var blank = Object.keys(r).every(function (k) { return str_(r[k]) === ''; });
    if (blank) return;
    try {
      var id = str_(r.empId);
      if (!id) throw new Error('ID Karyawan kosong.');
      var emp = emps[id];
      if (!emp) throw new Error('ID Karyawan "' + id + '" tidak ada di Master Data.');
      if (!canPay_(emp, period, ends)) throw new Error(emp.name + ' berstatus ' + emp.status + ' (tidak aktif).');
      if (num_(r.gp) === 0 && num_(r.tl) === 0 && num_(r.thr) === 0) { skipped++; return; }   // tanpa penghasilan = dilewati
      if (seen[id]) throw new Error('ID ' + id + ' muncul lebih dari sekali di file (pertama di baris ' + seen[id] + '). Baris ini dilewati.');
      var kasLalu = str_(r.kasLalu) === '' ? (kasMap[id] || 0) : r.kasLalu;
      var c = calcPayroll_(r.gp, r.tl, r.thr, kasLalu, r.potKas, r.jht, r.jp, r.kes);
      newRows.push(buildPayrollRow_(emp, period, c, 'BULK'));
      seen[id] = line;
    } catch (e) {
      errors.push({ line: line, msg: e.message });
    }
  });

  // Upload ulang tidak menggandakan data: semua baris lama (BULK maupun MANUAL)
  // milik ID yang sama di periode ini diganti dengan hasil upload terbaru.
  var replaced = 0, oldByEmp = {}, dropRows = [];
  payAll.forEach(function (r) {
    if (r.period === period && seen[r.empId]) { replaced++; oldByEmp[r.empId] = r; dropRows.push(r._row); }
  });
  newRows.forEach(function (r) { carryOverrides_(r, oldByEmp[r.empId]); });   // nilai laporan manual tetap dipertahankan
  if (newRows.length) {
    dropRows.forEach(function (n) { deleteRow_('Payroll', n); });
    appendRows_('Payroll', newRows);
  }
  return { processed: newRows.length, replaced: replaced, skipped: skipped, errors: errors };
}

/* ===================== EDIT / SALIN / KONFIRMASI PAYROLL ================== */

/** Tulis perubahan per baris (semua dikirim sekaligus dalam satu app_apply). */
function writeChanged_(name, all, changed) {
  changed.forEach(function (r) { updateRow_(name, r._row, r); });
}

/** Koreksi satu baris payroll (Gaji Real). Data karyawan (bank/rekening/site) disegarkan dari Master. */
function updatePayroll_(p) {
  var S = getSettings_();
  var cur = findById_('Payroll', p.id);
  if (!cur) throw new Error('Data payroll tidak ditemukan.');
  var emp = findEmp_(cur.empId);
  var kasLalu = (p.kasLalu === '' || p.kasLalu == null) ? (buildKasbonMap_(cur.period)[emp.empId] || 0) : p.kasLalu;
  var c = calcPayroll_(p.gp, p.tl, p.thr, kasLalu, p.potKas, p.jht, p.jp, p.kes);
  var row = buildPayrollRow_(emp, cur.period, c, cur.source || 'MANUAL', p.confirm ? 'FINAL' : (cur.status || 'FINAL'));
  row.id = cur.id; row.createdAt = cur.createdAt;
  carryOverrides_(row, cur);
  updateRow_('Payroll', cur._row, row);
  return row;
}

/** Salin payroll periode `from` ke periode `to` sebagai DRAFT.
 *  - Gaji Pokok & Tunjangan disalin; THR hanya bila includeThr = true.
 *  - Bila ada catatan Naik Gaji di periode tujuan, Gaji Pokok memakai Gaji Baru.
 *  - Sisa kasbon dihitung ulang (payroll terakhir + kasbon cair); potongan kasbon disalin, maks. sebesar sisa.
 *  - Karyawan yang sudah punya payroll di periode tujuan dilewati (tidak menimpa). */
function copyPayroll_(p) {
  var S = getSettings_();
  var from = validPeriod_(p.from), to = validPeriod_(p.to);
  if (from === to) throw new Error('Periode asal dan tujuan tidak boleh sama.');
  var payAll = readTable_('Payroll');
  var src = {};
  payAll.forEach(function (r) { if (r.period === from) src[r.empId] = r; });   // baris terakhir per karyawan
  var ids = Object.keys(src);
  if (!ids.length) throw new Error('Tidak ada data payroll di periode asal.');
  var emps = {};
  readTable_('Employees').forEach(function (e) { emps[e.empId] = e; });
  var exists = {};
  payAll.forEach(function (r) { if (r.period === to) exists[r.empId] = true; });
  var raise = {};
  readTable_('NaikGaji').forEach(function (r) { if (r.period === to) raise[r.empId] = num_(r.newSalary); });
  var kasMap = buildKasbonMap_(to, payAll), ends = endDates_();
  var rows = [], skipExist = 0, inactive = [], raised = 0, errors = [];
  ids.forEach(function (id) {
    var s = src[id], emp = emps[id];
    if (exists[id]) { skipExist++; return; }
    if (!emp || !canPay_(emp, to, ends)) { inactive.push(s.name + (emp ? ' (' + emp.status + ')' : ' (tidak ada di Master)')); return; }
    try {
      var gp = raise[id] ? raise[id] : num_(s.gp);
      if (raise[id]) raised++;
      var kasLalu = kasMap[id] || 0;
      var c = calcPayroll_(gp, s.tl, p.includeThr ? s.thr : 0, kasLalu, Math.min(num_(s.potKas), kasLalu), s.jht, s.jp, s.kes);   // BPJS ikut disalin
      rows.push(carryOverrides_(buildPayrollRow_(emp, to, c, 'SALIN', 'DRAFT'), s));
    } catch (e) { errors.push(s.name + ': ' + e.message); }
  });
  appendRows_('Payroll', rows);
  return { copied: rows.length, skipExist: skipExist, inactive: inactive, raised: raised, errors: errors };
}

/** Konfirmasi (DRAFT -> FINAL) atau batalkan konfirmasi. ids kosong = semua baris di periode. */
function confirmPayroll_(p) {
  var period = validPeriod_(p.period), target = p.undo ? 'DRAFT' : 'FINAL';
  var want = {};
  (p.ids || []).forEach(function (id) { want[id] = true; });
  var all = readTable_('Payroll'), changed = [];
  all.forEach(function (r) {
    if (r.period !== period || (p.ids && p.ids.length && !want[r.id])) return;
    if ((r.status || 'FINAL') === target) return;
    r.status = target; changed.push(r);
  });
  writeChanged_('Payroll', all, changed);
  return { count: changed.length, status: target };
}

/** Set nilai laporan "Gaji Setor BPJS Kesehatan" / "Gaji Setor Pajak" (per orang atau sekaligus).
 *  field: kesBase | taxBaseOv | both.  mode: value | thp | gp | bruto | auto (kembali otomatis). */
function setReportBase_(p) {
  var period = validPeriod_(p.period);
  var fields = p.field === 'both' ? ['kesBase', 'taxBaseOv'] : [p.field];
  fields.forEach(function (f) { if (f !== 'kesBase' && f !== 'taxBaseOv') throw new Error('Jenis gaji laporan tidak dikenal.'); });
  var mode = str_(p.mode) || 'value';
  if (mode === 'value' && (str_(p.value) === '' || num_(p.value) < 0)) throw new Error('Nominal wajib diisi (>= 0).');
  var want = {};
  (p.ids || []).forEach(function (id) { want[id] = true; });
  if (!p.ids || !p.ids.length) throw new Error('Tidak ada karyawan yang dipilih.');
  var all = readTable_('Payroll'), changed = [];
  all.forEach(function (r) {
    if (r.period !== period || !want[r.id]) return;
    var v = mode === 'auto' ? '' : mode === 'thp' ? num_(r.thp) : mode === 'gp' ? num_(r.gp) : mode === 'bruto' ? num_(r.bruto) : num_(p.value);
    fields.forEach(function (f) { r[f] = v; });
    changed.push(r);
  });
  writeChanged_('Payroll', all, changed);
  return { count: changed.length };
}

/* ================================ KASBON ==================================
   Status: "Pengajuan" (belum realisasi) -> "Cair" (realisasi, tgl cair diisi).
   Kasbon cair TIDAK masuk Batch Transfer Bank, dan mulai dipotong pada payroll
   bulan berikutnya (otomatis masuk ke "Sisa Kasbon Bulan Lalu"). */

function saveKasbon_(p) {
  var emp = findEmp_(p.empId);
  var amount = num_(p.amount);
  if (amount <= 0) throw new Error('Nominal kasbon harus lebih dari 0.');
  var status = str_(p.status) === 'Cair' ? 'Cair' : 'Pengajuan';
  var cairDate = status === 'Cair' ? parseDate_(p.cairDate) : '';
  if (status === 'Cair' && !cairDate) throw new Error('Tanggal cair wajib diisi untuk kasbon yang sudah cair.');
  var o = {
    empId: emp.empId, name: emp.name, reqDate: parseDate_(p.reqDate) || today_(), amount: amount,
    status: status, cairDate: cairDate, period: cairDate ? cairDate.slice(0, 7) : '', note: str_(p.note)
  };
  if (p.id) {
    var cur = findById_('Kasbon', p.id);
    if (!cur) throw new Error('Data kasbon tidak ditemukan.');
    o.id = cur.id; o.createdAt = cur.createdAt;
    updateRow_('Kasbon', cur._row, o);
    return o;
  }
  if (ACTIVE_STATUSES.indexOf(emp.status) < 0) throw new Error('Karyawan berstatus ' + emp.status + ' tidak dapat mengajukan kasbon.');
  o.id = newId_('KSB'); o.createdAt = now_();
  appendRows_('Kasbon', [o]);
  return o;
}

function cairKasbon_(p) {
  var cur = findById_('Kasbon', p.id);
  if (!cur) throw new Error('Data kasbon tidak ditemukan.');
  var d = parseDate_(p.cairDate);
  if (!d) throw new Error('Tanggal cair wajib diisi.');
  cur.status = 'Cair'; cur.cairDate = d; cur.period = d.slice(0, 7);
  updateRow_('Kasbon', cur._row, cur);
  return stripRow_(cur);
}

/* ============================== NAIK GAJI ================================= */

function lastSalary_(p) {
  var period = validPeriod_(p.period), id = str_(p.empId);
  var rows = readTable_('Payroll').filter(function (r) { return r.empId === id; });
  var before = rows.filter(function (r) { return r.period < period; })
    .sort(function (a, b) { return a.period === b.period ? a._row - b._row : (a.period < b.period ? -1 : 1); });
  if (before.length) { var b = before[before.length - 1]; return { gp: num_(b.gp), tl: num_(b.tl), period: b.period }; }
  var same = rows.filter(function (r) { return r.period === period; });
  return same.length ? { gp: num_(same[same.length - 1].gp), tl: num_(same[same.length - 1].tl), period: period } : { gp: 0, tl: 0, period: '' };
}

function saveRaise_(p) {
  var period = validPeriod_(p.period);
  var emp = findEmp_(p.empId);
  var oldS = num_(p.oldSalary), raise = num_(p.raise);
  if (oldS < 0 || raise <= 0) throw new Error('Gaji awal tidak boleh negatif dan kenaikan harus lebih dari 0.');
  var o = { period: period, empId: emp.empId, name: emp.name, oldSalary: oldS, raise: raise, newSalary: oldS + raise, note: str_(p.note) };
  if (p.id) {
    var cur = findById_('NaikGaji', p.id);
    if (!cur) throw new Error('Data kenaikan gaji tidak ditemukan.');
    o.id = cur.id; o.createdAt = cur.createdAt;
    updateRow_('NaikGaji', cur._row, o);
    return o;
  }
  o.id = newId_('NGJ'); o.createdAt = now_();
  appendRows_('NaikGaji', [o]);
  return o;
}

/* ================================= PHK ==================================== */

function savePhk_(p) {
  var emp = findEmp_(p.empId);
  var d = parseDate_(p.phkDate);
  if (!d) throw new Error('Tanggal PHK wajib diisi.');
  var reason = str_(p.reason);
  if (!reason) throw new Error('Alasan PHK wajib diisi.');
  var rights = Array.isArray(p.rights) ? p.rights.map(str_).filter(String).join(', ') : str_(p.rights);
  var amount = num_(p.amount);
  if (amount < 0) throw new Error('Nominal kompensasi tidak boleh negatif.');
  var o = { period: d.slice(0, 7), empId: emp.empId, name: emp.name, phkDate: d, reason: reason, rights: rights, amount: amount, note: str_(p.note) };
  if (p.id) {
    var cur = findById_('PHK', p.id);
    if (!cur) throw new Error('Data PHK tidak ditemukan.');
    o.id = cur.id; o.createdAt = cur.createdAt;
    updateRow_('PHK', cur._row, o);
  } else {
    o.id = newId_('PHK'); o.createdAt = now_();
    appendRows_('PHK', [o]);
  }
  // Status karyawan otomatis menjadi PHK (tidak bisa diproses payroll berikutnya).
  if (emp.status !== 'PHK') { emp.status = 'PHK'; updateRow_('Employees', emp._row, emp); }
  return o;
}

/* ================================ RESIGN ================================== */

/** Gaji prorata bulan resign = (Gaji Pokok + Tunjangan) / jumlah hari dalam bulan x jumlah hari s/d tanggal resign. */
function saveResign_(p) {
  var emp = findEmp_(p.empId);
  var d = parseDate_(p.resignDate);
  if (!d) throw new Error('Tanggal resign wajib diisi.');
  var gp = num_(p.gp), tl = num_(p.tl);
  if (gp < 0 || tl < 0) throw new Error('Gaji tidak boleh negatif.');
  var y = parseInt(d.slice(0, 4), 10), m = parseInt(d.slice(5, 7), 10);
  var monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate(), workDays = parseInt(d.slice(8, 10), 10);
  var total = gp + tl;
  var o = { period: d.slice(0, 7), empId: emp.empId, name: emp.name, resignDate: d, gp: gp, tl: tl, total: total,
            monthDays: monthDays, workDays: workDays, prorata: Math.round(total / monthDays * workDays), note: str_(p.note) };
  if (p.id) {
    var cur = findById_('Resign', p.id);
    if (!cur) throw new Error('Data resign tidak ditemukan.');
    o.id = cur.id; o.createdAt = cur.createdAt;
    updateRow_('Resign', cur._row, o);
  } else {
    if (readTable_('Resign').some(function (r) { return r.empId === emp.empId; }))
      throw new Error(emp.name + ' sudah tercatat resign. Ubah data resign yang ada.');
    o.id = newId_('RSG'); o.createdAt = now_();
    appendRows_('Resign', [o]);
  }
  // Status karyawan otomatis menjadi Resign (payroll masih bisa diproses s/d bulan resign).
  if (emp.status !== 'Resign') { emp.status = 'Resign'; updateRow_('Employees', emp._row, emp); }
  return o;
}

/* ======================= SALDO KASBON (sinkron Payroll) =================== */

/** Saldo kasbon per karyawan untuk `period`, angkanya sama dengan Payroll:
 *  - Sisa Bulan Lalu  : dari baris payroll periode ini (bila ada), jika belum ada payroll
 *                       = sisa payroll terakhir + kasbon cair sebelum periode ini
 *  - Potongan         : Potongan Kasbon di payroll periode ini
 *  - Sisa Setelah Pot.: = Sisa Kasbon Bulan Ini di payroll
 *  - Cair Bulan Ini   : kasbon cair di periode ini (dipotong mulai bulan depan)
 *  - Saldo Akhir      : Sisa Setelah Potongan + Cair Bulan Ini */
function kasbonSaldo_(period, payAll, kasAll, empById) {
  var base = buildKasbonMap_(period, payAll, kasAll), m = {};
  function get(id) { return m[id] || (m[id] = { empId: id, name: (empById[id] || {}).name || id, jobSite: (empById[id] || {}).jobSite || '', kasLalu: 0, potKas: 0, sisaKas: 0, cair: 0, hasPay: false }); }
  Object.keys(base).forEach(function (id) { if (base[id]) { var o = get(id); o.kasLalu = base[id]; o.sisaKas = base[id]; } });
  payAll.forEach(function (r) {
    if (r.period !== period) return;
    var o = get(r.empId);
    if (!o.hasPay) { o.kasLalu = 0; o.potKas = 0; o.sisaKas = 0; o.hasPay = true; }
    o.name = r.name; o.kasLalu += num_(r.kasLalu); o.potKas += num_(r.potKas); o.sisaKas += num_(r.sisaKas);
  });
  kasAll.forEach(function (k) { if (k.status === 'Cair' && k.period === period) get(k.empId).cair += num_(k.amount); });
  return Object.keys(m).map(function (id) { var o = m[id]; o.saldo = o.sisaKas + o.cair; return o; })
    .filter(function (o) { return o.kasLalu || o.potKas || o.sisaKas || o.cair; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/* ======================= PINDAH PERIODE & IMPORT LAPORAN ================== */

/** Pindahkan SEMUA baris payroll dari periode `from` ke periode `to` (mis. data September
 *  yang terlanjur tersimpan di Oktober). Ditolak bila periode tujuan sudah berisi payroll. */
function movePeriod_(p) {
  var from = validPeriod_(p.from), to = validPeriod_(p.to);
  if (from === to) throw new Error('Periode asal dan tujuan tidak boleh sama.');
  var all = readTable_('Payroll'), changed = [];
  if (all.some(function (r) { return r.period === to; }))
    throw new Error('Periode tujuan sudah berisi data payroll. Hapus/pindahkan dulu data di periode tujuan agar tidak tercampur.');
  all.forEach(function (r) { if (r.period === from) { r.period = to; changed.push(r); } });
  if (!changed.length) throw new Error('Tidak ada data payroll di periode asal.');
  writeChanged_('Payroll', all, changed);
  return { count: changed.length, from: from, to: to };
}

/** Hitung ulang Jumlah Penghasilan, Sisa Kasbon, Jumlah Pengurang & Gaji Bersih dari rincian yang TERSIMPAN
 *  (Gaji Pokok, Tunjangan, THR, Kasbon, BPJS JHT/JP/Kes) untuk satu periode.
 *  apply = false -> hanya pratinjau (tidak mengubah data). apply = true -> simpan hasilnya. */
function recalcPeriod_(p) {
  var period = validPeriod_(p.period), all = readTable_('Payroll'), changed = [], list = [], errors = [];
  all.forEach(function (r) {
    if (r.period !== period) return;
    try {
      var c = calcPayroll_(r.gp, r.tl, r.thr, r.kasLalu, r.potKas, r.jht, r.jp, r.kes);
      var diff = ['bruto', 'sisaKas', 'totalPeng', 'thp'].some(function (k) { return num_(r[k]) !== c[k]; });
      if (!diff) return;
      list.push({ id: r.id, empId: r.empId, name: r.name, oldPeng: num_(r.totalPeng), newPeng: c.totalPeng, oldThp: num_(r.thp), newThp: c.thp });
      if (p.apply) { ['bruto', 'sisaKas', 'totalPeng', 'thp'].forEach(function (k) { r[k] = c[k]; }); changed.push(r); }
    } catch (e) { errors.push(r.name + ': ' + e.message); }
  });
  if (p.apply) writeChanged_('Payroll', all, changed);
  return { rows: list, applied: p.apply ? changed.length : 0, errors: errors };
}

/** Set Status PTKP untuk satu / banyak karyawan sekaligus (dari menu Gaji Pajak). */
function setPtkp_(p) {
  var ptkp = normPtkp_(p.ptkp), want = {};
  (p.empIds || []).forEach(function (id) { want[str_(id)] = true; });
  if (!Object.keys(want).length) throw new Error('Tidak ada karyawan yang dipilih.');
  var all = readTable_('Employees'), changed = [];
  all.forEach(function (e) { if (want[e.empId] && e.ptkp !== ptkp) { e.ptkp = ptkp; changed.push(e); } });
  writeChanged_('Employees', all, changed);
  return { count: changed.length };
}

var RPT_ALIASES = {
  empId: ['idkaryawan', 'id', 'empid'],
  kes: ['gajibpjs', 'gajisetorbpjs', 'gajisetorbpjskesehatan', 'gajisetorbpjskes', 'gajibpjskesehatan', 'gajibpjskes', 'setorbpjs'],
  tax: ['gajipajak', 'gajisetorpajak', 'setorpajak', 'brutopajak'],
  ptkp: ['statusptkp', 'ptkp']
};

/** Import nilai laporan Gaji Setor BPJS Kes & Gaji Setor Pajak (per ID Karyawan, periode aktif).
 *  Sel kosong = tidak diubah; "otomatis"/"auto" = kembali ke hitungan otomatis. Gaji Real tidak diubah.
 *  Kolom "Status PTKP" (opsional) memperbarui PTKP di Master Karyawan. */
function importReportBase_(p) {
  var period = validPeriod_(p.period);
  var raws = p.rows && p.rows.length ? p.rows : readSheetRows_(p.url);
  var all = readTable_('Payroll'), byEmp = {};
  all.forEach(function (r) { if (r.period === period) (byEmp[r.empId] = byEmp[r.empId] || []).push(r); });
  var changed = {}, errors = [], updated = 0, ptkpSet = {};
  function val(v) { var s = str_(v).toLowerCase(); if (s === '') return null; if (s === 'otomatis' || s === 'auto') return ''; var n = num_(v); if (n < 0) throw new Error('Nominal tidak boleh negatif.'); return n; }
  raws.forEach(function (raw, i) {
    var r = mapRow_(raw, RPT_ALIASES), id = str_(r.empId);
    if (p.only === 'rptKes') { delete r.tax; delete r.ptkp; }      // import dari menu Gaji BPJS
    if (p.only === 'rptTax') { delete r.kes; }                     // import dari menu Gaji Pajak
    if (!id) return;   // baris kosong / baris TOTAL dilewati
    try {
      if (!byEmp[id]) throw new Error('ID ' + id + ' tidak punya payroll di periode ini.');
      var kes = r.kes === undefined ? null : val(r.kes), tax = r.tax === undefined ? null : val(r.tax);
      var ptkp = str_(r.ptkp) === '' ? null : normPtkp_(r.ptkp);
      if (ptkp !== null) ptkpSet[id] = ptkp;
      if (kes === null && tax === null) { if (ptkp !== null) updated++; return; }
      byEmp[id].forEach(function (row) {
        if (kes !== null) row.kesBase = kes;
        if (tax !== null) row.taxBaseOv = tax;
        changed[row.id] = row;
      });
      updated++;
    } catch (e) { errors.push({ line: i + 2, msg: e.message }); }
  });
  writeChanged_('Payroll', all, Object.keys(changed).map(function (k) { return changed[k]; }));
  if (Object.keys(ptkpSet).length) {   // Status PTKP ikut diperbarui di Master Karyawan bila kolomnya diisi
    var emps = readTable_('Employees'), ch = [];
    emps.forEach(function (e) { if (ptkpSet[e.empId] && e.ptkp !== ptkpSet[e.empId]) { e.ptkp = ptkpSet[e.empId]; ch.push(e); } });
    writeChanged_('Employees', emps, ch);
  }
  return { updated: updated, errors: errors };
}

/* ===================== DASHBOARD & BATCH TRANSFER ========================= */

function snapshot_(p) {
  var period = validPeriod_(p.period);
  var S = getSettings_();
  var emps = readTable_('Employees').map(stripRow_);
  var empById = {};
  emps.forEach(function (e) { empById[e.empId] = e; });
  var prev = prevPeriod_(period);
  var payAll = readTable_('Payroll');
  var pay = enrichPay_(payAll.filter(function (r) { return r.period === period; }).map(stripRow_), S, empById);
  var prevPay = enrichPay_(payAll.filter(function (r) { return r.period === prev; }).map(stripRow_), S, empById);
  var kasAll = readTable_('Kasbon');
  var kas = kasAll.filter(function (r) { return r.status !== 'Cair' || r.period === period; }).map(stripRow_);
  var raises = readTable_('NaikGaji').filter(function (r) { return r.period === period; }).map(stripRow_);
  var phkAll = readTable_('PHK').map(stripRow_);
  var phkDates = {};
  phkAll.forEach(function (r) { phkDates[r.empId] = r.phkDate; });
  var resignAll = readTable_('Resign').map(stripRow_), resignDates = {};
  resignAll.forEach(function (r) { resignDates[r.empId] = r.resignDate; });
  return {
    settings: S, employees: emps, payroll: pay,
    kasbon: kas, kasbonSaldo: kasbonSaldo_(period, payAll, kasAll, empById), raises: raises, phk: phkAll.filter(function (r) { return r.period === period; }), phkDates: phkDates,
    resign: resignAll.filter(function (r) { return r.period === period; }), resignDates: resignDates,
    dashboard: dashboard_(pay),
    summary: { cur: summary_(pay, period), prev: summary_(prevPay, prev) },
    batches: batches_(pay, S),
    statuses: ALL_STATUSES, activeStatuses: ACTIVE_STATUSES,
    tax: { ptkp: PTKP, cat: TER_CAT, ter: TER }
  };
}

/** Lengkapi baris payroll dengan info hitungan (tidak disimpan) untuk 3 jenis gaji.
 *  1. GAJI REAL  = Gaji Bersih / Take Home Pay di Payroll (potongan BPJS memakai tarif Payroll).
 *  2. GAJI BPJS  = nominal manual, atau otomatis MAX(Gaji Pokok, UMK Gaji BPJS).
 *                  Iuran Kesehatan, JHT, JP, JKK, JKM memakai ATURAN GAJI BPJS sendiri (RB_*).
 *  3. GAJI PAJAK = nominal manual, atau otomatis = jumlah komponen terpilih (RT_COMP):
 *                  Gaji Pokok, Tunjangan, THR, JKK, JKM, BPJS Kes pemberi kerja (dari aturan Gaji BPJS).
 *                  PPh 21 = TER (PP 58/2023) sesuai Status PTKP karyawan.
 *  Gaji BPJS & Gaji Pajak TIDAK mengubah Gaji Real / Payroll. */
function enrichPay_(rows, S, empById) {
  var rate = function (k) { return Number(S[k]) || 0; };
  var comps = str_(S.RT_COMP || TAX_COMPS.join(',')).split(',');
  rows.forEach(function (r) {
    r.status = str_(r.status) || 'FINAL';
    r.kesBase = blankOr_(r.kesBase); r.taxBaseOv = blankOr_(r.taxBaseOv);
    // ---- 2. GAJI BPJS ----
    r.kesAuto = num_(r.gp) > 0 ? Math.max(num_(r.gp), num_(S.RB_UMK)) : 0;
    r.kesManual = r.kesBase !== '';
    r.kesSetor = r.kesManual ? r.kesBase : r.kesAuto;
    var b = r.kesSetor, kesB = Math.min(b, num_(S.RB_KES_CAP) || b), jpB = Math.min(b, num_(S.RB_JP_CAP) || b);
    r.bKesEe = Math.round(rate('RB_KES_EE') * kesB); r.bKesEr = Math.round(rate('RB_KES_ER') * kesB);
    r.bJhtEe = Math.round(rate('RB_JHT_EE') * b);    r.bJhtEr = Math.round(rate('RB_JHT_ER') * b);
    r.bJpEe = Math.round(rate('RB_JP_EE') * jpB);    r.bJpEr = Math.round(rate('RB_JP_ER') * jpB);
    r.bJkk = Math.round(rate('RB_JKK_ER') * b);      r.bJkm = Math.round(rate('RB_JKM_ER') * b);
    r.bEe = r.bKesEe + r.bJhtEe + r.bJpEe;
    r.bEr = r.bKesEr + r.bJhtEr + r.bJpEr + r.bJkk + r.bJkm;
    r.bTotal = r.bEe + r.bEr;
    // ---- 3. GAJI PAJAK ----
    var part = { gp: num_(r.gp), tl: num_(r.tl), thr: num_(r.thr), jkk: r.bJkk, jkm: r.bJkm, kes: r.bKesEr };
    r.taxAuto = comps.reduce(function (a, c) { return a + (part[c] || 0); }, 0);
    r.taxManual = r.taxBaseOv !== '';
    r.taxSetor = r.taxManual ? r.taxBaseOv : r.taxAuto;
    r.ptkp = (empById[r.empId] || {}).ptkp || '';
    r.terCat = TER_CAT[r.ptkp] || '';
    var tr = r.terCat ? terRate_(r.terCat, r.taxSetor) : null;
    r.rptTerRate = tr;
    r.rptPph = tr === null ? null : Math.floor(r.taxSetor * tr / 100);
  });
  return rows;
}

/** Ringkasan realisasi satu periode (untuk perbandingan bulan lalu vs bulan ini). */
function summary_(pay, period) {
  var o = { period: period, rows: pay.length, drafts: 0, headcount: 0, thp: 0, kesSetor: 0, taxSetor: 0 };
  var head = {};
  pay.forEach(function (r) {
    head[r.empId] = true;
    if (r.status === 'DRAFT') o.drafts++;
    o.thp += num_(r.thp); o.kesSetor += num_(r.kesSetor); o.taxSetor += num_(r.taxSetor);
  });
  o.headcount = Object.keys(head).length;
  return o;
}

function bankName_(b) { return str_(b) || '(Tanpa Bank)'; }
function siteName_(s) { return str_(s) || '(Tanpa Job Site)'; }

function dashboard_(pay) {
  // Deduplikasi headcount: ID Karyawan yang sama dalam satu periode dihitung 1 orang.
  var head = {}, totalThp = 0, drafts = 0;
  var byBank = {}, bySite = {};
  function bucket(map, key) { return map[key] || (map[key] = { total: 0, headSet: {} }); }
  pay.forEach(function (r) {
    head[r.empId] = true;
    totalThp += num_(r.thp);
    if (r.status === 'DRAFT') drafts++;
    var b = bucket(byBank, bankName_(r.bank)); b.total += num_(r.thp); b.headSet[r.empId] = true;
    var s = bucket(bySite, siteName_(r.jobSite)); s.total += num_(r.thp); s.headSet[r.empId] = true;
  });
  function toList(map) {
    return Object.keys(map).map(function (k) {
      return { name: k, total: map[k].total, headcount: Object.keys(map[k].headSet).length };
    }).sort(function (a, b) { return b.total - a.total; });
  }
  return {
    headcount: Object.keys(head).length, payrollRows: pay.length, drafts: drafts,
    totalThp: totalThp, totalTransfer: totalThp,
    byBank: toList(byBank), bySite: toList(bySite)
  };
}

function batches_(pay, S) {
  // Catatan: pencairan kasbon sengaja TIDAK dimasukkan ke batch transfer.
  var limit = S.BATCH_LIMIT;
  var items = [];
  pay.forEach(function (r) {
    if (num_(r.thp) > 0) items.push({ type: 'GAJI', empId: r.empId, name: r.name, bank: bankName_(r.bank), accNo: r.accNo, jobSite: r.jobSite, note: '', amount: num_(r.thp) });
  });
  var groups = {};
  items.forEach(function (it) { (groups[it.bank] = groups[it.bank] || []).push(it); });
  return Object.keys(groups).sort().map(function (bank) {
    var list = groups[bank].sort(function (a, b) { return a.name.localeCompare(b.name) || a.type.localeCompare(b.type); });
    var out = [], cur = [], sum = 0;
    list.forEach(function (it) {
      if (cur.length && sum + it.amount > limit) { out.push({ items: cur, total: sum }); cur = []; sum = 0; }
      cur.push(it); sum += it.amount;
    });
    if (cur.length) out.push({ items: cur, total: sum });
    out.forEach(function (b, i) { b.no = i + 1; b.overLimit = b.total > limit; });
    var total = out.reduce(function (a, b) { return a + b.total; }, 0);
    return { bank: bank, total: total, count: list.length, batches: out };
  });
}

module.exports = { run: run, COLS: COLS, TABLES: TABLES, fromDb_: fromDb_ };
