// =====================================================================
// STUDENT INTAKE BOT — STUDENT_STEPS state machine
// Draft_Student_Info sheet ustunlariga to'g'ridan-to'g'ri mos keladi.
// Ustun xaritasi (PROGRAM ustuni qo'shilgandan keyingi holat):
//
//   A:№  B:STATUS  C:PROGRAM  D:ID  E:FULL NAME  F:UNIVERSITY 1
//   G:UNIVERSITY 2  H:AGREEMENT  I:CERTIFICATE STATUS  J:CERTIFICATE
//   K:SCORE  L:BRANCH  M:AGREEMENT COMPANY  N:PASSPORT №
//   O:DOB  P:GENDER  Q:PHONE  R:E-MAIL  S:ADRESS  T:ZIP CODE
//   U:TELEGRAM ID  V:SCHOOL NAME  W:MAJOR  X:GRADUATION DATE  Y:GPA
//   Z:REGION  AA:ZAGRAN  AB:JSHSHIR  AC:TEST REPORT NUMBER
//   AD:EXAM DATE  AE:REJECTION HISTORY  AF:FATHER'S NAME
//   AG:PHONE(father)  AH:JOB(father)  AI:MOTHER'S NAME
//   AJ:PHONE(mother)  AK:JOB(mother)  AL:ASOSIY MAQSAD
//   AM:ASOSIY SHAHAR/PREFERRED_REGION  AN:MISSING DOCS  AO:MUHIM IZOH!!
//   AP:CURRENT_STEP (YANGI, texnik — resume uchun, pastga qarang)
//
// STAFF TO'LDIRADI, BOT TEGMAYDI: B, C(agar staff avval to'ldirgan
// bo'lsa ham bot ustiga yozadi — chunki bu botning aynan vazifasi),
// F, G, H, L, M, D(faqat o'qiydi, tekshirish uchun).
// BOT AVTOMATIK TO'LDIRADI (savol so'ramaydi): U (Telegram username).
// HOZIRCHA ISHLATILMAYDI: AN, AO (keyinroq, hujjat/staff bosqichida).
//
// RESUME MEXANIZMI — soddalashtirildi:
// Har bir savolga javob qabul qilingandan keyin, bot KEYINGI step
// key'ini AP (CURRENT_STEP) ustuniga yozadi. /start qaytganda bot
// shunchaki AP'ni o'qiydi va aynan o'sha step'dan davom etadi.
// Hech qanday taxmin/inference yo'q — to'g'ridan-to'g'ri o'qish.
// =====================================================================

