import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChapterVerseFromTopic } from './satsang-ledger.js';

test('parseChapterVerseFromTopic supports explicit chapter.verse', () => {
  const parsed = parseChapterVerseFromTopic('Bhagavad Gita 2.47');
  assert.equal(parsed.chapter, 2);
  assert.equal(parsed.verse, 47);
});

test('parseChapterVerseFromTopic supports Hindi ordinal chapter requests', () => {
  const parsed = parseChapterVerseFromTopic('गीता का पहला अध्याय');
  assert.equal(parsed.chapter, 1);
  assert.equal(parsed.verse, 1);
});

test('parseChapterVerseFromTopic maps thematic topics to chapter starts', () => {
  const parsedKarma = parseChapterVerseFromTopic('कर्म पर satsang');
  assert.equal(parsedKarma.chapter, 3);
  assert.equal(parsedKarma.verse, 1);

  const parsedBhakti = parseChapterVerseFromTopic('भक्ति satsang');
  assert.equal(parsedBhakti.chapter, 12);
  assert.equal(parsedBhakti.verse, 1);
});

test('parseChapterVerseFromTopic defaults to random chapter start', () => {
  const parsed = parseChapterVerseFromTopic('सत्संग शुरू करें');
  assert.equal(parsed.verse, 1);
  assert.ok(parsed.chapter >= 1 && parsed.chapter <= 18);
});
