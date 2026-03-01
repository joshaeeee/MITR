import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDomainScores,
  computeSignalConfidence,
  extractSignalFeatures,
  scoreBandFromOverall,
  toIsoDateKey
} from './insights-scoring.js';

test('extractSignalFeatures picks key wellbeing cues from multilingual text', () => {
  const features = extractSignalFeatures('Aaj main thoda उदास hoon but बेटा called and medicine ले ली');

  assert.ok(features.negativeHits >= 1);
  assert.ok(features.familyHits >= 1);
  assert.ok(features.adherenceHits >= 1);
});

test('computeDomainScores keeps distress and adherence separable', () => {
  const distressFeatures = extractSignalFeatures('I feel scared, helpless and confused today');
  const adherenceFeatures = extractSignalFeatures('Medicine tablet routine done on time, reminder worked');

  const distressScores = computeDomainScores(distressFeatures);
  const adherenceScores = computeDomainScores(adherenceFeatures);

  assert.ok(distressScores.distressScore > adherenceScores.distressScore);
  assert.ok(adherenceScores.adherenceScore > distressScores.adherenceScore);
});

test('signal confidence increases with lexical richness and continuity', () => {
  const sparse = computeSignalConfidence({
    features: extractSignalFeatures('ok'),
    languageNormalizationConfidence: 70,
    prosodyCompleteness: 0,
    priorTurnsToday: 0
  });
  const rich = computeSignalConfidence({
    features: extractSignalFeatures('Today I spoke with family, took medicine, and attended satsang happily.'),
    languageNormalizationConfidence: 90,
    prosodyCompleteness: 0,
    priorTurnsToday: 4
  });

  assert.ok(rich.confidence > sparse.confidence);
  assert.ok(rich.dataSufficiency > sparse.dataSufficiency);
});

test('scoreBandFromOverall maps score thresholds correctly', () => {
  assert.equal(scoreBandFromOverall(80), 'stable');
  assert.equal(scoreBandFromOverall(50), 'watch');
  assert.equal(scoreBandFromOverall(25), 'concern');
});

test('toIsoDateKey uses IST day boundaries', () => {
  const key = toIsoDateKey(new Date('2026-02-28T23:45:00.000Z'), 'Asia/Kolkata');
  assert.equal(key, '2026-03-01');
});
