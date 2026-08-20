// =====================================================================
// STUDENT INTAKE BOT — asosiy webhook server
// Mavjud staff bot (executiveAI) patterniga asoslangan: Express +
// raw https (Telegram API) + googleapis (Sheets). Alohida Coolify
// deployment, alohida BOT_TOKEN, staff botga hech qanday ta'sir qilmaydi.
//
// KERAKLI ENV VARIABLES:
//   STUDENT_BOT_TOKEN        - @BotFather'dan olingan yangi token
//   GOOGLE_SERVICE_ACCOUNT_KEY - staff bot bilan bir xil bo'lishi mumkin
//                                 (agar shu Sheet'ga Editor huquqi berilgan bo'lsa)
//   SHEET_ID                 - 16Tuujram-hINyHcpUvEeO76Yhih53ylBspjVvkxaCho
//   PORT                     - default 3000
//
// SHEET TAB NOMI: "Draft_Student_Info" deb faraz qilindi — agar boshqacha
// nomlangan bo'lsa, DRAFT_SHEET nomini quyida o'zgartiring.
// =====================================================================

const express = require('express');
const https = require('https');
const { google } = require('googleapis');
const { STUDENT_STEPS, findResumeStep, CURRENT_STEP_COLUMN, FIRST_STEP } = require('./studentSteps');
const {
  getMissingDocs, markDocReceived, isComplete,
  buildDocumentMenuKeyboard, buildBankStatementSubmenu, buildMissingDocsText,
  sendDocumentToGroup, DOCUMENT_TYPES, REQUIRED_DOCS, VISA_STAGE_DOCS,
  PARENT_INCOME_CODES, MULTI_UPLOAD_CODES, MULTI_UPLOAD_MAX, NO_FILE_CODES,
  buildParentIncomeSubmenu, buildMoreFilesKeyboard,
  DOCUMENT_GROUP_CHAT_ID, DOCUMENT_TOPIC_ID,
} = require('./documentCollection');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.STUDENT_BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const DRAFT_SHEET = 'DRAFT';
const DB_SHEET = 'DB'; // asosiy ma'lumot ombori (journey/status manbai)
const DOCUMENTS_LOG_SHEET = 'DOCUMENT_LOG';
const FAQ_SHEET = 'FAQ';            // A:№ B:SAVOL C:JAVOB D:KIM KIRITDI
const BRANCHES_SHEET = 'LOCATION';  // A:BRANCH NAME B:ADRESS C:LATITUDE D:LONGITUDE
const CONTACTS_SHEET = 'CONTACTS';  // A:NAME B:POSITION C:PHONE
const COMPLAINTS_SHEET = 'COMPLAINTS'; // A:№ B:DATE C:ID D:NAME E:USERNAME F:MATN // A:timestamp B:contractId C:docCode D:fileType E:fileId

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// chatId -> { row, contractId, mode, editing }
const userStates = new Map();

// promptMessageId -> { chatId, threadId } — guruhda "/hujjat" so'ralganda,
// hodim shu xabarga REPLY qilib shartnoma raqamini yozadi.
const pendingGroupRequests = new Map();

// Ustun harfini rowData obyekt kalitiga aylantirish uchun mos ustun
// diapazoni (A dan AP gacha).
const COLUMN_RANGE = 'A:AR';
const LAST_COLUMN_INDEX = 44; // AR = 44-ustun

const TELEGRAM_CHAT_ID_COLUMN = 'AQ'; // raqamli chat_id (proaktiv xabar yuborish uchun)
const LAST_DOC_REMINDER_COLUMN = 'AR'; // oxirgi eslatma yuborilgan sana+soat

function colIndexToLetter(idx) {
  // 1-based index -> 'A', 'B', ... 'Z', 'AA', 'AB' ...
  let letter = '';
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    idx = Math.floor((idx - 1) / 26);
  }
  return letter;
}

const ALL_COLUMNS = Array.from({ length: LAST_COLUMN_INDEX }, (_, i) => colIndexToLetter(i + 1));

// ---------------------------------------------------------------------
// GOOGLE SHEETS FUNKSIYALARI (staff bot patterni asosida)
// ---------------------------------------------------------------------

async function readSheetRange(range) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values;
}

async function appendRow(range, values) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'OVERWRITE',
    resource: { values: [values] },
  });
}

async function updateCell(range, value) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  return sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[value]] },
  });
}

/**
 * Shartnoma ID (D ustuni) bo'yicha qatorni topadi.
 * @returns {number|null} qator raqami (1-based, header bilan) yoki null
 */
async function findRowByContractId(contractId) {
  const rows = await readSheetRange(`${DRAFT_SHEET}!D2:D2000`);
  if (!rows) return null;
  const normalizedInput = contractId.trim().toUpperCase();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && String(rows[i][0]).trim().toUpperCase() === normalizedInput) {
      return i + 2; // header hisobga olinadi
    }
  }
  return null;
}

/**
 * Butun qatorni o'qib, { A: '...', B: '...', ... AP: '...' } obyektiga
 * aylantiradi.
 */
async function getRowData(rowNum) {
  const range = `${DRAFT_SHEET}!A${rowNum}:AR${rowNum}`;
  const result = await readSheetRange(range);
  const row = (result && result[0]) || [];
  const data = {};
  ALL_COLUMNS.forEach((letter, idx) => {
    data[letter] = row[idx] || '';
  });
  return data;
}

async function writeStepValue(rowNum, sheetCol, value) {
  if (!sheetCol) return; // buttons-only step, sheetga yozilmaydi
  await updateCell(`${DRAFT_SHEET}!${sheetCol}${rowNum}`, value);
}

async function writeCurrentStep(rowNum, stepKey) {
  await updateCell(`${DRAFT_SHEET}!${CURRENT_STEP_COLUMN}${rowNum}`, stepKey);
}

// ---------------------------------------------------------------------
// HUJJATLAR JURNALI — har bir muvaffaqiyatli forward qilingan hujjat
// shu yerga yoziladi, keyinchalik hodim so'roviga javob berish uchun.
// ---------------------------------------------------------------------

async function logDocument(contractId, docCode, fileType, fileId) {
  const now = new Date().toISOString();
  await appendRow(`${DOCUMENTS_LOG_SHEET}!A:E`, [now, contractId, docCode, fileType, fileId]);
}

// Belgilangan hodimga (masalan @murodil_oke) talabaning barcha
// hujjatlarini FULL holda qayta yuboradi — hujjatlar to'liq bo'lganda
// bir marta chaqiriladi.
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID; // /adminid orqali olinadi
const BOSS_CHAT_ID = process.env.BOSS_CHAT_ID; // hisobot ko'ra oladigan rahbar

function isAdmin(chatId) {
  return ADMIN_NOTIFY_CHAT_ID && String(chatId) === String(ADMIN_NOTIFY_CHAT_ID);
}
function isBoss(chatId) {
  return BOSS_CHAT_ID && String(chatId) === String(BOSS_CHAT_ID);
}

