// =====================================================================
// HODIMLAR UCHUN TALABA PROFILI — oddiy matn (Telegram HTML)
// /talaba ID buyrug'i shu yerdagi formatlash bilan javob beradi.
// =====================================================================
const { FIELDS } = require('./studentData');

// DRAFT'dan olingan qiymat belgisi. Telegram matnida rang berib
// bo'lmaydi (faqat qalin/kursiv), shuning uchun qizil emoji ishlatiladi.
const DRAFT_MARK = '🔺';

const SECTIONS = [
  ['note', '❗ MUHIM IZOH'],
  ['status', '📌 HOLAT'],
  ['uni', '🎓 UNIVERSITETLAR'],
  ['personal', '👤 SHAXSIY MA’LUMOT'],
  ['passport', '🛂 PASSPORT'],
  ['edu', '🏫 TA’LIM'],
  ['cert', '📝 SERTIFIKAT'],
  ['family', '👨‍👩‍👦 OTA-ONA VA DAROMAD'],
  ['goal', '🎯 MAQSAD VA OTKAZ'],
  ['docs', '📄 HUJJATLAR'],
];

// Bo'sh bo'lsa ham "bo'sh maydonlar" ro'yxatiga kiritilmaydigan maydonlar
// (ixtiyoriy/shartli ma'lumotlar)
const OPTIONAL_KEYS = new Set([
  'uni2', 'uni3', 'zip', 'testReport', 'examDate', 'testIssue', 'testExpiry', 'score', 'certificate',
  'houseDate', 'carDate', 'note', 'missingDocs', 'schoolPhone', 'schoolAddress', 'agreementCompany',
  'bfSoha', 'bankStatement', 'income', 'chatId', 'telegram', 'docStatus',
]);

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "2027.03.15", "15.03.2027", "2027-03-15" -> Date | null */
function parseDate(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

function ageOf(dob, today) {
  const d = parseDate(dob);
  if (!d) return null;
  let a = today.getUTCFullYear() - d.getUTCFullYear();
  const md = (today.getUTCMonth() - d.getUTCMonth()) || (today.getUTCDate() - d.getUTCDate());
  if (md < 0) a--;
  return a > 5 && a < 90 ? a : null;
}

/** Muddat tekshiruvi: o'tgan / 6 oydan kam qolgan */
function expiryNote(v, today, warnMonths) {
  const d = parseDate(v);
  if (!d) return '';
  const days = Math.floor((d - today) / 86400000);
  if (days < 0) return ' ⛔️ muddati o‘tgan';
  if (days < warnMonths * 30.5) return ` ⚠️ ${Math.max(1, Math.round(days / 30.5))} oy qoldi`;
  return '';
}

/**
 * @param {Object} p
 *   values, fromDraft (merge natijasi), today: Date,
 *   supervisorPhone, docsCount (DOCUMENT_LOG'dagi fayllar soni),
 *   missingDocLabels: string[] | null (DB bo'sh bo'lsa DRAFT kodlaridan),
 *   inDb: boolean, columnWarnings: string[]
 * @returns {string[]} — Telegram'ga yuboriladigan xabarlar (har biri < 4000 belgi)
 */
function formatStaffProfile(p) {
  const { values: v, fromDraft, today = new Date() } = p;
  const mark = (key) => (fromDraft.has(key) ? ` ${DRAFT_MARK}` : '');
  const line = (key, label, extra = '') => {
    const val = v[key];
    if (!val) return null;
    return `<b>${esc(label)}:</b> ${esc(val)}${extra}${mark(key)}`;
  };

  const out = [];
  let head = `👤 <b>${esc(v.fullName || 'Ism kiritilmagan')}</b>${mark('fullName')}\n🆔 <code>${esc(v.id)}</code>`;
  if (!p.inDb) head += `\n\n⚠️ <b>Bu talaba DB sahifasida yo‘q</b> — barcha ma’lumot DRAFT'dan (${DRAFT_MARK}).`;
  out.push(head);

  const empty = [];
  for (const [section, title] of SECTIONS) {
    const lines = [];
    for (const [key, , , , sec, label] of FIELDS) {
      if (sec !== section) continue;
      if (!v[key]) {
        if (!OPTIONAL_KEYS.has(key) && key !== 'missingDocs') empty.push(label);
        continue;
      }
      let extra = '';
      if (key === 'dob') { const a = ageOf(v.dob, today); if (a) extra = ` (${a} yosh)`; }
      if (key === 'passportExpiry') extra = expiryNote(v[key], today, 6);
      if (key === 'testExpiry') extra = expiryNote(v[key], today, 2);
      if (key === 'supervisor' && p.supervisorPhone) extra = ` · ${esc(p.supervisorPhone)}`;
      if (key === 'missingDocs') continue; // pastda alohida
      const l = line(key, label, extra);
      if (l) lines.push(l);
    }
    if (section === 'docs') {
      const missing = p.missingDocLabels || (v.missingDocs ? v.missingDocs.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) : []);
      if (missing.length) {
        lines.push(`<b>Yetishmayapti (${missing.length}):</b>${mark('missingDocs')}`);
        for (const m of missing) lines.push(`  • ${esc(m)}`);
      } else {
        lines.push('<b>Yetishmayotgan hujjat:</b> yo‘q ✅');
      }
      lines.push(`<b>Botga yuborilgan fayllar:</b> ${p.docsCount || 0} ta`);
      lines.push(`<b>Bot bilan bog‘langan:</b> ${v.chatId ? 'ha ✅' : 'yo‘q ❌'}`);
    }
    if (lines.length) out.push(`<b>━━ ${title} ━━</b>\n${lines.join('\n')}`);
  }

  const foot = [];
  if (fromDraft.size) foot.push(`${DRAFT_MARK} — DB'da bo‘sh, DRAFT'dan olindi (tekshirilmagan ma’lumot)`);
  if (empty.length) foot.push(`⚪️ <b>DB va DRAFT'da bo‘sh (${empty.length}):</b> ${esc(empty.join(', '))}`);
  if (p.columnWarnings && p.columnWarnings.length) foot.push(`ℹ️ ${esc(p.columnWarnings.join('; '))}`);
  if (foot.length) out.push(foot.join('\n'));

  // 4096 belgi chegarasi — bo'limlarni xabarlarga taqsimlaymiz
  const msgs = [];
  let cur = '';
  for (const block of out) {
    if (cur && (cur.length + block.length + 2) > 3800) { msgs.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) msgs.push(cur);
  return msgs;
}

module.exports = { formatStaffProfile, DRAFT_MARK, parseDate };
