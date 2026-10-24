// =====================================================================
// TALABA SHAXSIY HISOBOTI (PDF) — har 10 kunda + status o'zgarganda
//
// Manbalar:
//   DB          — status, universitetlar, tarif, filial, supervisor, chat_id
//   DRAFT       — talaba anketasi (viloyat, tug'ilgan sana, sertifikat,
//                 ota-ona, otkaz tarixi, yetishmayotgan hujjatlar)
//   DOCUMENT_LOG— 3x4 rasm (PHOTO) va ota-ona daromad hujjatlari
//   CONTACTS    — supervisor telefon raqami
//   PROFILE_LOG — kimga qachon yuborilgani (bot o'zi yaratadi)
//
// PDF serverda pdfkit bilan chiziladi (Chromium kerak emas — kichik
// serverga yuk bermaydi, bitta PDF ~100-300 ms).
// =====================================================================

const path = require('path');
const https = require('https');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { FIELDS: STUDENT_FIELDS, resolveDbColumns } = require('./studentData');

// ---------------------------------------------------------------------
// SOZLAMALAR
// ---------------------------------------------------------------------
const PROFILE_LOG_SHEET = 'PROFILE_LOG'; // A:ID B:OXIRGI_YUBORILGAN C:HASH D:STATUS E:SONI F:SABAB
const PERIOD_DAYS = 10;                  // muntazam yuborish oralig'i
const SEND_WINDOW = { from: 11, to: 20 }; // Toshkent vaqti, soat
const MAX_SENDS_PER_TICK = 20;            // 5 daqiqada ko'pi bilan (yukni yoyish)
const CALL_CENTER = '55-203-71-71';
const SOCIAL = '@bright_future_skorea';

const FONT_DIR = path.join(__dirname, 'fonts');
const LOGO_PATH = path.join(__dirname, 'bf_logo.png');

// DB ustunlari (0 dan boshlanadi). Sarlavha (1-qator) bo'yicha topilmasa
// shu indekslar ishlatiladi — webhook.js dagi DB_COL bilan bir xil.
const DB_DEFAULT = {
  PAYMENT: 1, STATUS: 3, SUPERVISOR: 4, ID: 5, FULL_NAME: 6,
  UNIVERSITY_1: 7, UNIVERSITY_2: 8, AGREEMENT: 9, CERT_STATUS: 10,
  CERTIFICATE: 11, SCORE: 12, BRANCH: 13, CHAT_ID: 43, UNIVERSITY_3: 56, DOC_STATUS: 2, MISSING: 41,
};
// Sarlavha nomi bo'yicha qidiriladigan ustunlar (bo'lsa — ishlatiladi)
const DB_HEADER_PATTERNS = {
  TARIF: [/TARIF/i, /^AGREEMENT$/i],
  PROGRAM: [/^PROGRAM/i, /DASTUR/i],
  ACCEPTED_UNI: [/QABUL.*UNIV/i, /ACCEPTED/i, /QABUL QILGAN/i],
};

// ---------------------------------------------------------------------
// RANGLAR (namunadan olingan)
// ---------------------------------------------------------------------
const C = {
  navy: '#0E1B3D', green: '#0F8A4B', yellow: '#F5C618', red: '#C62923',
  blue: '#1F4ED7', gray: '#8A877C', card: '#F5F4EF', line: '#DAD7CB',
  track: '#DDD7C9', label: '#6E6B63', text: '#1A1A1A', white: '#FFFFFF',
  greenSoft: '#E9F5EF', redSoft: '#FBEAE9', yellowSoft: '#FFF8DC',
  yellowDark: '#8A6A00', blueSoft: '#EAF0FD', orangeSoft: '#FFF3E6', orange: '#C2560A',
  pillGray: '#E7E5DD',
};

const THEMES = {
  green: { bg: C.green, fg: C.white, sub: '#D7F0E3' },
  yellow: { bg: C.yellow, fg: C.navy, sub: C.navy },
  navy: { bg: C.navy, fg: C.white, sub: '#C9D1E6' },
  blue: { bg: C.blue, fg: C.white, sub: '#DCE5FB' },
  red: { bg: C.red, fg: C.white, sub: '#F7D6D4' },
  gray: { bg: C.gray, fg: C.white, sub: '#EEEDE8' },
};

// ---------------------------------------------------------------------
// STATUS QOIDALARI — DB!STATUS qiymati -> sarlavha, rang, keyingi
// bosqich va jarayon chizig'i. Matnlarni shu yerda o'zgartiring.
// progress: done = nechta bosqich tugagan; current = joriy bosqich
// indeksi (0..4); failed = muvaffaqiyatsiz bosqich indeksi.
// ---------------------------------------------------------------------
const STEPS = ['Shartnoma', 'Hujjatlar', 'Topshirildi', 'Qabul', 'Viza'];

const STATUS_RULES = {
  'SHARTNOMA QILDI': { title: 'SHARTNOMA TUZILDI', theme: 'navy', icon: 'doc', next: 'Boshlang‘ich to‘lov', done: 1 },
  "TO'LOV QILMADI": { title: 'TO‘LOV KUTILMOQDA', theme: 'yellow', icon: 'clock', next: 'Boshlang‘ich to‘lov', done: 1 },
  "TO'LOV QILDI": { title: 'TO‘LOV QABUL QILINDI', theme: 'blue', icon: 'check', next: 'Hujjatlarni yuborish', done: 1, current: 1 },
  "HUJJAT YIG'ILMOQDA": { title: 'HUJJATLAR YIG‘ILMOQDA', theme: 'yellow', icon: 'clock', next: 'Hujjatlarni to‘liq yuborish', done: 1, current: 1 },
  "HUJJAT TO'LIQ": { title: 'HUJJATLAR QABUL QILINDI', theme: 'blue', icon: 'check', next: 'Hujjatlar tekshiruvi', done: 1, current: 1, currentLabel: 'Tekshiruvda' },
  'HUJJAT TAYYOR': { title: 'HUJJATLAR TAYYOR', theme: 'navy', icon: 'doc', next: 'Universitetga topshirish', done: 1, current: 1, currentLabel: 'Hujjatlar tayyor', uni: 'ready' },
  'UNIVERSITY 1 TOPSHIRILDI': { title: 'TOPSHIRILDI', theme: 'yellow', icon: 'clock', next: 'Qabul natijasi', done: 2, current: 2, uni: 'submitted1' },
  'UNIVERSITY 2 TOPSHIRILDI': { title: 'TOPSHIRILDI', theme: 'yellow', icon: 'clock', next: 'Qabul natijasi', done: 2, current: 2, uni: 'submitted2' },
  'QABUL QILINDI': { title: 'QABUL QILINDI', theme: 'green', icon: 'check', next: 'Kontrakt to‘lovi va viza', done: 4, uni: 'accepted' },
  'QABUL QILINMADI': { title: 'QABUL QILINMADI', theme: 'red', icon: 'cross', next: 'Yangi reja — supervisor bilan', done: 3, failed: 3, uni: 'none' },
  "KONTRAKT TO'LADI": { title: 'KONTRAKT TO‘LANDI', theme: 'green', icon: 'check', next: 'Viza hujjatlari (KDB)', done: 4, current: 4, currentLabel: 'Viza hujjatlari', uni: 'accepted' },
  "KDB QO'YDI": { title: 'KDB HISOBI OCHILDI', theme: 'blue', icon: 'check', next: 'COA olish', done: 4, current: 4, currentLabel: 'Viza hujjatlari', uni: 'accepted' },
  'COA OLDI': { title: 'COA OLINDI', theme: 'blue', icon: 'check', next: 'Elchixonaga topshirish', done: 4, current: 4, currentLabel: 'Viza hujjatlari', uni: 'accepted' },
  'ELCHIXONA': { title: 'VIZAGA TOPSHIRILDI', theme: 'yellow', icon: 'clock', next: 'Viza natijasi', done: 4, current: 4, currentLabel: 'Viza kutilmoqda', uni: 'accepted' },
  'VISAGA TOPSHIRILDI': { title: 'VIZAGA TOPSHIRILDI', theme: 'yellow', icon: 'clock', next: 'Viza natijasi', done: 4, current: 4, currentLabel: 'Viza kutilmoqda', uni: 'accepted' },
  'VIZA TASDIQLANDI': { title: 'VIZA TASDIQLANDI', theme: 'green', icon: 'check', next: 'Aviabilet va jo‘nash', done: 5, uni: 'accepted' },
  'VIZA RAD QILINDI': { title: 'VIZA RAD ETILDI', theme: 'red', icon: 'cross', next: 'Keyingi reja — supervisor bilan', done: 4, failed: 4, uni: 'accepted' },
  'SHARTNOMA BEKOR QILDI': { title: 'SHARTNOMA BEKOR QILINGAN', theme: 'gray', icon: 'cross', next: 'Savollar bo‘yicha filialga', done: 0, uni: 'none' },
  'MUZLATDI': { title: 'JARAYON TO‘XTATILGAN', theme: 'gray', icon: 'pause', next: 'Qayta boshlash — filialga', done: 1, uni: 'none' },
};
const DEFAULT_RULE = { title: 'MA’LUMOTLAR QABUL QILINDI', theme: 'navy', icon: 'doc', next: 'Supervisor bog‘lanadi', done: 1 };

