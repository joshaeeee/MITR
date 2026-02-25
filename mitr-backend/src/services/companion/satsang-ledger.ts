import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface SatsangLedgerEntry {
  id: string;
  textName: 'Bhagavad Gita';
  chapter: number;
  verse: number;
  sanskrit: string;
  reference: string;
  themes: string[];
  arthHint: string;
  vyakhyaHint: string;
}

interface BuildSatsangLedgerArgs {
  topic?: string;
  targetShlokaCount: number;
  excludeIds?: string[];
}

interface BuildSatsangLedgerResult {
  ids: string[];
  entries: SatsangLedgerEntry[];
}

const makeFallbackEntry = (
  chapter: number,
  verse: number,
  sanskrit: string,
  themes: string[],
  arthHint: string,
  vyakhyaHint: string
): SatsangLedgerEntry => ({
  id: `bg_${chapter}_${verse}`,
  textName: 'Bhagavad Gita',
  chapter,
  verse,
  sanskrit,
  reference: `Bhagavad Gita ${chapter}.${verse}`,
  themes,
  arthHint,
  vyakhyaHint
});

const FALLBACK_CHAPTER_STARTS: SatsangLedgerEntry[] = [
  makeFallbackEntry(
    1,
    1,
    'धृतराष्ट्र उवाच | धर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः | मामकाः पाण्डवाश्चैव किमकुर्वत सञ्जय ||१-१||',
    ['invocation', 'context'],
    'यह अध्याय युद्धभूमि और आंतरिक संघर्ष की पृष्ठभूमि स्थापित करता है।',
    'मन के द्वंद्व को पहचानकर सजगता से साधना शुरू करने का संकेत है।'
  ),
  makeFallbackEntry(
    2,
    1,
    'सञ्जय उवाच | तं तथा कृपयाविष्टमश्रुपूर्णाकुलेक्षणम् | विषीदन्तमिदं वाक्यमुवाच मधुसूदनः ||२-१||',
    ['vivek', 'grief'],
    'अर्जुन के विषाद से ज्ञान-उपदेश का आरंभ होता है।',
    'कठिन भावनात्मक क्षण ही अक्सर आत्मबोध के द्वार खोलते हैं।'
  ),
  makeFallbackEntry(
    3,
    1,
    'अर्जुन उवाच | ज्यायसी चेत्कर्मणस्ते मता बुद्धिर्जनार्दन | तत्किं कर्मणि घोरे मां नियोजयसि केशव ||३-१||',
    ['karma', 'duty'],
    'यहां कर्म और ज्ञान के बीच शंका सामने आती है।',
    'दैनिक जीवन में कर्तव्य और चिंतन का संतुलन साधना जरूरी है।'
  ),
  makeFallbackEntry(
    4,
    1,
    'श्रीभगवानुवाच | इमं विवस्वते योगं प्रोक्तवानहमव्ययम् | विवस्वान्मनवे प्राह मनुरिक्ष्वाकवेऽब्रवीत् ||४-१||',
    ['jnana', 'parampara'],
    'भगवान योग की प्राचीन परंपरा का परिचय देते हैं।',
    'साधना में परंपरा, गुरु-शिष्य ज्ञान और निरंतरता का महत्त्व है।'
  ),
  makeFallbackEntry(
    5,
    1,
    'अर्जुन उवाच | संन्यासं कर्मणां कृष्ण पुनर्योगं च शंससि | यच्छ्रेय एतयोरेकं तन्मे ब्रूहि सुनिश्चितम् ||५-१||',
    ['renunciation', 'karma'],
    'संन्यास और कर्मयोग में क्या श्रेष्ठ है, यह प्रश्न उठता है।',
    'जीवन में पलायन नहीं, सजग कर्म के साथ आंतरिक वैराग्य अपनाएं।'
  ),
  makeFallbackEntry(
    6,
    1,
    'श्रीभगवानुवाच | अनाश्रितः कर्मफलं कार्यं कर्म करोति यः | स संन्यासी च योगी च न निरग्निर्न चाक्रियः ||६-१||',
    ['dhyan', 'discipline'],
    'फल की आसक्ति छोड़े बिना कर्तव्य करना योग का प्रवेशद्वार है।',
    'नियमित अभ्यास, संतुलित दिनचर्या और मन की एकाग्रता का संदेश है।'
  ),
  makeFallbackEntry(
    7,
    1,
    'श्रीभगवानुवाच | मय्यासक्तमनाः पार्थ योगं युञ्जन्मदाश्रयः | असंशयं समग्रं मां यथा ज्ञास्यसि तच्छृणु ||७-१||',
    ['bhakti', 'jnana'],
    'भगवान समग्र ज्ञान और ईश्वर-आश्रय की दिशा देते हैं।',
    'भक्ति और समझ दोनों मिलकर साधना को स्थिर बनाते हैं।'
  ),
  makeFallbackEntry(
    8,
    1,
    'अर्जुन उवाच | किं तद् ब्रह्म किमध्यात्मं किं कर्म पुरुषोत्तम | अधिभूतं च किं प्रोक्तमधिदैवं किमुच्यते ||८-१||',
    ['ultimate', 'inquiry'],
    'अर्जुन ब्रह्म, अध्यात्म और कर्म के गहरे प्रश्न पूछते हैं।',
    'सही प्रश्न पूछना भी साधना की महत्वपूर्ण अवस्था है।'
  ),
  makeFallbackEntry(
    9,
    1,
    'श्रीभगवानुवाच | इदं तु ते गुह्यतमं प्रवक्ष्याम्यनसूयवे | ज्ञानं विज्ञानसहितं यज्ज्ञात्वा मोक्ष्यसेऽशुभात् ||९-१||',
    ['raja-vidya', 'bhakti'],
    'यह अध्याय राजविद्या-राजगुह्य के रूप में गहन ज्ञान देता है।',
    'श्रद्धा के साथ ज्ञान को जीवन में उतारना आंतरिक शुद्धि लाता है।'
  ),
  makeFallbackEntry(
    10,
    1,
    'श्रीभगवानुवाच | भूय एव महाबाहो शृणु मे परमं वचः | यत्तेऽहं प्रीयमाणाय वक्ष्यामि हितकाम्यया ||१०-१||',
    ['vibhuti', 'devotion'],
    'भगवान अपनी विभूतियों का वर्णन प्रारंभ करते हैं।',
    'हर श्रेष्ठता में दिव्यता को पहचानना भक्ति को गहरा करता है।'
  ),
  makeFallbackEntry(
    11,
    1,
    'अर्जुन उवाच | मदनुग्रहाय परमं गुह्यमध्यात्मसंज्ञितम् | यत्त्वयोक्तं वचस्तेन मोहोऽयं विगतो मम ||११-१||',
    ['visvarupa', 'clarity'],
    'अर्जुन कहते हैं कि उपदेश से उनका मोह कम हुआ है।',
    'सही दृष्टि मिलने पर भ्रम घटता है और निर्णय स्पष्ट होते हैं।'
  ),
  makeFallbackEntry(
    12,
    1,
    'अर्जुन उवाच | एवं सततयुक्ता ये भक्तास्त्वां पर्युपासते | ये चाप्यक्षरमव्यक्तं तेषां के योगवित्तमाः ||१२-१||',
    ['bhakti', 'upasana'],
    'सगुण और निर्गुण उपासना में श्रेष्ठ मार्ग का प्रश्न है।',
    'भक्ति में निरंतरता, विनम्रता और हृदय की स्थिरता प्रमुख है।'
  ),
  makeFallbackEntry(
    13,
    1,
    'अर्जुन उवाच | प्रकृतिं पुरुषं चैव क्षेत्रं क्षेत्रज्ञमेव च | एतद्वेदितुमिच्छामि ज्ञानं ज्ञेयं च केशव ||१३-१||',
    ['kshetra', 'self-knowledge'],
    'यहां शरीर-चेतना, प्रकृति-पुरुष और ज्ञान-ज्ञेय का विवेचन शुरू होता है।',
    'स्व-परिचय के लिए साक्षीभाव और निरीक्षण की साधना आवश्यक है।'
  ),
  makeFallbackEntry(
    14,
    1,
    'श्रीभगवानुवाच | परं भूयः प्रवक्ष्यामि ज्ञानानां ज्ञानमुत्तमम् | यज्ज्ञात्वा मुनयः सर्वे परां सिद्धिमितो गताः ||१४-१||',
    ['gunas', 'detachment'],
    'त्रिगुणों के ज्ञान की प्रस्तावना यहाँ से होती है।',
    'मन के सत्त्व-रजस्-तमस् को पहचानकर संतुलन साधें।'
  ),
  makeFallbackEntry(
    15,
    1,
    'श्रीभगवानुवाच | ऊर्ध्वमूलमधःशाखमश्वत्थं प्राहुरव्ययम् | छन्दांसि यस्य पर्णानि यस्तं वेद स वेदवित् ||१५-१||',
    ['purushottama', 'detachment'],
    'उल्टे अश्वत्थ वृक्ष के माध्यम से संसार-बोध की शुरुआत होती है।',
    'आसक्ति की जड़ों को पहचानकर विवेकपूर्वक जीवन जीने का संकेत है।'
  ),
  makeFallbackEntry(
    16,
    1,
    'श्रीभगवानुवाच | अभयं सत्त्वसंशुद्धिर्ज्ञानयोगव्यवस्थितिः | दानं दमश्च यज्ञश्च स्वाध्यायस्तप आर्जवम् ||१६-१||',
    ['daivi', 'ethics'],
    'दैवी गुणों की सूची से चरित्र-साधना का मार्ग खुलता है।',
    'व्यवहार में विनम्रता, संयम और सत्यनिष्ठा का अभ्यास करें।'
  ),
  makeFallbackEntry(
    17,
    1,
    'अर्जुन उवाच | ये शास्त्रविधिमुत्सृज्य यजन्ते श्रद्धयान्विताः | तेषां निष्ठा तु का कृष्ण सत्त्वमाहो रजस्तमः ||१७-१||',
    ['shraddha', 'discernment'],
    'श्रद्धा के तीन प्रकारों पर प्रश्न के साथ अध्याय आरंभ होता है।',
    'अपनी श्रद्धा की गुणवत्ता पहचानना आध्यात्मिक प्रगति के लिए आवश्यक है।'
  ),
  makeFallbackEntry(
    18,
    1,
    'अर्जुन उवाच | संन्यासस्य महाबाहो तत्त्वमिच्छामि वेदितुम् | त्यागस्य च हृषीकेश पृथक्केशिनिषूदन ||१८-१||',
    ['tyaga', 'moksha'],
    'अंतिम अध्याय संन्यास और त्याग के तत्त्व से शुरू होता है।',
    'कर्तव्य करते हुए अहंकार-त्याग का अभ्यास मोक्षमार्ग को स्पष्ट करता है।'
  )
];

