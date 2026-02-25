const LANGUAGE_ALIASES: Record<string, string> = {
  hindi: 'hi-IN',
  hi: 'hi-IN',
  'hi-in': 'hi-IN',
  english: 'en-IN',
  en: 'en-IN',
  'en-in': 'en-IN',
  tamil: 'ta-IN',
  ta: 'ta-IN',
  'ta-in': 'ta-IN',
  telugu: 'te-IN',
  te: 'te-IN',
  'te-in': 'te-IN',
  kannada: 'kn-IN',
  kn: 'kn-IN',
  'kn-in': 'kn-IN',
  malayalam: 'ml-IN',
  ml: 'ml-IN',
  'ml-in': 'ml-IN',
  marathi: 'mr-IN',
  mr: 'mr-IN',
  'mr-in': 'mr-IN',
  gujarati: 'gu-IN',
  gu: 'gu-IN',
  'gu-in': 'gu-IN',
  bengali: 'bn-IN',
  bangla: 'bn-IN',
  bn: 'bn-IN',
  'bn-in': 'bn-IN',
  punjabi: 'pa-IN',
  panjabi: 'pa-IN',
  pa: 'pa-IN',
  'pa-in': 'pa-IN',
  odia: 'od-IN',
  oriya: 'od-IN',
  od: 'od-IN',
  'od-in': 'od-IN',
  urdu: 'ur-IN',
  ur: 'ur-IN',
  'ur-in': 'ur-IN'
};

export const normalizeLanguageCode = (input?: string | null, fallback = 'hi-IN'): string => {
  if (!input) return fallback;
  const cleaned = input.trim();
  if (!cleaned) return fallback;

  const key = cleaned.toLowerCase().replace(/_/g, '-');
  if (LANGUAGE_ALIASES[key]) return LANGUAGE_ALIASES[key];

  const bcp47Like = /^([a-z]{2,3})(-[a-z]{2})?$/i;
  if (bcp47Like.test(cleaned)) {
    const [langPart, regionPart] = cleaned.split('-');
    const lang = langPart.toLowerCase();
    if (regionPart) {
      return `${lang}-${regionPart.toUpperCase()}`;
    }
    return `${lang}-IN`;
  }

  return fallback;
};