// ---------------------------------------------------------------------
// LUG'ATLAR
// ---------------------------------------------------------------------
const PROGRAM_LABEL = { BAKALAVR: 'Bakalavr', KOLLEJ: 'Kollej', MAGISTRATURA: 'Magistratura', TIL_KURSI: 'Til kursi' };
const GOAL_LABEL = { OQISH: 'Faqat o‘qish', ISHLASH: 'Ishlash', OQIB_ISHLASH: 'O‘qib-ishlash', ISHLAB_OQISH: 'Ishlab o‘qish' };
const CITY_LABEL = {
  SEOUL: 'Seul', INCHEON: 'Incheon', CHEONAN: 'Cheonan', DAEGU: 'Tegu', DAEJON: 'Tejon',
  BUSAN: 'Pusan', GWANGJU_METRO: 'Gvanju', GWANGJU_CITY: 'Gvanju (kichik)', OTHER: '',
};
const PARENT_STATUS = { DEAD: 'Vafot etgan', DIVORCED: 'Ajrashgan' };

// Universitet nomi -> koreyscha nomi. Kalit — kichik harfli kalit so'z.
// Ro'yxatda bo'lmasa faqat inglizcha nom chiqadi (xato emas).
const UNI_KR = [
  ['seoul national', '서울대학교'], ['yonsei', '연세대학교'], ['korea university', '고려대학교'],
  ['sungkyunkwan', '성균관대학교'], ['kyung hee', '경희대학교'], ['kyunghee', '경희대학교'],
  ['hanyang', '한양대학교'], ['chung-ang', '중앙대학교'], ['chung ang', '중앙대학교'],
  ['konkuk', '건국대학교'], ['dongguk', '동국대학교'], ['sejong', '세종대학교'], ['kookmin', '국민대학교'],
  ['sogang', '서강대학교'], ['ewha', '이화여자대학교'], ['hankuk university of foreign', '한국외국어대학교'],
  ['inha', '인하대학교'], ['ajou', '아주대학교'], ['kyungpook', '경북대학교'], ['pusan national', '부산대학교'],
  ['chonnam', '전남대학교'], ['chungnam', '충남대학교'], ['chungbuk', '충북대학교'], ['keimyung', '계명대학교'],
  ['yeungnam', '영남대학교'], ['dong-a', '동아대학교'], ['woosong', '우송대학교'], ['sun moon', '선문대학교'],
  ['sunmoon', '선문대학교'], ['hoseo', '호서대학교'], ['dankook', '단국대학교'], ['gachon', '가천대학교'],
  ['kangwon', '강원대학교'], ['jeonbuk', '전북대학교'], ['soongsil', '숭실대학교'], ['sangmyung', '상명대학교'],
  ['hansung', '한성대학교'], ['kyonggi', '경기대학교'], ['seoyeong', '서영대학교'], ['joongbu', '중부대학교'],
  ['yewon', '예원예술대학교'], ['wonkwang', '원광대학교'], ['chosun', '조선대학교'], ['hannam', '한남대학교'],
  ['paichai', '배재대학교'], ['pai chai', '배재대학교'], ['silla', '신라대학교'], ['tongmyong', '동명대학교'],
  ['inje', '인제대학교'], ['semyung', '세명대학교'], ['daegu catholic', '대구가톨릭대학교'],
];

// ---------------------------------------------------------------------
// YORDAMCHI FUNKSIYALAR
// ---------------------------------------------------------------------
const s = (v) => String(v == null ? '' : v).replace(/[ ​﻿]/g, ' ').trim();
const up = (v) => s(v).toUpperCase();
function titleCase(v) {
  return s(v).toLowerCase().replace(/(^|[\s\-(,])([a-zà-ÿʻʼ‘’'а-яё])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/[‘’'`ʻʼ]([A-Z])/g, (m, c) => '‘' + c.toLowerCase())
    .replace(/\bO‘/g, 'O‘').replace(/\bG‘/g, 'G‘');
}
/** Hammasi KATTA harf bo'lsa — faqat birinchi harf katta; aks holda o'zgarishsiz. */
function niceCase(v) {
  const t = uzQuote(v);
  if (!t) return '';
  if (/[a-zа-яё]/.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  const low = t.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}
function uzQuote(v) { return s(v).replace(/([OoGg])['`ʻ’]/g, '$1‘'); }

function colIndexToLetter(idx) {
  let letter = '';
  let i = idx + 1;
  while (i > 0) { const r = (i - 1) % 26; letter = String.fromCharCode(65 + r) + letter; i = Math.floor((i - 1) / 26); }
  return letter;
}

function findDbColumns(headerRow) {
  const cols = { ...DB_DEFAULT, TARIF: null, PROGRAM: null, ACCEPTED_UNI: null };
  const found = {};
  const headers = (headerRow || []).map((h) => s(h));
  for (const [key, patterns] of Object.entries(DB_HEADER_PATTERNS)) {
    for (const re of patterns) {
      const idx = headers.findIndex((h) => re.test(h));
      if (idx !== -1) { cols[key] = idx; found[key] = `${colIndexToLetter(idx)} (${headers[idx]})`; break; }
    }
  }
  if (cols.TARIF === null) cols.TARIF = DB_DEFAULT.AGREEMENT;
  return { cols, found };
}

function ageFromDob(dob, today) {
  const m = s(dob).match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d)) age--;
  return age > 10 && age < 80 ? age : null;
}

function yearOf(v) { const m = s(v).match(/(19|20)\d{2}/); return m ? m[0] : ''; }

function displayName(full) {
  const parts = s(full).split(/\s+/).filter(Boolean)
    .filter((w) => !['UGLI', 'QIZI', 'KIZI', 'O‘G‘LI', "O'G'LI"].includes(w.toUpperCase()));
  if (parts.length === 0) return '';
  // Bazada: FAMILYA ISM OTASINING_ISMI -> "Ism Familya"
  if (parts.length >= 2) return titleCase(`${parts[1]} ${parts[0]}`);
  return titleCase(parts[0]);
}
function initialsOf(name) {
  const p = s(name).split(/\s+/).filter(Boolean);
  return ((p[0] || '').charAt(0) + (p[1] || '').charAt(0)).toUpperCase() || 'BF';
}

function universityKr(name) {
  const n = s(name);
  if (/[가-힣]/.test(n)) return '';
  const low = n.toLowerCase();
  const hit = UNI_KR.find(([k]) => low.includes(k));
  return hit ? hit[1] : '';
}
function universityTitle(name) {
  const n = s(name);
  if (!n) return '';
  if (/[a-z]/.test(n)) return n; // allaqachon to'g'ri yozilgan
  return titleCase(n).replace(/\bUniversity\b/i, 'University');
}

function regionText(draft) {
  const addr = s(draft.W);
  if (addr) {
    const parts = addr.split(',').map((p) => p.trim()).filter(Boolean);
    const clean = (p) => titleCase(p.replace(/\s+(tumani|tuman|t\.|shahri|sh\.|viloyati|vil\.)$/i, ''));
    if (parts.length >= 2) return `${clean(parts[0])}, ${clean(parts[1])}`;
    if (parts.length === 1) return clean(parts[0]);
  }
  return titleCase(draft.AD || '');
}

function certificateText(dbRow, cols, draft) {
  const dbCert = up(dbRow[cols.CERTIFICATE]);
  const dbScore = s(dbRow[cols.SCORE]);
  const dbStatus = up(dbRow[cols.CERT_STATUS]);
  const type = dbCert || up(draft.N);
  const score = dbScore || s(draft.O);
  const status = dbStatus || up(draft.M);
  if (/TAKER/.test(status) || (status === 'NO' && type)) {
    return { text: `${type || 'Imtihon'} — topshiradi`, tone: 'normal', has: false, taker: true };
  }
  if (type && type !== 'NO' && type !== "YO'Q") {
    let sc = score;
    if (type === 'IELTS' && /^\d(\.\d)?$/.test(sc) && !sc.includes('.')) sc = `${sc}.0`;
    return { text: `${type}${sc ? ' ' + sc : ''}`, tone: 'blue', has: true };
  }
  return { text: 'Yo‘q', tone: 'normal', has: false };
}