const FALLBACK_CATALOG: SatsangLedgerEntry[] = [
  ...FALLBACK_CHAPTER_STARTS,
  makeFallbackEntry(
    2,
    14,
    'मात्रास्पर्शास्तु कौन्तेय शीतोष्णसुखदुःखदाः। आगमापायिनोऽनित्यास्तांस्तितिक्षस्व भारत॥',
    ['dhairya', 'samatva'],
    'सुख-दुख आते-जाते अनुभव हैं; धैर्य से स्थिर रहना साधना है।',
    'भावनात्मक उतार-चढ़ाव में प्रतिक्रिया से पहले सजग ठहराव रखें।'
  ),
  makeFallbackEntry(
    2,
    15,
    'यं हि न व्यथयन्त्येते पुरुषं पुरुषर्षभ। समदुःखसुखं धीरं सोऽमृतत्वाय कल्पते॥',
    ['dhairya', 'samatva'],
    'जो सुख-दुख में विचलित नहीं होता, वही धीर पुरुष उच्च जीवन के योग्य होता है।',
    'कठिन समय में भी समभाव का अभ्यास करें।'
  ),
  makeFallbackEntry(
    2,
    16,
    'नासतो विद्यते भावो नाभावो विद्यते सतः। उभयोरपि दृष्टोऽन्तस्त्वनयोस्तत्त्वदर्शिभिः॥',
    ['vivek'],
    'अस्थायी का स्थायी अस्तित्व नहीं होता; सत्य कभी नष्ट नहीं होता।',
    'क्षणिक भावनाओं से ऊपर उठकर सत्य-विवेक पर टिकें।'
  ),
  makeFallbackEntry(
    2,
    47,
    'कर्मण्येवाधिकारस्ते मा फलेषु कदाचन। मा कर्मफलहेतुर्भूर्मा ते सङ्गोऽस्त्वकर्मणि॥',
    ['karma'],
    'अधिकार कर्म पर है, फल पर नहीं; कर्म से विमुख न हों।',
    'परिणाम-चिंता छोड़कर वर्तमान कर्तव्य पर ध्यान दें।'
  )
];

