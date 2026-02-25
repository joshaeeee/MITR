import { ReminderService } from '../reminders/reminder-service.js';
import { GuidedSessionPlan } from '../speech/guided-session.js';

export interface AartiSuggestion {
  title: string;
  traditionHint: string;
  reason: string;
  youtubeSearchUrl: string;
}

const IST_TIMEZONE = 'Asia/Kolkata';

const makeYoutubeSearchUrl = (query: string): string =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

const devotionalByWeekday: Record<number, AartiSuggestion[]> = {
  0: [
    {
      title: 'Shiv Aarti - Om Jai Shiv Omkara',
      traditionHint: 'Ravivar sandhya bhakti',
      reason: 'Sunday evening devotional routine',
      youtubeSearchUrl: makeYoutubeSearchUrl('Om Jai Shiv Omkara aarti')
    }
  ],
  1: [
    {
      title: 'Somvar Shiv Bhajan',
      traditionHint: 'Somvar Shiv bhakti',
      reason: 'Monday Shiva devotion',
      youtubeSearchUrl: makeYoutubeSearchUrl('Somvar Shiv bhajan')
    }
  ],
  2: [
    {
      title: 'Hanuman Chalisa',
      traditionHint: 'Mangalvar Hanuman ji',
      reason: 'Tuesday Hanuman devotion',
      youtubeSearchUrl: makeYoutubeSearchUrl('Hanuman Chalisa')
    }
  ],
  3: [
    {
      title: 'Ganesh Aarti - Sukhkarta Dukhharta',
      traditionHint: 'Budhvar Ganesh ji',
      reason: 'Wednesday Ganesh devotion',
      youtubeSearchUrl: makeYoutubeSearchUrl('Sukhkarta Dukhharta Ganesh aarti')
    }
  ],
  4: [
    {
      title: 'Vishnu / Sai Bhajan',
      traditionHint: 'Guruvar satsang',
      reason: 'Thursday bhakti routine',
      youtubeSearchUrl: makeYoutubeSearchUrl('Vishnu bhajan guruvar')
    }
  ],
  5: [
    {
      title: 'Maa Durga Aarti - Ambe Tu Hai Jagdambe',
      traditionHint: 'Shukravar Devi upasana',
      reason: 'Friday Devi devotion',
      youtubeSearchUrl: makeYoutubeSearchUrl('Ambe tu hai jagdambe kali aarti')
    }
  ],
  6: [
    {
      title: 'Shani Dev Bhajan',
      traditionHint: 'Shanivar bhakti',
      reason: 'Saturday Shani devotion',
      youtubeSearchUrl: makeYoutubeSearchUrl('Shani dev bhajan')
    }
  ]
};

const thoughtOfDay = [
  'Karmanye vadhikaraste, ma phaleshu kadachana.',
  'Satyam vada, dharmam chara.',
  'Shraddhavan labhate gyanam.',
  'Ahimsa paramo dharmah.',
  'Yogah karmasu kaushalam.'
];

const festivalHints: Record<string, { festival: string; line: string }> = {
  '01-14': { festival: 'Makar Sankranti', line: 'Aaj Makar Sankranti ka pavitra avsar hai.' },
  '08-15': { festival: 'Janmashtami (approx)', line: 'Aaj Krishna bhakti ka din mana sakte hain.' },
  '10-02': { festival: 'Navratri period (varies)', line: 'Navratri ke aas-paas ka samay hai, Devi upasana karein.' },
  '10-24': { festival: 'Diwali period (varies)', line: 'Diwali ke aas-paas ka samay hai, Lakshmi poojan ka mahatva hai.' }
};

export class CompanionService {
  constructor(private readonly reminders: ReminderService) {}

