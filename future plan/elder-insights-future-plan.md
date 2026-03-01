# Elder Insights Future Plan

This document captures deferred, high-impact improvements for the insights system.

## Priority List (Deferred)

1. **Temporal change detection (personal baseline drift)** — 10/10  
Compare each elder against their own baseline instead of global thresholds.

2. **Recommendation policy evaluation** — 10/10  
Track whether caregiver recommendations are accepted, ignored, or dismissed; optimize quality and reduce recommendation fatigue.

3. **Safety governance** — 10/10  
Formal escalation policy with audit/review loop for false positives, misses, and alert regret.

4. **Confidence calibration metrics** — 9/10  
Measure whether confidence values match actual correctness (e.g., calibration error).

5. **Bias and subgroup audits** — 9/10  
Evaluate performance by language/script groups and low-speech vs high-speech cohorts.

6. **Labeling and calibration loop** — 9/10  
Use weekly caregiver check-ins (and optional elder short check-ins) as calibration signals.

7. **Validated construct mapping (GDS/PHQ/LSNS/UCLA-inspired)** — 8/10  
Map output domains to validated wellbeing/social constructs without making clinical diagnoses.

8. **Benchmark protocol discipline (ADReSS/DAIC-style)** — 8/10  
Use strict offline evaluation protocol and leakage controls before model/rule updates.

9. **Older-adult human factors (trust UX)** — 8/10  
Improve explanation quality, uncertainty wording, and caregiver-facing interpretability.

10. **Real prosody extraction from audio** — 7/10  
Upgrade from prosody proxy features to actual acoustic features (pitch/energy/pause dynamics).

## Notes

- Current release remains **wellness-only** and **non-diagnostic**.
- These items are intentionally deferred to a later hardening phase.

## Research References

1. Yesavage et al., 1982 (GDS): https://pubmed.ncbi.nlm.nih.gov/7183759/
2. Phelan et al., 2010 (PHQ-9 in older adults): https://pubmed.ncbi.nlm.nih.gov/20122044/
3. Lubben et al., 2006 (LSNS-6): https://pubmed.ncbi.nlm.nih.gov/16399903/
4. Russell, 1996 (UCLA Loneliness v3): https://pubmed.ncbi.nlm.nih.gov/8879412/
5. ADReSS Challenge (Interspeech 2020): https://www.isca-archive.org/interspeech_2020/luz20_interspeech.html
6. DAIC-WOZ benchmark lineage: https://aclanthology.org/W14-3215/
7. Older-adult conversational agent systematic review: https://pubmed.ncbi.nlm.nih.gov/36565617/
