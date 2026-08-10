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
  { code: 'BIRTH_CERT', label: 'Birth certificate' },
  { code: 'PHOTO', label: 'Photo' },
  { code: 'FATHER_PASSPORT', label: "Father's passport" },
  { code: 'MOTHER_PASSPORT', label: "Mother's passport" },
  { code: 'CERTIFICATE', label: 'Sertifikat (til)' },
  { code: 'BANK_STATEMENT_UNIVERSITY', label: 'Bank statement (Universitet uchun)' },
  { code: 'BANK_STATEMENT_EMBASSY_STUDENT', label: 'Bank statement (Elchixona uchun)' },
  { code: 'BANK_STATEMENT_EMBASSY_PARENT', label: 'Ota-ona Bank statement (Elchixona uchun)' },
  { code: 'PARENT_INCOME', label: "Ota-ona yillik daromadi / mol-mulk hujjati" },
];

const BANK_STATEMENT_CODES = [
  'BANK_STATEMENT_UNIVERSITY',
  'BANK_STATEMENT_EMBASSY_STUDENT',
  'BANK_STATEMENT_EMBASSY_PARENT',
];

const REQUIRED_DOCS = DOCUMENT_TYPES.map((d) => d.code);

// ---------------------------------------------------------------------
// MISSING DOCS holatini boshqarish
// ---------------------------------------------------------------------

/**
 * AN ustunidagi qiymatdan hozirgi "kam hujjatlar" ro'yxatini oladi.
 * Bo'sh bo'lsa — hammasi kam deb hisoblanadi (forma yangi boshlangan).
 */
function getMissingDocs(anCellValue) {
  if (!anCellValue || String(anCellValue).trim() === '') {
    return [...REQUIRED_DOCS];
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
    BANK_STATEMENT_EMBASSY_STUDENT: 'Elchixona uchun (talaba)',
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
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
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
  BANK_STATEMENT_CODES,
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
