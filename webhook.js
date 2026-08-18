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
  sendDocumentToGroup, DOCUMENT_TYPES, REQUIRED_DOCS,
} = require('./documentCollection');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.STUDENT_BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const DRAFT_SHEET = 'DRAFT';
const DOCUMENTS_LOG_SHEET = 'DOCUMENT_LOG'; // A:timestamp B:contractId C:docCode D:fileType E:fileId

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
  return rows
    .filter((r) => r && String(r[1]).trim() === contractId.trim())
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
// FUNKSIYA MENYULARI (rol asosida farqlanadi)
// ---------------------------------------------------------------------

function buildStudentMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🆕 Boshlash / shartnoma ID', callback_data: 'menu:start' }],
      [{ text: '📄 Hujjatlar holati', callback_data: 'menu:docs' }],
    ],
  };
}

function buildAdminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '♻️ Hujjatni qaytarish', callback_data: 'menu:qaytar' }],
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

  // XAVFSIZLIK/MANTIQ TEKSHIRUVI: otasining telefon raqami talabaning
  // o'z raqami bilan bir xil bo'lishi mumkin emas.
  if (stepKey === 'father_phone') {
    const rowData = await getRowData(rowNum);
    if (rowData.Q && rowData.Q.replace(/\D/g, '') === trimmedValue.replace(/\D/g, '')) {
      await sendMessage(chatId, 'Bu raqam sizning o\'z telefon raqamingiz bilan bir xil. Otangizning boshqa (haqiqiy) raqamini kiriting:');
      return;
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
    const text = (message.text || '').trim();
    const username = message.from.username || '';

    // --- ADMIN: /qaytar — hujjatlardan birortasi to'g'ri bo'lmasa,
    // Murodil shu buyruq orqali qaysi hujjat(lar) qayta so'ralishini
    // belgilaydi. Faqat ADMIN_NOTIFY_CHAT_ID'dan ishlaydi.
    if (text === '/qaytar') {
      if (!ADMIN_NOTIFY_CHAT_ID || String(chatId) !== String(ADMIN_NOTIFY_CHAT_ID)) {
        await sendMessage(chatId, 'Bu buyruq faqat administrator uchun.');
        return res.sendStatus(200);
      }
      userStates.set(chatId, { mode: 'admin_return_awaiting_id' });
      await sendMessage(chatId, 'Qaysi talabaning hujjatlarini qaytarish kerak? Shartnoma raqamini kiriting:');
      return res.sendStatus(200);
    }

    // --- Funksiya menyusi (rol asosida farqlanadi) ---
    if (text === '/menu') {
      if (ADMIN_NOTIFY_CHAT_ID && String(chatId) === String(ADMIN_NOTIFY_CHAT_ID)) {
        await sendMessage(chatId, 'Admin funksiyalari:', buildAdminMenuKeyboard());
      } else {
        await sendMessage(chatId, 'Funksiyalar:', buildStudentMenuKeyboard());
      }
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
      userStates.set(chatId, { mode: 'awaiting_id' });
      await sendMessage(chatId, 'Assalomu alaykum! Biz bilan qilgan shartnoma raqamingizni kiriting:');
      return res.sendStatus(200);
    }

    // --- Admin oqimi: shartnoma ID kutilmoqda ---
    const session = userStates.get(chatId);
    if (session && session.mode === 'admin_return_awaiting_id') {
      const rowNum = await findRowByContractId(text);
      if (!rowNum) {
        await sendMessage(chatId, 'Bunday shartnoma topilmadi. Qayta kiriting.');
        return res.sendStatus(200);
      }
      userStates.set(chatId, { mode: 'admin_return_selecting_docs', row: rowNum, contractId: text, selectedCodes: [] });
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
          contractId: text,
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
      userStates.set(chatId, { mode: 'in_form', row: rowNum, contractId: text, editing: false });

      // Faqat BIRINCHI marta kirganda (forma hali boshlanmagan) —
      // tabrik xati + tanishtiruv video yuboriladi.
      if (stepKey === FIRST_STEP) {
        await sendMessage(chatId, 'Siz bizning kompaniyamiz bilan keyingi bosqichga o\'tganingiz bilan tabriklayman! 🎉');
        await sendWelcomeVideo(chatId);
      }

      await sendMessage(chatId, 'Shartnoma tasdiqlandi. Ma\'lumot kiritishni boshlaymiz.');
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
      const missing = getMissingDocs(rowData.AN);
      await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      return res.sendStatus(200);
    }

    // --- Fayl yuborilganda (hujjat rejimida) ---
    if ((message.document || message.photo) && session.mode === 'awaiting_document') {
      let fileId, fileType;
      if (message.document) { fileId = message.document.file_id; fileType = 'document'; }
      else { const photos = message.photo; fileId = photos[photos.length - 1].file_id; fileType = 'photo'; }

      const forwardResult = await sendDocumentToGroup(fileType, fileId, session.contractId, session.docCode);

      if (!forwardResult || !forwardResult.ok) {
        // Guruhga yuborish MUVAFFAQIYATSIZ bo'ldi — hujjat "qabul
        // qilindi" deb belgilanmaydi, talabaga aniq aytiladi.
        console.error(`Hujjat forward xatosi (${session.docCode}, shartnoma ${session.contractId}):`, forwardResult);
        await sendMessage(chatId, 'Kechirasiz, hujjatni yuborishda texnik xatolik yuz berdi. Iltimos, qayta urinib ko\'ring yoki administratorga murojaat qiling.');
        return res.sendStatus(200);
      }

      const rowData = await getRowData(session.row);
      // Muvaffaqiyatli forward qilindi — keyinchalik hodim so'rovi
      // uchun jurnalga yoziladi.
      await logDocument(session.contractId, session.docCode, fileType, fileId);
      const missing = getMissingDocs(rowData.AN);
      const { updatedList, cellValue } = markDocReceived(missing, session.docCode);
      await updateCell(`${DRAFT_SHEET}!AN${session.row}`, cellValue);

      if (isComplete(updatedList)) {
        await updateCell(`${DRAFT_SHEET}!B${session.row}`, "HUJJATLAR TO'LIQ");
        // Barcha hujjatlar to'liq bo'ldi — belgilangan hodimga
        // (masalan @murodil_oke) FULL holda qayta yuboriladi.
        await sendFullDocumentSetToAdmin(session.contractId);
      }

      session.mode = 'in_form';
      userStates.set(chatId, session);
      await sendMessage(chatId, 'Hujjat qabul qilindi.\n\n' + buildMissingDocsText(updatedList),
        updatedList.length > 0 ? buildDocumentMenuKeyboard(updatedList) : null);
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
    const missing = getMissingDocs(rowData.AN);
    await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
    return;
  }
  if (data === 'menu:qaytar') {
    if (!ADMIN_NOTIFY_CHAT_ID || String(chatId) !== String(ADMIN_NOTIFY_CHAT_ID)) {
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
      const currentMissing = getMissingDocs(rowData.AN);
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
    await sendMessage(chatId, 'Ma\'lumotlaringiz tasdiqlandi. Endi kerakli hujjatlarni yuborishingiz kerak. /hujjatlar buyrug\'ini yuboring.');
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

  // --- Hujjat menyusi ---
  if (data.startsWith('doc:')) {
    const code = data.substring(4);
    answerCallbackQuery(callbackId, '');

    if (code === 'bank_menu') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN);
      await sendMessage(chatId, 'Qaysi bank statement turini yuborasiz?', buildBankStatementSubmenu(missing));
      return;
    }
    if (code === 'status') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN);
      await sendMessage(chatId, buildMissingDocsText(missing), buildDocumentMenuKeyboard(missing));
      return;
    }
    if (code === 'back') {
      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN);
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
      const chatId = row[42] || ''; // AQ
      const lastReminder = row[43] || ''; // AR

      if (!contractId || !chatId) continue;
      if (status !== 'MA\'LUMOT TASDIQLANDI') continue; // hali forma tasdiqlanmagan
      if (lastReminder === reminderKey) continue; // shu oyna uchun allaqachon yuborilgan

      const missing = getMissingDocs(missingCell);
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
  setInterval(runDocumentReminderTick, 5 * 60 * 1000);
});