// Supervisorlar — vergul bilan ajratilgan chat_id ro'yxati.
// Masalan: SUPERVISOR_CHAT_IDS=123456,789012
const SUPERVISOR_CHAT_IDS = String(process.env.SUPERVISOR_CHAT_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isSupervisor(chatId) {
  return SUPERVISOR_CHAT_IDS.includes(String(chatId));
}
/** FAQ tahrirlash huquqi: supervisor, admin yoki boss */
function canEditFaq(chatId) {
  return isSupervisor(chatId) || isAdmin(chatId) || isBoss(chatId);
}
const WELCOME_VIDEO_FILE_ID = process.env.WELCOME_VIDEO_FILE_ID; // /setvideo orqali olinadi

async function sendFullDocumentSetToAdmin(contractId) {
  if (!ADMIN_NOTIFY_CHAT_ID) {
    console.error('ADMIN_NOTIFY_CHAT_ID env variable o\'rnatilmagan — FULL hujjat to\'plami yuborilmadi.');
    return;
  }
  const docs = await getDocumentsForContract(contractId);
  if (docs.length === 0) return;
  await sendMessage(ADMIN_NOTIFY_CHAT_ID, `Shartnoma ${contractId} — barcha hujjatlar to'liq yig'ildi (${docs.length} ta). Yuborilmoqda...`);
  for (const doc of docs) {
    await sendFileTo(ADMIN_NOTIFY_CHAT_ID, null, doc.fileType, doc.fileId, `${contractId}_${doc.docCode}`);
  }
}

// Yangi talabaga tanishtiruv videosini yuboradi. Video hali
// sozlanmagan bo'lsa (WELCOME_VIDEO_FILE_ID yo'q), jim o'tkazib
// yuboriladi (talaba formasini davom ettirishga to'sqinlik qilmaydi).
async function sendWelcomeVideo(chatId) {
  if (!WELCOME_VIDEO_FILE_ID) {
    console.error('WELCOME_VIDEO_FILE_ID o\'rnatilmagan — video yuborilmadi.');
    return;
  }
  const payload = { chat_id: chatId, video: WELCOME_VIDEO_FILE_ID, caption: 'Videoni to\'liq ko\'rib chiqing!' };
  const data = JSON.stringify(payload);
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendVideo`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  };
  await new Promise((resolve) => {
    const req = https.request(options, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(data);
    req.end();
  });
}

async function getDocumentsForContract(contractId) {
  const rows = await readSheetRange(`${DOCUMENTS_LOG_SHEET}!A2:E5000`);
  if (!rows) return [];
  const normalized = String(contractId).trim().toUpperCase();
  return rows
    .filter((r) => r && String(r[1]).trim().toUpperCase() === normalized)
    .map((r) => ({ timestamp: r[0], docCode: r[2], fileType: r[3], fileId: r[4] }));
}

// Fayl yuborish — istalgan chat/topic'ga (guruh so'rovi uchun umumiy)
function sendFileTo(chatId, threadId, fileType, fileId, caption) {
  return new Promise((resolve) => {
    const method = fileType === 'photo' ? 'sendPhoto' : 'sendDocument';
    const fieldName = fileType === 'photo' ? 'photo' : 'document';
    const payload = { chat_id: chatId, [fieldName]: fileId };
    if (threadId) payload.message_thread_id = threadId;
    if (caption) payload.caption = caption;
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------
// TELEGRAM API (staff bot patterni bilan bir xil)
// ---------------------------------------------------------------------

function sendMessage(chatId, text, replyMarkup, threadId) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    if (threadId) payload.message_thread_id = threadId;
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  const data = JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  };
  const req = https.request(options, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
  req.on('error', (e) => console.error('answerCallback xato:', e));
  req.write(data);
  req.end();
}

function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const data = JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/editMessageReplyMarkup`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  };
  const req = https.request(options, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
  req.on('error', (e) => console.error('editMarkup xato:', e));
  req.write(data);
  req.end();
}

// ---------------------------------------------------------------------
// TUGMA QURUVCHILAR
// ---------------------------------------------------------------------

function buildStepKeyboard(step) {
  const rows = step.options.map((o) => [{ text: o.text, callback_data: `ans:${o.value}` }]);
  return { inline_keyboard: rows };
}

function buildConfirmSummaryKeyboard() {
  return {
    inline_keyboard: [[
      { text: 'Tasdiqlash \u2705', callback_data: 'confirm:yes' },
      { text: 'Tahrirlash \u270f\ufe0f', callback_data: 'confirm:edit' },
    ]],
  };
}

// ---------------------------------------------------------------------
// DB SAHIFASI — asosiy ma'lumot ombori. /status va statistika shu
// yerdan o'qiydi (DRAFT emas).
// Ustunlar: A:№ B:PAYMENT C:DOCUMENT_STATUS D:STATUS E:SUPERVISOR
//   F:ID G:FULL NAME H:UNIVERSITY 1 I:UNIVERSITY 2 J:AGREEMENT
//   K:CERT STATUS L:CERTIFICATE M:SCORE N:BRANCH O:AGREEMENT COMPANY
//   ... AP:MISSING DOCS AQ:MUHIM IZOH
// ---------------------------------------------------------------------

const DB_COL = {
  NUM: 0, PAYMENT: 1, DOCUMENT_STATUS: 2, STATUS: 3, SUPERVISOR: 4,
  ID: 5, FULL_NAME: 6, UNIVERSITY_1: 7, UNIVERSITY_2: 8, AGREEMENT: 9,
  CERT_STATUS: 10, CERTIFICATE: 11, SCORE: 12,
  BRANCH: 13, PHONE: 18, MISSING_DOCS: 41, IZOH: 42, CHAT_ID: 43,
};

// ---------------------------------------------------------------------
// BOSS HISOBOTI — DB sahifasi bo'yicha to'liq analitika
// ---------------------------------------------------------------------

function countBy(rows, colIndex, transform) {
  const counts = {};
  for (const row of rows) {
    if (!row) continue;
    let val = String(row[colIndex] || '').trim();
    if (transform) val = transform(val);
    if (!val) val = '(bo\'sh)';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function formatCounts(counts, total, limit) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const shown = limit ? entries.slice(0, limit) : entries;
  return shown.map(([k, v]) => {
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    return `  ${k}: ${v} ta (${pct}%)`;
  }).join('\n');
}

async function buildBossReport() {
  const rows = (await readSheetRange(`${DB_SHEET}!A2:AR3000`) || [])
    .filter((r) => r && String(r[DB_COL.ID] || '').trim());

  const total = rows.length;
  if (total === 0) return ['DB sahifasida ma\'lumot topilmadi.'];

  const messages = [];

  // ---- 1. UMUMIY + STATUS bo'yicha ----
  const statusCounts = countBy(rows, DB_COL.STATUS, (v) => v.toUpperCase());
  let m1 = `📊 UMUMIY HISOBOT\n\nJami talabalar: ${total} ta\n\n`;
  m1 += `━━ BOSQICHLAR (STATUS) ━━\n${formatCounts(statusCounts, total)}`;

  // Muhim yig'ma ko'rsatkichlar
  const g = (key) => statusCounts[key] || 0;
  const docReady = g('HUJJAT TAYYOR') + g('HUJJAT TO\'LIQ');
  const submitted = g('UNIVERSITY 1 TOPSHIRILDI') + g('UNIVERSITY 2 TOPSHIRILDI');
  const accepted = g('QABUL QILINDI');
  const rejected = g('QABUL QILINMADI');
  const visaOk = g('VIZA TASDIQLANDI');
  const visaNo = g('VIZA RAD QILINDI');
  const cancelled = g('SHARTNOMA BEKOR QILDI') + g('MUZLATDI');

  m1 += `\n\n━━ ASOSIY KO'RSATKICHLAR ━━\n`;
  m1 += `  Hujjati tayyor: ${docReady} ta\n`;
  m1 += `  Universitetga topshirilgan: ${submitted} ta\n`;
  m1 += `  Qabul qilingan: ${accepted} ta\n`;
  m1 += `  Qabul qilinmagan: ${rejected} ta\n`;
  m1 += `  Viza tasdiqlangan: ${visaOk} ta\n`;
  m1 += `  Viza rad etilgan: ${visaNo} ta\n`;
  m1 += `  Bekor/muzlatilgan: ${cancelled} ta`;

  if (accepted + rejected > 0) {
    const rate = Math.round((accepted / (accepted + rejected)) * 100);
    m1 += `\n\n  Qabul foizi: ${rate}% (${accepted}/${accepted + rejected})`;
  }
  if (visaOk + visaNo > 0) {
    const vrate = Math.round((visaOk / (visaOk + visaNo)) * 100);
    m1 += `\n  Viza foizi: ${vrate}% (${visaOk}/${visaOk + visaNo})`;
  }
  messages.push(m1);

  // ---- 2. SERTIFIKAT tahlili ----
  const certStatusCounts = countBy(rows, DB_COL.CERT_STATUS, (v) => v.toUpperCase());
  const certTypeCounts = countBy(
    rows.filter((r) => String(r[DB_COL.CERTIFICATE] || '').trim()),
    DB_COL.CERTIFICATE, (v) => v.toUpperCase()
  );

  let m2 = `🎓 SERTIFIKAT TAHLILI\n\n━━ HOLAT ━━\n${formatCounts(certStatusCounts, total)}`;
  m2 += `\n\n━━ SERTIFIKAT TURI ━━\n`;
  const certTotal = Object.values(certTypeCounts).reduce((a, b) => a + b, 0);
  m2 += formatCounts(certTypeCounts, certTotal) || '  (ma\'lumot yo\'q)';

  // Har bir sertifikat turi uchun ball taqsimoti
  const byType = {};
  for (const row of rows) {
    if (!row) continue;
    const type = String(row[DB_COL.CERTIFICATE] || '').trim().toUpperCase();
    const score = String(row[DB_COL.SCORE] || '').trim();
    if (!type || !score) continue;
    if (!byType[type]) byType[type] = {};
    byType[type][score] = (byType[type][score] || 0) + 1;
  }

  for (const [type, scores] of Object.entries(byType)) {
    const typeTotal = Object.values(scores).reduce((a, b) => a + b, 0);
    m2 += `\n\n━━ ${type} BALLARI ━━\n${formatCounts(scores, typeTotal)}`;
  }
  messages.push(m2);

  // ---- 3. FILIAL va UNIVERSITETLAR ----
  const branchCounts = countBy(rows, DB_COL.BRANCH, (v) => v.toUpperCase());
  let m3 = `🏢 FILIAL BO'YICHA SOTUV\n\n${formatCounts(branchCounts, total)}`;

  const uniCounts = {};
  for (const row of rows) {
    if (!row) continue;
    for (const col of [DB_COL.UNIVERSITY_1, DB_COL.UNIVERSITY_2]) {
      const uni = String(row[col] || '').trim();
      if (!uni) continue;
      uniCounts[uni] = (uniCounts[uni] || 0) + 1;
    }
  }
  const uniTotal = Object.values(uniCounts).reduce((a, b) => a + b, 0);
  m3 += `\n\n🏛 UNIVERSITETLAR (jami ${uniTotal} ta ariza)\n`;
  m3 += formatCounts(uniCounts, uniTotal, 15) || '  (ma\'lumot yo\'q)';

  // To'lov holati
  const payCounts = countBy(rows, DB_COL.PAYMENT, (v) => v.toUpperCase());
  m3 += `\n\n💰 TO'LOV HOLATI\n${formatCounts(payCounts, total)}`;
  messages.push(m3);

  return messages;
}


/**
 * DB sahifasidan shartnoma ID bo'yicha qatorni topadi.
 * @returns {Array|null} qator massivi yoki null
 */
async function findDbRowByContractId(contractId) {
  const rows = await readSheetRange(`${DB_SHEET}!A2:AR3000`);
  if (!rows) return null;
  const normalized = String(contractId).trim().toUpperCase();
  for (const row of rows) {
    if (!row) continue;
    if (String(row[DB_COL.ID] || '').trim().toUpperCase() === normalized) return row;
  }
  return null;
}

/**
 * Talabaning raqamli chat_id'sini topadi. Avval DB!AR ustunidan
 * qidiriladi (asosiy manba), topilmasa DRAFT!AQ dan olinadi.
 */
async function findStudentChatId(contractId) {
  const dbRow = await findDbRowByContractId(contractId);
  if (dbRow && dbRow[DB_COL.CHAT_ID]) return String(dbRow[DB_COL.CHAT_ID]).trim();
  const rowNum = await findRowByContractId(contractId);
  if (!rowNum) return null;
  const rowData = await getRowData(rowNum);
  return rowData[TELEGRAM_CHAT_ID_COLUMN] || null;
}


// talabaga tushunarli matn ko'rinishida qaytaradi.
// Kelajakda DB sahifasidan o'qishga o'tkaziladi (journey map to'liq
// bosqichlari bilan) — hozircha DRAFT!B yetarli.
// ---------------------------------------------------------------------

// STATUS matnlari — DB!D ustunidagi har bir qiymat uchun talabaga
// ko'rsatiladigan xabar. Kalitlar KATTA HARF bilan.
// ESLATMA: bu matnlarni BOSS o'zi yakuniy tahrirlaydi — quyidagilar
// dastlabki variant, o'zgartirish uchun faqat shu ro'yxatni tahrirlang.
const STATUS_MESSAGES = {
  'SHARTNOMA QILDI': 'Siz biz bilan shartnoma tuzdingiz. Keyingi bosqichga o\'tish uchun boshlang\'ich to\'lovni amalga oshirishingiz kerak.',
  "TO'LOV QILMADI": 'Hozircha to\'lovingiz qayd etilmagan. Jarayonni boshlash uchun boshlang\'ich to\'lovni amalga oshiring.',
  "TO'LOV QILDI": 'Sizning boshlang\'ich to\'lovingiz amalga oshirilgan. Keyingi bosqichga darhol o\'tishimiz uchun hujjatlaringizni to\'liq taqdim qilishingiz kerak!',
  "HUJJAT YIG'ILMOQDA": 'Hozir hujjatlaringiz yig\'ilmoqda. Yetishmayotgan hujjatlarni tezroq yuboring.',
  "HUJJAT TO'LIQ": 'Barcha hujjatlaringiz qabul qilindi. Mutaxassislarimiz ularni tekshirmoqda.',
  'HUJJAT TAYYOR': 'Hujjatlaringiz universitetga topshirishga tayyorlandi.',
  'UNIVERSITY 1 TOPSHIRILDI': 'Hujjatlaringiz birinchi universitetga topshirildi. Natijani kutmoqdamiz.',
  'UNIVERSITY 2 TOPSHIRILDI': 'Hujjatlaringiz ikkinchi universitetga topshirildi. Natijani kutmoqdamiz.',
  'QABUL QILINDI': 'Tabriklaymiz! Siz universitetga qabul qilindingiz. Keyingi qadam — kontrakt to\'lovi.',
  'QABUL QILINMADI': 'Afsuski, bu safar qabul qilinmadingiz. Mas\'ul hodimimiz siz bilan bog\'lanib, keyingi imkoniyatlarni muhokama qiladi.',
  "KONTRAKT TO'LADI": 'Kontrakt to\'lovingiz qabul qilindi. Endi viza hujjatlarini tayyorlash bosqichiga o\'tamiz.',
  "KDB QO'YDI": 'KDB bank hisobingiz ochildi. Elchixona uchun hujjatlar tayyorlanmoqda.',
  'COA OLDI': 'Universitetdan qabul hujjati (COA) olindi. Elchixonaga topshirishga tayyorlanmoqdamiz.',
  'ELCHIXONA': 'Hujjatlaringiz elchixonaga topshirildi. Viza natijasini kutmoqdamiz.',
  'VIZA TASDIQLANDI': 'Tabriklaymiz! Vizangiz tasdiqlandi. Endi aviabilet masalasiga o\'tamiz.',
  'VIZA RAD QILINDI': 'Afsuski, viza rad etildi. Mas\'ul hodimimiz siz bilan bog\'lanib, keyingi qadamlarni muhokama qiladi.',
  'SHARTNOMA BEKOR QILDI': 'Shartnomangiz bekor qilingan. Savollaringiz bo\'lsa, filialingizga murojaat qiling.',
  'MUZLATDI': 'Jarayoningiz vaqtincha to\'xtatilgan. Qayta boshlash uchun filialingizga murojaat qiling.',
};

/**
 * Talabaga joriy holatini yuboradi. Ma'lumot DB sahifasidan olinadi
 * (DRAFT emas). Agar DB'da qator topilmasa — talaba hali DB'ga
 * o'tkazilmagan, DRAFT bosqichida ekani aytiladi.
 */
async function sendStudentStatus(chatId, contractId, draftRowNum) {
  const dbRow = await findDbRowByContractId(contractId);

  if (!dbRow) {
    // DB'da hali yo'q — DRAFT bosqichida
    let text = `Shartnoma: ${contractId}\n\n`;
    text += 'Ma\'lumotlaringiz hali tekshiruvdan o\'tmoqda. ';
    if (draftRowNum) {
      try {
        const d = await getRowData(draftRowNum);
        const missing = getMissingDocs(d.AN, d.AF, d.AI);
        if (!isComplete(missing)) {
          text += `\n\nYetishmayotgan hujjatlar: ${missing.length} ta. Ularni yuborish uchun /hujjatlar buyrug'ini yuboring.`;
        } else {
          text += 'Barcha hujjatlaringiz qabul qilingan.';
        }
      } catch (e) { /* jim o'tkazamiz */ }
    }
    await sendMessage(chatId, text);
    return;
  }

  const status = String(dbRow[DB_COL.STATUS] || '').trim();
  const payment = String(dbRow[DB_COL.PAYMENT] || '').trim().toUpperCase();
  const fullName = dbRow[DB_COL.FULL_NAME] || '';
  const uni1 = dbRow[DB_COL.UNIVERSITY_1] || '';
  const uni2 = dbRow[DB_COL.UNIVERSITY_2] || '';
  const branch = dbRow[DB_COL.BRANCH] || '';

  let statusText = STATUS_MESSAGES[status.toUpperCase()];
  if (!statusText) {
    statusText = status
      ? `Joriy bosqich: ${status}`
      : 'Holatingiz hali belgilanmagan. Savolingiz bo\'lsa, filialingizga murojaat qiling.';
  }

  let text = `Shartnoma: ${contractId}\n`;
  if (fullName) text += `Ism: ${fullName}\n`;
  if (branch) text += `Filial: ${branch}\n`;
  text += `\n${statusText}\n`;

  if (uni1 || uni2) {
    text += '\nUniversitetlar:';
    if (uni1) text += `\n1) ${uni1}`;
    if (uni2) text += `\n2) ${uni2}`;
    text += '\n';
  }

  if (payment === 'DEBT') {
    text += '\nTo\'lov holati: qisman to\'langan (qarzdorlik mavjud).';
  } else if (payment === 'FULL') {
    text += '\nTo\'lov holati: to\'liq to\'langan.';
  } else if (payment === 'NOT PAID') {
    text += '\nTo\'lov holati: hali to\'lov qilinmagan.';
  }

  await sendMessage(chatId, text);
}


// ---------------------------------------------------------------------
// DOIMIY TUGMALAR (Reply Keyboard) — ekran pastida turadi, har doim
// ko'rinadi. Inline tugmalardan farqli, yo'qolib ketmaydi.
// Tugma bosilganda oddiy MATN yuboriladi — shuning uchun quyidagi
// yorliqlar handler ichida matn sifatida tekshiriladi.
// ---------------------------------------------------------------------

const BTN = {
  DOCS: '📄 Hujjatlarim',
  STATUS: '📊 Mening holatim',
  HELP: '🆘 Yordam kerak',
  RESTART: '🔄 Qaytadan boshlash',
  GUIDE: '📖 Qo\'llanma',
  FAQ: '❓ Savol-javob',
  BRANCHES: '📍 Filiallarimiz',
  CONTACTS: '☎️ Aloqa',
  FAQ_EDIT: '✏️ FAQ tahrirlash',
  COMPLAINT: '📣 E\'tiroz va shikoyatlar',
  // Admin
  RETURN_DOC: '♻️ Hujjatni qaytarish',
  GET_DOCS: '📥 Talaba hujjatlari',
  VISA: '🛂 Viza bosqichi',
  // Boss
  REPORT: '📊 To\'liq hisobot',
  SUMMARY: '🌙 Kunlik xulosa',
};

function studentReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.DOCS }, { text: BTN.STATUS }],
      [{ text: BTN.FAQ }, { text: BTN.HELP }],
      [{ text: BTN.BRANCHES }, { text: BTN.CONTACTS }],
      [{ text: BTN.COMPLAINT }],
      [{ text: BTN.GUIDE }, { text: BTN.RESTART }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function adminReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.RETURN_DOC }, { text: BTN.GET_DOCS }],
      [{ text: BTN.VISA }, { text: BTN.REPORT }],
      [{ text: BTN.SUMMARY }, { text: BTN.FAQ_EDIT }],
      [{ text: BTN.BRANCHES }, { text: BTN.CONTACTS }],
      [{ text: BTN.GUIDE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function bossReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.REPORT }, { text: BTN.SUMMARY }],
      [{ text: BTN.GET_DOCS }, { text: BTN.FAQ_EDIT }],
      [{ text: BTN.BRANCHES }, { text: BTN.CONTACTS }],
      [{ text: BTN.GUIDE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function supervisorReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.FAQ_EDIT }, { text: BTN.GET_DOCS }],
      [{ text: BTN.BRANCHES }, { text: BTN.CONTACTS }],
      [{ text: BTN.FAQ }, { text: BTN.GUIDE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function keyboardForUser(chatId) {
  if (isBoss(chatId)) return bossReplyKeyboard();
  if (isAdmin(chatId)) return adminReplyKeyboard();
  if (isSupervisor(chatId)) return supervisorReplyKeyboard();
  return studentReplyKeyboard();
}

// ---------------------------------------------------------------------
// TELEGRAM "Menu" TUGMASI — xabar maydonining chap tomonidagi ko'k
// tugma. setMyCommands orqali ro'yxatdan o'tkaziladi. Foydalanuvchi
// uni bosganda buyruqlar ro'yxati chiqadi.
// ---------------------------------------------------------------------

const STUDENT_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'hujjatlar', description: 'Hujjatlarni yuborish va holatini ko\'rish' },
  { command: 'status', description: 'Jarayondagi joriy bosqichim' },
  { command: 'yordam', description: 'Mas\'ul hodimga savol yuborish' },
  { command: 'shikoyat', description: 'E\'tiroz va shikoyat bildirish' },
  { command: 'filiallar', description: 'Filiallarimiz manzillari' },
  { command: 'aloqa', description: 'Hodimlar telefon raqamlari' },
  { command: 'savollar', description: 'Ko\'p so\'raladigan savollar' },
  { command: 'qollanma', description: 'Botdan qanday foydalanish' },
  { command: 'menu', description: 'Tugmalarni qayta ko\'rsatish' },
];

