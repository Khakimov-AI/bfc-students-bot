// =====================================================================
// DOCUMENT COLLECTION MODULE
// Talaba hujjatlarini qabul qilib, "Supervisors" guruhidagi
// "Original hujjatlar" topic'iga forward qiladi. Fayl serverga
// yuklanmaydi — file_id orqali to'g'ridan-to'g'ri qayta yuboriladi
// (Telegram'ning o'z serveridan-serveriga o'tadi).
//
// Fayl NOMI o'zgarmaydi (talaba yuborgan asl nom saqlanadi) — buning
// o'rniga CAPTION orqali identifikatsiya qilinadi:
//   {shartnoma_raqami}_{hujjat_turi_kodi}
//   masalan: 2703-B0001_PASSPORT
//
// Draft_Student_Info!AN (MISSING DOCS) ustuni "kam hujjatlar" ro'yxatini
// saqlaydi — vergul bilan ajratilgan kod ro'yxati. Bo'sh bo'lsa,
// birinchi chaqiriqda REQUIRED_DOCS bilan to'ldiriladi.
// =====================================================================

const https = require('https');

const BOT_TOKEN = process.env.STUDENT_BOT_TOKEN;
const DOCUMENT_GROUP_CHAT_ID = '-1003750734641'; // "Supervisors" guruhi
const DOCUMENT_TOPIC_ID = 205; // "Original hujjatlar" topic

// ---------------------------------------------------------------------
// HUJJAT TURLARI (spec #1-12 asosida, bank statement 3ga bo'lingan)
// ---------------------------------------------------------------------
const DOCUMENT_TYPES = [
  { code: 'ID', label: 'ID karta' },
  { code: 'PASSPORT', label: 'Passport (chet elga chiqish)' },
  { code: 'DIPLOM', label: 'Diplom yoki shahodatnoma' },
  { code: 'BIRTH_CERT', label: "Tug'ilganlik to'g'risidagi ma'lumotnoma (Metrka)" },
  { code: 'PHOTO', label: 'Rasm 3x4' },
  { code: 'FATHER_PASSPORT', label: 'Otangizning passporti' },
  { code: 'MOTHER_PASSPORT', label: 'Onangizning passporti' },
  { code: 'FATHER_DEATH_CERT', label: "Otangizning o'limi to'g'risidagi ma'lumotnoma" },
  { code: 'MOTHER_DEATH_CERT', label: "Onangizning o'limi to'g'risidagi ma'lumotnoma" },
  { code: 'DIVORCE_CERT', label: "Ajrashganlik to'g'risidagi ma'lumotnoma" },
  { code: 'CERTIFICATE', label: 'Sertifikat (til)' },
  { code: 'BANK_STATEMENT_UNIVERSITY', label: 'Bank statement (Universitet uchun)' },
  { code: 'KDB', label: 'KDB' },
  { code: 'BANK_STATEMENT_EMBASSY_PARENT', label: 'Ota-ona Bank statement (Elchixona uchun)' },
  { code: 'PARENT_INCOME', label: "Ota-ona yillik daromadi / mol-mulk hujjati" },
];

const BANK_STATEMENT_CODES = [
  'BANK_STATEMENT_UNIVERSITY',
  'KDB',
  'BANK_STATEMENT_EMBASSY_PARENT',
];

// Ota-ona holatiga bog'liq hujjatlar — ular DOIM so'ralmaydi,
// faqat tegishli holat bo'lganda ro'yxatga qo'shiladi.
const CONDITIONAL_DOCS = [
  'FATHER_PASSPORT', 'MOTHER_PASSPORT',
  'FATHER_DEATH_CERT', 'MOTHER_DEATH_CERT', 'DIVORCE_CERT',
];

// VIZA BOSQICHI hujjatlari — boshida so'ralmaydi. Talaba universitetga
// qabul qilinib, kontraktni to'lagandan keyin, ADMIN buyrug'i bilan
// (/viza) shu hujjatlar talab qilinadigan ro'yxatga qo'shiladi.
const VISA_STAGE_DOCS = [
  'KDB',
  'BANK_STATEMENT_EMBASSY_PARENT',
];