  suggestAarti(now = new Date()): AartiSuggestion {
    const weekdayName = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: IST_TIMEZONE }).format(now);
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[weekdayName] ?? now.getDay();
    const entries = devotionalByWeekday[weekday] ?? devotionalByWeekday[now.getDay()];
    return entries[0];
  }

  async getDailyBriefing(userId: string, language = 'hi-IN'): Promise<{
    dateISO: string;
    festival?: string;
    festivalLine?: string;
    remindersToday: string[];
    thought: string;
    language: string;
  }> {
    const now = new Date();
    const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const festival = festivalHints[monthDay];
    const reminders = await this.reminders.listByUser(userId);
    const todayKey = now.toISOString().slice(0, 10);
    const remindersToday = reminders
      .filter((r) => r.datetimeISO.startsWith(todayKey))
      .map((r) => `${r.title} (${new Date(r.datetimeISO).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})`);

    const thought = thoughtOfDay[now.getDate() % thoughtOfDay.length];
    return {
      dateISO: now.toISOString(),
      festival: festival?.festival,
      festivalLine: festival?.line,
      remindersToday,
      thought,
      language
    };
  }

  getPranayamaGuide(minutes = 5): { title: string; steps: string[]; sessionPlan: GuidedSessionPlan } {
    const safeMinutes = Math.max(2, Math.min(20, Math.floor(minutes)));
    const rounds = Math.max(4, Math.floor((safeMinutes * 60) / 18));
    const steps: GuidedSessionPlan['steps'] = [
      { type: 'speak', text: 'Seedhe baithiye, kandhe dheele chhodiye, aur aankhen band kijiye.' },
      { type: 'speak', text: `Hum ${rounds} rounds ka shaant pranayama karenge. Mere count ke saath chalna.` }
    ];
    for (let i = 0; i < rounds; i += 1) {
      steps.push({ type: 'speak', text: `Round ${i + 1}. Saans andar lijiye.` });
      steps.push({ type: 'count', label: 'andar', from: 1, to: 4, intervalMs: 900 });
      steps.push({ type: 'speak', text: 'Saans rokiye.' });
      steps.push({ type: 'count', label: 'rokiye', from: 1, to: 2, intervalMs: 900 });
      steps.push({ type: 'speak', text: 'Ab dheere se saans bahar chhodiye.' });
      steps.push({ type: 'count', label: 'bahar', from: 1, to: 6, intervalMs: 900 });
      steps.push({ type: 'silence', durationMs: 1200 });
    }
    steps.push({ type: 'speak', text: 'Bahut badhiya. Ab 30 second shaant baithiye aur dhyaan saans par rakhiye.' });
    steps.push({ type: 'silence', durationMs: 30000 });
    steps.push({ type: 'speak', text: 'Aaj ka pranayama session yahin samaapt hota hai. Aapne bahut accha kiya.' });

    const sessionPlan: GuidedSessionPlan = {
      id: `pranayama-${safeMinutes}m`,
      kind: 'pranayama',
      title: `${safeMinutes}-minute guided pranayama`,
      totalEstimatedMs: safeMinutes * 60 * 1000,
      ambientPreset: 'flute_calm',
      steps
    };

    return {
      title: `${safeMinutes}-minute guided breathing`,
      steps: [
        'Seedhe baithiye, kandhe dheele chhodiye.',
        '4 count tak gehri saans lijiye.',
        '2 count tak saans rokiye.',
        '6 count tak dheere se saans chhodiye.',
        `Is cycle ko lagbhag ${rounds} rounds karein.`,
        'Ant mein 30 second shaant baithkar dhyaan rakhein.'
      ],
      sessionPlan
    };
  }

  getStory(theme = 'panchatantra'): { title: string; story: string } {
    const key = theme.toLowerCase();
    if (key.includes('akbar') || key.includes('birbal')) {
      return {
        title: 'Akbar-Birbal: Sabse Badi Cheez',
        story:
          'Ek din darbar mein Badshah Akbar ne sabhi mantriyon se poocha: "Duniya ki sabse badi cheez kya hai?" Kisi ne kaha dhan, kisi ne kaha shakti, aur kisi ne kaha gyaan. Badshah har jawab sunte rahe, lekin unke chehre par santushti nahi thi.\n\nPhir unhone Birbal ki taraf dekha. Birbal ne vinamrata se kaha, "Huzoor, sabse badi cheez samay hai." Darbar mein sannata chha gaya. Akbar ne poocha, "Samay kaise sabse bada hua?" Birbal bole, "Dhan khatam ho sakta hai, shakti chhin sakti hai, lekin samay sabko badal deta hai. Jo aaj raja hai kal praja ho sakta hai, aur jo aaj dukhi hai kal sukh pa sakta hai."\n\nBirbal ne aage kaha, "Samay kisi ka intezar nahi karta. Jo samay ka satkar karta hai, woh jeevan mein unnati karta hai. Jo samay gawa deta hai, woh mauke kho deta hai." Akbar ne muskurate hue kaha, "Birbal, tumne phir darbar ko ek anmol seekh di."\n\nUs din ke baad Akbar ne darbar ke kaam aur bhi niyamit kiye. Darbariyon ne bhi samjha ki jeevan mein anushasan aur samay ka maan hi safalta ki asli kunji hai.\n\nSeekh: Samay sabse bada dhan hai. Iska sahi upyog hi jeevan ko mahatvapurn banata hai.'
      };
    }
    if (key.includes('tenali')) {
      return {
        title: 'Tenali Raman: Buddhi Ka Upyog',
        story:
          'Vijayanagar ke darbar mein ek vidwan mehmaan aaya. Usne raja se kaha ki darbar mein agar koi vastav mein buddhimaan hai, to woh uske teen kathin prashnon ka turant jawab de. Darbar ke bade-bade pandit chintit ho gaye.\n\nRaja ne Tenali Raman ko bulaya. Mehmaan ne pehla prashn poocha: "Duniya ka kendr kahan hai?" Tenali ne turant zameen par ek bindu bana kar kaha, "Yahi kendr hai. Vishwas na ho to naap lijiye." Darbar mein halki hansi gunj uthi.\n\nDoosra prashn tha: "Aasmaan mein kitne taare hain?" Tenali ne ek bhed bulwayi aur bola, "Is bhed ke baalon jitne. Agar shaq ho to gin lijiye." Mehmaan hairan reh gaya.\n\nTeesra prashn: "Duniya mein sabse zaroori cheez kya hai?" Tenali ne jawab diya, "Samay par sahi buddhi ka prayog. Shakti aur dhan tab tak kaam ke hain jab tak unka sahi upyog ho." Raja bahut prasann hue.\n\nMehmaan ne sweekar kiya ki Tenali ka dimag teekha hi nahi, balki shaant aur upyogi bhi hai. Darbar ko samajh aa gaya ki kathin samasya ka hal sirf jaankari se nahi, sochne ke tareeke se nikalta hai.\n\nSeekh: Tez dimag ka asli matlab hai shaant rehkar sahi samay par sahi tareeka chunna.'
      };
    }
    return {
      title: 'Panchatantra: Sher Aur Khargosh',
      story:
        'Ek ghane jungle mein ek bahut hi balwan sher rehta tha. Woh roz shikar karta aur anek janwaron ko maar deta. Saare jaanwar bhay se kaampte rehte. Aakhir sabne milkar faisla kiya ki roz ek jaanwar swayam sher ke paas jayega, taaki bekaar ka khoon-kharaba ruk sake.\n\nKuch din tak yahi chalta raha. Ek din ek chhota sa khargosh ki baari aayi. Khargosh dheere-dheere chala aur jaanbujhkar der se sher ke paas pahuncha. Sher gusse se dahada, "Itni der kyun? Aur tum itne chhote, mera pet kaise bharega?"\n\nKhargosh ne darne ka naatak karte hue kaha, "Maharaj, main to samay par hi aa raha tha. Lekin raste mein ek doosra sher mil gaya. Usne kaha ki woh hi jungle ka asli raja hai. Usne mujhe rok liya." Yeh sunkar sher ka gussa aur badh gaya. "Mujhe turant uske paas le chalo!"\n\nKhargosh sher ko ek gehray kuen ke paas le gaya. Khargosh bola, "Maharaj, woh isi kuen ke andar chhupa hai." Sher ne kuen mein jhaanka to usse apni hi parchai dikhayi di. Gusse mein usne socha doosra sher usse ghur raha hai. Usne zor se dahad lagayi; kuen se pratidhvani aayi. Sher ko laga saamne wala sher jawab de raha hai.\n\nBina soche-samjhe sher kuen mein kud pada aur doob gaya. Chhota khargosh jeet gaya. Jungle ke saare jaanwar khush ho gaye aur us din ke baad shanti se jeene lage.\n\nSeekh: Sirf bal se nahi, buddhi, dhairya aur samayojit soch se badi se badi samasya ka hal nikalta hai.'
    };
  }

  getBrainGame(type = 'riddle'): { type: string; prompt: string; answer?: string } {
    if (type.toLowerCase().includes('shloka')) {
      return {
        type: 'complete_the_shloka',
        prompt: 'Shloka poora kijiye: "Karmanye vadhikaraste..."',
        answer: 'Ma phaleshu kadachana.'
      };
    }
    if (type.toLowerCase().includes('math')) {
      return {
        type: 'quick_math',
        prompt: 'Agar 12 mein 9 jod dein aur phir 7 ghata dein, kya bachega?',
        answer: '14'
      };
    }
    return {
      type: 'riddle',
      prompt: 'Paheli: Aisa kya hai jo tootne par awaaz nahi karta?',
      answer: 'Vishwas / trust.'
    };
  }

  getFestivalCompanion(now = new Date()): { dateISO: string; festival?: string; guidance: string } {
    const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const festival = festivalHints[monthDay];
    if (!festival) {
      return {
        dateISO: now.toISOString(),
        guidance: 'Aaj ke liye ek chhota sankalp rakhein: prarthana, kritagyata aur daya.'
      };
    }
    return {
      dateISO: now.toISOString(),
      festival: festival.festival,
      guidance: `${festival.line} Is avsar par ek chhoti prarthana aur deep prajwalit karein.`
    };
  }
}
