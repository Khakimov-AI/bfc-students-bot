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
  sendDocumentToGroup,
} = require('./documentCollection');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.STUDENT_BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const DRAFT_SHEET = 'DRAFT';

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// chatId -> { row, contractId, mode, editing }
const userStates = new Map();

// Ustun harfini rowData obyekt kalitiga aylantirish uchun mos ustun
// diapazoni (A dan AP gacha).
const COLUMN_RANGE = 'A:AP';
const LAST_COLUMN_INDEX = 42; // AP = 42-ustun

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
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && String(rows[i][0]).trim() === contractId.trim()) {
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
  const range = `${DRAFT_SHEET}!A${rowNum}:AP${rowNum}`;
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
// TELEGRAM API (staff bot patterni bilan bir xil)
// ---------------------------------------------------------------------

function sendMessage(chatId, text, replyMarkup) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
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

  if (step.validate && !step.validate(answerValue)) {
    await sendMessage(chatId, step.errorMsg || 'Format noto\'g\'ri, qayta kiriting.');
    return;
  }

  await writeStepValue(rowNum, step.sheetCol, answerValue);

  // Tahrirlash rejimida bo'lsa — javobni yozib, to'g'ridan-to'g'ri
  // tasdiqlash sahifasiga qaytariladi (oddiy zanjirni davom ettirmaydi).
  if (session.editing) {
    session.editing = false;
    await writeCurrentStep(rowNum, 'confirm');
    return renderStep(chatId, rowNum, 'confirm', {});
  }

  const sessionData = { [stepKey]: answerValue };
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

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const username = message.from.username || '';

    // --- /start: shartnoma ID so'raladi ---
    if (text === '/start') {
      userStates.set(chatId, { mode: 'awaiting_id' });
      await sendMessage(chatId, 'Assalomu alaykum! Biz bilan qilgan shartnoma raqamingizni kiriting:');
      return res.sendStatus(200);
    }

    const session = userStates.get(chatId);

    if (!session) {
      await sendMessage(chatId, 'Sessiya topilmadi. Iltimos /start bosing.');
      return res.sendStatus(200);
    }

    // --- Shartnoma ID tekshiruvi ---
    if (session.mode === 'awaiting_id') {
      const rowNum = await findRowByContractId(text);
      if (!rowNum) {
        await sendMessage(chatId, 'Bunday shartnoma raqami topilmadi. Qayta kiriting yoki administratorga murojaat qiling.');
        return res.sendStatus(200);
      }
      const rowData = await getRowData(rowNum);

      // Telegram username'ni avtomatik yozib qo'yish (savol so'ramasdan)
      if (!rowData.U && username) {
        await updateCell(`${DRAFT_SHEET}!U${rowNum}`, username);
      }

      const stepKey = findResumeStep(rowData);
      userStates.set(chatId, { mode: 'in_form', row: rowNum, contractId: text, editing: false });

      await sendMessage(chatId, 'Shartnoma tasdiqlandi. Ma\'lumot kiritishni boshlaymiz.');
      await renderStep(chatId, rowNum, stepKey, {});
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

      await sendDocumentToGroup(fileType, fileId, session.contractId, session.docCode);

      const rowData = await getRowData(session.row);
      const missing = getMissingDocs(rowData.AN);
      const { updatedList, cellValue } = markDocReceived(missing, session.docCode);
      await updateCell(`${DRAFT_SHEET}!AN${session.row}`, cellValue);

      if (isComplete(updatedList)) {
        await updateCell(`${DRAFT_SHEET}!B${session.row}`, "HUJJATLAR TO'LIQ");
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

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data;
  const callbackId = callback.id;
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

app.listen(PORT, () => {
  console.log(`Student bot ${PORT} portida ishga tushdi`);
});