const runtimeCache = new Map<string, SatsangLedgerEntry>();
const MAX_GITA_CHAPTER = 18;
const CHAPTER_WORD_PATTERN =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|पहला|प्रथम|दूसरा|द्वितीय|तीसरा|तृतीय|चौथा|चतुर्थ|पांचवां|पाँचवां|पंचम|छठा|षष्ठ|सातवां|सातवाँ|सप्तम|आठवां|आठवाँ|अष्टम|नौवां|नवम|दसवां|दशम|ग्यारहवां|एकादश|बारहवां|द्वादश|तेरहवां|त्रयोदश|चौदहवां|चतुर्दश|पंद्रहवां|पन्द्रहवां|पंचदश|सोलहवां|षोडश|सत्रहवां|सप्तदश|अठारहवां|अष्टादश';

const randomChapter = (): number => 1 + Math.floor(Math.random() * MAX_GITA_CHAPTER);

const chapterWordToNumber = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  const dictionary: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    पहला: 1,
    प्रथम: 1,
    दूसरा: 2,
    द्वितीय: 2,
    तीसरा: 3,
    तृतीय: 3,
    चौथा: 4,
    चतुर्थ: 4,
    पांचवां: 5,
    पाँचवां: 5,
    पंचम: 5,
    छठा: 6,
    षष्ठ: 6,
    सातवां: 7,
    सातवाँ: 7,
    सप्तम: 7,
    आठवां: 8,
    आठवाँ: 8,
    अष्टम: 8,
    नौवां: 9,
    नवम: 9,
    दसवां: 10,
    दशम: 10,
    ग्यारहवां: 11,
    एकादश: 11,
    बारहवां: 12,
    द्वादश: 12,
    तेरहवां: 13,
    त्रयोदश: 13,
    चौदहवां: 14,
    चतुर्दश: 14,
    पंद्रहवां: 15,
    पन्द्रहवां: 15,
    पंचदश: 15,
    सोलहवां: 16,
    षोडश: 16,
    सत्रहवां: 17,
    सप्तदश: 17,
    अठारहवां: 18,
    अष्टादश: 18
  };
  return dictionary[normalized] ?? null;
};