const ADMIN_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'qaytar', description: 'Talabaga hujjatni qayta so\'rash' },
  { command: 'viza', description: 'Talabani viza bosqichiga o\'tkazish' },
  { command: 'hisobot', description: 'To\'liq analitik hisobot' },
  { command: 'xulosa', description: 'Kunlik xulosa' },
  { command: 'qollanma', description: 'Funksiyalar bo\'yicha yo\'riqnoma' },
  { command: 'menu', description: 'Tugmalarni qayta ko\'rsatish' },
];

function telegramApi(method, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

/** Umumiy (barcha foydalanuvchilar uchun) buyruqlar ro'yxati */
async function registerDefaultCommands() {
  const r = await telegramApi('setMyCommands', {
    commands: STUDENT_COMMANDS,
    scope: { type: 'default' },
  });
  console.log('setMyCommands (default):', r && r.ok ? 'OK' : JSON.stringify(r));
}

/** Admin/Boss uchun shaxsiy chatda kengaytirilgan ro'yxat */
async function registerAdminCommands(chatId) {
  await telegramApi('setMyCommands', {
    commands: ADMIN_COMMANDS,
    scope: { type: 'chat', chat_id: chatId },
  });
}

// ---------------------------------------------------------------------
// QO'LLANMA — har bir funksiya nima qilishini tushuntiradi
// ---------------------------------------------------------------------

const STUDENT_GUIDE = `📖 BOTDAN FOYDALANISH QO'LLANMASI

Bu bot orqali siz ma'lumotlaringizni topshirasiz, hujjatlaringizni yuborasiz va jarayondagi holatingizni kuzatasiz.

━━ TUGMALAR ━━

📄 Hujjatlarim
Kerakli hujjatlar ro'yxatini ko'rsatadi. Qaysi hujjat yetishmayotganini bilib, o'sha tugmani bosib faylni yuborasiz. Yuborilgan hujjat darhol mutaxassislarimizga yetib boradi.

📊 Mening holatim
Jarayonning qaysi bosqichida ekaningizni ko'rsatadi: hujjat yig'ish, universitetga topshirish, natija kutish, viza va boshqalar. To'lov holatingiz ham shu yerda ko'rinadi.

🆘 Yordam kerak
Savolingiz bo'lsa yoki biror joyda qiynalsangiz, shu tugmani bosib savolingizni yozing. Savolingiz mas'ul hodimimizga yetkaziladi va u siz bilan bog'lanadi.

🔄 Qaytadan boshlash
Shartnoma raqamini qayta kiritish uchun. Masalan boshqa qurilmadan kirsangiz kerak bo'ladi.

━━ MUHIM ━━

• Ism-familyangizni ZAGRAN pasportdagidek kiriting — bu ma'lumot viza uchun ishlatiladi, xato bo'lsa muammo chiqadi.
• Hujjatlarni istalgan tartibda yuborishingiz mumkin.
• Bot sizga kuniga 2 marta (10:00 va 16:00) yetishmayotgan hujjatlar haqida eslatib turadi.
• Ma'lumot kiritishni yarim yo'lda to'xtatsangiz, keyingi safar to'xtagan joyingizdan davom etasiz.`;

const ADMIN_GUIDE = `📖 ADMIN QO'LLANMASI

━━ TUGMALAR ━━

♻️ Hujjatni qaytarish
Talaba yuborgan hujjat noto'g'ri yoki sifatsiz bo'lsa ishlatiladi. Shartnoma raqamini kiritasiz, keyin qaysi hujjat(lar) qayta so'ralishini belgilaysiz. Talabaga darhol xabar boradi va eslatma tsikli qayta ishga tushadi.

📥 Talaba hujjatlari
Muayyan talabaning barcha yuborgan hujjatlarini qayta olish uchun. Shartnoma raqamini kiritsangiz, bot barcha fayllarni sizga yuboradi.

🛂 Viza bosqichi
Talaba universitetga qabul qilinib, kontraktni to'lagandan keyin ishlatiladi. Bu tugma bosilgach, botdan talabadan KDB va ota-ona bank statement hujjatlari so'raladi. Bir nechta talabani vergul bilan ajratib kiritish mumkin.

📊 To'liq hisobot
Barcha talabalar bo'yicha analitika: bosqichlar, sertifikat turlari va ballari, filiallar, universitetlar, to'lov holati.

🌙 Kunlik xulosa
Harakatsiz talabalar, hujjat yubormaganlar va to'lov qilmaganlar ro'yxati.

━━ MUHIM ━━

• Hujjatlar to'liq bo'lganda avtomatik ravishda sizga yuboriladi.
• Guruhda /hujjat buyrug'i orqali ham talaba hujjatlarini so'rash mumkin — javob shu topic'ga qaytadi.`;

const BOSS_GUIDE = `📖 RAHBARIYAT QO'LLANMASI

━━ TUGMALAR ━━

📊 To'liq hisobot
Barcha talabalar bo'yicha to'liq analitika:
• Bosqichlar bo'yicha taqsimot (18 ta status)
• Qabul foizi va viza foizi
• Sertifikat tahlili: bor/yo'q/TAKER, tur bo'yicha (IELTS, TOPIK, TOEFL, SKA) va har bir turdagi ball taqsimoti
• Filial bo'yicha sotuv reytingi
• Universitetlar bo'yicha ariza soni
• To'lov holati taqsimoti

🌙 Kunlik xulosa
Har kuni 18:00 da avtomatik keladi. Ichida:
• Bugun nechta talaba hujjat yuborgani
• 3+ kundan beri harakatsiz talabalar ro'yxati
• Umuman hujjat yubormaganlar
• To'lov qilmaganlar

📥 Talaba hujjatlari
Muayyan talabaning barcha hujjatlarini ko'rish uchun.

━━ AVTOMATIK ISHLAR ━━

• Talabalarga kuniga 2 marta (10:00, 16:00) hujjat eslatmasi
• Dushanba 10:00 da to'lov eslatmasi (faqat NOT PAID va DEBT holatidagilarga)
• Hujjatlar to'liq bo'lganda adminga avtomatik yuborish`;

function guideForUser(chatId) {
  if (isBoss(chatId)) return BOSS_GUIDE;
  if (isAdmin(chatId)) return ADMIN_GUIDE;
  return STUDENT_GUIDE;
}

// =====================================================================
// FAQ — ko'p so'raluvchi savollar. Manba: FAQ sahifasi (A:savol B:javob).
// Supervisorlar bot orqali yoki to'g'ridan-to'g'ri Sheet'da tahrirlaydi.
// =====================================================================

async function getFaqList() {
  // FAQ ustunlari: A:№ B:SAVOL C:JAVOB D:KIM KIRITDI
  const rows = await readSheetRange(`${FAQ_SHEET}!A2:D200`) || [];
  const list = [];
  // MUHIM: haqiqiy Sheet qator raqamini saqlaymiz (bo'sh qatorlar
  // o'tkazib yuborilganda ham). Aks holda o'chirishda noto'g'ri
  // qator tozalanadi.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !String(r[1] || '').trim()) continue; // B = SAVOL
    list.push({
      row: i + 2,
      question: String(r[1]).trim(),
      answer: String(r[2] || '').trim(), // C = JAVOB
      author: String(r[3] || '').trim(), // D = KIM KIRITDI
    });
  }
  return list;
}

function buildFaqKeyboard(faqs) {
  const rows = faqs.slice(0, 30).map((f, i) => [{
    text: f.question.length > 60 ? f.question.slice(0, 57) + '...' : f.question,
    callback_data: `faq:${i}`,
  }]);
  return { inline_keyboard: rows };
}

// =====================================================================
// FILIALLAR — manzil + lokatsiya. Manba: BRANCHES sahifasi.
// =====================================================================

async function getBranches() {
  const rows = await readSheetRange(`${BRANCHES_SHEET}!A2:D50`) || [];
  return rows
    .filter((r) => r && String(r[0] || '').trim())
    .map((r) => ({
      name: String(r[0]).trim(),
      address: String(r[1] || '').trim(),
      lat: parseFloat(String(r[2] || '').replace(',', '.')),
      lng: parseFloat(String(r[3] || '').replace(',', '.')),
    }));
}

function buildBranchesKeyboard(branches) {
  return {
    inline_keyboard: branches.slice(0, 20).map((b, i) => [{ text: b.name, callback_data: `branch:${i}` }]),
  };
}

function sendLocation(chatId, lat, lng) {
  return telegramApi('sendLocation', { chat_id: chatId, latitude: lat, longitude: lng });
}

// =====================================================================
// ALOQA — hodimlar telefon raqamlari. Manba: CONTACTS sahifasi.
// =====================================================================

async function getContacts() {
  const rows = await readSheetRange(`${CONTACTS_SHEET}!A2:C100`) || [];
  return rows
    .filter((r) => r && String(r[0] || '').trim())
    .map((r) => ({
      name: String(r[0]).trim(),
      role: String(r[1] || '').trim(),
      phone: String(r[2] || '').trim(),
    }));
}

function buildContactsKeyboard(contacts) {
  return {
    inline_keyboard: contacts.slice(0, 30).map((c, i) => [{
      text: c.role ? `${c.name} — ${c.role}` : c.name,
      callback_data: `contact:${i}`,
    }]),
  };
}



function buildStudentMenuKeyboard() {  return {
    inline_keyboard: [
      [{ text: '🆕 Boshlash / shartnoma ID', callback_data: 'menu:start' }],
      [{ text: '📄 Hujjatlar holati', callback_data: 'menu:docs' }],
      [{ text: '📊 Mening holatim', callback_data: 'menu:status' }],
      [{ text: '🆘 Yordam kerak', callback_data: 'menu:yordam' }],
    ],
  };
}

function buildAdminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '♻️ Hujjatni qaytarish', callback_data: 'menu:qaytar' }],
      [{ text: '📄 Talaba hujjatlarini olish', callback_data: 'menu:gethujjat' }],
      [{ text: '🛂 Viza bosqichiga o\'tkazish (KDB)', callback_data: 'menu:viza' }],
      [{ text: '📊 To\'liq hisobot', callback_data: 'menu:hisobot' }],
    ],
  };
}

function buildAdminDocSelectKeyboard(selectedCodes) {
  const rows = DOCUMENT_TYPES.map((d) => {
    const checked = selectedCodes.includes(d.code);
    return [{ text: `${checked ? '✅' : '⚪️'} ${d.label}`, callback_data: `adret:${d.code}` }];
  });
  rows.push([
    { text: 'Bekor qilish', callback_data: 'adret:cancel' },
    { text: 'Tayyor ✔️', callback_data: 'adret:confirm' },
  ]);
  return { inline_keyboard: rows };
}

