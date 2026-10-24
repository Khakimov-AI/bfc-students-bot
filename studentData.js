// =====================================================================
// TALABA MA'LUMOTLARI — DB (asosiy, tahrirlangan) + DRAFT (zaxira)
//
// DB sahifasi — eng to'g'ri manba. Agar DB'dagi katak bo'sh bo'lsa,
// qiymat DRAFT'dan olinadi va "DRAFT'dan" deb belgilanadi (hodim
// ko'rganda tekshirilmagan ma'lumot ekanini bilib tursin).
//
// Ustunlar avval SARLAVHA nomi bo'yicha qidiriladi (kimdir ustun
// qo'shsa/surilsa ham ishlayveradi), topilmasa standart indeks olinadi.
// =====================================================================

// [kalit, DB sarlavhasi, standart indeks (A=0), DRAFT ustuni yoki null, bo'lim, yorliq]
const FIELDS = [
  ['payment', 'PAYMENT', 1, null, 'status', 'To‘lov'],
  ['docStatus', 'DOCUMENT_STATUS', 2, null, 'status', 'Hujjat holati'],
  ['status', 'STATUS', 3, 'B', 'status', 'Bosqich'],
  ['supervisor', 'SUPERVISOR', 4, null, 'status', 'Supervisor'],
  ['id', 'ID', 5, 'H', 'head', 'ID'],
  ['fullName', 'FULL NAME', 6, 'I', 'head', 'F.I.SH'],
  ['uni1', 'UNIVERSITY 1', 7, null, 'uni', '1-universitet'],
  ['uni2', 'UNIVERSITY 2', 8, null, 'uni', '2-universitet'],
  ['agreement', 'AGREEMENT', 9, null, 'status', 'Shartnoma (tarif)'],
  ['certStatus', 'CERTIFICATE STATUS', 10, 'M', 'cert', 'Sertifikat holati'],
  ['certificate', 'CERTIFICATE', 11, 'N', 'cert', 'Sertifikat'],
  ['score', 'SCORE', 12, 'O', 'cert', 'Ball'],
  ['branch', 'BRANCH', 13, null, 'status', 'Filial'],
  ['agreementCompany', 'AGREEMENT COMPANY', 14, null, 'status', 'Shartnoma kompaniyasi'],
  ['passport', 'PASSPORT №', 15, 'R', 'passport', 'Passport №'],
  ['dob', 'DOB (YYYY.MM.DD)', 16, 'S', 'personal', 'Tug‘ilgan sana'],
  ['gender', 'GENDER', 17, 'T', 'personal', 'Jinsi'],
  ['phone', 'PHONE', 18, 'U', 'personal', 'Telefon'],
  ['email', 'E-MAIL', 19, 'V', 'personal', 'E-mail'],
  ['address', 'ADRESS', 20, 'W', 'personal', 'Manzil'],
  ['zip', 'ZIP CODE', 21, null, 'personal', 'ZIP kod'],
  ['telegram', 'TELEGRAMM ID', 22, 'Y', 'personal', 'Telegram'],
  ['school', 'SCHOOL NAME', 23, 'Z', 'edu', 'O‘quv muassasasi'],
  ['major', 'MAJOR', 24, 'AA', 'edu', 'Yo‘nalish'],
  ['gradDate', 'GRADUATION DATE', 25, 'AB', 'edu', 'Bitirgan sana'],
  ['gpa', 'GPA', 26, 'AC', 'edu', 'GPA / attestat'],
  ['region', 'REGION', 27, 'AD', 'personal', 'Viloyat'],
  ['zagran', 'ZAGRAN', 28, 'AE', 'passport', 'Zagran'],
  ['jshshir', 'JSHSHIR', 29, 'AF', 'passport', 'JSHSHIR'],
  ['testReport', 'TEST REPORT NUMBER', 30, 'AG', 'cert', 'Test report №'],
  ['examDate', 'EXAM DATE', 31, 'AH', 'cert', 'Imtihon sanasi'],
  ['rejection', 'REJECTION HISTORY', 32, 'AI', 'goal', 'Otkaz tarixi'],
  ['fatherName', "FATHER'S NAME", 33, 'AJ', 'family', 'Otasi'],
  ['fatherPhone', "FATHER'S PHONE NUMBER", 34, 'AK', 'family', 'Otasi tel.'],
  ['fatherJob', "FATHER'S JOB", 35, 'AL', 'family', 'Otasi kasbi'],
  ['motherName', "MOTHER'S NAME", 36, 'AM', 'family', 'Onasi'],
  ['motherPhone', "MOTHER'S PHONE NUMBER", 37, 'AN', 'family', 'Onasi tel.'],
  ['motherJob', "MOTHER'S JOB", 38, 'AO', 'family', 'Onasi kasbi'],
  ['goal', 'ASOSIY MAQSAD', 39, 'AP', 'goal', 'Asosiy maqsad'],
  ['city', 'ASOSIY SHAHAR', 40, 'AQ', 'goal', 'Asosiy shahar'],
  ['missingDocs', 'MISSING DOCS', 41, 'AR', 'docs', 'Yetishmayotgan hujjatlar'],
  ['note', 'MUHIM IZOH!!', 42, null, 'note', 'Muhim izoh'],
  ['chatId', 'CHAT_ID', 43, 'AU', 'tech', 'Chat ID'],
  ['passportIssue', 'PASSPORT ISSUE DATE', 45, null, 'passport', 'Berilgan sana'],
  ['passportExpiry', 'PASSPORT EXPIRY DATE', 46, null, 'passport', 'Amal qilish muddati'],
  ['testIssue', 'TEST ISSUE DATE', 47, null, 'cert', 'Sertifikat berilgan sana'],
  ['testExpiry', 'EXPIRY DATE', 48, null, 'cert', 'Sertifikat muddati'],
  ['schoolAddress', 'SCHOOL ADDRESS', 49, null, 'edu', 'Maktab manzili'],
  ['income', 'YILLIK DAROMAD', 50, null, 'family', 'Yillik daromad'],
  ['houseDate', "OTA YOKI ONA NOMIDAGI UY O'TKAZILGAN ANIQ SANA", 51, null, 'family', 'Uy o‘tkazilgan sana'],
  ['carDate', "OTA YOKI ONA NOMIDAGI MOSHINA O'TKAZILGAN ANIQ SANA", 52, null, 'family', 'Mashina o‘tkazilgan sana'],
  ['schoolPhone', 'SCHOOL PHONE NUMBER', 53, null, 'edu', 'Maktab telefoni'],
  ['program', 'DASTUR', 54, 'C', 'status', 'Dastur'],
  ['bankStatement', 'BANK STATEMENT', 55, null, 'family', 'Bank statement'],
  ['uni3', 'UNIVERSITY 3', 56, null, 'uni', '3-universitet'],
  ['bfSoha', 'BF - SOHA', 57, null, 'status', 'BF soha'],
];

