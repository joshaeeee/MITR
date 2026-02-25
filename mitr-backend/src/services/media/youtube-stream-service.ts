import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const execFileAsync = promisify(execFile);

interface YtSearchJson {
  entries?: Array<{ webpage_url?: string; title?: string }>;
  webpage_url?: string;
  title?: string;
}

export interface MediaStreamResolution {
  title: string;
  searchQuery: string;
  webpageUrl?: string;
  streamUrl?: string;
}

const toYoutubeSearchUrl = (query: string): string =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

export class YoutubeStreamService {
  private cache = new Map<string, { value: MediaStreamResolution; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  async resolveFromSearch(query: string): Promise<MediaStreamResolution> {
    const searchQuery = query.trim();
    if (!searchQuery) {
      return { title: 'Unknown', searchQuery };
    }
    const key = searchQuery.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const { stdout } = await execFileAsync(
        env.YTDLP_PATH,
        ['-J', '--no-warnings', '--no-playlist', `ytsearch1:${searchQuery}`],
        { timeout: env.YTDLP_SEARCH_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout) as YtSearchJson;
      const entry = parsed.entries?.[0] ?? parsed;
      const webpageUrl = entry.webpage_url;
      const title = entry.title ?? searchQuery;
      if (!webpageUrl) {
        return { title, searchQuery, webpageUrl: toYoutubeSearchUrl(searchQuery) };
      }

      let streamUrl: string | undefined;
      try {
        const attempts: string[][] = [
          ['--no-warnings', '--no-playlist', '-f', 'bestaudio', '-g', webpageUrl],
          ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-g', webpageUrl]
        ];
        for (const args of attempts) {
          const streamResult = await execFileAsync(env.YTDLP_PATH, args, {
            timeout: env.YTDLP_STREAM_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024
          });
          streamUrl = streamResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.startsWith('http'));
          if (streamUrl) break;
        }
      } catch (error) {
        const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
          ? (error as { stderr?: string }).stderr?.slice(0, 300)
          : undefined;
        logger.warn('yt-dlp stream-url resolution failed; returning webpage URL fallback', {
          query: searchQuery,
          webpageUrl,
          error: (error as Error).message,
          stderr
        });
      }

      const value = { title, searchQuery, webpageUrl, streamUrl };
      this.cache.set(key, { value, expiresAt: Date.now() + YoutubeStreamService.CACHE_TTL_MS });
      return value;
    } catch (error) {
      logger.warn('yt-dlp stream resolution failed', {
        query: searchQuery,
        error: (error as Error).message
      });
      return {
        title: searchQuery,
        searchQuery,
        webpageUrl: toYoutubeSearchUrl(searchQuery)
      };
    }
  }
}