// Birinchi bosqichda (universitetga topshirish uchun) talab
// qilinadigan hujjatlar — shartli va viza bosqichi hujjatlarisiz.
const BASE_REQUIRED_DOCS = DOCUMENT_TYPES
  .map((d) => d.code)
  .filter((code) => !CONDITIONAL_DOCS.includes(code) && !VISA_STAGE_DOCS.includes(code));

/**
 * Ota va ona holatiga qarab (NORMAL / DEAD / DIVORCED), BIRINCHI
 * BOSQICHDA talab qilinadigan hujjatlar ro'yxatini shakllantiradi.
 * Viza bosqichi hujjatlari (KDB, ota-ona elchixona statement) bu
 * ro'yxatga KIRMAYDI — ular keyinroq admin tomonidan qo'shiladi.
 * @param {string} fatherName - AF ustuni qiymati ('DEAD'/'DIVORCED'/ism)
 * @param {string} motherName - AI ustuni qiymati
 */
function buildRequiredDocs(fatherName, motherName) {
  const docs = [...BASE_REQUIRED_DOCS];
  const f = String(fatherName || '').trim().toUpperCase();
  const m = String(motherName || '').trim().toUpperCase();

  if (f === 'DEAD') docs.push('FATHER_DEATH_CERT');
  else if (f !== 'DIVORCED' && f !== '') docs.push('FATHER_PASSPORT');

  if (m === 'DEAD') docs.push('MOTHER_DEATH_CERT');
  else if (m !== 'DIVORCED' && m !== '') docs.push('MOTHER_PASSPORT');

  // Ota YOKI ona ajrashgan bo'lsa — ajrashganlik hujjati bir marta
  if (f === 'DIVORCED' || m === 'DIVORCED') docs.push('DIVORCE_CERT');

  return docs;
}

const REQUIRED_DOCS = DOCUMENT_TYPES.map((d) => d.code);

// ---------------------------------------------------------------------
// MISSING DOCS holatini boshqarish
// ---------------------------------------------------------------------

/**
 * AN ustunidagi qiymatdan hozirgi "kam hujjatlar" ro'yxatini oladi.
 * Bo'sh bo'lsa — ota-ona holatiga qarab hisoblangan to'liq ro'yxat
 * qaytariladi (fatherName/motherName berilgan bo'lsa).
 */
function getMissingDocs(anCellValue, fatherName, motherName) {
  if (!anCellValue || String(anCellValue).trim() === '') {
    return buildRequiredDocs(fatherName, motherName);
  }
  return String(anCellValue)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => REQUIRED_DOCS.includes(s));
}

/**
 * Bitta hujjat qabul qilingandan keyin, uni ro'yxatdan olib tashlab,
 * AN ustuniga yozish uchun yangi string qaytaradi.
 */
function markDocReceived(missingList, code) {
  const updated = missingList.filter((c) => c !== code);
  return { updatedList: updated, cellValue: updated.join(', ') };
}

function isComplete(missingList) {
  return missingList.length === 0;
}

// ---------------------------------------------------------------------
// TUGMALAR
// ---------------------------------------------------------------------

function buildDocumentMenuKeyboard(missingList) {
  const rows = [];
  const nonBankMissing = missingList.filter((c) => !BANK_STATEMENT_CODES.includes(c));
  const bankMissing = missingList.filter((c) => BANK_STATEMENT_CODES.includes(c));

  for (const code of nonBankMissing) {
    const doc = DOCUMENT_TYPES.find((d) => d.code === code);
    rows.push([{ text: doc.label, callback_data: `doc:${code}` }]);
  }

  if (bankMissing.length > 0) {
    rows.push([{ text: 'Bank statement', callback_data: 'doc:bank_menu' }]);
  }

  rows.push([{ text: 'Hujjatlar holatini ko\'rish', callback_data: 'doc:status' }]);
  return { inline_keyboard: rows };
}

function buildBankStatementSubmenu(missingList) {
  const rows = [];
  const labels = {
    BANK_STATEMENT_UNIVERSITY: 'Universitet uchun',
    KDB: 'KDB',
    BANK_STATEMENT_EMBASSY_PARENT: 'Elchixona uchun (ota-ona)',
  };
  for (const code of BANK_STATEMENT_CODES) {
    if (!missingList.includes(code)) continue;
    rows.push([{ text: labels[code], callback_data: `doc:${code}` }]);
  }
  rows.push([{ text: '\u2190 Orqaga', callback_data: 'doc:back' }]);
  return { inline_keyboard: rows };
}