const DB_LAST_COL = 'BF'; // 58-ustun

const norm = (h) => String(h || '').replace(/[ ​﻿]/g, ' ').replace(/\s+/g, ' ').replace(/[‘’`ʻ]/g, "'").trim().toUpperCase();
const clean = (v) => String(v == null ? '' : v).replace(/[ ​﻿]/g, ' ').trim();

/**
 * Sarlavha qatori bo'yicha ustun indekslarini aniqlaydi.
 * @returns {{ idx: Object<string,number>, moved: string[], missing: string[] }}
 */
function resolveDbColumns(headerRow) {
  const headers = (headerRow || []).map(norm);
  const idx = {}; const moved = []; const missing = [];
  for (const [key, header, def] of FIELDS) {
    const want = norm(header);
    if (headers[def] === want) { idx[key] = def; continue; }
    const found = headers.indexOf(want);
    if (found !== -1) { idx[key] = found; moved.push(`${header}: ${def + 1} → ${found + 1}`); } else { idx[key] = def; if (headers.length) missing.push(header); }
  }
  return { idx, moved, missing };
}

// DRAFT'dagi texnik kodlarni o'qiladigan matnga aylantirish
const DRAFT_HUMAN = {
  program: { BAKALAVR: 'Bakalavr', KOLLEJ: 'Kollej', MAGISTRATURA: 'Magistratura', TIL_KURSI: 'Til kursi' },
  goal: { OQISH: 'O‘qish', ISHLASH: 'Ishlash', OQIB_ISHLASH: 'O‘qib ham ishlash', ISHLAB_OQISH: 'Ishlab o‘qish' },
  city: { SEOUL: 'Seoul', INCHEON: 'Incheon', CHEONAN: 'Cheonan', DAEGU: 'Daegu', DAEJON: 'Daejon', BUSAN: 'Busan', GWANGJU_METRO: 'Gwangju (katta)', GWANGJU_CITY: 'Gwangju (kichik)' },
  certStatus: { YES: 'Bor', NO: 'Yo‘q' },
  zagran: { BOR: 'Bor', YOQ: 'Yo‘q' },
  gender: { ERKAK: 'Erkak', AYOL: 'Ayol' },
  rejection: { 'RAD JAVOBI OLMAGANMAN': 'Rad javobi olmagan', HA: 'Ha' },
};

/**
 * DB qatori + DRAFT qatoridan yagona yozuv yasaydi.
 * @param {Array} dbRow
 * @param {Object} idx — resolveDbColumns().idx
 * @param {Object|null} draft — { A: .., B: .., ... } yoki null
 * @returns {{ values: Object<string,string>, fromDraft: Set<string> }}
 */
function mergeStudent(dbRow, idx, draft) {
  const values = {}; const fromDraft = new Set();
  for (const [key, , , draftCol] of FIELDS) {
    const dbVal = clean(dbRow ? dbRow[idx[key]] : '');
    if (dbVal) { values[key] = dbVal; continue; }
    const dv = draft && draftCol ? clean(draft[draftCol]) : '';
    if (dv) {
      const map = DRAFT_HUMAN[key];
      values[key] = map && map[dv.toUpperCase()] ? map[dv.toUpperCase()] : dv;
      fromDraft.add(key);
    } else {
      values[key] = '';
    }
  }
  return { values, fromDraft };
}

module.exports = { FIELDS, DB_LAST_COL, resolveDbColumns, mergeStudent, norm, clean };