function buildEditFieldKeyboard() {
  const editable = Object.entries(STUDENT_STEPS).filter(([, s]) => s.sheetCol && s.type !== 'skip');
  const rows = editable.map(([key, s]) => [{ text: s.question && typeof s.question === 'string' ? s.question.split('\n').pop().slice(0, 40) : key, callback_data: `edit:${key}` }]);
  rows.push([{ text: '\u2190 Bekor qilish', callback_data: 'edit:cancel' }]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------
// STEP RENDER — savolni foydalanuvchiga yuborish
// ---------------------------------------------------------------------

async function renderStep(chatId, rowNum, stepKey, sessionData) {
  const step = STUDENT_STEPS[stepKey];

  // 'skip' turdagi steplar avtomatik yoziladi, savol so'ralmaydi
  if (step.type === 'skip') {
    await writeStepValue(rowNum, step.sheetCol, step.autoValue);
    const nextKey = step.next(sessionData);
    await writeCurrentStep(rowNum, nextKey);
    return renderStep(chatId, rowNum, nextKey, sessionData);
  }

  // 'skip_multi' — bitta qiymatni bir nechta ustunga bir vaqtda yozadi
  // (masalan ota/ona "DEAD"/"DIVORCED" — ism, kasb, telefon ustunlariga)
  if (step.type === 'skip_multi') {
    const value = typeof step.autoValue === 'function' ? step.autoValue(sessionData) : step.autoValue;
    for (const col of step.sheetCols) {
      await writeStepValue(rowNum, col, value);
    }
    const nextKey = step.next(sessionData);
    await writeCurrentStep(rowNum, nextKey);
    return renderStep(chatId, rowNum, nextKey, sessionData);
  }

  // 'branch_by_sheet' — savol so'ramasdan, Sheet'dagi boshqa ustun
  // qiymatiga qarab keyingi qadamni tanlaydi (masalan: PROGRAM
  // ustunida "MAGISTRATURA" bo'lsa — Master sohasi so'raladi, aks
  // holda o'tkazib yuboriladi).
  if (step.type === 'branch_by_sheet') {
    const rowData = await getRowData(rowNum);
    const checkValue = rowData[step.sheetColToCheck];
    const nextKey = checkValue === step.matchValue ? step.ifMatchNext : step.ifNoMatchNext;
    await writeCurrentStep(rowNum, nextKey);
    return renderStep(chatId, rowNum, nextKey, sessionData);
  }

  if (step.type === 'confirm_summary') {
    const rowData = await getRowData(rowNum);
    const lines = Object.entries(STUDENT_STEPS)
      .filter(([, s]) => s.sheetCol && s.type !== 'skip')
      .map(([, s]) => `${rowData[s.sheetCol] || '-'}`);
    await sendMessage(chatId, 'Barcha ma\'lumotlaringiz:\n\n' + lines.join('\n') + '\n\nTasdiqlaysizmi?', buildConfirmSummaryKeyboard());
    return;
  }

  const questionText = typeof step.question === 'function' ? step.question(sessionData) : step.question;

  if (step.type === 'buttons' || step.type === 'buttons_then_text') {
    await sendMessage(chatId, questionText, buildStepKeyboard(step));
  } else {
    await sendMessage(chatId, questionText);
  }
}

// ---------------------------------------------------------------------
// JAVOBNI QAYTA ISHLASH (text yoki button)
// ---------------------------------------------------------------------

async function handleStepAnswer(chatId, rowNum, stepKey, answerValue, session) {
  const step = STUDENT_STEPS[stepKey];
  const trimmedValue = typeof answerValue === 'string' ? answerValue.trim() : answerValue;

  if (step.validate && !step.validate(trimmedValue)) {
    await sendMessage(chatId, step.errorMsg || 'Format noto\'g\'ri, qayta kiriting.');
    return;
  }

  // XAVFSIZLIK/MANTIQ TEKSHIRUVI: telefon raqamlari takrorlanmasligi
  // kerak — talaba, otasi va onasi uchun uchta ALOHIDA raqam bo'lishi
  // shart.
  if (stepKey === 'phone' || stepKey === 'father_phone' || stepKey === 'mother_phone') {
    const rowData = await getRowData(rowNum);
    const digits = (v) => String(v || '').replace(/\D/g, '');
    const entered = digits(trimmedValue);

    // Har bir maydon uchun: qaysi boshqa ustunlar bilan solishtiriladi
    const compareMap = {
      phone: [
        { col: 'AG', label: 'otangizning raqami' },
        { col: 'AJ', label: 'onangizning raqami' },
      ],
      father_phone: [
        { col: 'Q', label: 'sizning raqamingiz' },
        { col: 'AJ', label: 'onangizning raqami' },
      ],
      mother_phone: [
        { col: 'Q', label: 'sizning raqamingiz' },
        { col: 'AG', label: 'otangizning raqami' },
      ],
    };

    for (const { col, label } of compareMap[stepKey]) {
      const existing = digits(rowData[col]);
      if (existing && existing === entered) {
        await sendMessage(chatId, `Bu raqam ${label} bilan bir xil. Har bir shaxs uchun ALOHIDA telefon raqami kiritilishi kerak. Boshqa raqam kiriting:`);
        return;
      }
    }
  }

  await writeStepValue(rowNum, step.sheetCol, trimmedValue);

  // Tahrirlash rejimida bo'lsa — javobni yozib, to'g'ridan-to'g'ri
  // tasdiqlash sahifasiga qaytariladi (oddiy zanjirni davom ettirmaydi).
  if (session.editing) {
    session.editing = false;
    await writeCurrentStep(rowNum, 'confirm');
    return renderStep(chatId, rowNum, 'confirm', {});
  }

  const sessionData = { [stepKey]: trimmedValue };
  const nextKey = step.next(sessionData);
  await writeCurrentStep(rowNum, nextKey);
  await renderStep(chatId, rowNum, nextKey, sessionData);
}

// ---------------------------------------------------------------------
// WEBHOOK
// ---------------------------------------------------------------------

app.post('/webhook', async (req, res) => {
  try {
    if (req.body.callback_query) {
      await handleCallback(req.body.callback_query);
      return res.sendStatus(200);
    }

    const message = req.body.message;
    if (!message || !message.chat) return res.sendStatus(200);

    // --- Guruh xabarlari — butunlay boshqa oqim (hodim hujjat so'rovi) ---
    if (message.chat.type === 'group' || message.chat.type === 'supergroup') {
      await handleGroupMessage(message);
      return res.sendStatus(200);
    }

    // Guruhga a'zolik o'zgarishi, va boshqa shaxsiy bo'lmagan hodisalar
    // e'tiborsiz qoldiriladi.
    if (!message.text && !message.document && !message.photo && !message.video) return res.sendStatus(200);

    const chatId = message.chat.id;
    let text = (message.text || '').trim();
    const username = message.from.username || '';

    // --- ADMIN: /viza — talaba viza bosqichiga o'tdi, endi KDB va
    // ota-ona bank statement hujjatlari talab qilinadi. Faqat shu
    // buyruqdan keyin ular ro'yxatga qo'shiladi va eslatma boshlanadi.
    if (text === '/viza') {
      if (!isAdmin(chatId) && !isBoss(chatId)) {
        await sendMessage(chatId, 'Bu buyruq faqat administrator uchun.');
        return res.sendStatus(200);
      }
      userStates.set(chatId, { mode: 'admin_visa_awaiting_id' });
      await sendMessage(chatId, 'Qaysi talaba viza bosqichiga o\'tdi? Shartnoma raqamini kiriting:\n\n(Bir nechta talaba bo\'lsa, vergul bilan ajratib yozing)');
      return res.sendStatus(200);
    }

    // --- ADMIN: /qaytar — hujjatlardan birortasi to'g'ri bo'lmasa,
    // Murodil shu buyruq orqali qaysi hujjat(lar) qayta so'ralishini
    // belgilaydi. Faqat ADMIN_NOTIFY_CHAT_ID'dan ishlaydi.
    if (text === '/qaytar') {
      if (!isAdmin(chatId) && !isBoss(chatId)) {
        await sendMessage(chatId, 'Bu buyruq faqat administrator uchun.');
        return res.sendStatus(200);
      }
      userStates.set(chatId, { mode: 'admin_return_awaiting_id' });
      await sendMessage(chatId, 'Qaysi talabaning hujjatlarini qaytarish kerak? Shartnoma raqamini kiriting:');
      return res.sendStatus(200);
    }

    // --- /xulosa: kunlik xulosani darhol ko'rish (sinov uchun ham) ---
    if (text === '/xulosa') {
      if (!isBoss(chatId) && !isAdmin(chatId)) {
        await sendMessage(chatId, 'Bu buyruq faqat rahbariyat uchun.');
        return res.sendStatus(200);
      }
      await sendMessage(chatId, 'Xulosa tayyorlanmoqda...');
      try {
        const summary = await buildDailySummary();
        if (summary.length <= 4000) {
          await sendMessage(chatId, summary);
        } else {
          for (let i = 0; i < summary.length; i += 4000) {
            await sendMessage(chatId, summary.slice(i, i + 4000));
          }
        }
      } catch (e) {
        console.error('Xulosa xatosi:', e);
        await sendMessage(chatId, 'Xulosa tayyorlashda xatolik: ' + e.message);
      }
      return res.sendStatus(200);
    }

    // --- /hisobot: Boss uchun to'liq analitika (DB sahifasidan) ---
    if (text === '/hisobot') {
      if (!isBoss(chatId) && !isAdmin(chatId)) {
        await sendMessage(chatId, 'Bu buyruq faqat rahbariyat uchun.');
        return res.sendStatus(200);
      }
      await sendMessage(chatId, 'Hisobot tayyorlanmoqda, biroz kuting...');
      try {
        const parts = await buildBossReport();
        for (const part of parts) {
          await sendMessage(chatId, part);
        }
      } catch (e) {
        console.error('Hisobot xatosi:', e);
        await sendMessage(chatId, 'Hisobot tayyorlashda xatolik yuz berdi: ' + e.message);
      }
      return res.sendStatus(200);
    }

    // --- /yordam: talaba yordam so'raydi, supervisor guruhiga signal ---
    if (text === '/yordam') {
      const s = userStates.get(chatId);
      userStates.set(chatId, { ...(s || {}), mode: 'awaiting_help_text', helpPrev: s ? s.mode : null });
      await sendMessage(chatId, 'Savolingizni yoki muammoingizni yozing — mas\'ul hodimimizga yetkazamiz:');
      return res.sendStatus(200);
    }

    // --- Funksiya menyusi (rol asosida farqlanadi) ---
    // --- Matnli buyruqlar tugma yorliqlariga yo'naltiriladi ---
    if (text === '/shikoyat') text = BTN.COMPLAINT;
    else if (text === '/filiallar') text = BTN.BRANCHES;
    else if (text === '/aloqa') text = BTN.CONTACTS;
    else if (text === '/savollar' || text === '/faq') text = BTN.FAQ;

    // --- /qollanma: funksiyalar bo'yicha yo'riqnoma ---
    if (text === '/qollanma' || text === '/yoriqnoma') {
      await sendMessage(chatId, guideForUser(chatId), keyboardForUser(chatId));
      return res.sendStatus(200);
    }

    if (text === '/menu') {
      // Doimiy tugmalarni (reply keyboard) qayta ko'rsatadi.
      // Foydalanuvchi tugmalarni yashirib qo'ygan bo'lsa, shu bilan
      // qaytariladi.
      let label = 'Funksiyalar quyida:';
      if (isBoss(chatId)) label = 'Rahbariyat funksiyalari quyida:';
      else if (isAdmin(chatId)) label = 'Admin funksiyalari quyida:';
      await sendMessage(chatId, label, keyboardForUser(chatId));
      return res.sendStatus(200);
    }

    // --- /status: talabaning joriy bosqichi (DB!STATUS ustunidan) ---
    if (text === '/status') {
      const s = userStates.get(chatId);
      if (!s || !s.row) {
        await sendMessage(chatId, 'Avval shartnoma raqamingizni kiriting (/start).');
        return res.sendStatus(200);
      }
      await sendStudentStatus(chatId, s.contractId, s.row);
      return res.sendStatus(200);
    }

    // --- Admin ID olish uchun texnik buyruq (har doim ishlaydi,
    // sessiyadan qat'iy nazar) ---
    if (text === '/adminid') {
      await sendMessage(chatId, `Sizning chat_id: ${chatId}\nUsername: @${username}`);
      return res.sendStatus(200);
    }

    // --- Video yuborilsa, uning file_id'sini qaytaradi (WELCOME_VIDEO_FILE_ID
    // sozlash uchun — video shaxsiy chatga bir marta yuboriladi, chiqqan
    // ID Coolify environment variable'ga qo'yiladi) ---
    if (message.video) {
      await sendMessage(chatId, `Video file_id:\n${message.video.file_id}\n\nBuni WELCOME_VIDEO_FILE_ID environment variable sifatida saqlang.`);
      return res.sendStatus(200);
    }

    // --- /start: shartnoma ID so'raladi ---
    if (text === '/start') {
      // Admin/Boss uchun kengaytirilgan buyruqlar ro'yxatini
      // ro'yxatdan o'tkazamiz (ko'k "Menu" tugmasi ostida chiqadi)
      if (isAdmin(chatId) || isBoss(chatId)) {
        await registerAdminCommands(chatId);
      }
      userStates.set(chatId, { mode: 'awaiting_id' });
      await sendMessage(chatId,
        'Assalomu alaykum! Bright Future Consulting botiga xush kelibsiz.\n\n'
        + 'Boshlash uchun biz bilan qilgan shartnoma raqamingizni kiriting.\n\n'
        + 'Botdan qanday foydalanishni bilish uchun 📖 Qo\'llanma tugmasini bosing.',
        keyboardForUser(chatId));
      return res.sendStatus(200);
    }

    // =================================================================
    // DOIMIY TUGMALAR — matn sifatida keladi. Bu blok forma
    // mantig'idan OLDIN turadi, chunki talaba forma to'ldirayotganda
    // ham tugmani bosishi mumkin.
    // =================================================================
    {
      const s = userStates.get(chatId) || {};

      if (text === BTN.COMPLAINT) {
        const s2 = userStates.get(chatId) || {};
        userStates.set(chatId, { ...s2, mode: 'awaiting_complaint', complaintPrev: s2.mode || null });
        await sendMessage(chatId,
          'Bu bildiradigan bizning kompaniyamiz haqidagi har qanday o\'rinli e\'tiroz va '
          + 'shikoyatlarni albatta ko\'rib chiqamiz va qoniqarli hal qilishga harakat qilamiz!\n\n'
          + 'E\'tiroz yoki shikoyatingizni yozing:');
        return res.sendStatus(200);
      }

      if (text === BTN.FAQ) {
        const faqs = await getFaqList();
        if (faqs.length === 0) {
          await sendMessage(chatId, 'Hozircha savol-javob ro\'yxati bo\'sh.', keyboardForUser(chatId));
          return res.sendStatus(200);
        }
        await sendMessage(chatId, 'Ko\'p so\'raladigan savollar — qiziqtirgan savolni tanlang:', buildFaqKeyboard(faqs));
        return res.sendStatus(200);
      }

      if (text === BTN.BRANCHES) {
        const branches = await getBranches();
        if (branches.length === 0) {
          await sendMessage(chatId, 'Filiallar ro\'yxati hozircha kiritilmagan.', keyboardForUser(chatId));
          return res.sendStatus(200);
        }
        await sendMessage(chatId, 'Filiallarimiz — kerakli filialni tanlang:', buildBranchesKeyboard(branches));
        return res.sendStatus(200);
      }

      if (text === BTN.CONTACTS) {
        const contacts = await getContacts();
        if (contacts.length === 0) {
          await sendMessage(chatId, 'Aloqa ma\'lumotlari hozircha kiritilmagan.', keyboardForUser(chatId));
          return res.sendStatus(200);
        }
        await sendMessage(chatId, 'Kimga bog\'lanmoqchisiz? Tanlang:', buildContactsKeyboard(contacts));
        return res.sendStatus(200);
      }

      if (text === BTN.FAQ_EDIT) {
        if (!canEditFaq(chatId)) {
          await sendMessage(chatId, 'Bu funksiya faqat supervisorlar uchun.');
          return res.sendStatus(200);
        }
        const faqs = await getFaqList();
        let listText = `FAQ ro'yxati (${faqs.length} ta savol):\n\n`;
        listText += faqs.map((f, i) => `${i + 1}. ${f.question}`).join('\n') || '(bo\'sh)';
        await sendMessage(chatId, listText, {
          inline_keyboard: [
            [{ text: '➕ Yangi savol qo\'shish', callback_data: 'faqedit:add' }],
            [{ text: '🗑 Savolni o\'chirish', callback_data: 'faqedit:del' }],
          ],
        });
        return res.sendStatus(200);
      }

      if (text === BTN.GUIDE) {
        await sendMessage(chatId, guideForUser(chatId), keyboardForUser(chatId));
        return res.sendStatus(200);
      }

      if (text === BTN.RESTART) {
        userStates.set(chatId, { mode: 'awaiting_id' });
        await sendMessage(chatId, 'Shartnoma raqamingizni kiriting:', keyboardForUser(chatId));
        return res.sendStatus(200);
      }

      if (text === BTN.HELP) {
        userStates.set(chatId, { ...s, mode: 'awaiting_help_text', helpPrev: s.mode || null });
        await sendMessage(chatId, 'Savolingizni yoki muammoingizni yozing — mas\'ul hodimimizga yetkazamiz:');
        return res.sendStatus(200);
      }

      if (text === BTN.DOCS) {
        if (!s.row) {
          await sendMessage(chatId, 'Avval shartnoma raqamingizni kiriting.', keyboardForUser(chatId));
          return res.sendStatus(200);
        }
        const rowData = await getRowData(s.row);
        const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
        await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
        return res.sendStatus(200);
      }

      if (text === BTN.STATUS) {
        if (!s.contractId) {
          await sendMessage(chatId, 'Avval shartnoma raqamingizni kiriting.', keyboardForUser(chatId));
          return res.sendStatus(200);
        }
        await sendStudentStatus(chatId, s.contractId, s.row);
        return res.sendStatus(200);
      }

      // ---- Admin / Boss tugmalari ----
      if (text === BTN.REPORT || text === BTN.SUMMARY) {
        if (!isBoss(chatId) && !isAdmin(chatId)) {
          await sendMessage(chatId, 'Bu funksiya faqat rahbariyat uchun.');
          return res.sendStatus(200);
        }
        await sendMessage(chatId, 'Tayyorlanmoqda, biroz kuting...');
        try {
          if (text === BTN.REPORT) {
            const parts = await buildBossReport();
            for (const p of parts) await sendMessage(chatId, p);
          } else {
            const sum = await buildDailySummary();
            if (sum.length <= 4000) await sendMessage(chatId, sum);
            else for (let i = 0; i < sum.length; i += 4000) await sendMessage(chatId, sum.slice(i, i + 4000));
          }
        } catch (e) {
          console.error('Hisobot/xulosa xatosi:', e);
          await sendMessage(chatId, 'Xatolik: ' + e.message);
        }
        return res.sendStatus(200);
      }

      if (text === BTN.RETURN_DOC) {
        if (!isAdmin(chatId) && !isBoss(chatId)) {
          await sendMessage(chatId, 'Bu funksiya faqat administrator uchun.');
          return res.sendStatus(200);
        }
        userStates.set(chatId, { mode: 'admin_return_awaiting_id' });
        await sendMessage(chatId, 'Qaysi talabaning hujjatlarini qaytarish kerak? Shartnoma raqamini kiriting:');
        return res.sendStatus(200);
      }

      if (text === BTN.GET_DOCS) {
        if (!isAdmin(chatId) && !isBoss(chatId)) {
          await sendMessage(chatId, 'Bu funksiya faqat rahbariyat uchun.');
          return res.sendStatus(200);
        }
        userStates.set(chatId, { mode: 'admin_get_docs_awaiting_id' });
        await sendMessage(chatId, 'Qaysi talabaning hujjatlari kerak? Shartnoma raqamini kiriting:');
        return res.sendStatus(200);
      }

      if (text === BTN.VISA) {
        if (!isAdmin(chatId) && !isBoss(chatId)) {
          await sendMessage(chatId, 'Bu funksiya faqat administrator uchun.');
          return res.sendStatus(200);
        }
        userStates.set(chatId, { mode: 'admin_visa_awaiting_id' });
        await sendMessage(chatId, 'Qaysi talaba viza bosqichiga o\'tdi? Shartnoma raqamini kiriting:\n\n(Bir nechta bo\'lsa, vergul bilan ajrating)');
        return res.sendStatus(200);
      }
    }

    // --- Yordam matni kutilmoqda ---
    const session = userStates.get(chatId);
    if (session && session.mode === 'awaiting_help_text') {
      const helpText = text;
      let contractId = session.contractId || 'noma\'lum';
      let fullName = '';
      let stage = '';

      if (session.row) {
        try {
          const rowData = await getRowData(session.row);
          fullName = rowData.E || '';
          stage = rowData[CURRENT_STEP_COLUMN] || rowData.B || '';
        } catch (e) { console.error('Yordam: qator o\'qishda xato', e); }
      }

      const msg = `🆘 TALABA YORDAM SO'RADI\n\n`
        + `Shartnoma: ${contractId}\n`
        + (fullName ? `Ism: ${fullName}\n` : '')
        + (stage ? `Bosqich: ${stage}\n` : '')
        + `Telegram: @${username || 'username yo\'q'}\n\n`
        + `Savol: ${helpText}`;

      // General topic'ga yuboriladi — message_thread_id UZATILMAYDI.
      // (Telegram'da General oqimi thread ID'siz ishlaydi; agar
      // DOCUMENT_TOPIC_ID berilsa, xabar "Original hujjatlar"
      // topic'iga tushib qoladi.)
      await sendMessage(DOCUMENT_GROUP_CHAT_ID, msg);

      // Oldingi rejimga qaytarish (forma davom etsin)
      userStates.set(chatId, { ...session, mode: session.helpPrev || 'in_form' });
      await sendMessage(chatId, 'Savolingiz mas\'ul hodimimizga yuborildi. Tez orada siz bilan bog\'lanishadi.');
      return res.sendStatus(200);
    }

    // --- FAQ tahrirlash oqimi (supervisor) ---
    if (session && session.mode === 'faq_add_question') {
      userStates.set(chatId, { ...session, mode: 'faq_add_answer', pendingQuestion: text });
      await sendMessage(chatId, 'Endi shu savolga JAVOBNI yozing:');
      return res.sendStatus(200);
    }
    if (session && session.mode === 'faq_add_answer') {
      try {
        const faqs = await getFaqList();
        const nextNum = faqs.length + 1;
        const author = username ? `@${username}` : String(chatId);
        // A:№ B:SAVOL C:JAVOB D:KIM KIRITDI
        await appendRow(`${FAQ_SHEET}!A:D`, [nextNum, session.pendingQuestion, text, author]);
        userStates.set(chatId, { ...session, mode: null, pendingQuestion: null });
        await sendMessage(chatId, 'Yangi savol-javob qo\'shildi ✅', keyboardForUser(chatId));
      } catch (e) {
        console.error('FAQ qo\'shish xatosi:', e);
        await sendMessage(chatId, 'Saqlashda xatolik: ' + e.message);
      }
      return res.sendStatus(200);
    }
    if (session && session.mode === 'faq_delete_number') {
      const idx = parseInt(text.trim(), 10);
      const faqs = await getFaqList();
      if (isNaN(idx) || idx < 1 || idx > faqs.length) {
        await sendMessage(chatId, `Noto'g'ri raqam. 1 dan ${faqs.length} gacha son kiriting.`);
        return res.sendStatus(200);
      }
      try {
        const target = faqs[idx - 1];
        // Qatorni bo'shatamiz (o'chirish o'rniga tozalash — boshqa
        // qatorlar siljimasligi uchun xavfsizroq)
        for (const col of ['A', 'B', 'C', 'D']) {
          await updateCell(`${FAQ_SHEET}!${col}${target.row}`, '');
        }
        userStates.set(chatId, { ...session, mode: null });
        await sendMessage(chatId, `"${target.question}" o'chirildi ✅`, keyboardForUser(chatId));
      } catch (e) {
        console.error('FAQ o\'chirish xatosi:', e);
        await sendMessage(chatId, 'O\'chirishda xatolik: ' + e.message);
      }
      return res.sendStatus(200);
    }

    // --- E'tiroz va shikoyat matni kutilmoqda ---
    if (session && session.mode === 'awaiting_complaint') {
      const complaintText = text;
      let contractId = session.contractId || '';
      let fullName = '';
      if (session.row) {
        try {
          const rowData = await getRowData(session.row);
          fullName = rowData.E || '';
        } catch (e) { /* jim */ }
      }

      // 1) Sheet'ga yozib qo'yamiz (tahlil uchun)
      // Ustunlar: A:№ B:DATE C:ID D:NAME E:USERNAME F:MATN
      try {
        const existing = await readSheetRange(`${COMPLAINTS_SHEET}!B2:B2000`) || [];
        const nextNum = existing.filter((r) => r && String(r[0] || '').trim()).length + 1;
        const now = new Date();
        const tashkent = new Date(now.getTime() + 5 * 3600000);
        const dateStr = tashkent.toISOString().slice(0, 16).replace('T', ' ');
        await appendRow(`${COMPLAINTS_SHEET}!A:F`, [
          nextNum, dateStr, contractId, fullName,
          username ? `@${username}` : String(chatId), complaintText,
        ]);
      } catch (e) {
        console.error('Shikoyat yozishda xato (sheet):', e);
      }

      // 2) Rahbariyatga darhol yuboramiz
      const notice = `📣 E'TIROZ / SHIKOYAT\n\n`
        + (contractId ? `Shartnoma: ${contractId}\n` : '')
        + (fullName ? `Ism: ${fullName}\n` : '')
        + `Telegram: @${username || 'yo\'q'}\n\n`
        + `Matn: ${complaintText}`;
      if (BOSS_CHAT_ID) await sendMessage(BOSS_CHAT_ID, notice);
      if (ADMIN_NOTIFY_CHAT_ID && String(ADMIN_NOTIFY_CHAT_ID) !== String(BOSS_CHAT_ID)) {
        await sendMessage(ADMIN_NOTIFY_CHAT_ID, notice);
      }
      // Supervisorlarga ham yuboriladi (ular mijoz bilan bevosita
      // ishlaydi, shuning uchun tezroq javob bera oladi)
      for (const supId of SUPERVISOR_CHAT_IDS) {
        if (String(supId) === String(BOSS_CHAT_ID)) continue;
        if (String(supId) === String(ADMIN_NOTIFY_CHAT_ID)) continue;
        await sendMessage(supId, notice);
      }

      userStates.set(chatId, { ...session, mode: session.complaintPrev || 'in_form' });
      await sendMessage(chatId,
        'Murojaatingiz qabul qilindi. Rahbariyatimizga yetkazildi — albatta ko\'rib chiqamiz.',
        keyboardForUser(chatId));
      return res.sendStatus(200);
    }

    // --- Admin oqimi: viza bosqichi uchun shartnoma ID(lar) kutilmoqda ---
    if (session && session.mode === 'admin_visa_awaiting_id') {
      userStates.delete(chatId);
      const ids = text.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const results = [];

      for (const id of ids) {
        const rowNum = await findRowByContractId(id);
        if (!rowNum) { results.push(`${id} — topilmadi`); continue; }

        const rowData = await getRowData(rowNum);
        const currentMissing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
        const newMissing = Array.from(new Set([...currentMissing, ...VISA_STAGE_DOCS]));
        await updateCell(`${DRAFT_SHEET}!AN${rowNum}`, newMissing.join(', '));
        await updateCell(`${DRAFT_SHEET}!B${rowNum}`, 'VIZA BOSQICHI');

        const studentChatId = rowData[TELEGRAM_CHAT_ID_COLUMN];
        if (studentChatId) {
          await sendMessage(studentChatId,
            'Tabriklaymiz! Siz viza olish bosqichiga o\'tdingiz.\n\n' +
            'Endi quyidagi hujjatlarni taqdim qilishingiz kerak:\n' +
            '\u2022 KDB\n\u2022 Ota-ona Bank statement (Elchixona uchun)\n\n' +
            'Hujjatlarni yuborish uchun quyidagi tugmalardan foydalaning.',
            buildDocumentMenuKeyboard(newMissing));
          results.push(`${id} — bajarildi, talabaga xabar berildi`);
        } else {
          results.push(`${id} — bajarildi, lekin talaba bot bilan bog'lanmagan`);
        }
      }

      await sendMessage(chatId, 'Natija:\n\n' + results.join('\n'));
      return res.sendStatus(200);
    }

    if (session && session.mode === 'admin_get_docs_awaiting_id') {
      const docs = await getDocumentsForContract(text);
      userStates.delete(chatId);
      if (docs.length === 0) {
        await sendMessage(chatId, `Shartnoma ${text.toUpperCase()} uchun hech qanday hujjat topilmadi.`);
        return res.sendStatus(200);
      }
      const normalizedId = text.trim().toUpperCase();
      await sendMessage(chatId, `${docs.length} ta hujjat topildi, yuborilmoqda...`);
      for (const doc of docs) {
        await sendFileTo(chatId, null, doc.fileType, doc.fileId, `${normalizedId}_${doc.docCode}`);
      }
      return res.sendStatus(200);
    }

    if (session && session.mode === 'admin_return_awaiting_id') {
      const rowNum = await findRowByContractId(text);
      if (!rowNum) {
        await sendMessage(chatId, 'Bunday shartnoma topilmadi. Qayta kiriting.');
        return res.sendStatus(200);
      }
      userStates.set(chatId, { mode: 'admin_return_selecting_docs', row: rowNum, contractId: text.trim().toUpperCase(), selectedCodes: [] });
      await sendMessage(chatId, 'Qaysi hujjat(lar) qayta so\'ralsin? Tanlang (bir nechtasini belgilash mumkin):', buildAdminDocSelectKeyboard([]));
      return res.sendStatus(200);
    }

    if (!session) {
      await sendMessage(chatId, 'Sessiya topilmadi. Iltimos /start bosing.');
      return res.sendStatus(200);
    }

    // --- Shartnoma ID tekshiruvi + XAVFSIZLIK NAZORATI ---
    if (session.mode === 'awaiting_id') {
      const rowNum = await findRowByContractId(text);
      if (!rowNum) {
        await sendMessage(chatId, 'Bunday shartnoma raqami topilmadi. Qayta kiriting yoki administratorga murojaat qiling.');
        return res.sendStatus(200);
      }
      const rowData = await getRowData(rowNum);

      // XAVFSIZLIK: agar bu qator allaqachon boshqa Telegram username
      // tomonidan "egallangan" bo'lsa (U ustuni to'ldirilgan va hozirgi
      // username bilan mos kelmasa) — telefon raqami oxirgi 4 raqami
      // orqali tasdiqlash talab qilinadi. Yangi/bo'sh qator uchun
      // (hali hech kim kirmagan) tekshiruv shart emas — sizib chiqadigan
      // ma'lumot hali yo'q.
      if (rowData.U && rowData.U !== username) {
        userStates.set(chatId, {
          mode: 'awaiting_phone_verify',
          row: rowNum,
          contractId: text.trim().toUpperCase(),
          pendingUsername: username,
        });
        await sendMessage(chatId, 'Xavfsizlik uchun, ushbu shartnomada ro\'yxatdan o\'tgan telefon raqamining OXIRGI 4 ta raqamini kiriting:');
        return res.sendStatus(200);
      }

      if (!rowData.U && username) {
        await updateCell(`${DRAFT_SHEET}!U${rowNum}`, username);
        await updateCell(`${DRAFT_SHEET}!${TELEGRAM_CHAT_ID_COLUMN}${rowNum}`, String(chatId));
      }

      const stepKey = findResumeStep(rowData);
      userStates.set(chatId, { mode: 'in_form', row: rowNum, contractId: text.trim().toUpperCase(), editing: false });

      // Faqat BIRINCHI marta kirganda (forma hali boshlanmagan) —
      // tabrik xati + tanishtiruv video yuboriladi.
      if (stepKey === FIRST_STEP) {
        await sendMessage(chatId, 'Siz bizning kompaniyamiz bilan keyingi bosqichga o\'tganingiz bilan tabriklayman! 🎉');
        await sendWelcomeVideo(chatId);
      }

      await sendMessage(chatId, 'Shartnoma tasdiqlandi. Ma\'lumot kiritishni boshlaymiz.', keyboardForUser(chatId));
      await renderStep(chatId, rowNum, stepKey, {});
      return res.sendStatus(200);
    }

    // --- Telefon raqami oxirgi 4 raqami orqali tasdiqlash ---
    if (session.mode === 'awaiting_phone_verify') {
      const rowData = await getRowData(session.row);
      const storedPhone = String(rowData.Q || '').trim();
      const enteredLast4 = text.replace(/\D/g, '').slice(-4);
      const storedLast4 = storedPhone.slice(-4);

      if (!storedPhone || enteredLast4.length !== 4 || enteredLast4 !== storedLast4) {
        await sendMessage(chatId, 'Ma\'lumotlar mos kelmadi. Bu shartnoma raqami sizga tegishli emas yoki xato kiritildi. Administratorga murojaat qiling.');
        userStates.delete(chatId);
        return res.sendStatus(200);
      }

      // Tasdiqlandi — username yangilanadi (masalan talaba yangi
      // qurilma/akkaunt ishlatayotgan bo'lishi mumkin)
      await updateCell(`${DRAFT_SHEET}!U${session.row}`, session.pendingUsername);
      await updateCell(`${DRAFT_SHEET}!${TELEGRAM_CHAT_ID_COLUMN}${session.row}`, String(chatId));
      const stepKey = findResumeStep(rowData);
      userStates.set(chatId, { mode: 'in_form', row: session.row, contractId: session.contractId, editing: false });
      await sendMessage(chatId, 'Tasdiqlandi. Davom etamiz.');
      await renderStep(chatId, session.row, stepKey, {});
      return res.sendStatus(200);
    }

    // --- Hujjatlar buyrug'i ---
    if (text === '/hujjatlar' && session.mode === 'in_form') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      return res.sendStatus(200);
    }

    // --- Fayl yuborilganda (hujjat rejimida) ---
    if ((message.document || message.photo) && session.mode === 'awaiting_document') {
      let fileId, fileType;
      if (message.document) { fileId = message.document.file_id; fileType = 'document'; }
      else { const photos = message.photo; fileId = photos[photos.length - 1].file_id; fileType = 'photo'; }

      const docCode = session.docCode;
      const contractId = session.contractId;

      // Rejimni DARHOL qaytarish — agar quyida xato chiqsa ham,
      // foydalanuvchi "hujjat kutilmoqda" holatida qotib qolmasin.
      session.mode = 'in_form';
      userStates.set(chatId, session);

      const forwardResult = await sendDocumentToGroup(fileType, fileId, contractId, docCode);

      if (!forwardResult || !forwardResult.ok) {
        console.error(`Hujjat forward xatosi (${docCode}, shartnoma ${contractId}):`, forwardResult);
        await sendMessage(chatId, 'Kechirasiz, hujjatni yuborishda texnik xatolik yuz berdi. Iltimos, qayta urinib ko\'ring yoki administratorga murojaat qiling.');
        return res.sendStatus(200);
      }

      // Sheets amallarini alohida try/catch ichida bajaramiz — bu yerda
      // xato chiqsa (masalan API kvota limiti), foydalanuvchi baribir
      // javob olishi kerak, jim qolmasligi kerak.
      try {
        await logDocument(contractId, docCode, fileType, fileId);

        // Ko'p faylli hujjat (masalan mashina texnik passporti) —
        // "yana bormi?" so'raladi, ro'yxat hali yangilanmaydi.
        if (MULTI_UPLOAD_CODES.includes(docCode)) {
          session.multiCount = (session.multiCount || 0) + 1;
          userStates.set(chatId, session);
          if (session.multiCount >= MULTI_UPLOAD_MAX) {
            await sendMessage(chatId, `Qabul qilindi (${session.multiCount}/${MULTI_UPLOAD_MAX}). Chegaraga yetdingiz.`,
              buildMoreFilesKeyboard(docCode));
          } else {
            await sendMessage(chatId, `Qabul qilindi (${session.multiCount}/${MULTI_UPLOAD_MAX}). Yana fayl yuborasizmi?`,
              buildMoreFilesKeyboard(docCode));
          }
          return res.sendStatus(200);
        }

        // PARENT_INCOME ichidagi hujjatlar — ro'yxatda 'PARENT_INCOME'
        // sifatida belgilanadi (ichki kodlar alohida sanalmaydi).
        const markCode = PARENT_INCOME_CODES.includes(docCode) ? 'PARENT_INCOME' : docCode;

        const rowData = await getRowData(session.row);
        const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
        const { updatedList, cellValue } = markDocReceived(missing, markCode);
        await updateCell(`${DRAFT_SHEET}!AN${session.row}`, cellValue);

        if (isComplete(updatedList)) {
          await updateCell(`${DRAFT_SHEET}!B${session.row}`, "HUJJATLAR TO'LIQ");
          await sendFullDocumentSetToAdmin(contractId);
          await sendMessage(chatId,
            'Barcha hujjatlaringiz muvaffaqiyatli qabul qilindi!\n\n' +
            'Hujjatlaringiz tez orada tekshirib chiqiladi. Agar xato yoki kamchilik bo\'lsa, ' +
            'mas\'ul hodimimiz siz bilan bog\'lanadi.');
        } else {
          await sendMessage(chatId, 'Hujjat qabul qilindi.\n\n' + buildMissingDocsText(updatedList),
            buildDocumentMenuKeyboard(updatedList));
        }
      } catch (sheetErr) {
        console.error('Hujjat qabul qilingandan keyingi Sheets xatosi:', sheetErr);
        // Fayl guruhga BORDI — shuning uchun "qabul qilindi" deyish
        // to'g'ri, faqat ro'yxat yangilanmagani aytiladi.
        await sendMessage(chatId,
          'Hujjatingiz qabul qilindi, lekin ro\'yxatni yangilashda texnik nosozlik yuz berdi. ' +
          'Hujjatlar holatini ko\'rish uchun /hujjatlar buyrug\'ini yuboring.');
      }

      return res.sendStatus(200);
    }

    // --- Oddiy matn javobi (forma bosqichida) ---
    if (session.mode === 'in_form' && text) {
      const rowData = await getRowData(session.row);
      const currentStepKey = rowData[CURRENT_STEP_COLUMN] || FIRST_STEP;
      const step = STUDENT_STEPS[currentStepKey];

      if (step.type === 'text') {
        await handleStepAnswer(chatId, session.row, currentStepKey, text, session);
      } else if (step.type === 'buttons_then_text' && session.awaitingFollowUp) {
        await handleStepAnswer(chatId, session.row, currentStepKey, text, session);
        session.awaitingFollowUp = false;
      } else {
        await sendMessage(chatId, 'Iltimos, tugmalardan birini tanlang.');
      }
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook xatosi:', err);
    return res.sendStatus(200);
  }
});

// =====================================================================
// GURUH OQIMI — hodim "/hujjat" buyrug'i orqali talaba hujjatlarini
// qayta so'raydi. Reply-based: bot o'z xabariga REPLY qilingan javobni
// kutadi — bu Telegram'ning privacy mode cheklovidan mustaqil ishlaydi.
// =====================================================================

async function handleGroupMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const threadId = message.message_thread_id;

  if (text === '/menu' || text.startsWith('/menu@')) {
    await sendMessage(chatId, 'Hodimlar uchun funksiyalar:', {
      inline_keyboard: [[{ text: '📄 Hujjat so\'rash', callback_data: 'groupmenu:hujjat' }]],
    }, threadId);
    return;
  }

  if (text === '/hujjat' || text.startsWith('/hujjat@')) {
    const result = await sendMessage(chatId, 'Qaysi talabaning hujjatlari kerak? Shartnoma raqamini SHU XABARGA REPLY qilib yozing.', null, threadId);
    if (result && result.result && result.result.message_id) {
      pendingGroupRequests.set(result.result.message_id, { chatId, threadId });
    }
    return;
  }

  // Reply orqali javob keldi
  if (message.reply_to_message && pendingGroupRequests.has(message.reply_to_message.message_id)) {
    const { chatId: reqChatId, threadId: reqThreadId } = pendingGroupRequests.get(message.reply_to_message.message_id);
    pendingGroupRequests.delete(message.reply_to_message.message_id);

    const contractId = text;
    const docs = await getDocumentsForContract(contractId);

    if (docs.length === 0) {
      await sendMessage(reqChatId, `Shartnoma ${contractId} uchun hech qanday hujjat topilmadi.`, null, reqThreadId);
      return;
    }

    await sendMessage(reqChatId, `Shartnoma ${contractId} uchun ${docs.length} ta hujjat topildi, yuborilmoqda...`, null, reqThreadId);
    for (const doc of docs) {
      await sendFileTo(reqChatId, reqThreadId, doc.fileType, doc.fileId, `${contractId}_${doc.docCode}`);
    }
    return;
  }

  // Boshqa guruh xabarlari — javob berilmaydi (spam qilmaslik uchun)
}

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data;
  const callbackId = callback.id;

  // --- FAQ: savol tanlandi ---
  if (data.startsWith('faq:')) {
    const idx = parseInt(data.substring(4), 10);
    answerCallbackQuery(callbackId, '');
    const faqs = await getFaqList();
    const f = faqs[idx];
    if (!f) {
      await sendMessage(chatId, 'Savol topilmadi.');
      return;
    }
    await sendMessage(chatId, `❓ ${f.question}\n\n${f.answer || '(javob hali kiritilmagan)'}`);
    return;
  }

  // --- FAQ tahrirlash ---
  if (data === 'faqedit:add') {
    if (!canEditFaq(chatId)) { answerCallbackQuery(callbackId, 'Ruxsat yo\'q.'); return; }
    const s = userStates.get(chatId) || {};
    userStates.set(chatId, { ...s, mode: 'faq_add_question' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Yangi SAVOLNI yozing:');
    return;
  }
  if (data === 'faqedit:del') {
    if (!canEditFaq(chatId)) { answerCallbackQuery(callbackId, 'Ruxsat yo\'q.'); return; }
    const s = userStates.get(chatId) || {};
    userStates.set(chatId, { ...s, mode: 'faq_delete_number' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'O\'chirmoqchi bo\'lgan savolning RAQAMINI yozing:');
    return;
  }

  // --- Filial tanlandi: manzil matn + lokatsiya ---
  if (data.startsWith('branch:')) {
    const idx = parseInt(data.substring(7), 10);
    answerCallbackQuery(callbackId, '');
    const branches = await getBranches();
    const b = branches[idx];
    if (!b) { await sendMessage(chatId, 'Filial topilmadi.'); return; }
    await sendMessage(chatId, `📍 ${b.name}\n\n${b.address || 'Manzil kiritilmagan'}`);
    if (!isNaN(b.lat) && !isNaN(b.lng)) {
      await sendLocation(chatId, b.lat, b.lng);
    }
    return;
  }

  // --- Aloqa: hodim tanlandi ---
  if (data.startsWith('contact:')) {
    const idx = parseInt(data.substring(8), 10);
    answerCallbackQuery(callbackId, '');
    const contacts = await getContacts();
    const c = contacts[idx];
    if (!c) { await sendMessage(chatId, 'Ma\'lumot topilmadi.'); return; }
    let t = `👤 ${c.name}`;
    if (c.role) t += `\n${c.role}`;
    t += `\n\n☎️ ${c.phone || 'raqam kiritilmagan'}`;
    await sendMessage(chatId, t);
    return;
  }

  // --- Guruh menyusi: "Hujjat so'rash" tugmasi ---
  if (data === 'groupmenu:hujjat') {
    const groupChatId = callback.message.chat.id;
    const groupThreadId = callback.message.message_thread_id;
    answerCallbackQuery(callbackId, '');
    const result = await sendMessage(groupChatId, 'Qaysi talabaning hujjatlari kerak? Shartnoma raqamini SHU XABARGA REPLY qilib yozing.', null, groupThreadId);
    if (result && result.result && result.result.message_id) {
      pendingGroupRequests.set(result.result.message_id, { chatId: groupChatId, threadId: groupThreadId });
    }
    return;
  }

  // --- MENYU tugmalari — sessiyasiz ham ishlashi kerak ---
  if (data === 'menu:start') {
    userStates.set(chatId, { mode: 'awaiting_id' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Biz bilan qilgan shartnoma raqamingizni kiriting:');
    return;
  }
  if (data === 'menu:docs') {
    const s = userStates.get(chatId);
    answerCallbackQuery(callbackId, '');
    if (!s || !s.row) {
      await sendMessage(chatId, 'Avval shartnoma raqamingizni kiriting (/start).');
      return;
    }
    const rowData = await getRowData(s.row);
    const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
    await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
    return;
  }
  if (data === 'menu:yordam') {
    const s = userStates.get(chatId) || {};
    userStates.set(chatId, { ...s, mode: 'awaiting_help_text', helpPrev: s.mode || null });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Savolingizni yoki muammoingizni yozing — mas\'ul hodimimizga yetkazamiz:');
    return;
  }
  if (data === 'menu:status') {
    const s = userStates.get(chatId);
    answerCallbackQuery(callbackId, '');
    if (!s || !s.row) {
      await sendMessage(chatId, 'Avval shartnoma raqamingizni kiriting (/start).');
      return;
    }
    await sendStudentStatus(chatId, s.contractId, s.row);
    return;
  }
  if (data === 'menu:xulosa') {
    if (!isBoss(chatId) && !isAdmin(chatId)) {
      answerCallbackQuery(callbackId, 'Ruxsat yo\'q.');
      return;
    }
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Xulosa tayyorlanmoqda...');
    try {
      const summary = await buildDailySummary();
      if (summary.length <= 4000) await sendMessage(chatId, summary);
      else for (let i = 0; i < summary.length; i += 4000) await sendMessage(chatId, summary.slice(i, i + 4000));
    } catch (e) {
      console.error('Xulosa xatosi:', e);
      await sendMessage(chatId, 'Xatolik: ' + e.message);
    }
    return;
  }
  if (data === 'menu:hisobot') {
    if (!isBoss(chatId) && !isAdmin(chatId)) {
      answerCallbackQuery(callbackId, 'Ruxsat yo\'q.');
      return;
    }
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Hisobot tayyorlanmoqda, biroz kuting...');
    try {
      const parts = await buildBossReport();
      for (const part of parts) await sendMessage(chatId, part);
    } catch (e) {
      console.error('Hisobot xatosi:', e);
      await sendMessage(chatId, 'Hisobot tayyorlashda xatolik: ' + e.message);
    }
    return;
  }
  if (data === 'menu:viza') {
    if (!isAdmin(chatId) && !isBoss(chatId)) {
      answerCallbackQuery(callbackId, 'Ruxsat yo\'q.');
      return;
    }
    userStates.set(chatId, { mode: 'admin_visa_awaiting_id' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Qaysi talaba viza bosqichiga o\'tdi? Shartnoma raqamini kiriting:\n\n(Bir nechta talaba bo\'lsa, vergul bilan ajratib yozing)');
    return;
  }
  if (data === 'menu:gethujjat') {
    if (!isAdmin(chatId) && !isBoss(chatId)) {
      answerCallbackQuery(callbackId, 'Ruxsat yo\'q.');
      return;
    }
    userStates.set(chatId, { mode: 'admin_get_docs_awaiting_id' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Qaysi talabaning hujjatlari kerak? Shartnoma raqamini kiriting:');
    return;
  }
  if (data === 'menu:qaytar') {
    if (!isAdmin(chatId) && !isBoss(chatId)) {
      answerCallbackQuery(callbackId, 'Ruxsat yo\'q.');
      return;
    }
    userStates.set(chatId, { mode: 'admin_return_awaiting_id' });
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Qaysi talabaning hujjatlarini qaytarish kerak? Shartnoma raqamini kiriting:');
    return;
  }

  // --- ADMIN: hujjat tanlash (qaytarish uchun) ---
  if (data.startsWith('adret:')) {
    const s = userStates.get(chatId);
    if (!s || s.mode !== 'admin_return_selecting_docs') {
      answerCallbackQuery(callbackId, 'Sessiya topilmadi.');
      return;
    }
    const action = data.substring(6);

    if (action === 'cancel') {
      userStates.delete(chatId);
      answerCallbackQuery(callbackId, 'Bekor qilindi');
      await sendMessage(chatId, 'Bekor qilindi.');
      return;
    }

    if (action === 'confirm') {
      if (s.selectedCodes.length === 0) {
        answerCallbackQuery(callbackId, 'Kamida bitta hujjat tanlang');
        return;
      }
      answerCallbackQuery(callbackId, '');

      const rowData = await getRowData(s.row);
      const currentMissing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      // Tanlangan kodlarni "kam hujjatlar" ro'yxatiga qaytarish
      // (takrorlanmasin, shuning uchun Set orqali birlashtiriladi)
      const newMissing = Array.from(new Set([...currentMissing, ...s.selectedCodes]));
      const cellValue = newMissing.join(', ');
      await updateCell(`${DRAFT_SHEET}!AN${s.row}`, cellValue);
      // STATUS'ni qaytarish — eslatma tsikli qayta ishga tushishi uchun
      await updateCell(`${DRAFT_SHEET}!B${s.row}`, 'MA\'LUMOT TASDIQLANDI');

      const studentChatId = rowData[TELEGRAM_CHAT_ID_COLUMN];
      if (studentChatId) {
        const labels = s.selectedCodes.map((code) => {
          const doc = DOCUMENT_TYPES.find((d) => d.code === code);
          return `\u2022 ${doc ? doc.label : code}`;
        }).join('\n');
        await sendMessage(studentChatId,
          `Diqqat! Quyidagi hujjat(lar)ni qayta topshirishingiz kerak:\n\n${labels}\n\nIltimos, to'g'ri hujjatni qayta yuboring.`,
          buildDocumentMenuKeyboard(newMissing));
      }

      await sendMessage(chatId, `Shartnoma ${s.contractId} uchun ${s.selectedCodes.length} ta hujjat qaytarildi. Talabaga xabar berildi.`);
      userStates.delete(chatId);
      return;
    }

    // Hujjat turi belgilash/bekor qilish (toggle)
    const idx = s.selectedCodes.indexOf(action);
    if (idx === -1) s.selectedCodes.push(action);
    else s.selectedCodes.splice(idx, 1);
    userStates.set(chatId, s);
    answerCallbackQuery(callbackId, '');
    // Tugmalarni yangilash
    const newKeyboard = buildAdminDocSelectKeyboard(s.selectedCodes);
    editMessageReplyMarkup(chatId, callback.message.message_id, newKeyboard);
    return;
  }

  const session = userStates.get(chatId);

  if (!session) {
    answerCallbackQuery(callbackId, 'Sessiya topilmadi, /start bosing.');
    return;
  }

  // --- Forma ichidagi tugma javoblari (ans:VALUE) ---
  if (data.startsWith('ans:')) {
    const value = data.substring(4);
    const rowData = await getRowData(session.row);
    const currentStepKey = rowData[CURRENT_STEP_COLUMN] || FIRST_STEP;
    const step = STUDENT_STEPS[currentStepKey];

    // full_name_warning kabi "ack"-only steplar uchun maxsus holat:
    if (step.sheetCol === null && step.type === 'buttons' && step.options.length === 1) {
      const nextKey = step.next({});
      await writeCurrentStep(session.row, nextKey);
      answerCallbackQuery(callbackId, '');
      await renderStep(chatId, session.row, nextKey, {});
      return;
    }

    if (step.type === 'buttons_then_text') {
      // Birinchi tugma bosildi (KNOWN/UNKNOWN) — followUp savol yuboriladi
      session.awaitingFollowUp = true;
      session.followUpChoice = value;
      userStates.set(chatId, session);
      answerCallbackQuery(callbackId, '');
      await sendMessage(chatId, step.followUpQuestion[value]);
      return;
    }

    answerCallbackQuery(callbackId, '');
    await handleStepAnswer(chatId, session.row, currentStepKey, value, session);
    return;
  }

  // --- Tasdiqlash sahifasi ---
  if (data === 'confirm:yes') {
    await updateCell(`${DRAFT_SHEET}!B${session.row}`, 'MA\'LUMOT TASDIQLANDI');
    answerCallbackQuery(callbackId, 'Tasdiqlandi');
    await sendMessage(chatId,
      'Ma\'lumotlaringiz tasdiqlandi!\n\nEndi kerakli hujjatlarni yuborishingiz kerak. '
      + 'Pastdagi "📄 Hujjatlarim" tugmasini bosing.',
      keyboardForUser(chatId));
    return;
  }
  if (data === 'confirm:edit') {
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, 'Qaysi ma\'lumotni tahrirlaysiz?', buildEditFieldKeyboard());
    return;
  }
  if (data.startsWith('edit:')) {
    const key = data.substring(5);
    answerCallbackQuery(callbackId, '');
    if (key === 'cancel') {
      await renderStep(chatId, session.row, 'confirm', {});
      return;
    }
    session.editing = true;
    userStates.set(chatId, session);
    await writeCurrentStep(session.row, key);
    await renderStep(chatId, session.row, key, {});
    return;
  }

  // --- Ko'p faylli hujjat: "Yana yuboraman" / "Tugadi" ---
  if (data.startsWith('more:')) {
    const code = data.substring(5);
    const count = (session.multiCount || 0);
    if (count >= MULTI_UPLOAD_MAX) {
      answerCallbackQuery(callbackId, `Ko'pi bilan ${MULTI_UPLOAD_MAX} ta`);
      return;
    }
    session.mode = 'awaiting_document';
    session.docCode = code;
    userStates.set(chatId, session);
    answerCallbackQuery(callbackId, '');
    await sendMessage(chatId, `Keyingi faylni yuboring (${count + 1}/${MULTI_UPLOAD_MAX}):`);
    return;
  }
  if (data.startsWith('moredone:')) {
    answerCallbackQuery(callbackId, '');
    session.multiCount = 0;
    userStates.set(chatId, session);
    try {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      const { updatedList, cellValue } = markDocReceived(missing, 'PARENT_INCOME');
      await updateCell(`${DRAFT_SHEET}!AN${session.row}`, cellValue);
      if (isComplete(updatedList)) {
        await updateCell(`${DRAFT_SHEET}!B${session.row}`, "HUJJATLAR TO'LIQ");
        await sendFullDocumentSetToAdmin(session.contractId);
        await sendMessage(chatId, 'Barcha hujjatlaringiz muvaffaqiyatli qabul qilindi!\n\nHujjatlaringiz tez orada tekshiriladi. Xato yoki kamchilik bo\'lsa, mas\'ul hodimimiz siz bilan bog\'lanadi.');
      } else {
        await sendMessage(chatId, 'Qabul qilindi.\n\n' + buildMissingDocsText(updatedList), buildDocumentMenuKeyboard(updatedList));
      }
    } catch (e) {
      console.error('moredone xatosi:', e);
      await sendMessage(chatId, 'Texnik nosozlik. /hujjatlar buyrug\'ini qayta yuboring.');
    }
    return;
  }

  // --- Hujjat menyusi ---
  if (data.startsWith('doc:')) {
    const code = data.substring(4);
    answerCallbackQuery(callbackId, '');

    if (code === 'bank_menu') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      await sendMessage(chatId, 'Qaysi bank statement turini yuborasiz?', buildBankStatementSubmenu(missing));
      return;
    }
    // PARENT_INCOME tugmasi — ichki ierarxiya ochiladi (fayl so'ralmaydi)
    if (code === 'PARENT_INCOME') {
      await sendMessage(chatId, 'Ota-onangizning daromadi yoki mol-mulki bo\'yicha qaysi hujjatni yuborasiz?', buildParentIncomeSubmenu());
      return;
    }
    // "Daromad/mol-mulk yo'q" — fayl so'ralmaydi, darhol bajarilgan
    // deb belgilanadi.
    if (NO_FILE_CODES.includes(code)) {
      try {
        const rowData = await getRowData(session.row);
        const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
        const { updatedList, cellValue } = markDocReceived(missing, 'PARENT_INCOME');
        await updateCell(`${DRAFT_SHEET}!AN${session.row}`, cellValue);
        await logDocument(session.contractId, 'NO_ASSETS', 'none', '-');
        if (isComplete(updatedList)) {
          await updateCell(`${DRAFT_SHEET}!B${session.row}`, "HUJJATLAR TO'LIQ");
          await sendFullDocumentSetToAdmin(session.contractId);
          await sendMessage(chatId, 'Qabul qilindi. Barcha hujjatlaringiz to\'liq!\n\nHujjatlaringiz tez orada tekshiriladi. Xato yoki kamchilik bo\'lsa, mas\'ul hodimimiz siz bilan bog\'lanadi.');
        } else {
          await sendMessage(chatId, 'Qabul qilindi.\n\n' + buildMissingDocsText(updatedList), buildDocumentMenuKeyboard(updatedList));
        }
      } catch (e) {
        console.error('NO_ASSETS xatosi:', e);
        await sendMessage(chatId, 'Texnik nosozlik. /hujjatlar buyrug\'ini qayta yuboring.');
      }
      return;
    }
    if (code === 'status') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      return;
    }
    if (code === 'back') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN, rowData.AF, rowData.AI);
      await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      return;
    }

    session.mode = 'awaiting_document';
    session.docCode = code;
    userStates.set(chatId, session);
    await sendMessage(chatId, 'Hujjat fayli yoki rasmini yuboring:');
    return;
  }

  answerCallbackQuery(callbackId, '');
}

app.get('/', (req, res) => res.send('Student bot server ishlayapti'));

// =====================================================================
// KUNIGA 2 MARTA ESLATMA — ertalab 10:00 va kechqurun 17:00 (Toshkent
// vaqti), hujjatlari hali TO'LIQ bo'lmagan talabalarga eslatma yuboradi.
// AR ustuni (LAST_DOC_REMINDER) orqali bir kunda ikki marta ortiqcha
// yuborilishining oldi olinadi.
// =====================================================================

function getTashkentHourAndDateKey() {
  const now = new Date();
  const tashkent = new Date(now.getTime() + 5 * 3600000);
  return {
    hour: tashkent.getUTCHours(),
    minute: tashkent.getUTCMinutes(),
    dateKey: tashkent.toISOString().slice(0, 10), // YYYY-MM-DD
  };
}

let reminderTickRunning = false;

// =====================================================================
// TO'LOV ESLATMASI — haftada BIR marta (dushanba 10:00, Toshkent).
// Manba: DB sahifasi (DRAFT emas).
//   PAYMENT = 'NOT PAID' -> boshlang'ich to'lov qilinmagan
//   PAYMENT = 'DEBT'     -> qisman to'lagan, qarzdorlik bor
//   PAYMENT = 'FULL' / 'OLD STUDENT' / 'REFUND' -> eslatma YO'Q
// Shovqin bo'lmasligi uchun: haftada 1 marta, yumshoq ohangda,
// ayblovsiz. To'lov holati o'zgarishi bilan avtomatik to'xtaydi.
// =====================================================================

const PAYMENT_MESSAGES = {
  'NOT PAID': 'Assalomu alaykum! Sizning shartnomangiz bo\'yicha boshlang\'ich to\'lov hali qayd etilmagan.\n\n'
    + 'Jarayonni boshlashimiz uchun to\'lovni amalga oshirishingiz kerak. '
    + 'Savollaringiz bo\'lsa yoki to\'lovni allaqachon qilgan bo\'lsangiz, filialingizga murojaat qiling.',
  'DEBT': 'Assalomu alaykum! Sizning shartnomangiz bo\'yicha qarzdorlik mavjud.\n\n'
    + 'Jarayonni kechiktirmaslik uchun qolgan summani to\'lashingizni so\'raymiz. '
    + 'Savollaringiz bo\'lsa, filialingizga murojaat qiling.',
};

let paymentTickRunning = false;

async function runPaymentReminderTick() {
  if (paymentTickRunning) return;
  paymentTickRunning = true;
  try {
    const now = new Date();
    const tashkent = new Date(now.getTime() + 5 * 3600000);
    const dayOfWeek = tashkent.getUTCDay(); // 1 = dushanba
    const hour = tashkent.getUTCHours();
    const minute = tashkent.getUTCMinutes();
    const dateKey = tashkent.toISOString().slice(0, 10);

    // Faqat dushanba 10:00-10:05 oralig'ida
    if (dayOfWeek !== 1 || hour !== 10 || minute >= 5) return;
    if (lastPaymentReminderDate === dateKey) return; // bugun allaqachon yuborilgan
    lastPaymentReminderDate = dateKey;

    const rows = await readSheetRange(`${DB_SHEET}!A2:AR3000`);
    if (!rows) return;

    let sent = 0;
    for (const row of rows) {
      if (!row) continue;
      const contractId = String(row[DB_COL.ID] || '').trim();
      const payment = String(row[DB_COL.PAYMENT] || '').trim().toUpperCase();
      const chatId = String(row[DB_COL.CHAT_ID] || '').trim();

      if (!contractId || !chatId) continue;
      const msg = PAYMENT_MESSAGES[payment];
      if (!msg) continue; // FULL / OLD STUDENT / REFUND / bo'sh — eslatma yo'q

      await sendMessage(chatId, msg);
      sent++;
    }
    console.log(`To'lov eslatmasi yuborildi: ${sent} ta talabaga (${dateKey})`);
  } catch (err) {
    console.error('To\'lov eslatmasi xatosi:', err);
  } finally {
    paymentTickRunning = false;
  }
}

// =====================================================================
// KUNLIK XULOSA — har kuni 18:00 (Toshkent) BOSS_CHAT_ID ga yuboriladi.
// "Harakatsiz talaba" DOCUMENT_LOG timestamp'lari orqali aniqlanadi
// (DB'da oxirgi harakat ustuni yo'q — shuning uchun shu yo'l).
// =====================================================================

const STALLED_DAYS = 3; // necha kundan beri harakatsiz bo'lsa signal

let lastDailySummaryDate = null;
let dailyTickRunning = false;

/**
 * DOCUMENT_LOG'dan har bir shartnoma uchun OXIRGI hujjat sanasini
 * qaytaradi: { '2609-M0001': Date, ... }
 */
async function getLastActivityMap() {
  const rows = await readSheetRange(`${DOCUMENTS_LOG_SHEET}!A2:E5000`) || [];
  const map = {};
  for (const r of rows) {
    if (!r || !r[1] || !r[0]) continue;
    const id = String(r[1]).trim().toUpperCase();
    const t = new Date(r[0]);
    if (isNaN(t.getTime())) continue;
    if (!map[id] || t > map[id]) map[id] = t;
  }
  return map;
}

async function buildDailySummary() {
  const rows = (await readSheetRange(`${DB_SHEET}!A2:AR3000`) || [])
    .filter((r) => r && String(r[DB_COL.ID] || '').trim());
  const activity = await getLastActivityMap();
  const now = new Date();
  const todayKey = new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10);

  // Bugun hujjat yuborganlar
  const activeToday = new Set();
  for (const [id, t] of Object.entries(activity)) {
    const dayKey = new Date(t.getTime() + 5 * 3600000).toISOString().slice(0, 10);
    if (dayKey === todayKey) activeToday.add(id);
  }

  // Faol bosqichdagi talabalar (jarayoni davom etayotganlar)
  const ACTIVE_STATUSES = [
    "TO'LOV QILDI", "HUJJAT YIG'ILMOQDA", "HUJJAT TO'LIQ", 'HUJJAT TAYYOR',
    "KONTRAKT TO'LADI", "KDB QO'YDI", 'COA OLDI',
  ];

  const stalled = [];   // uzoq vaqt harakatsiz
  const noActivity = []; // umuman hujjat yubormagan
  const notPaid = [];

  for (const row of rows) {
    const id = String(row[DB_COL.ID] || '').trim().toUpperCase();
    const status = String(row[DB_COL.STATUS] || '').trim().toUpperCase();
    const payment = String(row[DB_COL.PAYMENT] || '').trim().toUpperCase();
    const name = row[DB_COL.FULL_NAME] || '';
    const branch = row[DB_COL.BRANCH] || '';

    if (payment === 'NOT PAID') notPaid.push(`${id} — ${name} (${branch})`);

    if (!ACTIVE_STATUSES.includes(status)) continue;

    const last = activity[id];
    if (!last) {
      noActivity.push(`${id} — ${name} (${branch})`);
    } else {
      const days = Math.floor((now - last) / 86400000);
      if (days >= STALLED_DAYS) {
        stalled.push(`${id} — ${name} (${branch}) — ${days} kun`);
      }
    }
  }

  const statusCounts = countBy(rows, DB_COL.STATUS, (v) => v.toUpperCase());
  const g = (k) => statusCounts[k] || 0;

  let text = `🌙 KUNLIK XULOSA — ${todayKey}\n\n`;
  text += `Jami talabalar: ${rows.length} ta\n`;
  text += `Bugun hujjat yuborganlar: ${activeToday.size} ta\n\n`;

  text += `━━ FAOL BOSQICHLAR ━━\n`;
  text += `  Hujjat yig'ilmoqda: ${g("HUJJAT YIG'ILMOQDA")} ta\n`;
  text += `  Hujjat to'liq: ${g("HUJJAT TO'LIQ")} ta\n`;
  text += `  Hujjat tayyor: ${g('HUJJAT TAYYOR')} ta\n`;
  text += `  Universitetda: ${g('UNIVERSITY 1 TOPSHIRILDI') + g('UNIVERSITY 2 TOPSHIRILDI')} ta\n`;
  text += `  Elchixonada: ${g('ELCHIXONA')} ta\n`;

  if (stalled.length > 0) {
    text += `\n⚠️ ${STALLED_DAYS}+ KUN HARAKATSIZ (${stalled.length} ta)\n`;
    text += stalled.slice(0, 20).map((s) => `  • ${s}`).join('\n');
    if (stalled.length > 20) text += `\n  ...va yana ${stalled.length - 20} ta`;
  }

  if (noActivity.length > 0) {
    text += `\n\n🔴 UMUMAN HUJJAT YUBORMAGAN (${noActivity.length} ta)\n`;
    text += noActivity.slice(0, 20).map((s) => `  • ${s}`).join('\n');
    if (noActivity.length > 20) text += `\n  ...va yana ${noActivity.length - 20} ta`;
  }

  if (notPaid.length > 0) {
    text += `\n\n💰 TO'LOV QILMAGANLAR (${notPaid.length} ta)\n`;
    text += notPaid.slice(0, 15).map((s) => `  • ${s}`).join('\n');
    if (notPaid.length > 15) text += `\n  ...va yana ${notPaid.length - 15} ta`;
  }

  if (stalled.length === 0 && noActivity.length === 0) {
    text += `\n\n✅ Harakatsiz talaba yo'q — barchasi jarayonda.`;
  }

  return text;
}

async function runDailySummaryTick() {
  if (dailyTickRunning) return;
  dailyTickRunning = true;
  try {
    if (!BOSS_CHAT_ID) return;
    const t = new Date(Date.now() + 5 * 3600000);
    const hour = t.getUTCHours();
    const minute = t.getUTCMinutes();
    const dateKey = t.toISOString().slice(0, 10);

    if (hour !== 18 || minute >= 5) return;
    if (lastDailySummaryDate === dateKey) return;
    lastDailySummaryDate = dateKey;

    const text = await buildDailySummary();
    // Telegram xabar chegarasi ~4096 belgi — kerak bo'lsa bo'linadi
    if (text.length <= 4000) {
      await sendMessage(BOSS_CHAT_ID, text);
    } else {
      for (let i = 0; i < text.length; i += 4000) {
        await sendMessage(BOSS_CHAT_ID, text.slice(i, i + 4000));
      }
    }
    console.log(`Kunlik xulosa yuborildi: ${dateKey}`);
  } catch (err) {
    console.error('Kunlik xulosa xatosi:', err);
  } finally {
    dailyTickRunning = false;
  }
}

let lastPaymentReminderDate = null;

async function runDocumentReminderTick() {
  if (reminderTickRunning) return;
  reminderTickRunning = true;
  try {
    const { hour, minute, dateKey } = getTashkentHourAndDateKey();
    const isReminderWindow = (hour === 10 || hour === 16) && minute < 5;
    if (!isReminderWindow) return;

    const reminderKey = `${dateKey}-${hour}`;
    const rows = await readSheetRange(`${DRAFT_SHEET}!A2:AR2000`);
    if (!rows) return;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const rowNum = i + 2;
      const status = row[1] || ''; // B
      const contractId = row[3] || ''; // D
      const missingCell = row[39] || ''; // AN
      const fatherName = row[31] || ''; // AF
      const motherName = row[34] || ''; // AI
      const chatId = row[42] || ''; // AQ
      const lastReminder = row[43] || ''; // AR

      if (!contractId || !chatId) continue;
      // Eslatma faqat shu ikki holatda yuboriladi:
      //  - MA'LUMOT TASDIQLANDI: birinchi bosqich hujjatlari yig'ilmoqda
      //  - VIZA BOSQICHI: admin /viza orqali KDB va ota-ona statement
      //    talab qilgan, ular hali to'liq emas
      const st = String(status).toUpperCase();
      if (st !== 'MA\'LUMOT TASDIQLANDI' && st !== 'VIZA BOSQICHI') continue;
      if (lastReminder === reminderKey) continue; // shu oyna uchun allaqachon yuborilgan

      const missing = getMissingDocs(missingCell, fatherName, motherName);
      if (isComplete(missing)) continue; // hammasi topshirilgan

      await sendMessage(chatId, 'Eslatma: hujjatlaringiz hali to\'liq emas.\n\n' + buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      await updateCell(`${DRAFT_SHEET}!AR${rowNum}`, reminderKey);
    }
  } catch (err) {
    console.error('Eslatma tick xatosi:', err);
  } finally {
    reminderTickRunning = false;
  }
}

app.listen(PORT, () => {
  console.log(`Student bot ${PORT} portida ishga tushdi`);
  // Telegram "Menu" tugmasi uchun buyruqlar ro'yxatini ro'yxatdan
  // o'tkazamiz (bir marta, server ishga tushganda yetarli)
  registerDefaultCommands().catch((e) => console.error('setMyCommands xatosi:', e));
  setInterval(runDocumentReminderTick, 5 * 60 * 1000);
  setInterval(runPaymentReminderTick, 5 * 60 * 1000);
  setInterval(runDailySummaryTick, 5 * 60 * 1000);
});