const cleanText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\|\|.*?\|\|/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const extractHint = (obj: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return cleanText(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ['ht', 'et', 'ec', 'sc', 'hc']) {
        if (typeof nested[nestedKey] === 'string' && String(nested[nestedKey]).trim().length > 0) {
          return cleanText(nested[nestedKey]);
        }
      }
    }
  }
  return '';
};

export const parseChapterVerseFromTopic = (topic?: string): { chapter: number; verse: number } => {
  const normalized = (topic ?? '').toLowerCase();

  const direct = normalized.match(/([0-9]{1,2})\s*[:.]\s*([0-9]{1,3})/);
  if (direct) {
    return {
      chapter: Math.max(1, Math.min(18, Number(direct[1]))),
      verse: Math.max(1, Number(direct[2]))
    };
  }

  const chapterOnly = normalized.match(/(?:chapter|adhyaay|adhyay|अध्याय)\s*([0-9]{1,2})/i);
  if (chapterOnly) {
    return {
      chapter: Math.max(1, Math.min(MAX_GITA_CHAPTER, Number(chapterOnly[1]))),
      verse: 1
    };
  }

  const chapterWordAfter = normalized.match(
    new RegExp(`(?:chapter|adhyaay|adhyay|अध्याय)\\s*(${CHAPTER_WORD_PATTERN})`, 'i')
  );
  if (chapterWordAfter) {
    const chapter = chapterWordToNumber(chapterWordAfter[1]);
    if (chapter) {
      return { chapter, verse: 1 };
    }
  }

  const chapterWordBefore = normalized.match(
    new RegExp(`(${CHAPTER_WORD_PATTERN})\\s*(?:chapter|adhyaay|adhyay|अध्याय)`, 'i')
  );
  if (chapterWordBefore) {
    const chapter = chapterWordToNumber(chapterWordBefore[1]);
    if (chapter) {
      return { chapter, verse: 1 };
    }
  }

  if (/(कर्म|karma|duty|कर्तव्य)/i.test(normalized)) return { chapter: 3, verse: 1 };
  if (/(ध्यान|dhyan|meditation|mind)/i.test(normalized)) return { chapter: 6, verse: 1 };
  if (/(भक्ति|bhakti|devotion|शरणागति|sharanagati|faith|विश्वास)/i.test(normalized)) {
    return { chapter: 12, verse: 1 };
  }

  return { chapter: randomChapter(), verse: 1 };
};