function rejectionInfo(draft) {
  const v = s(draft.AI);
  if (!v) return { state: 'unknown', text: 'Ma’lumot kiritilmagan.' };
  if (/OLMAGAN/i.test(v) || /^(YO'?Q|YOQ|NO)$/i.test(v)) {
    return { state: 'no', text: 'Hech qachon Koreya vizasidan rad javobi olmagan.' };
  }
  let detail = '';
  if (!/^HA$/i.test(v)) {
    detail = /^\d+$/.test(v) ? `${v}-band` : v;
  }
  return { state: 'yes', text: `Avval Koreya vizasidan rad javobi olgan${detail ? ` (${detail})` : ''}.` };
}

function parentJob(v) {
  const u = up(v);
  if (PARENT_STATUS[u]) return PARENT_STATUS[u];
  return niceCase(v) || '—';
}

function incomeRows(docCodes, missing, extra = {}) {
  const has = (c) => docCodes.has(c);
  const rows = [];
  // DB'da qo'lda kiritilgan qiymatlar — eng ishonchli manba
  if (s(extra.income) || s(extra.houseDate) || s(extra.carDate)) {
    if (s(extra.income)) rows.push(['Yillik daromad', niceCase(extra.income), 'normal']);
    const assets = [];
    if (s(extra.houseDate)) assets.push(`Uy (${s(extra.houseDate)})`);
    if (s(extra.carDate)) assets.push(`Mashina (${s(extra.carDate)})`);
    if (assets.length) rows.push(['Mulk', assets.join(' + '), 'normal']);
    return rows;
  }
  if (has('NO_ASSETS')) {
    rows.push(['Daromad / mulk', 'Mavjud emas', 'normal']);
    return rows;
  }
  const income = [];
  if (has('FATHER_INCOME')) income.push('ota');
  if (has('MOTHER_INCOME')) income.push('ona');
  const assets = [];
  if (has('HOUSE_KADASTR')) assets.push('Uy');
  if (has('CAR_TECH')) assets.push('mashina');
  if (has('OTHER_ASSETS')) assets.push('boshqa');
  if (income.length) rows.push(['Daromad hujjati', `Topshirilgan (${income.join(', ')})`, 'green']);
  if (assets.length) rows.push(['Mulk hujjati', assets.join(' + '), 'normal']);
  if (!income.length && !assets.length) {
    const pending = missing.includes('PARENT_INCOME');
    rows.push(['Daromad hujjati', pending ? 'Kutilmoqda' : 'Topshirilmagan', pending ? 'orange' : 'normal']);
  }
  return rows;
}

// ---------------------------------------------------------------------
// MA'LUMOTNI YIG'ISH — sof funksiya (Sheets/Telegram'ga murojaat yo'q)
// ---------------------------------------------------------------------
/**
 * @param {Object} src
 *   dbRow: Array, cols: findDbColumns().cols, draft: {A..AW} yoki {},
 *   docCodes: Set(DOCUMENT_LOG kodlari), missingDocs: [{code,label,optional}],
 *   supervisor: {name, phone}, today: Date
 */
function buildReportData(src) {
  const { dbRow = [], cols, draft = {}, docCodes = new Set(), missingDocs = [], supervisor = {}, today = new Date(), extra = {} } = src;
  const contractId = up(dbRow[cols.ID] || draft.H);
  const status = up(dbRow[cols.STATUS]);
  const rule = STATUS_RULES[status] || DEFAULT_RULE;

  const programRaw = up((cols.PROGRAM !== null && dbRow[cols.PROGRAM]) || draft.C);
  const program = PROGRAM_LABEL[programRaw] || titleCase(programRaw) || '';
  const isMaster = programRaw === 'MAGISTRATURA';
  const fullName = s(dbRow[cols.FULL_NAME] || draft.I);
  const name = displayName(fullName) || contractId;
  const branch = titleCase(dbRow[cols.BRANCH] || '');
  const tarif = niceCase(dbRow[cols.TARIF] || '');
  const cert = certificateText(dbRow, cols, draft);
  const age = ageFromDob(draft.S, today);

  // --- 1. Talaba haqida
  const about = [];
  const region = regionText(draft);
  if (region) about.push(['Viloyat', region]);
  if (age) about.push(['Yoshi', `${age} yosh`]);
  const gradYear = yearOf(draft.AB);
  if (isMaster) {
    if (s(draft.Z)) about.push(['Diplom', `${uzQuote(draft.Z)}${gradYear ? ` (${gradYear})` : ''}`]);
    if (s(draft.AA)) about.push(['Yo‘nalish', niceCase(draft.AA)]);
  } else if (s(draft.AC)) {
    const gpa = up(draft.AC) === 'EXPECTED' ? 'Kutilmoqda' : `${s(draft.AC).replace(',', '.')} / 5`;
    about.push(['Attestat bali', `${gpa}${gradYear ? ` (${gradYear}-yil)` : ''}`]);
  }
  about.push(['Sertifikat', cert.text, cert.tone === 'blue' ? 'blue' : 'normal']);
  const goal = GOAL_LABEL[up(draft.AP)] || niceCase(draft.AP);
  const cityRaw = up(draft.AQ);
  const city = CITY_LABEL[cityRaw] !== undefined ? CITY_LABEL[cityRaw] : titleCase(draft.AQ);
  if (goal || city) about.push(['Maqsadi', [goal, city].filter(Boolean).join(' · ')]);

  // --- 2. Shartnoma (+ supervisor kontakti)
  const contract = [];
  if (tarif) contract.push(['Tarif', tarif]);
  if (program) contract.push(['Dastur', program]);
  if (branch) contract.push(['Filial', branch]);
  if (supervisor.name) contract.push(['Supervisor', titleCase(supervisor.name)]);
  if (supervisor.phone) contract.push(['Telefon', supervisor.phone, 'blue']);

  // --- 3. Otkaz
  const rejection = rejectionInfo(draft);

  // --- 4. Ota-ona
  const parents = [];
  const fatherJob = parentJob(draft.AL || (PARENT_STATUS[up(draft.AJ)] ? draft.AJ : ''));
  const motherJob = parentJob(draft.AO || (PARENT_STATUS[up(draft.AM)] ? draft.AM : ''));
  parents.push(['Ota', fatherJob]);
  parents.push(['Ona', motherJob]);
  const missingCodes = missingDocs.map((m) => m.code);
  for (const r of incomeRows(docCodes, missingCodes, extra)) parents.push(r);

  // --- 5. Universitetlar
  const uniNames = [dbRow[cols.UNIVERSITY_1], dbRow[cols.UNIVERSITY_2], dbRow[cols.UNIVERSITY_3]].map(s).filter(Boolean);
  let acceptedIdx = 0;
  if (cols.ACCEPTED_UNI !== null && s(dbRow[cols.ACCEPTED_UNI])) {
    const acc = s(dbRow[cols.ACCEPTED_UNI]).toLowerCase();
    const i = uniNames.findIndex((u) => acc.includes(u.toLowerCase()) || u.toLowerCase().includes(acc));
    if (i !== -1) acceptedIdx = i;
  }
  const universities = uniNames.map((n, i) => {
    let pill = null; let style = 'plain'; let choice = `${i + 1}-tanlov${program ? ` · ${program}` : ''}`;
    switch (rule.uni) {
      case 'ready':
        pill = i === 0 ? { text: 'TOPSHIRISHGA TAYYOR', theme: 'navy' } : { text: 'NAVBATDA', theme: 'gray' };
        break;
      case 'submitted1':
        if (i === 0) { pill = { text: 'TOPSHIRILDI', theme: 'yellow' }; style = 'yellow'; } else pill = { text: 'NAVBATDA', theme: 'gray' };
        break;
      case 'submitted2':
        pill = { text: 'TOPSHIRILDI', theme: 'yellow' }; style = 'yellow';
        break;
      case 'accepted':
        if (i === acceptedIdx) { pill = { text: 'QABUL QILINDI', theme: 'green' }; style = 'green'; } else { pill = { text: 'ZAXIRA', theme: 'gray' }; choice = `${i + 1}-tanlov · zaxira varianti`; }
        break;
      case 'none':
        pill = null;
        break;
      default:
        pill = { text: 'TANLANGAN', theme: 'gray' };
    }
    return { name: universityTitle(n), kr: universityKr(n), choice, pill, style };
  });
  const submittedStage = ['submitted1', 'submitted2', 'accepted'].includes(rule.uni) || status === 'QABUL QILINMADI';
  const uniTitle = universities.length > 1
    ? (submittedStage ? 'Qaysi universitetlarga topshirildi' : 'Qaysi universitetlarga topshiriladi')
    : (submittedStage ? 'Qaysi universitetga topshirildi' : 'Qaysi universitetga topshiriladi');

  // --- Banner kichik qatori
  let bannerSub;
  const uniJoined = universities.map((u) => u.name.replace(/\s+University$/i, '')).join(' va ');
  if (rule.uni === 'accepted' && universities[acceptedIdx]) {
    const u = universities[acceptedIdx];
    bannerSub = `${u.name}${u.kr ? ` (${u.kr})` : ''}${program ? ` · ${program} dasturi` : ''}`;
  } else if ((rule.uni === 'submitted1' || rule.uni === 'submitted2') && universities.length) {
    const list = rule.uni === 'submitted1' ? universities[0].name : uniJoined;
    bannerSub = `${list} ${rule.uni === 'submitted2' && universities.length > 1 ? 'universitetlariga' : 'universitetiga'}${program ? ` · ${program}` : ''}`;
  } else if (rule.uni === 'ready' && universities.length) {
    bannerSub = `Hali topshirilmagan · ${universities[0].name}${program ? ` · ${program}` : ''}`;
  } else {
    bannerSub = [program && `${program} dasturi`, branch && `${branch} filiali`].filter(Boolean).join(' · ');
  }

  // --- Jarayon chizig'i
  const progress = STEPS.map((label, i) => {
    let state = 'todo';
    if (i < rule.done) state = 'done';
    if (rule.current === i) state = 'current';
    if (rule.failed === i) state = 'failed';
    const lbl = rule.current === i && rule.currentLabel ? rule.currentLabel : label;
    return { label: lbl, state };
  });

  // --- E-viza eslatmasi
  const eviza = /E-?\s?VIZA/i.test(tarif)
    ? 'Viza Koreyaning o‘zidan olinadi — sertifikat va ota-onaning yillik daromadi talab qilinmaydi.'
    : '';

  // --- Yetishmayotgan hujjatlar (faqat hujjat bosqichlarida)
  const docStage = !['QABUL QILINMADI', 'SHARTNOMA BEKOR QILDI', 'MUZLATDI', 'VIZA TASDIQLANDI', 'VIZA RAD QILINDI'].includes(status);
  const missing = docStage ? missingDocs : [];

  // --- Xulosa (shablon)
  const summary = buildSummary({ status, rule, universities, acceptedIdx, program, cert, missing });

  const subtitleParts = [`Shartnoma № ${contractId}`];
  if (program) subtitleParts.push(`${program} dasturi`);
  if (branch) subtitleParts.push(`${branch} filiali`);

  return {
    contractId, status, name, initials: initialsOf(name), subtitle: subtitleParts.join(' · '),
    banner: { title: rule.title, sub: bannerSub, theme: rule.theme, icon: rule.icon, next: rule.next },
    about, contract, rejection, parents, universities, uniTitle, eviza, progress,
    progressTheme: rule.theme, missing, summary,
    dateText: formatDate(today),
  };
}

function buildSummary({ status, universities, acceptedIdx, program, cert, missing }) {
  const prog = program ? program.toLowerCase() : '';
  const certPhrase = cert.has ? `${cert.text} sertifikati bilan ` : '';
  const shortName = (n) => n.replace(/\s+University$/i, '');
  const uniList = universities.map((u) => shortName(u.name)).join(' va ');
  const miss = missing.filter((m) => !m.optional).length;
  const missSentence = miss > 0
    ? ` Hozircha ${miss} ta hujjat yetishmayapti — ularni botdagi «Hujjatlarim» tugmasi orqali yuboring.`
    : '';
  switch (status) {
    case 'QABUL QILINDI': {
      const u = universities[acceptedIdx];
      return `Tabriklaymiz! ${certPhrase}${u ? u.name : 'universitet'}${prog ? ` ${prog} dasturiga` : 'ga'} qabul qilindingiz. Keyingi qadam — kontrakt to‘lovi va viza hujjatlarini tayyorlash.`;
    }
    case 'UNIVERSITY 1 TOPSHIRILDI':
    case 'UNIVERSITY 2 TOPSHIRILDI':
      return `${certPhrase ? certPhrase.charAt(0).toUpperCase() + certPhrase.slice(1) : ''}${certPhrase ? 'h' : 'H'}ujjatlaringiz ${uniList || 'universitet'}${universities.length > 1 && status === 'UNIVERSITY 2 TOPSHIRILDI' ? ' universitetlariga' : ' universitetiga'} topshirildi. Natija e’lon qilinishi bilan sizga darhol xabar beramiz.`;
    case 'HUJJAT TAYYOR':
      return `Hujjatlaringiz ${universities[0] ? `${universities[0].name}ga` : 'universitetga'} topshirish uchun tayyorlandi. Keyingi qadam — universitetga topshirish.`;
    case "HUJJAT TO'LIQ":
      return 'Barcha hujjatlaringiz qabul qilindi va mutaxassislarimiz tomonidan tekshirilmoqda. Kamchilik bo‘lsa, supervisoringiz siz bilan bog‘lanadi.';
    case "HUJJAT YIG'ILMOQDA":
    case "TO'LOV QILDI":
      return `Universitetga topshirish uchun hujjatlaringiz yig‘ilmoqda.${missSentence || ' Hujjatlaringiz tekshirilmoqda.'}`;
    case "TO'LOV QILMADI":
    case 'SHARTNOMA QILDI':
      return 'Hujjatlarni tayyorlash boshlang‘ich to‘lovdan keyin boshlanadi. Savollaringiz bo‘lsa, supervisoringizga murojaat qiling.';
    case "KONTRAKT TO'LADI":
    case "KDB QO'YDI":
    case 'COA OLDI':
      return `Universitet bosqichi yakunlandi, hozir viza hujjatlari tayyorlanmoqda.${missSentence}`;
    case 'ELCHIXONA':
    case 'VISAGA TOPSHIRILDI':
      return 'Hujjatlaringiz elchixonaga topshirildi. Ko‘rib chiqish odatda 2 haftadan 1 oygacha davom etadi — natija chiqishi bilan xabar beramiz.';
    case 'VIZA TASDIQLANDI':
      return 'Tabriklaymiz! Vizangiz tasdiqlandi. Keyingi qadam — aviabilet va jo‘nashga tayyorgarlik. Supervisoringiz batafsil ma’lumot beradi.';
    case 'QABUL QILINMADI':
      return 'Bu safar qabul natijasi ijobiy bo‘lmadi. Supervisoringiz siz bilan bog‘lanib, boshqa universitet yoki keyingi semestr variantlarini muhokama qiladi.';
    case 'VIZA RAD QILINDI':
      return 'Afsuski, bu safar viza rad etildi. Supervisoringiz siz bilan bog‘lanib, keyingi qadamlarni birga rejalashtiradi.';
    case 'SHARTNOMA BEKOR QILDI':
      return 'Shartnomangiz bekor qilingan. Savollaringiz bo‘lsa, filialingizga yoki call-markazga murojaat qiling.';
    case 'MUZLATDI':
      return 'Jarayoningiz vaqtincha to‘xtatilgan. Qayta boshlash uchun supervisoringiz yoki filialingizga murojaat qiling.';
    default:
      return `Ma’lumotlaringiz qabul qilindi.${missSentence || ' Supervisoringiz keyingi qadamlar bo‘yicha siz bilan bog‘lanadi.'}`;
  }
}

function formatDate(d) {
  const t = new Date(d.getTime() + 5 * 3600000);
  const dd = String(t.getUTCDate()).padStart(2, '0');
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${t.getUTCFullYear()}`;
}

/** Hisobot mazmunining "barmoq izi" — o'zgarish bo'lganini aniqlash uchun (sana kirmaydi). */
function reportHash(report) {
  const { dateText, ...rest } = report;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------
// PDF CHIZISH
// ---------------------------------------------------------------------
const PAGE = { w: 595.28, h: 841.89, m: 30 };

function registerFonts(doc) {
  doc.registerFont('R', path.join(FONT_DIR, 'Pretendard-Regular.ttf'));
  doc.registerFont('M', path.join(FONT_DIR, 'Pretendard-Medium.ttf'));
  doc.registerFont('SB', path.join(FONT_DIR, 'Pretendard-SemiBold.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'Pretendard-Bold.ttf'));
  doc.registerFont('XB', path.join(FONT_DIR, 'Pretendard-ExtraBold.ttf'));
}

function fitText(doc, text, font, size, maxW, minSize = 6) {
  let sz = size;
  doc.font(font);
  while (sz > minSize && doc.fontSize(sz).widthOfString(text) > maxW) sz -= 0.5;
  return sz;
}

function drawIcon(doc, kind, cx, cy, r, color) {
  doc.save().lineWidth(1.6).strokeColor(color).fillColor(color);
  if (kind === 'check') {
    doc.moveTo(cx - r * 0.45, cy + r * 0.02).lineTo(cx - r * 0.1, cy + r * 0.38).lineTo(cx + r * 0.5, cy - r * 0.35).stroke();
  } else if (kind === 'clock') {
    doc.circle(cx, cy, r * 0.55).stroke();
    doc.moveTo(cx, cy - r * 0.32).lineTo(cx, cy).lineTo(cx + r * 0.25, cy + r * 0.15).stroke();
  } else if (kind === 'cross') {
    doc.moveTo(cx - r * 0.35, cy - r * 0.35).lineTo(cx + r * 0.35, cy + r * 0.35).stroke();
    doc.moveTo(cx + r * 0.35, cy - r * 0.35).lineTo(cx - r * 0.35, cy + r * 0.35).stroke();
  } else if (kind === 'pause') {
    doc.rect(cx - r * 0.3, cy - r * 0.35, r * 0.18, r * 0.7).fill();
    doc.rect(cx + r * 0.12, cy - r * 0.35, r * 0.18, r * 0.7).fill();
  } else { // doc
    doc.roundedRect(cx - r * 0.33, cy - r * 0.45, r * 0.66, r * 0.9, 1.5).stroke();
    doc.moveTo(cx - r * 0.18, cy - r * 0.12).lineTo(cx + r * 0.18, cy - r * 0.12).stroke();
    doc.moveTo(cx - r * 0.18, cy + r * 0.12).lineTo(cx + r * 0.18, cy + r * 0.12).stroke();
  }
  doc.restore();
}

function pill(doc, text, x, y, theme, align = 'left') {
  const t = {
    green: [C.green, C.white], yellow: [C.yellow, C.navy], navy: [C.navy, C.white], red: [C.red, C.white],
    gray: [C.pillGray, '#5E5B52'], blue: [C.blue, C.white], greenSoft: [C.greenSoft, C.green],
  }[theme] || [C.pillGray, C.navy];
  doc.font('XB').fontSize(7.5);
  const w = doc.widthOfString(text) + 16;
  const h = 17;
  const px = align === 'right' ? x - w : x;
  doc.roundedRect(px, y, w, h, 4).fill(t[0]);
  doc.fillColor(t[1]).text(text, px, y + 4.6, { width: w, align: 'center', lineBreak: false });
  return { w, h };
}

function card(doc, x, y, w, h, fill = C.card) {
  doc.roundedRect(x, y, w, h, 9).fill(fill);
}

function sectionTitle(doc, text, x, y) {
  doc.font('XB').fontSize(9).fillColor(C.navy).text(text, x, y, { lineBreak: false });
}

function kvRows(doc, rows, x, y, w, rowH = 19.5) {
  rows.forEach(([k, v, tone], i) => {
    const ry = y + i * rowH;
    doc.font('R').fontSize(8.2).fillColor(C.label).text(k, x, ry + 5, { lineBreak: false });
    const color = tone === 'blue' ? C.blue : tone === 'green' ? C.green : tone === 'red' ? C.red : tone === 'orange' ? C.orange : C.text;
    const font = tone && tone !== 'normal' ? 'B' : 'SB';
    const maxW = w - doc.font('R').fontSize(8.2).widthOfString(k) - 12;
    const sz = fitText(doc, s(v), font, 8.6, maxW, 6.5);
    doc.font(font).fontSize(sz).fillColor(color).text(s(v), x, ry + 5 + (8.6 - sz) / 2, { width: w, align: 'right', lineBreak: false });
    if (i < rows.length - 1) {
      doc.moveTo(x, ry + rowH - 0.5).lineTo(x + w, ry + rowH - 0.5).lineWidth(0.5).strokeColor(C.line).stroke();
    }
  });
  return rows.length * rowH;
}

/**
 * @param {Object} r — buildReportData() natijasi
 * @param {Buffer|null} photo — 3x4 rasm (JPEG/PNG)
 * @returns {Promise<Buffer>}
 */
function renderReportPdf(r, photo) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Shaxsiy hisobot — ${r.contractId}`, Author: 'Bright Future Consulting' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      registerFonts(doc);
      const level = chooseLevel(r, photo);
      draw(doc, r, photo, LEVELS[level]);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function isImage(buf) {
  if (!buf || buf.length < 4) return false;
  return (buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47);
}

// Sahifaga sig'maslik xavfi bo'lsa (ko'p hujjat yetishmasa va h.k.) —
// avval o'lchab ko'riladi, keyin ixchamroq joylashuv tanlanadi.
const LEVELS = [
  { rowH: 19.5, gap: 10, sectionGap: 14, uniH: 40, uniGap: 7, photoW: 54, photoH: 72, nameSize: 24, bannerH: 52, missCols: 2, lineH: 12.5, sumSize: 9.6 },
  { rowH: 17.5, gap: 8, sectionGap: 11, uniH: 35, uniGap: 6, photoW: 48, photoH: 64, nameSize: 22, bannerH: 48, missCols: 2, lineH: 11.5, sumSize: 9.2 },
  { rowH: 16, gap: 7, sectionGap: 9, uniH: 32, uniGap: 5, photoW: 42, photoH: 56, nameSize: 20, bannerH: 44, missCols: 3, lineH: 11, sumSize: 8.8 },
];
const FOOTER_Y = PAGE.h - 34;

function chooseLevel(r, photo) {
  for (let i = 0; i < LEVELS.length; i++) {
    const probe = new PDFDocument({ size: 'A4', margin: 0 });
    registerFonts(probe);
    probe.on('data', () => {});
    const bottom = draw(probe, r, photo, LEVELS[i]);
    probe.end();
    if (bottom <= FOOTER_Y - 10) return i;
  }
  return LEVELS.length - 1;
}

function draw(doc, r, photo, L = LEVELS[0]) {
  const M = PAGE.m;
  const W = PAGE.w - 2 * M;
  let y = 26;

  // ---- Sarlavha
  try { doc.image(LOGO_PATH, M, y + 1, { height: 15 }); } catch (e) { /* logo yo'q bo'lsa ham davom */ }
  doc.font('XB').fontSize(9).fillColor(C.navy).text('BRIGHT FUTURE', M + 37, y, { characterSpacing: 0.8, lineBreak: false });
  doc.font('R').fontSize(7.5).fillColor(C.label).text(`Shaxsiy hisobot · ${r.dateText}`, M + 37, y + 11.5, { lineBreak: false });
  const idSize = fitText(doc, `№ ${r.contractId}`, 'XB', 13, 200);
  doc.font('XB').fontSize(idSize).fillColor(C.navy).text(`№ ${r.contractId}`, M, y + 4, { width: W, align: 'right', lineBreak: false });
  y += 30;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.2).strokeColor(C.navy).stroke();
  y += 12;

  // ---- Status banner
  const th = THEMES[r.banner.theme] || THEMES.navy;
  const bh = L.bannerH;
  doc.roundedRect(M, y, W, bh, 10).fill(th.bg);
  doc.circle(M + 27, y + bh / 2, 13.5).fillOpacity(0.18).fill(th.fg).fillOpacity(1);
  drawIcon(doc, r.banner.icon, M + 27, y + bh / 2, 13, th.fg);
  const titleMaxW = W - 54 - 135;
  const tsz = fitText(doc, r.banner.title, 'XB', 18, titleMaxW, 11);
  doc.font('XB').fontSize(tsz).fillColor(th.fg).text(r.banner.title, M + 50, y + 9 + (18 - tsz) / 2, { lineBreak: false });
  const subSz = fitText(doc, r.banner.sub || '', 'M', 8.5, titleMaxW, 6.5);
  doc.font('M').fontSize(subSz).fillColor(th.fg).text(r.banner.sub || '', M + 50, y + 32, { lineBreak: false });
  doc.font('SB').fontSize(7.5).fillColor(th.fg).text('Keyingi bosqich:', M + W - 140, y + 15, { width: 128, align: 'right', lineBreak: false });
  const nextSz = fitText(doc, r.banner.next, 'B', 8.5, 128, 6.5);
  doc.font('B').fontSize(nextSz).fillColor(th.fg).text(r.banner.next, M + W - 140, y + 27, { width: 128, align: 'right', lineBreak: false });
  y += bh + L.gap;

  // ---- Ism + 3x4 rasm (o'ng burchakda)
  const hasPhoto = isImage(photo);
  const photoW = L.photoW; const photoH = L.photoH;
  const nameX = hasPhoto ? M : M + 50;
  const nameRowH = hasPhoto ? photoH : 46;
  if (hasPhoto) {
    const px = M + W - photoW;
    doc.save();
    doc.roundedRect(px, y, photoW, photoH, 6).clip();
    try { doc.image(photo, px, y, { cover: [photoW, photoH], align: 'center', valign: 'center' }); } catch (e) { doc.rect(px, y, photoW, photoH).fill(C.card); }
    doc.restore();
    doc.roundedRect(px, y, photoW, photoH, 6).lineWidth(1).strokeColor(C.line).stroke();
  } else {
    doc.circle(M + 21, y + 21, 21).fill(C.navy);
    const isz = fitText(doc, r.initials, 'XB', 13, 34);
    doc.font('XB').fontSize(isz).fillColor(C.white).text(r.initials, M, y + 21 - isz * 0.62, { width: 42, align: 'center', lineBreak: false });
  }
  const nameMaxW = W - (hasPhoto ? photoW + 14 : 50);
  const nsz = fitText(doc, r.name, 'XB', L.nameSize, nameMaxW, 14);
  const nameY = hasPhoto ? y + photoH / 2 - 22 : y + 1;
  doc.font('XB').fontSize(nsz).fillColor(C.navy).text(r.name, nameX, nameY, { lineBreak: false });
  const ssz = fitText(doc, r.subtitle, 'R', 9, nameMaxW, 7);
  doc.font('R').fontSize(ssz).fillColor(C.label).text(r.subtitle, nameX, nameY + nsz + 5, { lineBreak: false });
  y += nameRowH + L.gap + 2;

  // ---- 4 ta karta (2 ustun)
  const gap = 12;
  const colW = (W - gap) / 2;
  const pad = 12;
  const rowH = L.rowH;
  const head = 24;
  const leftX = M; const rightX = M + colW + gap;

  // Chap: 1 · Talaba haqida, 2 · Shartnoma
  let ly = y;
  const c1h = head + r.about.length * rowH + 8;
  card(doc, leftX, ly, colW, c1h);
  sectionTitle(doc, '1 · Talaba haqida', leftX + pad, ly + 11);
  kvRows(doc, r.about, leftX + pad, ly + head + 2, colW - 2 * pad, rowH);
  ly += c1h + L.gap;
  const c2rows = r.contract.length ? r.contract : [['Shartnoma', '—']];
  const c2h = head + c2rows.length * rowH + 8;
  card(doc, leftX, ly, colW, c2h);
  sectionTitle(doc, '2 · Shartnoma', leftX + pad, ly + 11);
  kvRows(doc, c2rows, leftX + pad, ly + head + 2, colW - 2 * pad, rowH);
  ly += c2h;

  // O'ng: 3 · Otkaz, 4 · Ota-ona
  let ry = y;
  const rej = r.rejection;
  doc.font('R').fontSize(8.6);
  const rejTextH = doc.heightOfString(rej.text, { width: colW - 2 * pad, lineGap: 1.5 });
  const c3h = head + 22 + rejTextH + 12;
  card(doc, rightX, ry, colW, c3h);
  sectionTitle(doc, '3 · Otkaz (rad javobi) tarixi', rightX + pad, ry + 11);
  const pt = rej.state === 'yes' ? ['BOR', 'red'] : rej.state === 'no' ? ['YO‘Q', 'green'] : ['NOMA’LUM', 'gray'];
  pill(doc, pt[0], rightX + pad, ry + head + 2, pt[1]);
  doc.font('R').fontSize(8.6).fillColor(C.text).text(rej.text, rightX + pad, ry + head + 25, { width: colW - 2 * pad, lineGap: 1.5 });
  ry += c3h + L.gap;
  const c4h = head + r.parents.length * rowH + 8;
  card(doc, rightX, ry, colW, c4h);
  sectionTitle(doc, '4 · Ota-ona daromadi', rightX + pad, ry + 11);
  kvRows(doc, r.parents, rightX + pad, ry + head + 2, colW - 2 * pad, rowH);
  ry += c4h;
  y = Math.max(ly, ry) + L.sectionGap;

  // ---- 5 · Universitetlar
  sectionTitle(doc, `5 · ${r.uniTitle}`, M, y);
  y += 15;
  const unis = r.universities.length ? r.universities : [{ name: 'Universitet hali tanlanmagan', kr: '', choice: 'Supervisoringiz siz bilan birga tanlaydi', pill: null, style: 'plain' }];
  const uh = L.uniH;
  for (const u of unis) {
    const fill = u.style === 'yellow' ? C.yellowSoft : C.white;
    const border = u.style === 'green' ? C.green : u.style === 'yellow' ? C.yellow : C.line;
    doc.roundedRect(M, y, W, uh, 9).fill(fill);
    doc.roundedRect(M + 0.5, y + 0.5, W - 1, uh - 1, 9).lineWidth(u.style === 'plain' ? 0.8 : 1.4).strokeColor(border).stroke();
    const nameTxt = u.kr ? `${u.name} · ${u.kr}` : u.name;
    const pillSpace = u.pill ? 150 : 20;
    const usz = fitText(doc, nameTxt, 'B', 11.5, W - 28 - pillSpace, 8);
    doc.font('B').fontSize(usz).fillColor(C.navy).text(nameTxt, M + 14, y + (uh > 38 ? 8 : 6), { lineBreak: false });
    doc.font('R').fontSize(7.8).fillColor(C.label).text(u.choice, M + 14, y + (uh > 38 ? 24 : 21), { lineBreak: false });
    if (u.pill) pill(doc, u.pill.text, M + W - 14, y + uh / 2 - 8.5, u.pill.theme, 'right');
    y += uh + L.uniGap;
  }

  // ---- E-viza eslatmasi
  if (r.eviza) {
    const eh = 26;
    doc.roundedRect(M, y, W, eh, 7).fill(C.blueSoft);
    pill(doc, 'E-VIZA', M + 8, y + 4.5, 'blue');
    doc.font('M').fontSize(8).fillColor(C.navy).text(r.eviza, M + 66, y + 9, { width: W - 76, lineBreak: false });
    y += eh + L.uniGap;
  }
  y += 3;

  // ---- 6 · Jarayon qayerda
  sectionTitle(doc, '6 · Jarayon qayerda', M, y);
  y += 15;
  const segGap = 6;
  const segW = (W - segGap * 4) / 5;
  const curColor = { green: C.green, yellow: C.yellow, navy: C.blue, blue: C.blue, red: C.red, gray: C.gray }[r.progressTheme] || C.blue;
  r.progress.forEach((p, i) => {
    const sx = M + i * (segW + segGap);
    const color = p.state === 'done' ? C.navy : p.state === 'current' ? curColor : p.state === 'failed' ? C.red : C.track;
    doc.roundedRect(sx, y, segW, 5, 2.5).fill(color);
    const lx = sx;
    const ly2 = y + 10;
    const txtColor = p.state === 'todo' ? '#8E8A7E' : p.state === 'current' ? (curColor === C.yellow ? C.yellowDark : curColor) : p.state === 'failed' ? C.red : C.navy;
    let off = 0;
    if (p.state === 'done') {
      doc.save().lineWidth(1.3).strokeColor(C.navy)
        .moveTo(lx + 0.5, ly2 + 4.5).lineTo(lx + 3, ly2 + 7).lineTo(lx + 7.5, ly2 + 1.5).stroke().restore();
      off = 11;
    } else if (p.state === 'current') {
      doc.circle(lx + 3.5, ly2 + 4.3, 3.2).fill(txtColor);
      off = 10;
    } else if (p.state === 'failed') {
      doc.save().lineWidth(1.3).strokeColor(C.red)
        .moveTo(lx + 1, ly2 + 1.5).lineTo(lx + 6.5, ly2 + 7).moveTo(lx + 6.5, ly2 + 1.5).lineTo(lx + 1, ly2 + 7).stroke().restore();
      off = 10;
    }
    const f = p.state === 'todo' ? 'M' : 'SB';
    const lsz = fitText(doc, p.label, f, 8.3, segW - off - 2, 6);
    doc.font(f).fontSize(lsz).fillColor(txtColor).text(p.label, lx + off, ly2 + (8.3 - lsz) / 2, { lineBreak: false });
  });
  y += 28;

  // ---- Yetishmayotgan hujjatlar (bo'lsa)
  if (r.missing.length) {
    const cols2 = L.missCols;
    const items = r.missing.map((m) => `${m.label}${m.optional ? ' (ixtiyoriy)' : ''}`);
    const perCol = Math.ceil(items.length / cols2);
    const lineH = L.lineH;
    const mh = 28 + perCol * lineH + 16;
    doc.roundedRect(M, y, W, mh, 9).fill(C.orangeSoft);
    doc.roundedRect(M + 0.5, y + 0.5, W - 1, mh - 1, 9).lineWidth(0.8).strokeColor('#F2C9A0').stroke();
    const req = r.missing.filter((m) => !m.optional).length;
    const head2 = req > 0 ? `Sizdan kerak: ${req} ta hujjat yetishmayapti` : `Tavsiya etiladi: ${items.length} ta hujjat`;
    doc.font('XB').fontSize(9).fillColor(C.orange).text(head2, M + 14, y + 11, { lineBreak: false });
    const cw = (W - 28) / cols2;
    items.forEach((t, i) => {
      const cx = M + 14 + Math.floor(i / perCol) * cw;
      const cy = y + 29 + (i % perCol) * lineH;
      doc.circle(cx + 2.5, cy + 4.3, 1.8).fill(C.orange);
      const isz = fitText(doc, t, 'M', 8.2, cw - 14, 6);
      doc.font('M').fontSize(isz).fillColor(C.text).text(t, cx + 9, cy, { lineBreak: false });
    });
    doc.font('R').fontSize(7.6).fillColor(C.label)
      .text('Botdagi «Hujjatlarim» tugmasi orqali yuboring.', M + 14, y + mh - 15, { lineBreak: false });
    y += mh + L.gap;
  }

  // ---- XULOSA
  doc.font('SB').fontSize(L.sumSize);
  const sumH = doc.heightOfString(r.summary, { width: W - 32, lineGap: 2 });
  const xh = 28 + sumH + 12;
  const footerY = FOOTER_Y;
  const xy = y;
  doc.roundedRect(M, xy, W, xh, 10).fill(C.navy);
  doc.font('XB').fontSize(8).fillColor('#8FA6F5').text('XULOSA', M + 16, xy + 12, { characterSpacing: 1, lineBreak: false });
  doc.font('SB').fontSize(L.sumSize).fillColor(C.white).text(r.summary, M + 16, xy + 26, { width: W - 32, lineGap: 2 });

  // ---- Footer
  doc.font('M').fontSize(8).fillColor(C.navy).text(`Call Center: ${CALL_CENTER}`, M, footerY, { lineBreak: false });
  doc.font('M').fontSize(8).fillColor(C.navy).text(`Telegram / Instagram: ${SOCIAL}`, M, footerY, { width: W, align: 'right', lineBreak: false });
  return xy + xh;
}

// ---------------------------------------------------------------------
// TELEGRAM: fayl yuklab olish va PDF yuborish (multipart)
// ---------------------------------------------------------------------
function httpsGetBuffer(url, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(); reject(new Error('fayl juda katta')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function downloadTelegramFile(token, fileId) {
  const meta = await httpsGetBuffer(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, 1024 * 1024);
  const j = JSON.parse(meta.toString('utf8'));
  if (!j.ok || !j.result || !j.result.file_path) throw new Error('getFile xatosi');
  return httpsGetBuffer(`https://api.telegram.org/file/bot${token}/${j.result.file_path}`);
}

function sendPdfToTelegram(token, chatId, pdfBuffer, fileName, caption) {
  return new Promise((resolve) => {
    const boundary = `----bf${crypto.randomBytes(8).toString('hex')}`;
    const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8');
    const body = Buffer.concat([
      field('chat_id', String(chatId)),
      field('caption', caption || ''),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
      pdfBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendDocument`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, description: b.slice(0, 200) }); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('sendDocument timeout')));
    req.on('error', (e) => resolve({ ok: false, description: e.message }));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------
// XIZMAT — Sheets'dan o'qish, jadval bo'yicha yuborish
// ---------------------------------------------------------------------
/**
 * @param {Object} deps
 *   readSheetRange, updateCell, appendRow, ensureSheet(name, headers),
 *   getMissingDocs, isComplete, DOCUMENT_TYPES, NON_BLOCKING_CODES,
 *   botToken, adminChatId, sendMessage, autoSend (bool), log
 */
function createProfileService(deps) {
  const log = deps.log || console;
  let tickRunning = false;
  let logSheetReady = false;

  const nowMs = () => (deps.nowFn ? deps.nowFn() : Date.now());
  function tashkentNow() { return new Date(nowMs() + 5 * 3600000); }

  async function loadSources() {
    const [dbAll, draftRows, docLog, contacts] = await Promise.all([
      deps.readSheetRange('DB!A1:BF3000'),
      deps.readSheetRange('DRAFT!A2:AW2000'),
      deps.readSheetRange('DOCUMENT_LOG!A2:E10000'),
      deps.readSheetRange('CONTACTS!A2:C200'),
    ]);
    const header = (dbAll && dbAll[0]) || [];
    const { cols, found } = findDbColumns(header);
    // To'liq maydon xaritasi (sarlavha bo'yicha) — DB'ni DRAFT'dan ustun qo'yish uchun
    const fieldIdx = resolveDbColumns(header).idx;
    for (const k of ['UNIVERSITY_3', 'DOC_STATUS', 'MISSING']) {
      const key = { UNIVERSITY_3: 'uni3', DOC_STATUS: 'docStatus', MISSING: 'missingDocs' }[k];
      cols[k] = fieldIdx[key];
    }
    const dbRows = (dbAll || []).slice(1).map((row, i) => ({ row, rowNum: i + 2 }))
      .filter(({ row }) => row && s(row[cols.ID]));

    const draftById = {};
    (draftRows || []).forEach((row, i) => {
      if (!row) return;
      const obj = {};
      for (let c = 0; c < 49; c++) obj[colIndexToLetter(c)] = row[c] || '';
      const id = up(obj.H);
      if (id && !draftById[id]) draftById[id] = { data: obj, rowNum: i + 2 };
    });

    const docsById = {};
    for (const r of docLog || []) {
      if (!r || !r[1]) continue;
      const id = up(r[1]);
      (docsById[id] = docsById[id] || []).push({ ts: r[0], code: up(r[2]), fileType: s(r[3]), fileId: s(r[4]) });
    }

    const contactList = (contacts || []).filter((r) => r && s(r[0]))
      .map((r) => ({ name: s(r[0]), role: s(r[1]), phone: s(r[2]) }));

    return { cols, found, fieldIdx, dbRows, draftById, docsById, contactList };
  }

  function findSupervisor(name, contactList) {
    const n = s(name).toLowerCase();
    if (!n) return {};
    const exact = contactList.find((c) => c.name.toLowerCase() === n);
    const partial = exact || contactList.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()));
    return { name: s(name), phone: partial ? partial.phone : '' };
  }

  function toMissing(codes) {
    return codes.map((code) => {
      const d = deps.DOCUMENT_TYPES.find((t) => t.code === up(code) || t.label.toLowerCase() === s(code).toLowerCase());
      return { code: d ? d.code : s(code), label: d ? d.label : s(code), optional: deps.NON_BLOCKING_CODES.includes(d ? d.code : '') };
    });
  }

  /** DB!MISSING DOCS asosiy manba; bo'sh bo'lsa va DB'da "to'liq" deyilmagan bo'lsa — DRAFT. */
  function missingDocsForStudent(dbRow, cols, draft) {
    const dbMissing = s(dbRow[cols.MISSING]);
    if (dbMissing) return toMissing(dbMissing.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean));
    if (/TO.?LIQ|FULL|COMPLETE|TAYYOR|YIG.?ILDI/i.test(s(dbRow[cols.DOC_STATUS]))) return [];
    return missingDocsFor(draft);
  }

  function missingDocsFor(draft) {
    if (!draft) return [];
    const ar = s(draft.AR);
    const b = up(draft.B);
    let codes = [];
    if (ar) codes = deps.getMissingDocs(ar, draft.AJ, draft.AM);
    else if (b === "MA'LUMOT TASDIQLANDI") codes = deps.getMissingDocs('', draft.AJ, draft.AM);
    return codes.map((code) => {
      const d = deps.DOCUMENT_TYPES.find((t) => t.code === code);
      return { code, label: d ? d.label : code, optional: deps.NON_BLOCKING_CODES.includes(code) };
    });
  }

  function buildFor(entry, src, today) {
    const { row } = entry;
    const id = up(row[src.cols.ID]);
    const draftEntry = src.draftById[id];
    const rawDraft = draftEntry ? draftEntry.data : {};
    // DB qiymatlari DRAFT ustunlariga ustidan yoziladi: DB — asosiy manba
    const draft = { ...rawDraft };
    for (const [key, , , draftCol] of STUDENT_FIELDS) {
      if (!draftCol || key === 'status') continue;
      const v = s(row[src.fieldIdx[key]]);
      if (v) draft[draftCol] = v;
    }
    const fv = (key) => s(row[src.fieldIdx[key]]);
    const docs = src.docsById[id] || [];
    const report = buildReportData({
      dbRow: row, cols: src.cols, draft,
      docCodes: new Set(docs.map((d) => d.code)),
      missingDocs: missingDocsForStudent(row, src.cols, rawDraft.H ? rawDraft : null),
      supervisor: findSupervisor(row[src.cols.SUPERVISOR], src.contactList),
      extra: { income: fv('income'), houseDate: fv('houseDate'), carDate: fv('carDate') },
      today,
    });
    const photoDoc = [...docs].reverse().find((d) => d.code === 'PHOTO' && d.fileId && d.fileId !== '-');
    const chatId = s(row[src.cols.CHAT_ID]) || s(draft.AU);
    return { id, report, photoFileId: photoDoc ? photoDoc.fileId : null, chatId, hasDraft: !!draftEntry };
  }

  async function fetchPhoto(fileId) {
    if (!fileId || !deps.botToken) return null;
    try {
      const buf = await downloadTelegramFile(deps.botToken, fileId);
      return isImage(buf) ? buf : null;
    } catch (e) {
      log.warn(`3x4 rasmni yuklab bo'lmadi: ${e.message}`);
      return null;
    }
  }

  async function generate(entryBuilt) {
    const photo = await fetchPhoto(entryBuilt.photoFileId);
    const pdf = await renderReportPdf(entryBuilt.report, photo);
    return { pdf, hadPhoto: !!photo };
  }

  // ---- PROFILE_LOG
  async function readProfileLog() {
    if (!logSheetReady && deps.ensureSheet) {
      await deps.ensureSheet(PROFILE_LOG_SHEET, ['CONTRACT_ID', 'OXIRGI_YUBORILGAN', 'HASH', 'STATUS', 'SONI', 'SABAB']);
      logSheetReady = true;
    }
    const rows = await deps.readSheetRange(`${PROFILE_LOG_SHEET}!A2:F5000`) || [];
    const map = {};
    rows.forEach((r, i) => { if (r && s(r[0])) map[up(r[0])] = { rowNum: i + 2, sentAt: s(r[1]), hash: s(r[2]), status: s(r[3]), count: Number(r[4]) || 0 }; });
    return map;
  }

  async function writeProfileLog(logMap, id, hash, status, reason) {
    const nowIso = new Date(nowMs()).toISOString();
    const prev = logMap[id];
    if (prev) {
      const vals = [id, nowIso, hash, status, String(prev.count + 1), reason];
      for (let i = 0; i < vals.length; i++) {
        await deps.updateCell(`${PROFILE_LOG_SHEET}!${colIndexToLetter(i)}${prev.rowNum}`, vals[i]);
      }
      logMap[id] = { ...prev, sentAt: nowIso, hash, status, count: prev.count + 1 };
    } else {
      await deps.appendRow(`${PROFILE_LOG_SHEET}!A:F`, [id, nowIso, hash, status, '1', reason]);
      logMap[id] = { rowNum: null, sentAt: nowIso, hash, status, count: 1 };
    }
  }

  function staggerSlot(id) {
    return parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 6), 16) % PERIOD_DAYS;
  }

  /** Kimga hozir yuborish kerakligini hal qiladi. */
  function decide(built, logEntry, todayIndex) {
    const hash = reportHash(built.report);
    if (!logEntry) {
      // Birinchi marta: 1000+ talabaga bir kunda emas, 10 kunga yoyib yuboramiz.
      return staggerSlot(built.id) === todayIndex % PERIOD_DAYS ? { reason: 'birinchi', hash } : null;
    }
    if (built.report.status && logEntry.status !== built.report.status) return { reason: 'status', hash };
    const days = (nowMs() - new Date(logEntry.sentAt).getTime()) / 86400000;
    if (days >= PERIOD_DAYS && hash !== logEntry.hash) return { reason: '10 kun', hash };
    return null;
  }

  async function sendOne(built, reason, logMap) {
    const { pdf } = await generate(built);
    const caption = reason === 'status'
      ? `📢 Holatingiz yangilandi — ${built.report.banner.title}\n\nTo‘liq shaxsiy hisobotingiz ilovada.`
      : `📄 Shaxsiy hisobotingiz · ${built.report.dateText}\n\nJarayoningiz qayerdaligi va keyingi qadamlar shu faylda.`;
    const res = await sendPdfToTelegram(deps.botToken, built.chatId, pdf, `Hisobot_${built.id}.pdf`, caption);
    if (!res || !res.ok) throw new Error((res && res.description) || 'sendDocument xatosi');
    await writeProfileLog(logMap, built.id, reportHash(built.report), built.report.status, reason);
  }

  async function runTick() {
    if (!deps.autoSend || tickRunning) return;
    const now = tashkentNow();
    const hour = now.getUTCHours();
    if (hour < SEND_WINDOW.from || hour >= SEND_WINDOW.to) return;
    tickRunning = true;
    try {
      const src = await loadSources();
      const logMap = await readProfileLog();
      const todayIndex = Math.floor(now.getTime() / 86400000);
      const due = [];
      for (const entry of src.dbRows) {
        const built = buildFor(entry, src, new Date(nowMs()));
        if (!built.chatId) continue;
        const d = decide(built, logMap[built.id], todayIndex);
        if (d) due.push({ built, ...d });
      }
      due.sort((a, b) => (a.reason === 'status' ? -1 : 0) - (b.reason === 'status' ? -1 : 0));
      let sent = 0; let failed = 0;
      for (const item of due.slice(0, MAX_SENDS_PER_TICK)) {
        try {
          await sendOne(item.built, item.reason, logMap);
          sent++;
        } catch (e) {
          failed++;
          log.error(`Hisobot yuborilmadi (${item.built.id}): ${e.message}`);
          // Bloklagan talabaga qayta-qayta urinmaslik uchun baribir qayd qilamiz
          if (/blocked|chat not found|deactivated/i.test(e.message)) {
            await writeProfileLog(logMap, item.built.id, item.hash, item.built.report.status, `xato: ${e.message.slice(0, 60)}`);
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (sent || failed) log.log(`Shaxsiy hisobot: ${sent} ta yuborildi, ${failed} ta xato, navbatda ${Math.max(due.length - MAX_SENDS_PER_TICK, 0)} ta`);
    } catch (e) {
      log.error('Shaxsiy hisobot tick xatosi:', e && e.message);
    } finally {
      tickRunning = false;
    }
  }

  /** Admin uchun: bitta talaba hisobotini tayyorlash (oldindan ko'rish yoki yuborish). */
  async function buildForContract(contractId) {
    const src = await loadSources();
    const id = up(contractId);
    const entry = src.dbRows.find(({ row }) => up(row[src.cols.ID]) === id);
    if (!entry) return { error: `"${id}" DB sahifasida topilmadi.` };
    const built = buildFor(entry, src, new Date());
    const { pdf, hadPhoto } = await generate(built);
    const notes = [];
    notes.push(`DB ustunlari: tarif — ${src.found.TARIF || `J (standart)`}, qabul qilgan universitet — ${src.found.ACCEPTED_UNI || 'ustun topilmadi (1-tanlov deb olinadi)'}`);
    if (!built.hasDraft) notes.push('DRAFT’da bu ID yo‘q — faqat DB ma’lumotlari ishlatildi (DB’dagi bo‘sh kataklar PDF’da chiqmaydi).');
    if (!built.photoFileId) notes.push('3x4 rasm hali yuborilmagan — rasm o‘rnida bosh harflar.');
    else if (!hadPhoto) notes.push('3x4 rasm fayli rasm formatida emas (masalan PDF) — chiqmadi.');
    if (!built.chatId) notes.push('Talabaning chat_id si yo‘q — avtomatik yuborib bo‘lmaydi.');
    return { built, pdf, notes };
  }

  async function sendNow(contractId) {
    const res = await buildForContract(contractId);
    if (res.error) return res;
    if (!res.built.chatId) return { error: 'Talabaning chat_id si yo‘q.' };
    const logMap = await readProfileLog();
    const r = await sendPdfToTelegram(deps.botToken, res.built.chatId, res.pdf, `Hisobot_${res.built.id}.pdf`,
      `📄 Shaxsiy hisobotingiz · ${res.built.report.dateText}`);
    if (!r || !r.ok) return { error: (r && r.description) || 'yuborilmadi' };
    await writeProfileLog(logMap, res.built.id, reportHash(res.built.report), res.built.report.status, 'qo‘lda');
    return { ok: true };
  }

  return { runTick, buildForContract, sendNow, sendPdfToTelegram: (chatId, pdf, name, cap) => sendPdfToTelegram(deps.botToken, chatId, pdf, name, cap) };
}

module.exports = {
  sendPdfToTelegram, downloadTelegramFile,
  buildReportData, renderReportPdf, reportHash, findDbColumns, createProfileService,
  STATUS_RULES, PERIOD_DAYS, PROFILE_LOG_SHEET,
};
