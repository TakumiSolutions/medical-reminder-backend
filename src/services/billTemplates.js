// Each branch's printed Cash Memo (from the stores' own bill books), redrawn for bill PDFs.
// Keyed by branch code. Texts are copied from the printed memos; keep them in sync with them.

const CENTRAL = {
  // Shivam Medical Centre: orange and maroon on cream paper.
  paper: '#fffaf4',
  accent: '#ec7a1c',
  dark: '#9a4652',
  bar: '#9a4652',
  rule: '#c79aa0',
  label: '#b0737b',
  cashMemo: true,
  logo: 'central-logo.png',
  deity: 'central-deity.png',
  nameBox: 'શિવમ',
  nameRest: 'મેડીકલ સેન્ટર',
  address: 'પારીતોષ બિલ્ડીંગ, શોપ નં. ૮, ઇન્દીરા સર્કલ, યુનિવર્સીટી રોડ, રાજકોટ.',
  phone: '૭૨૦૨૦ ૦૦૯૫૫',
  legal: [
    'GSTIN : 24ABGFS3038K1Z3   •   FSSAI No.: 20720030000045',
    'D.L. No.: 20 RR 2440 / 20 B RR 2412',
    '              21 RR 2441 / 21 B RR 2334 Dt. 12-10-2006',
    'Subject to Rajkot Jurisdiction Only.   •   E. & O. E.',
  ],
  notes: [
    ['દવા ડોક્ટરને બતાવીને વાપરવી.', 'દવા પરત આપતી વખતે બીલ લાવવું જરૂરી છે.'],
    ['એક મહિનાની અંદર દવા પરત કરવાની રહેશે.', 'કટીંગ કરેલ દવા પરત રાખવામાં આવશે નહીં.'],
  ],
  bullet: '#ec7a1c',
  hours: { box: '#ec7a1c', boxText: '#ffffff', rest: '#9a4652', restBg: null },
  forLine: 'For, SHIVAM MEDICAL CENTRE',
};

const SPEEDWELL = {
  // Shivam Medical Store: pink, purple and black on white paper.
  paper: '#ffffff',
  accent: '#e94379',
  dark: '#2b2b2b',
  bar: '#e94379',
  rule: '#3a3a3a',
  label: '#3a3a3a',
  cashMemo: false,
  logo: 'speedwell-logo.png',
  deity: 'speedwell-deity.png',
  nameBox: 'શિવમ્',
  nameRest: 'મેડીકલ સ્ટોર',
  address: 'ગ્રાઉન્ડ ફ્લોર, સ્વયંમ્ કેર, સ્પીડવેલ હાઇટ્સની સામે, સ્પીડવેલ પાર્ટી પ્લોટ પાસે, અંબિકા ટાઉનશીપ મેઇન રોડ, રાજકોટ.',
  phone: '૯૦૯૦ ૫૨૫૨ ૦૮',
  legal: [
    'GSTIN : 24AEYFS5250G1ZM   •   FSSAI No. 20724030000385',
    'D.L.No. : 20 GJ-RAJ 237158        21 GJ-RAJ-237159',
    '              20B GJ-RAJ-237160      21B GJ-RAJ-237161',
    'Subject to Rajkot Jurisdiction only.   •   E.&O.E.',
  ],
  notes: [
    ['દવા ડોક્ટરને બતાવીને વાપરવી.', 'દવા પરત આપવી વખતે બીલ લાવવું જરૂરી છે.'],
    ['એક મહીનાની અંદર દવા પરત કરવાની રહેશે.', 'કટીંગ કરેલી દવા પરત રાખવામાં આવશે નહી.'],
  ],
  bullet: '#2e9e4f',
  hours: { box: '#7c5cad', boxText: '#ffffff', rest: '#2b2b2b', restBg: '#e4e4e4' },
  forLine: 'For, SHIVAM MEDICAL STORE',
  // Back of the memo (offers and WhatsApp ordering), added after the bill when it is sent on
  // WhatsApp; not printed. *…* marks red bold words. The printed back's first offer
  // ("રૂ. ૩૦૦ કે તેથી વધુ કિંમત પર હોમ ડિલિવરી ફ્રી") is crossed out by hand, so it is left out.
  back: {
    title: 'મોટા બીલ પર મોટું ડિસ્કાઉન્ટ',
    badge: ':: અમારી સુવિધાઓ ::',
    points: [
      '*ફ્રી* હોમ ડિલિવરીનો સમય સવારે ૯ થી રાત્રે ૧૦ વાગ્યા સુધી.',
      'એલોપેથીક, આર્યુવેદિક દવાઓ તથા સર્જીકલ વસ્તુઓ પર મહતમ ડિસ્કાઉન્ટ.',
      'કેન્સરની દવાઓ પર પણ મહતમ ડિસ્કાઉન્ટ.',
      'જેનેરીક દવાઓ પર પણ મહતમ ડિસ્કાઉન્ટ.',
    ],
    whatsapp: '9090 5252 08',
    orderLines: ['દવાનું પ્રિસ્ક્રીપ્શન WHATSAPP', 'કરી ઘરે બેઠા *ફ્રી* ડીલીવરી મેળવો.'],
    picture: 'speedwell-back-scooter.png',
    account: 'Shivam Medical Store',
    accountNote: 'WhatsApp business account',
    // The WhatsApp business link in the printed QR code (decoded from it).
    qrUrl: 'https://wa.me/message/REGML33T6RYUD1?src=qr',
    qrLines: ['પ્રિસ્ક્રીપ્શન WHATSAPP', 'કરવા માટે આ QR કોડ સ્કેન કરો.'],
    red: '#e2231a',
  },
};

const TEMPLATES = { central: CENTRAL, speedwell: SPEEDWELL };

/** The branch's Cash Memo design, or null for a branch without one (a plain bill is used). */
export const billTemplateFor = (branchCode) => TEMPLATES[String(branchCode ?? '').toLowerCase()] ?? null;