const toEntry = (json: Record<string, unknown>, chapter: number, verse: number): SatsangLedgerEntry | null => {
  const slok = cleanText(json.slok);
  if (!slok) return null;

  const hintArth =
    extractHint(json, ['tej', 'siva', 'jaya', 'chinmay', 'prabhu']) ||
    'इस श्लोक का सरल अर्थ जीवन में धैर्य, संतुलन और विवेक का अभ्यास करना है।';
  const hintVyakhya =
    extractHint(json, ['prabhu', 'madhav', 'adi', 'sankar', 'raman']) ||
    'दैनिक जीवन में इस श्लोक को व्यवहार, निर्णय और मन की स्थिरता में लागू करें।';

  return {
    id: `bg_${chapter}_${verse}`,
    textName: 'Bhagavad Gita',
    chapter,
    verse,
    sanskrit: slok,
    reference: `Bhagavad Gita ${chapter}.${verse}`,
    themes: [],
    arthHint: hintArth.slice(0, 260),
    vyakhyaHint: hintVyakhya.slice(0, 340)
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const fetchFromVedicScriptures = async (chapter: number, verse: number): Promise<SatsangLedgerEntry | null> => {
  const base = env.BHAGAVAD_GITA_API_BASE_URL || 'https://vedicscriptures.github.io';
  const url = new URL(`/slok/${chapter}/${verse}/`, base).toString();
  const response = await withTimeout(fetch(url), env.BHAGAVAD_GITA_TIMEOUT_MS);
  if (!response.ok) return null;
  const json = (await response.json()) as Record<string, unknown>;
  return toEntry(json, chapter, verse);
};

const fetchFromBhagavadGitaIo = async (chapter: number, verse: number): Promise<SatsangLedgerEntry | null> => {
  if (!env.BHAGAVAD_GITA_API_KEY) return null;
  const base = env.BHAGAVAD_GITA_API_BASE_URL || 'https://api.bhagavadgita.io';
  const url = new URL(`/v2/chapters/${chapter}/verses/${verse}/`, base).toString();
  const response = await withTimeout(
    fetch(url, {
      headers: {
        'x-api-key': env.BHAGAVAD_GITA_API_KEY
      }
    }),
    env.BHAGAVAD_GITA_TIMEOUT_MS
  );
  if (!response.ok) return null;
  const json = (await response.json()) as Record<string, unknown>;
  return toEntry(json, chapter, verse);
};

const fetchEntry = async (chapter: number, verse: number): Promise<SatsangLedgerEntry | null> => {
  try {
    if (env.BHAGAVAD_GITA_PROVIDER === 'bhagavadgita_io') {
      const fromPrimary = await fetchFromBhagavadGitaIo(chapter, verse);
      if (fromPrimary) return fromPrimary;
      return fetchFromVedicScriptures(chapter, verse);
    }
    const fromPrimary = await fetchFromVedicScriptures(chapter, verse);
    if (fromPrimary) return fromPrimary;
    return fetchFromBhagavadGitaIo(chapter, verse);
  } catch (error) {
    logger.warn('Bhagavad Gita API fetch failed', {
      chapter,
      verse,
      reason: (error as Error).message
    });
    return null;
  }
};

export const getSatsangLedgerEntryById = (id: string): SatsangLedgerEntry | null => {
  const cached = runtimeCache.get(id);
  if (cached) return cached;
  const fallback = FALLBACK_CATALOG.find((entry) => entry.id === id) ?? null;
  if (fallback) runtimeCache.set(fallback.id, fallback);
  return fallback;
};

export const buildSatsangLedger = async (args: BuildSatsangLedgerArgs): Promise<BuildSatsangLedgerResult> => {
  const target = Math.max(2, Math.min(8, args.targetShlokaCount));
  const exclude = new Set((args.excludeIds ?? []).map((id) => id.trim()).filter(Boolean));
  const start = parseChapterVerseFromTopic(args.topic);

  const entries: SatsangLedgerEntry[] = [];
  const maxFetch = Math.max(target + 4, target);
  let misses = 0;

  for (let offset = 0; offset < maxFetch; offset += 1) {
    const verse = start.verse + offset;
    const entry = await fetchEntry(start.chapter, verse);
    if (!entry) {
      misses += 1;
      if (entries.length >= target || misses >= 3) break;
      continue;
    }
    if (exclude.has(entry.id)) continue;
    entries.push(entry);
    runtimeCache.set(entry.id, entry);
    if (entries.length >= target) break;
  }

  if (entries.length < target) {
    const fallback = FALLBACK_CATALOG
      .filter((entry) => !exclude.has(entry.id))
      .sort((a, b) => {
        const aSameStart = a.chapter === start.chapter && a.verse >= start.verse ? 0 : 1;
        const bSameStart = b.chapter === start.chapter && b.verse >= start.verse ? 0 : 1;
        if (aSameStart !== bSameStart) return aSameStart - bSameStart;

        const chapterDistance = Math.abs(a.chapter - start.chapter) - Math.abs(b.chapter - start.chapter);
        if (chapterDistance !== 0) return chapterDistance;

        if (a.chapter !== b.chapter) return a.chapter - b.chapter;
        return a.verse - b.verse;
      });

    for (const entry of fallback) {
      if (entries.some((e) => e.id === entry.id)) continue;
      entries.push(entry);
      runtimeCache.set(entry.id, entry);
      if (entries.length >= target) break;
    }
  }

  return {
    ids: entries.map((entry) => entry.id),
    entries
  };
};