// ---------------------------------------------------------------------
// VALIDATORLAR
// ---------------------------------------------------------------------
const validators = {
  // To'liq ism — ZAGRAN passport yozuvi bo'yicha:
  //   • FAQAT lotin harflari va bo'sh joy (apostrof, kirill YO'Q)
  //     "O'G'LI" ❌   "UGLI" ✅   "KHAKIMJONOV" ✅
  //   • kamida 3 ta so'z (familya + ism + otasining ismi)
  //   • "UGLI/QIZI/KIZI" qo'shimchasi alohida so'z sifatida sanalmaydi
  //   • takrorlanuvchi so'zlar (A A A) rad etiladi
  fullName: (v) => {
    const cleaned = v.trim().replace(/\s+/g, ' ');
    // Faqat lotin harflari va bo'sh joy
    if (!/^[A-Za-z ]+$/.test(cleaned)) return false;
    const parts = cleaned.split(' ');
    const SUFFIX = ['UGLI', 'QIZI', 'KIZI'];
    const last = parts[parts.length - 1].toUpperCase();
    const core = SUFFIX.includes(last) ? parts.slice(0, -1) : parts;
    if (core.length < 3) return false;
    if (!core.every((w) => w.length >= 2)) return false;
    const lower = core.map((w) => w.toLowerCase());
    if (new Set(lower).size < core.length) return false;
    return true;
  },
  // Telefon: ANIQ 9 ta raqam, bo'sh joy/chiziqcha/qavssiz
  phone: (v) => /^\d{9}$/.test(v.trim()),
  // Kasb (erkin matn): kamida 3 belgi, faqat harf va bo'sh joy,
  // kamida bitta unli, bir xil harf 3 marta ketma-ket takrorlanmasin
  job: (v) => {
    const s = v.trim();
    if (s.length < 3) return false;
    if (!/^[A-Za-zÀ-ÿЀ-ӿ'’`\-\s]+$/.test(s)) return false;
    if (!/[aeiouAEIOUаеёиоуыэюяАЕЁИОУЫЭЮЯ]/.test(s)) return false;
    if (/(.)\1{2,}/.test(s)) return false;
    return true;
  },
  // Sertifikat ballari — tur bo'yicha alohida
  toeflScore: (v) => {
    const n = parseInt(v.trim(), 10);
    return /^\d{2,3}$/.test(v.trim()) && n >= 71 && n <= 120;
  },
  skaScore: (v) => {
    const n = parseInt(v.trim(), 10);
    return /^\d{3}$/.test(v.trim()) && n >= 201 && n <= 800;
  },
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  dob: (v) => /^\d{4}\.\d{2}\.\d{2}$/.test(v.trim()),
  jshshir: (v) => /^\d{14}$/.test(v.trim()),
  zipCode: (v) => /^\d{5,6}$/.test(v.trim()),
  examDate: (v) => /^\d{4}\.\d{2}\.\d{2}$/.test(v.trim()) || v.trim().length > 3, // aniq sana YOKI izoh matni
  gpa: (v) => /^\d(\.\d{1,2})?$/.test(v.trim()) || v.trim().toUpperCase() === 'EXPECTED',
  graduationDate: (v) => /^\d{4}\.\d{2}$/.test(v.trim()) || v.trim().toUpperCase().includes('EXPECTED'),
  notEmpty: (v) => v.trim().length > 0,
  // Manzil: kamida 3 ta qism (vergul bilan ajratilgan: viloyat, tuman,
  // ko'cha+uy raqami), oxirgi qismida raqam bo'lishi kerak (uy raqami).
  address: (v) => {
    const s = v.trim();
    if (s.length < 15) return false;
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return false;
    if (!parts.some((p) => /\d/.test(p))) return false;
    return true;
  },
  // Passport: 2 harf + 7 raqam, bo'sh joysiz (masalan FB1234567)
  passport: (v) => /^[A-Za-z]{2}\d{7}$/.test(v.trim().replace(/\s/g, '')),
};

// Eng ko'p uchraydigan kasblar — tugma sifatida taklif qilinadi.
// Ro'yxatda bo'lmasa, "Boshqa" tugmasi orqali erkin matn kiritiladi.
const JOB_OPTIONS = [
  'Tadbirkor', 'Haydovchi', "O'qituvchi", 'Shifokor',
  'Quruvchi', 'Fermer', 'Ishchi', 'Savdogar',
  'Uy bekasi', 'Nafaqada', 'Ishsiz', 'Chet elda ishlaydi',
];

const REGION_OPTIONS = [  'ANDIJAN', 'NAMANGAN', "FARG'ONA", 'TOSHKENT', 'SAMARQAND',
  'SIRDARYO', 'BUXORO', 'JIZZAX', 'QASHQADARYO', 'SURXANDARYO',
  'NAVOIY', 'NUKUS', 'XORAZM',
];

// ---------------------------------------------------------------------
// STUDENT_STEPS — key bo'yicha ordered flow.
// Har bir step: question, type ('text'|'buttons'), options, validate,
// sheetCol, va next(data) — keyingi step key'ini hisoblovchi funksiya.
// ---------------------------------------------------------------------
const STUDENT_STEPS = {

  // --- 0. DASTUR TANLASH (birinchi savol, ID tasdiqlangandan keyin) ---
  program_selection: {
    label: 'Dastur',
    type: 'buttons',
    question: 'Qaysi dastur asosida Koreaga ketayotganingizni tanlang:',
    options: [
      { text: 'Bakalavr', value: 'BAKALAVR' },
      { text: 'Kollej', value: 'KOLLEJ' },
      { text: 'Magistratura', value: 'MAGISTRATURA' },
      { text: 'Til kursi', value: 'TIL_KURSI' },
    ],
    sheetCol: 'C', // PROGRAM
    next: () => 'zagran_status',
  },

  // --- ZAGRAN bor/yo'q (endi ID tasdiqlangandan keyin, ismdan OLDIN) ---
  zagran_status: {
    label: 'Zagran passport',
    type: 'buttons',
    question: 'Chet elga chiqish (zagran) pasportingiz bormi?',
    options: [
      { text: 'Bor', value: 'BOR' },
      { text: 'Yo\'q', value: 'YOQ' },
    ],
    sheetCol: 'AA', // ZAGRAN
    next: (data) => (data.zagran_status === 'BOR' ? 'passport_number' : 'full_name_warning'),
  },
  passport_number: {
    label: 'Passport raqami',
    type: 'text',
    question: 'Zagran pasport seriya-raqamingizni bo\'sh joysiz, ketma-ket kiriting.\n\nNAMUNA: FB1234567',
    validate: validators.passport,
    errorMsg: 'Format noto\'g\'ri. 2 harf + 7 raqam, bo\'sh joysiz kiriting (masalan: FB1234567).',
    sheetCol: 'N', // PASSPORT №
    next: () => 'full_name_warning',
  },

  // --- 1. ISM-FAMILYA (zagran ogohlantirishi + namuna bilan) ---
  full_name_warning: {
    type: 'buttons',
    question: 'DIQQAT: Ism-familyangizni chet elga chiqish pasport(ZAGRAN)ingizdagidek kiriting. Bu ma\'lumot visa uchun ishlatiladi.',
    options: [{ text: 'Ogohlantirildim', value: 'ack' }],
    sheetCol: null,
    next: () => 'full_name',
  },
  full_name: {
    label: 'Ism-familya',
    type: 'text',
    question: 'DIQQAT: Zagran passportda yozilganidek, LOTIN harflarida kiriting.\n'
      + '• Apostrof (\') ishlatilmaydi: O\'G\'LI emas — UGLI\n'
      + '• "X" o\'rniga ko\'pincha "KH" yoziladi: XAKIMOV emas — KHAKIMOV\n'
      + '• To\'liq: familya + ism + otasining ismi\n\n'
      + 'To\'liq ism-familyangizni kiriting.\n\n'
      + 'NAMUNA: ABDULLAEV ADBULLAJON ABDULLAJON UGLI',
    validate: validators.fullName,
    errorMsg: 'Ism zagran passportdagidek bo\'lishi kerak:\n'
      + '• Faqat lotin harflari (apostrof va kirill yozuv qabul qilinmaydi)\n'
      + '• Kamida 3 ta so\'z: familya + ism + otasining ismi\n\n'
      + 'NAMUNA: ABDULLAEV ADBULLAJON ABDULLAJON UGLI',
    sheetCol: 'E', // FULL NAME
    next: () => 'phone',
  },

  // --- 2. TELEFON ---
  phone: {
    label: 'Telefon',
    type: 'text',
    question: 'Telefon raqamingizni kiriting.\n\nFaqat 9 ta raqam, bo\'sh joy va chiziqchasiz.\nNAMUNA: 901234567',
    validate: validators.phone,
    errorMsg: 'Faqat 9 ta raqam kiriting — bo\'sh joy, chiziqcha yoki qavs ishlatmang.\nNAMUNA: 901234567',
    sheetCol: 'Q', // PHONE
    next: () => 'email',
  },

  // --- 3. GMAIL ---
  email: {
    label: 'E-mail',
    type: 'text',
    question: 'Elektron pochta (gmail) manzilingizni kiriting:',
    validate: validators.email,
    errorMsg: 'Email formati noto\'g\'ri. Qayta kiriting.',
    sheetCol: 'R', // E-MAIL
    next: () => 'dob',
  },

  // --- 4. TUG'ILGAN SANA ---
  dob: {
    label: 'Tug\'ilgan sana',
    type: 'text',
    question: 'Tug\'ilgan sanangizni YYYY.MM.DD formatida kiriting (masalan: 2005.03.21):',
    validate: validators.dob,
    errorMsg: 'Format noto\'g\'ri. YYYY.MM.DD ko\'rinishida kiriting.',
    sheetCol: 'O', // DOB
    next: () => 'gender',
  },

  // --- 5. JINSI ---
  gender: {
    label: 'Jinsi',
    type: 'buttons',
    question: 'Jinsingizni tanlang:',
    options: [
      { text: 'Erkak', value: 'ERKAK' },
      { text: 'Ayol', value: 'AYOL' },
    ],
    sheetCol: 'P', // GENDER
    next: () => 'jshshir',
  },

  // --- 6. JSHSHIR ---
  jshshir: {
    label: 'JSHSHIR',
    type: 'text',
    question: 'JSHSHIR raqamingizni kiriting (14 ta raqam):',
    validate: validators.jshshir,
    errorMsg: '14 ta raqamdan iborat bo\'lishi kerak. Qayta kiriting.',
    sheetCol: 'AB', // JSHSHIR
    next: () => 'certificate_status',
  },

  // --- 7. SERTIFIKAT (murakkab shoxlanish) ---
  certificate_status: {
    label: 'Sertifikat holati',
    type: 'buttons',
    question: 'Til sertifikatingiz bormi?',
    options: [
      { text: 'Bor', value: 'YES' },
      { text: 'Yo\'q', value: 'NO' },
    ],
    sheetCol: 'I', // CERTIFICATE STATUS
    next: (data) => (data.certificate_status === 'YES' ? 'certificate_type' : 'no_cert_taker_choice'),
  },
  no_cert_taker_choice: {
    type: 'buttons',
    question: 'Sertifikatsiz davom etasizmi, yoki imtihonga yozilgansiz (TAKER)?',
    options: [
      { text: 'Sertifikatsiz', value: 'NONE' },
      { text: 'TAKER', value: 'TAKER' },
    ],
    sheetCol: null,
    next: (data) => {
      if (data.no_cert_taker_choice === 'NONE') return 'asosiy_maqsad';
      return 'certificate_type_taker';
    },
  },
  certificate_type: {
    label: 'Sertifikat turi',
    type: 'buttons',
    question: 'Sertifikat turini tanlang:',
    options: [
      { text: 'IELTS', value: 'IELTS' },
      { text: 'TOPIK', value: 'TOPIK' },
      { text: 'TOEFL', value: 'TOEFL' },
      { text: 'SKA', value: 'SKA' },
    ],
    sheetCol: 'J', // CERTIFICATE
    next: (data) => {
      const t = data.certificate_type;
      if (t === 'IELTS') return 'cert_score_ielts';
      if (t === 'TOPIK') return 'cert_score_topik';
      if (t === 'TOEFL') return 'cert_score_toefl';
      return 'cert_score_ska';
    },
  },

  // --- Sertifikat ballari — tur bo'yicha alohida ---
  cert_score_ielts: {
    label: 'IELTS ball',
    type: 'buttons',
    question: 'IELTS ballingizni tanlang:',
    options: [
      { text: '5,5', value: '5.5' }, { text: '6,0', value: '6.0' },
      { text: '6,5', value: '6.5' }, { text: '7,0', value: '7.0' },
      { text: '7,5', value: '7.5' }, { text: '8,0', value: '8.0' },
      { text: '8,5', value: '8.5' }, { text: '9,0', value: '9.0' },
    ],
    sheetCol: 'K', // SCORE
    next: () => 'asosiy_maqsad',
  },
  cert_score_topik: {
    label: 'TOPIK daraja',
    type: 'buttons',
    question: 'TOPIK darajangizni tanlang:',
    options: [
      { text: '2', value: '2' }, { text: '3', value: '3' },
      { text: '4', value: '4' }, { text: '5', value: '5' },
      { text: '6', value: '6' },
    ],
    sheetCol: 'K',
    next: () => 'asosiy_maqsad',
  },
  cert_score_toefl: {
    label: 'TOEFL ball',
    type: 'text',
    question: 'Sertifikat ballingizni kiriting:',
    validate: validators.toeflScore,
    errorMsg: 'Talabadan o\'qishga topshirayotgan paytda eng past 71 balldan eng yuqori 120 ballgacha mezon qo\'yilgan. TOEFL ballingizni tekshirib qayta kiriting!',
    sheetCol: 'K',
    next: () => 'asosiy_maqsad',
  },
  cert_score_ska: {
    label: 'SKA ball',
    type: 'text',
    question: 'Sertifikat ballingizni kiriting:',
    validate: validators.skaScore,
    errorMsg: 'Talabadan o\'qishga topshirayotgan paytda eng past 201 balldan eng yuqori 800 ballgacha mezon qo\'yilgan. SKA ballingizni tekshirib qayta kiriting!',
    sheetCol: 'K',
    next: () => 'asosiy_maqsad',
  },
  certificate_type_taker: {
    label: 'Imtihon turi (Taker)',
    type: 'buttons',
    question: 'TAKER — qaysi imtihonga yozilgansiz?',
    options: [
      { text: 'IELTS', value: 'IELTS' },
      { text: 'TOPIK', value: 'TOPIK' },
      { text: 'TOEFL', value: 'TOEFL' },
      { text: 'SKA', value: 'SKA' },
    ],
    sheetCol: 'J', // CERTIFICATE
    next: (data) => (data.certificate_type_taker === 'TOPIK' ? 'test_report_number' : 'exam_date'),
  },
  test_report_number: {
    label: 'TOPIK test raqami',
    type: 'text',
    question: 'TOPIK test hisobot raqamini (Test Report Number) kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AC', // TEST REPORT NUMBER
    next: () => 'exam_date',
  },
  exam_date: {
    label: 'Imtihon sanasi',
    type: 'buttons_then_text',
    question: 'Imtihon topshirish sanasi ma\'lummi?',
    options: [
      { text: 'Ha, sana aniq', value: 'KNOWN' },
      { text: 'Yo\'q, taxminiy', value: 'UNKNOWN' },
    ],
    followUpQuestion: {
      KNOWN: 'Sanani YYYY.MM.DD formatida kiriting:',
      UNKNOWN: 'Taxminiy sana yoki izoh yozing (masalan: "2026 yil bahorida"):',
    },
    validate: validators.examDate,
    sheetCol: 'AD', // EXAM DATE
    next: () => 'asosiy_maqsad',
  },

  // --- 8. MAQSAD ---
  asosiy_maqsad: {
    label: 'Asosiy maqsad',
    type: 'buttons',
    question: 'Koreaga borishdan maqsadingiz:',
    options: [
      { text: 'O\'qish', value: 'OQISH' },
      { text: 'Ishlash', value: 'ISHLASH' },
      { text: 'O\'qib ham ishlash', value: 'OQIB_ISHLASH' },
      { text: 'Ishlab o\'qish', value: 'ISHLAB_OQISH' },
    ],
    sheetCol: 'AL', // ASOSIY MAQSAD
    next: () => 'father_status',
  },

  // --- 9. OTA MA'LUMOTLARI ---
  father_status: {
    type: 'buttons',
    question: 'Otangiz haqida:',
    options: [
      { text: 'Ma\'lumot kiritish', value: 'NORMAL' },
      { text: 'Vafot etgan', value: 'DEAD' },
      { text: 'Ajrashgan', value: 'DIVORCED' },
    ],
    sheetCol: null,
    next: (data) => (data.father_status === 'NORMAL' ? 'father_name' : 'father_skip_fill'),
  },
  // DEAD/DIVORCED tanlansa, ism/kasb/telefon ustunlariga bir xil
  // qiymat ("DEAD" yoki "DIVORCED") yoziladi, savol so'ralmaydi.
  father_skip_fill: {
    type: 'skip_multi',
    sheetCols: ['AF', 'AG', 'AH'], // FATHER'S NAME, JOB, PHONE
    autoValue: (data) => data.father_status,
    next: () => 'mother_status',
  },
  father_name: {
    label: 'Otasining ismi',
    type: 'text',
    question: 'Otangizning to\'liq ism-familyasini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AF', // FATHER'S NAME
    next: () => 'father_job',
  },
  father_job: {
    label: 'Otasining kasbi',
    type: 'buttons',
    question: 'Otangizning kasbini tanlang:',
    options: [
      ...JOB_OPTIONS.map((j) => ({ text: j, value: j })),
      { text: 'Boshqa (o\'zim yozaman)', value: 'OTHER' },
    ],
    sheetCol: 'AH', // JOB (father)
    next: (data) => (data.father_job === 'OTHER' ? 'father_job_custom' : 'father_phone'),
  },
  father_job_custom: {
    label: 'Otasining kasbi',
    type: 'text',
    question: 'Otangizni kasbini kiriting:',
    validate: validators.job,
    errorMsg: 'Haqiqiy kasb kiriting',
    sheetCol: 'AH',
    next: () => 'father_phone',
  },
  father_phone: {
    label: 'Otasining telefoni',
    type: 'text',
    question: 'Otangizning telefon raqamini kiriting.\n\nFaqat 9 ta raqam, bo\'sh joysiz.\nNAMUNA: 901234567',
    validate: validators.phone,
    errorMsg: 'Faqat 9 ta raqam kiriting — bo\'sh joy, chiziqcha yoki qavs ishlatmang.\nNAMUNA: 901234567',
    sheetCol: 'AG', // PHONE NUMBER (father)
    next: () => 'mother_status',
  },

  // --- 10. ONA MA'LUMOTLARI (xuddi shu qolip) ---
  mother_status: {
    type: 'buttons',
    question: 'Onangiz haqida:',
    options: [
      { text: 'Ma\'lumot kiritish', value: 'NORMAL' },
      { text: 'Vafot etgan', value: 'DEAD' },
      { text: 'Ajrashgan', value: 'DIVORCED' },
    ],
    sheetCol: null,
    next: (data) => (data.mother_status === 'NORMAL' ? 'mother_name' : 'mother_skip_fill'),
  },
  mother_skip_fill: {
    type: 'skip_multi',
    sheetCols: ['AI', 'AJ', 'AK'], // MOTHER'S NAME, JOB, PHONE
    autoValue: (data) => data.mother_status,
    next: () => 'address',
  },
  mother_name: {
    label: 'Onasining ismi',
    type: 'text',
    question: 'Onangizning to\'liq ism-familyasini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AI', // MOTHER'S NAME
    next: () => 'mother_job',
  },
  mother_job: {
    label: 'Onasining kasbi',
    type: 'buttons',
    question: 'Onangizning kasbini tanlang:',
    options: [
      ...JOB_OPTIONS.map((j) => ({ text: j, value: j })),
      { text: 'Boshqa (o\'zim yozaman)', value: 'OTHER' },
    ],
    sheetCol: 'AK', // JOB (mother)
    next: (data) => (data.mother_job === 'OTHER' ? 'mother_job_custom' : 'mother_phone'),
  },
  mother_job_custom: {
    label: 'Onasining kasbi',
    type: 'text',
    question: 'Onangizni kasbini kiriting:',
    validate: validators.job,
    errorMsg: 'Haqiqiy kasb kiriting',
    sheetCol: 'AK',
    next: () => 'mother_phone',
  },
  mother_phone: {
    label: 'Onasining telefoni',
    type: 'text',
    question: 'Onangizning telefon raqamini kiriting.\n\nFaqat 9 ta raqam, bo\'sh joysiz.\nNAMUNA: 901234567',
    validate: validators.phone,
    errorMsg: 'Faqat 9 ta raqam kiriting — bo\'sh joy, chiziqcha yoki qavs ishlatmang.\nNAMUNA: 901234567',
    sheetCol: 'AJ', // PHONE NUMBER (mother)
    next: () => 'address',
  },

  // --- 11. MANZIL + ZIP ---
  address: {
    label: 'Manzil',
    type: 'text',
    question: 'Yashaydigan to\'liq manzilingizni shu tartibda kiriting: Viloyat, tuman, ko\'cha, uy raqami.\n\n'
      + 'NAMUNA: Andijon, Andijon tumani, Qandolatchilar ko\'chasi 3',
    validate: validators.address,
    errorMsg: 'Manzil namunadagi tartibda, vergul bilan ajratib to\'liq kiritilishi kerak: '
      + 'Viloyat, tuman, ko\'cha, uy raqami.\n\nNAMUNA: Andijon, Andijon tumani, Qandolatchilar ko\'chasi 3',
    sheetCol: 'S', // ADRESS
    next: () => 'region',
  },
  region: {
    label: 'Viloyat',
    type: 'buttons',
    question: 'Qaysi viloyatdan ekanligingizni tanlang:',
    options: REGION_OPTIONS.map((r) => ({ text: r, value: r })),
    sheetCol: 'Z', // REGION
    next: () => 'rejection_history',
  },

  // --- 12. VIZA RAD TARIXI ---
  rejection_history: {
    type: 'buttons',
    question: 'Oldin vizaga topshirib, rad javobi olganmisiz?',
    options: [
      { text: 'Ha', value: 'HA' },
      { text: 'Yo\'q', value: 'YOQ' },
    ],
    sheetCol: null,
    next: (data) => (data.rejection_history === 'HA' ? 'rejection_detail' : 'school_name'),
  },
  rejection_detail: {
    label: 'Viza rad sababi',
    type: 'text',
    question: 'Qaysi band bilan rad javobi olganingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AE', // REJECTION HISTORY
    next: () => 'school_name',
  },

  // --- 13. TA'LIM MUASSASASI ---
  school_name: {
    label: 'Ta\'lim muassasasi',
    type: 'text',
    question: 'Eng oxirgi bitirgan (yoki bitirayotgan) ta\'lim muassasasi nomini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'V', // SCHOOL NAME
    next: () => 'graduating_this_year',
  },
  graduating_this_year: {
    type: 'buttons',
    question: 'Bitirgansizmi, yoki shu yil bitirasizmi?',
    options: [
      { text: 'Bitirganman', value: 'GRADUATED' },
      { text: 'Bu yil bitiraman', value: 'EXPECTED' },
    ],
    sheetCol: null,
    next: () => 'graduation_date',
  },
  graduation_date: {
    label: 'Bitirgan sana',
    type: 'text',
    question: (data) => data.graduating_this_year === 'EXPECTED'
      ? 'Taxminiy bitirish sanangizni kiriting (YYYY.MM):'
      : 'Bitirgan sanangizni kiriting (YYYY.MM):',
    validate: validators.graduationDate,
    sheetCol: 'X', // GRADUATION DATE
    next: (data) => (data.graduating_this_year === 'EXPECTED' ? 'gpa_expected' : 'gpa_known'),
  },
  gpa_expected: {
    label: 'GPA',
    type: 'skip', // avtomatik "EXPECTED" yoziladi, savol berilmaydi
    sheetCol: 'Y', // GPA
    autoValue: 'EXPECTED',
    next: () => 'master_major_gate',
  },
  gpa_known: {
    label: 'GPA',
    type: 'text',
    question: 'O\'rtacha bahoingiz (GPA)ni kiriting:',
    validate: validators.gpa,
    sheetCol: 'Y', // GPA
    next: () => 'master_major_gate',
  },

  // --- 14. MASTER SOHASI ---
  // Qayta so'ralmaydi — boshida tanlangan PROGRAM (C ustuni) qiymatiga
  // qarab avtomatik aniqlanadi. Faqat "MAGISTRATURA" tanlangan bo'lsa
  // shu savol so'raladi, aks holda o'tkazib yuboriladi. Bu step
  // 'branch_by_sheet' turida — webhook.js Sheet'dan PROGRAM qiymatini
  // o'qib, keyingi qadamni hisoblaydi.
  master_major_gate: {
    type: 'branch_by_sheet',
    sheetColToCheck: 'C', // PROGRAM
    matchValue: 'MAGISTRATURA',
    ifMatchNext: 'master_major',
    ifNoMatchNext: 'preferred_region',
  },
  master_major: {
    label: 'Bakalavr sohasi',
    type: 'text',
    question: 'Bakalavr bosqichida qaysi sohani tugatganingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'W', // MAJOR
    next: () => 'preferred_region',
  },

  // --- 15. O'QIMOQCHI BO'LGAN HUDUD (erkin matn — o'zgarishsiz) ---
  preferred_region: {
    label: 'Afzal shahar',
    type: 'buttons',
    question: 'Koreyaning qaysi hududi (shahri) sizga qulayroq?',
    options: [
      { text: 'Seoul - 서울', value: 'SEOUL' },
      { text: 'Incheon - 인천', value: 'INCHEON' },
      { text: 'Cheonan - 천안', value: 'CHEONAN' },
      { text: 'Daegu - 대구', value: 'DAEGU' },
      { text: 'Daejon - 대전', value: 'DAEJON' },
      { text: 'Busan - 부산', value: 'BUSAN' },
      { text: 'Gwangju (katta) - 광주광역시', value: 'GWANGJU_METRO' },
      { text: 'Gwangju (kichik) - 광주시', value: 'GWANGJU_CITY' },
      { text: 'Boshqa', value: 'OTHER' },
    ],
    sheetCol: 'AM', // ASOSIY SHAHAR / PREFERRED_REGION
    next: (data) => (data.preferred_region === 'OTHER' ? 'preferred_region_custom' : 'confirm'),
  },
  preferred_region_custom: {
    label: 'Afzal shahar',
    type: 'text',
    question: 'Koreyaning qaysi hududi (shahri) sizga qulayroq bo\'lishini yozib bering:',
    validate: validators.notEmpty,
    sheetCol: 'AM',
    next: () => 'confirm',
  },

  // --- 16. TASDIQLASH ---
  confirm: {
    type: 'confirm_summary',
    sheetCol: null,
    next: () => null, // forma yakunlandi
  },
};

// ---------------------------------------------------------------------
// RESUME LOGIC — /start kelganda, mavjud qatordan davom ettirish
// SODDALASHTIRILGAN VERSIYA — CURRENT_STEP (AP) ustuniga tayangan.
// ---------------------------------------------------------------------
// Ishlash tartibi:
// 1. Shartnoma raqami (ID) bo'yicha Draft_Student_Info'dan qator topiladi.
// 2. Qator topilmasa — yangi qator yaratiladi: D=ID, B=STATUS('JARAYONDA'),
//    AP=CURRENT_STEP('program_selection') — birinchi savol shu bo'ladi.
// 3. Qator topilsa — bot AP (CURRENT_STEP) katagini o'qiydi va aynan
//    o'sha step'dan davom etadi. HECH QANDAY TAXMIN YO'Q.
// 4. Har bir javob qabul qilinib, tegishli ustunga yozilgandan so'ng,
//    bot next() orqali keyingi step key'ini hisoblaydi va DARHOL
//    shu key'ni AP ustuniga yozib qo'yadi (keyingi savolni yuborishdan
//    OLDIN yoki bir vaqtda — process shu yerda uzilib qolsa ham,
//    AP allaqachon to'g'ri qiymatda turadi).
//
// Misol oqim:
//   AP bo'sh -> 'program_selection'dan boshlanadi
//   Talaba "Bakalavr" bosadi -> C='BAKALAVR' yoziladi,
//     next() 'full_name_warning'ni qaytaradi -> AP='full_name_warning'
//     deb yangilanadi, keyin savol yuboriladi.
//   Process shu yerda restart bo'lsa -> /start -> AP o'qiladi ->
//     'full_name_warning'dan davom etadi. Ma'lumot yo'qolmaydi.

function getStepOrder() {
  return Object.keys(STUDENT_STEPS);
}

const CURRENT_STEP_COLUMN = 'AP';
const FIRST_STEP = 'program_selection';

/**
 * Draft qatoridan CURRENT_STEP qiymatini o'qib, davom etish kerak
 * bo'lgan step key'ini qaytaradi. Bo'sh bo'lsa — formani boshidan
 * boshlaydi.
 * @param {Object} rowData - { AP: 'father_status', D: '2703-B0001', ... }
 * @returns {string} - step key
 */
function findResumeStep(rowData) {
  const savedStep = rowData[CURRENT_STEP_COLUMN];
  if (!savedStep || !STUDENT_STEPS[savedStep]) {
    return FIRST_STEP;
  }
  return savedStep;
}

module.exports = {
  STUDENT_STEPS,
  validators,
  findResumeStep,
  getStepOrder,
  CURRENT_STEP_COLUMN,
  FIRST_STEP,
  REGION_OPTIONS,
};
