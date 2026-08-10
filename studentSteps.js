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
  fullName: (v) => v.trim().split(/\s+/).length >= 2,
  phone: (v) => /^\d{9}$/.test(v.replace(/\D/g, '')),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  dob: (v) => /^\d{4}\.\d{2}\.\d{2}$/.test(v.trim()),
  jshshir: (v) => /^\d{14}$/.test(v.trim()),
  zipCode: (v) => /^\d{5,6}$/.test(v.trim()),
  examDate: (v) => /^\d{4}\.\d{2}\.\d{2}$/.test(v.trim()) || v.trim().length > 3, // aniq sana YOKI izoh matni
  gpa: (v) => /^\d(\.\d{1,2})?$/.test(v.trim()) || v.trim().toUpperCase() === 'EXPECTED',
  graduationDate: (v) => /^\d{4}\.\d{2}$/.test(v.trim()) || v.trim().toUpperCase().includes('EXPECTED'),
  notEmpty: (v) => v.trim().length > 0,
  // Passport: 2 harf + 7 raqam, bo'sh joysiz (masalan FB1234567)
  passport: (v) => /^[A-Za-z]{2}\d{7}$/.test(v.trim().replace(/\s/g, '')),
};

const REGION_OPTIONS = [
  'ANDIJAN', 'NAMANGAN', "FARG'ONA", 'TOSHKENT', 'SAMARQAND',
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
    type: 'buttons',
    question: 'Qaysi dastur asosida Koreaga ketayotganingizni tanlang:',
    options: [
      { text: 'Bakalavr', value: 'BAKALAVR' },
      { text: 'Kollej', value: 'KOLLEJ' },
      { text: 'Magistratura', value: 'MAGISTRATURA' },
      { text: 'Til kursi', value: 'TIL_KURSI' },
    ],
    sheetCol: 'C', // PROGRAM
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
    type: 'text',
    question: 'NAMUNA: OLIMOV JASURBEK TOHIRJON UGLI\n\nTo\'liq ism-familyangizni shu ko\'rinishda kiriting:',
    validate: validators.fullName,
    errorMsg: 'Namunadagidek to\'liq ism-familyani kiriting.',
    sheetCol: 'E', // FULL NAME
    next: () => 'zagran_status',
  },

  // --- ZAGRAN bor/yo'q ---
  zagran_status: {
    type: 'buttons',
    question: 'Chet elga chiqish (zagran) pasportingiz bormi?',
    options: [
      { text: 'Bor', value: 'BOR' },
      { text: 'Yo\'q', value: 'YOQ' },
    ],
    sheetCol: 'AA', // ZAGRAN
    next: (data) => (data.zagran_status === 'BOR' ? 'passport_number' : 'phone'),
  },
  passport_number: {
    type: 'text',
    question: 'NAMUNA: FB1234567 (bo\'sh joysiz, ketma-ket kiriting)\n\nZagran pasport seriya-raqamingizni kiriting:',
    validate: validators.passport,
    errorMsg: 'Format noto\'g\'ri. 2 harf + 7 raqam, bo\'sh joysiz kiriting (masalan: FB1234567).',
    sheetCol: 'N', // PASSPORT №
    next: () => 'phone',
  },

  // --- 2. TELEFON ---
  phone: {
    type: 'text',
    question: 'Telefon raqamingizni 9 ta raqam bilan kiriting (masalan: 901234567):',
    validate: validators.phone,
    errorMsg: '9 ta raqamdan iborat bo\'lishi kerak. Qayta kiriting.',
    sheetCol: 'Q', // PHONE
    next: () => 'email',
  },

  // --- 3. GMAIL ---
  email: {
    type: 'text',
    question: 'Elektron pochta (gmail) manzilingizni kiriting:',
    validate: validators.email,
    errorMsg: 'Email formati noto\'g\'ri. Qayta kiriting.',
    sheetCol: 'R', // E-MAIL
    next: () => 'dob',
  },

  // --- 4. TUG'ILGAN SANA ---
  dob: {
    type: 'text',
    question: 'Tug\'ilgan sanangizni YYYY.MM.DD formatida kiriting (masalan: 2005.03.21):',
    validate: validators.dob,
    errorMsg: 'Format noto\'g\'ri. YYYY.MM.DD ko\'rinishida kiriting.',
    sheetCol: 'O', // DOB
    next: () => 'gender',
  },

  // --- 5. JINSI ---
  gender: {
    type: 'buttons',
    question: 'Jinsingizni tanlang:',
    options: [
      { text: 'Male', value: 'MALE' },
      { text: 'Female', value: 'FEMALE' },
    ],
    sheetCol: 'P', // GENDER
    next: () => 'jshshir',
  },

  // --- 6. JSHSHIR ---
  jshshir: {
    type: 'text',
    question: 'JSHSHIR raqamingizni kiriting (14 ta raqam):',
    validate: validators.jshshir,
    errorMsg: '14 ta raqamdan iborat bo\'lishi kerak. Qayta kiriting.',
    sheetCol: 'AB', // JSHSHIR
    next: () => 'certificate_status',
  },

  // --- 7. SERTIFIKAT (murakkab shoxlanish) ---
  certificate_status: {
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
    type: 'buttons',
    question: 'Sertifikat turini tanlang:',
    options: [
      { text: 'IELTS', value: 'IELTS' },
      { text: 'TOPIK', value: 'TOPIK' },
      { text: 'TOEFL', value: 'TOEFL' },
      { text: 'SKA', value: 'SKA' },
    ],
    sheetCol: 'J', // CERTIFICATE
    next: () => 'certificate_score',
  },
  certificate_score: {
    type: 'text',
    question: 'Sertifikat bahoingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'K', // SCORE
    next: () => 'exam_date',
  },
  certificate_type_taker: {
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
    type: 'text',
    question: 'TOPIK test hisobot raqamini (Test Report Number) kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AC', // TEST REPORT NUMBER
    next: () => 'exam_date',
  },
  exam_date: {
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
    next: (data) => (data.father_status === 'NORMAL' ? 'father_name' : 'mother_status'),
  },
  father_name: {
    type: 'text',
    question: 'Otangizning to\'liq ism-familyasini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AF', // FATHER'S NAME
    next: () => 'father_job',
  },
  father_job: {
    type: 'text',
    question: 'Otangizning kasbini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AH', // JOB (father)
    next: () => 'father_phone',
  },
  father_phone: {
    type: 'text',
    question: 'Otangizning telefon raqamini kiriting (9 ta raqam):',
    validate: validators.phone,
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
    next: (data) => (data.mother_status === 'NORMAL' ? 'mother_name' : 'address'),
  },
  mother_name: {
    type: 'text',
    question: 'Onangizning to\'liq ism-familyasini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AI', // MOTHER'S NAME
    next: () => 'mother_job',
  },
  mother_job: {
    type: 'text',
    question: 'Onangizning kasbini kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AK', // JOB (mother)
    next: () => 'mother_phone',
  },
  mother_phone: {
    type: 'text',
    question: 'Onangizning telefon raqamini kiriting (9 ta raqam):',
    validate: validators.phone,
    sheetCol: 'AJ', // PHONE NUMBER (mother)
    next: () => 'address',
  },

  // --- 11. MANZIL + ZIP ---
  address: {
    type: 'text',
    question: 'Yashaydigan to\'liq manzilingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'S', // ADRESS
    next: () => 'zip_code',
  },
  zip_code: {
    type: 'text',
    question: 'Pochta indeksi (zip code)ni kiriting:',
    validate: validators.zipCode,
    errorMsg: 'Zip code 5-6 raqamdan iborat bo\'lishi kerak.',
    sheetCol: 'T', // ZIP CODE
    next: () => 'region',
  },
  region: {
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
    type: 'text',
    question: 'Qaysi band bilan rad javobi olganingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'AE', // REJECTION HISTORY
    next: () => 'school_name',
  },

  // --- 13. TA'LIM MUASSASASI ---
  school_name: {
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
    type: 'text',
    question: (data) => data.graduating_this_year === 'EXPECTED'
      ? 'Taxminiy bitirish sanangizni kiriting (YYYY.MM):'
      : 'Bitirgan sanangizni kiriting (YYYY.MM):',
    validate: validators.graduationDate,
    sheetCol: 'X', // GRADUATION DATE
    next: (data) => (data.graduating_this_year === 'EXPECTED' ? 'gpa_expected' : 'gpa_known'),
  },
  gpa_expected: {
    type: 'skip', // avtomatik "EXPECTED" yoziladi, savol berilmaydi
    sheetCol: 'Y', // GPA
    autoValue: 'EXPECTED',
    next: () => 'master_major_check',
  },
  gpa_known: {
    type: 'text',
    question: 'O\'rtacha bahoingiz (GPA)ni kiriting:',
    validate: validators.gpa,
    sheetCol: 'Y', // GPA
    next: () => 'master_major_check',
  },

  // --- 14. MASTER SOHASI ---
  // NOTE: "Master bosqichi tanlandimi" ma'lumoti hozircha STUDENT_STEPS
  // ichida so'ralmaydi (bu bosqich darajasi shartnomada belgilanadi
  // deb taxmin qilindi — AGREEMENT ustunida). Agar bot o'zi so'rashi
  // kerak bo'lsa, shu yerga qo'shimcha step qo'shiladi.
  master_major_check: {
    type: 'buttons',
    question: 'Magistratura (Master) darajasiga topshiryapsizmi?',
    options: [
      { text: 'Ha', value: 'HA' },
      { text: 'Yo\'q', value: 'YOQ' },
    ],
    sheetCol: null,
    next: (data) => (data.master_major_check === 'HA' ? 'master_major' : 'preferred_region'),
  },
  master_major: {
    type: 'text',
    question: 'Bakalavr bosqichida qaysi sohani tugatganingizni kiriting:',
    validate: validators.notEmpty,
    sheetCol: 'W', // MAJOR
    next: () => 'preferred_region',
  },

  // --- 15. O'QIMOQCHI BO'LGAN HUDUD (erkin matn — o'zgarishsiz) ---
  preferred_region: {
    type: 'text',
    question: 'Koreyaning qaysi hududi (shahri) sizga qulayroq bo\'lishini yozib bering:',
    validate: validators.notEmpty,
    sheetCol: 'AM', // ASOSIY SHAHAR / PREFERRED_REGION
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
