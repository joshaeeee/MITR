import { createToolDefinitions } from '../src/services/agent/tools.js';
import { ReligiousRetriever } from '../src/services/retrieval/religious-retriever.js';
import { Mem0Service } from '../src/services/memory/mem0-service.js';
import { ReminderService } from '../src/services/reminders/reminder-service.js';
import { NewsService } from '../src/services/news/news-service.js';
import { CompanionService } from '../src/services/companion/companion-service.js';
import { DiaryService } from '../src/services/companion/diary-service.js';
import { YoutubeStreamService } from '../src/services/media/youtube-stream-service.js';
import { SessionDirectorService } from '../src/services/long-session/session-director-service.js';
import { GeocodingService } from '../src/services/location/geocoding-service.js';
import { PanchangService } from '../src/services/panchang/panchang-service.js';
import { WebSearchService } from '../src/services/web/web-search-service.js';

const reminderService = new ReminderService();
const religiousRetriever = new ReligiousRetriever();
const geocodingService = new GeocodingService();

const tools = createToolDefinitions({
  religiousRetriever,
  mem0: new Mem0Service(),
  reminderService,
  newsService: new NewsService(),
  companionService: new CompanionService(reminderService),
  diaryService: new DiaryService(),
  sessionDirector: new SessionDirectorService(),
  youtubeStreamService: new YoutubeStreamService(),
  panchangService: new PanchangService(geocodingService),
  webSearchService: new WebSearchService()
});

console.log(`Loaded ${tools.length} tools`);
console.log(tools.map((tool) => `- ${tool.name}`).join('\n'));
process.exit(0);