function buildMissingDocsText(missingList) {
  if (isComplete(missingList)) {
    return 'Barcha kerakli hujjatlar qabul qilindi. Rahmat!';
  }
  const lines = missingList.map((code) => {
    const doc = DOCUMENT_TYPES.find((d) => d.code === code);
    return `\u2022 ${doc.label}`;
  });
  return `Hali quyidagi hujjatlar yetishmayapti:\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------
// TELEGRAM API — guruh/topic'ga forward
// ---------------------------------------------------------------------

function sendDocumentToGroup(fileType, fileId, contractId, docCode) {
  return new Promise((resolve, reject) => {
    const method = fileType === 'photo' ? 'sendPhoto' : 'sendDocument';
    const fieldName = fileType === 'photo' ? 'photo' : 'document';
    const caption = `${contractId}_${docCode}`;

    const payload = {
      chat_id: DOCUMENT_GROUP_CHAT_ID,
      message_thread_id: DOCUMENT_TOPIC_ID,
      [fieldName]: fileId,
      caption: caption,
    };

    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          console.error('sendDocumentToGroup: javobni JSON qilib o\'qib bo\'lmadi:', body);
          return resolve({ ok: false, description: 'Invalid JSON response' });
        }
        if (!parsed.ok) {
          // MUHIM: bu xato konteyner loglarida ko'rinadi (docker logs orqali).
          // Eng ko'p uchraydigan sabablar: bot guruhga a'zo emas,
          // message_thread_id noto'g'ri/mavjud emas, yoki bot guruhda
          // xabar yozish huquqiga ega emas.
          console.error('sendDocumentToGroup XATO:', JSON.stringify(parsed));
        }
        resolve(parsed);
      });
    });
    req.on('error', (err) => {
      console.error('sendDocumentToGroup tarmoq xatosi:', err);
      resolve({ ok: false, description: err.message });
    });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------
// ASOSIY OQIM (webhook handlerda ishlatiladigan yordamchi funksiya)
// ---------------------------------------------------------------------
//
// Foydalanish tartibi (webhook.js ichida):
//
// 1. Talaba "Hujjatlar" buyrug'ini bosadi:
//      const missing = getMissingDocs(rowData.AN);
//      sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
//
// 2. Talaba "doc:PASSPORT" tugmasini bosadi:
//      userStates.set(chatId, { mode: 'awaiting_document', docCode: 'PASSPORT' });
//      sendMessage(chatId, "Passport rasmi/skanini yuboring:");
//
// 3. Talaba fayl (document/photo) yuboradi:
//      const state = userStates.get(chatId);
//      await sendDocumentToGroup(fileType, fileId, contractId, state.docCode);
//      const missing = getMissingDocs(rowData.AN);
//      const { updatedList, cellValue } = markDocReceived(missing, state.docCode);
//      await updateCell(`Draft_Student_Info!AN${row}`, cellValue);
//      sendMessage(chatId, buildMissingDocsText(updatedList), buildDocumentMenuKeyboard(updatedList));
//      userStates.delete(chatId);
//
// 4. "doc:bank_menu" bosilsa -> buildBankStatementSubmenu(missing) ko'rsatiladi.
// 5. "doc:status" bosilsa -> buildMissingDocsText(missing) qayta yuboriladi.

module.exports = {
  DOCUMENT_TYPES,
  REQUIRED_DOCS,
  BASE_REQUIRED_DOCS,
  CONDITIONAL_DOCS,
  VISA_STAGE_DOCS,
  BANK_STATEMENT_CODES,
  buildRequiredDocs,
  getMissingDocs,
  markDocReceived,
  isComplete,
  buildDocumentMenuKeyboard,
  buildBankStatementSubmenu,
  buildMissingDocsText,
  sendDocumentToGroup,
  DOCUMENT_GROUP_CHAT_ID,
  DOCUMENT_TOPIC_ID,
};
