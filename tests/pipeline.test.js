// Deterministic tests for Discovery Transcriber v2 — no network, ffmpeg, or keys.
const { normalize: dgNormalize } = require('../lib/asr/deepgram');
const { normalize: smNormalize } = require('../lib/asr/speechmatics');
const { computeCheckpoints } = require('../lib/visual');
const { mergeByTime, render } = require('../lib/pipeline');
const { distinctLabels, extractJsonObject, looksValid, applyMap } = require('../lib/refine');

let pass = 0;
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (cond) pass++; else process.exitCode = 1; };

// 1. Deepgram normalize — utterances path.
{
  const json = {
    metadata: { duration: 123.4 },
    results: {
      utterances: [
        { start: 0.2, speaker: 0, transcript: 'Hello there.' },
        { start: 5.9, speaker: 1, transcript: 'Um, hi.' },
      ],
    },
  };
  const { items, durationSeconds } = dgNormalize(json);
  check('dg: utterances → 2 items', items.length === 2);
  check('dg: speaker index +1 → S1/S2', items[0].speaker === 'S1' && items[1].speaker === 'S2');
  check('dg: timestamps rounded seconds', items[0].t === 0 && items[1].t === 6);
  check('dg: duration rounded', durationSeconds === 123);
  check('dg: filler words preserved', /Um,/.test(items[1].text));
}

// 2. Deepgram normalize — words fallback (no utterances).
{
  const json = {
    metadata: { duration: 10 },
    results: {
      channels: [{ alternatives: [{ words: [
        { punctuated_word: 'Hi', start: 0.0, speaker: 0 },
        { punctuated_word: 'there.', start: 0.5, speaker: 0 },
        { punctuated_word: 'Yes.', start: 2.0, speaker: 1 },
      ] }] }],
    },
  };
  const { items } = dgNormalize(json);
  check('dg words: grouped by speaker into 2 lines', items.length === 2);
  check('dg words: first line joined', items[0].text === 'Hi there.' && items[0].speaker === 'S1');
  check('dg words: speaker change starts new line', items[1].text === 'Yes.' && items[1].speaker === 'S2');
}

// 3. Speechmatics normalize — word + punctuation grouping.
{
  const json = { results: [
    { type: 'word', start_time: 0.1, end_time: 0.4, alternatives: [{ content: 'Hello', speaker: 'S1' }] },
    { type: 'punctuation', start_time: 0.4, end_time: 0.4, alternatives: [{ content: ',', speaker: 'S1' }] },
    { type: 'word', start_time: 0.5, end_time: 0.9, alternatives: [{ content: 'sir', speaker: 'S1' }] },
    { type: 'word', start_time: 3.0, end_time: 3.4, alternatives: [{ content: 'Yes', speaker: 'S2' }] },
    { type: 'punctuation', start_time: 3.4, end_time: 3.4, alternatives: [{ content: '.', speaker: 'S2' }] },
  ] };
  const { items, durationSeconds } = smNormalize(json);
  check('sm: two speaker turns', items.length === 2);
  check('sm: punctuation attached with no leading space', items[0].text === 'Hello, sir');
  check('sm: second turn speaker + text', items[1].speaker === 'S2' && items[1].text === 'Yes.');
  check('sm: duration from last end_time', durationSeconds === 3);
}

// 4. Visual checkpoints — opening + last-10s of every 10-min + closing; covers a long file.
{
  const cps = computeCheckpoints(4730, 600, 10); // 1:18:50
  check('cp: opens at 0', cps[0].start === 0 && cps[0].label === 0);
  check('cp: every window is 10s', cps.every((c) => (c.end - c.start) <= 10 + 1e-9));
  check('cp: a 10-min mark present (last 10s of 10:00)', cps.some((c) => c.label === 600 && c.start === 590 && c.end === 600));
  check('cp: closing reaches the end', cps[cps.length - 1].end === 4730);
  check('cp: strictly increasing starts', cps.every((c, i) => i === 0 || c.start > cps[i - 1].start));
  // ~ opening + marks(600..4200 => 7) + closing ≈ 9
  check('cp: count reasonable for 78min', cps.length >= 8 && cps.length <= 10);
}

// 5. Merge ordering — a [Scene] at t sorts just before dialogue at the same t.
{
  const dialogue = [{ t: 600, kind: 'dialogue', speaker: 'S1', text: 'ok' }, { t: 0, kind: 'dialogue', speaker: 'S1', text: 'hi' }];
  const visuals = [{ t: 600, kind: 'visual', body: '[Scene at 10:00 — a room.]' }];
  const merged = mergeByTime(dialogue, visuals);
  check('merge: sorted by time', merged[0].t === 0 && merged[1].t === 600 && merged[2].t === 600);
  check('merge: visual precedes dialogue at equal t', merged[1].kind === 'visual' && merged[2].kind === 'dialogue');
}

// 6. Render — dialogue keeps H:MM:SS; visual has NO leading timecode.
{
  const out = render([
    { t: 0, kind: 'dialogue', speaker: 'Officer Taylor', text: 'Step out.' },
    { t: 600, kind: 'visual', body: '[Scene at 0:10:00 — roadside at night.]' },
  ]);
  check('render: dialogue line format', out.includes('0:00:00 - Officer Taylor: Step out.'));
  check('render: visual line has no leading timecode',
    /\n\[Scene at 0:10:00 — roadside at night\.\]/.test(out) && !/\d:\d\d:\d\d - \[Scene/.test(out));
}

// 6b. Visual prompt — full on first checkpoint, delta-aware when given a previous.
{
  const { buildPrompt } = require('../lib/visual/gemini');
  check('visual prompt: first checkpoint is full', /FIRST checkpoint/.test(buildPrompt(10, '')));
  const p = buildPrompt(10, 'A room with two officers.');
  check('visual prompt: carries previous + asks for update',
    /A room with two officers\./.test(p) && /UPDATE/i.test(p) && /unchanged/i.test(p));
}

// 7. Refine helpers + verbatim-safe apply.
{
  const items = [
    { t: 0, kind: 'dialogue', speaker: 'S1', text: 'My name is Jason.' },
    { t: 5, kind: 'visual', body: '[Scene …]' },
    { t: 6, kind: 'dialogue', speaker: 'S2', text: 'Step out of the car.' },
  ];
  check('refine: distinct labels in order', JSON.stringify(distinctLabels(items)) === JSON.stringify(['S1', 'S2']));
  check('refine: extractJsonObject tolerates prose', JSON.stringify(extractJsonObject('sure: {"S1":"Jason Griner"} done')) === JSON.stringify({ S1: 'Jason Griner' }));
  check('refine: looksValid rejects Speaker N / bare label', !looksValid('Speaker 1') && !looksValid('S2') && looksValid('Officer Taylor'));

  const before = items.map((i) => i.text || i.body).join('|');
  const n = applyMap(items, { S1: 'Jason Griner', S2: 'Officer Taylor' });
  const after = items.map((i) => i.text || i.body).join('|');
  check('refine: applied to both dialogue lines', n === 2);
  check('refine: labels replaced', items[0].speaker === 'Jason Griner' && items[2].speaker === 'Officer Taylor');
  check('refine: TEXT unchanged (verbatim)', before === after);
  check('refine: visual line untouched', items[1].kind === 'visual' && items[1].body === '[Scene …]');
}

console.log(`\n${pass} checks passed${process.exitCode ? ' — SOME FAILED' : ' — ALL PASSED'}`);
