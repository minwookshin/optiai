import { sha256 } from './svg-document.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

const STUDY_TOOL = 'OptiAI Adaptive Preference Lab';
const RESPONSE_TOOL = 'OptiAI Adaptive Preference Response';
const MODEL_TOOL = 'OptiAI Tie-aware Ideal Point';
const DATUM_TOOL = 'OptiAI Adaptive Preference Datum';
const CHOICES = new Set(['A', 'B', 'TIE', 'ABSTAIN']);
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const GRID = Array.from({ length: 101 }, (_, index) => -5 + index / 10);
const EPSILON = 1e-12;

const axisValue = (candidate, axis) => axis === 'x' ? candidate.correction.dxPercent : candidate.correction.dyPercent;
const entropy = (values) => -values.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
const sigmoid = (value) => 1 / (1 + Math.exp(-value));

function probabilities(mu, a, b, tieWidth = 0.2, temperature = 0.35) {
  const advantageA = Math.abs(mu - b) - Math.abs(mu - a);
  const pA = sigmoid((advantageA - tieWidth) / temperature);
  const pB = sigmoid((-advantageA - tieWidth) / temperature);
  return [pA, pB, Math.max(EPSILON, 1 - pA - pB)];
}

function studyCore(study) {
  const { studyDigest: _digest, studyId: _id, ...core } = study;
  return core;
}

function trialId(axis, condition, first, second) {
  return sha256(JSON.stringify({ version: 1, axis, condition, candidates: [first, second].sort() }));
}

function validBaseStudy(study) {
  if (study?.schemaVersion !== 1 || study?.tool !== 'OptiAI Preference Lab' || study?.nonAuthorizing !== true) {
    fail('Adaptive collection requires a validated OptiAI Preference Lab study.', 'adaptive-base-study-invalid', 2);
  }
  if (!Array.isArray(study.candidates) || study.candidates.length < 2 || !Array.isArray(study.config?.sizes) || !Array.isArray(study.config?.themes)) {
    fail('Base preference study has no usable candidates or display conditions.', 'adaptive-base-study-invalid', 2);
  }
}

export function buildAdaptiveStudy(baseStudy, options = {}) {
  validBaseStudy(baseStudy);
  const seed = String(options.seed ?? `${baseStudy.config.seed ?? 'optiai'}-adaptive`);
  const maxTrials = Number(options.maxTrials ?? 16);
  if (!SAFE_ID.test(seed)) fail('Adaptive seed must be a safe 1–64 character ID.', 'adaptive-seed-invalid');
  if (!Number.isInteger(maxTrials) || maxTrials < 5 || maxTrials > 32) fail('Adaptive max trials must be an integer from 5 to 32.', 'adaptive-max-trials-invalid');
  const candidates = [...baseStudy.candidates].sort((a, b) => a.axis.localeCompare(b.axis) || axisValue(a, a.axis) - axisValue(b, b.axis) || a.id.localeCompare(b.id));
  const pool = [];
  for (const axis of ['x', 'y']) {
    const byAxis = candidates.filter((item) => item.axis === axis);
    for (const size of baseStudy.config.sizes) {
      for (const theme of baseStudy.config.themes) {
        const condition = { size, theme };
        for (let left = 0; left < byAxis.length - 1; left += 1) {
          for (let right = left + 1; right < byAxis.length; right += 1) {
            const first = byAxis[left];
            const second = byAxis[right];
            const id = trialId(axis, condition, first.id, second.id);
            const flip = Number.parseInt(sha256(`${seed}:${id}`).slice(0, 8), 16) % 2 === 1;
            const A = flip ? second : first;
            const B = flip ? first : second;
            pool.push({
              id,
              axis,
              condition,
              presentation: { A: A.id, B: B.id },
              values: { A: axisValue(A, axis), B: axisValue(B, axis) },
              tieBreak: sha256(`${seed}:acquisition:${id}`),
              repeatId: sha256(`optiai-adaptive-repeat-v1:${seed}:${id}`),
            });
          }
        }
      }
    }
  }
  pool.sort((a, b) => a.id.localeCompare(b.id));
  if (pool.length < maxTrials - 1) fail('Not enough safe condition-specific pairs for the requested adaptive trial count.', 'adaptive-pool-too-small', 2);
  const core = {
    schemaVersion: 1,
    tool: STUDY_TOOL,
    nonAuthorizing: true,
    source: baseStudy.source,
    audit: baseStudy.audit,
    context: baseStudy.context,
    rtl: baseStudy.rtl,
    baseStudy: { studyId: baseStudy.studyId, studyDigest: baseStudy.studyDigest },
    baseConfig: structuredClone(baseStudy.config),
    config: {
      seed,
      maxTrials,
      policy: 'posterior-information-v1',
      repeatPolicy: 'final-repeat-first-trial-v1',
      sizes: [...baseStudy.config.sizes],
      themes: [...baseStudy.config.themes],
    },
    candidates,
    pool,
  };
  const studyDigest = sha256(JSON.stringify(core));
  return { ...core, studyDigest, studyId: sha256(`optiai-adaptive-study-v1:${studyDigest}`) };
}

export function validateAdaptiveStudy(study) {
  if (study?.schemaVersion !== 1 || study?.tool !== STUDY_TOOL || study?.nonAuthorizing !== true) fail('Unsupported or authorizing adaptive study.', 'adaptive-study-schema-invalid', 2);
  const digest = sha256(JSON.stringify(studyCore(study)));
  if (study.studyDigest !== digest || study.studyId !== sha256(`optiai-adaptive-study-v1:${digest}`)) fail('Adaptive study was modified after generation.', 'adaptive-study-tampered', 2);
  if (!Number.isInteger(study.config?.maxTrials) || study.config.maxTrials < 5 || study.config.maxTrials > 32 || study.config.policy !== 'posterior-information-v1') fail('Adaptive study configuration is invalid.', 'adaptive-study-config-invalid', 2);
  if (!Array.isArray(study.pool) || new Set(study.pool.map((item) => item.id)).size !== study.pool.length) fail('Adaptive study pool is invalid.', 'adaptive-study-pool-invalid', 2);
  for (const trial of study.pool) {
    if (!['x', 'y'].includes(trial.axis) || !Number.isInteger(trial.condition?.size) || !study.config.sizes.includes(trial.condition.size) || !study.config.themes.includes(trial.condition.theme)) fail('Adaptive trial condition is invalid.', 'adaptive-study-pool-invalid', 2);
    if (trial.id !== trialId(trial.axis, trial.condition, trial.presentation.A, trial.presentation.B)) fail('Adaptive trial identity is invalid.', 'adaptive-study-pool-invalid', 2);
  }
  return true;
}

function posteriorFor(study, responses) {
  const posterior = { x: GRID.map(() => 1 / GRID.length), y: GRID.map(() => 1 / GRID.length) };
  for (const item of responses) {
    if (item.choice === 'ABSTAIN') continue;
    const trial = item._trial;
    const likelihoodIndex = item.choice === 'A' ? 0 : item.choice === 'B' ? 1 : 2;
    const updated = posterior[trial.axis].map((weight, index) => weight * probabilities(GRID[index], trial.values.A, trial.values.B)[likelihoodIndex]);
    const total = updated.reduce((sum, value) => sum + value, 0) || 1;
    posterior[trial.axis] = updated.map((value) => value / total);
  }
  return posterior;
}

function informationScore(trial, posterior, contextCount) {
  const conditional = GRID.map((mu) => probabilities(mu, trial.values.A, trial.values.B));
  const predictive = [0, 1, 2].map((outcome) => conditional.reduce((sum, probs, index) => sum + posterior[index] * probs[outcome], 0));
  const expectedEntropy = conditional.reduce((sum, probs, index) => sum + posterior[index] * entropy(probs), 0);
  const posteriorMean = posterior.reduce((sum, weight, index) => sum + weight * GRID[index], 0);
  const midpoint = (trial.values.A + trial.values.B) / 2;
  return entropy(predictive) - expectedEntropy - contextCount * 0.003 - Math.abs(midpoint - posteriorMean) * 0.02;
}

function attachTrials(study, responses) {
  const attached = [];
  for (let index = 0; index < responses.length; index += 1) {
    const expected = selectNext(study, attached);
    const item = responses[index];
    if (item?.trialId !== expected.id || item?.presentedIndex !== index) fail('Adaptive response sequence does not match policy replay.', 'adaptive-response-replay-mismatch', 2);
    if (!CHOICES.has(item.choice)) fail('Adaptive choice must be A, B, TIE, or ABSTAIN.', 'adaptive-choice-invalid', 2);
    if (!Number.isInteger(item.responseTimeMs) || item.responseTimeMs < 50 || item.responseTimeMs > 300000) fail('Adaptive response time must be 50–300000 ms.', 'adaptive-response-time-invalid', 2);
    attached.push({ ...item, _trial: expected });
  }
  return attached;
}

function selectNext(study, attached) {
  if (attached.length >= study.config.maxTrials) fail('Adaptive study is already complete.', 'adaptive-study-complete', 2);
  if (attached.length === study.config.maxTrials - 1) {
    const original = attached[0]._trial;
    return {
      ...original,
      id: original.repeatId,
      presentation: { A: original.presentation.B, B: original.presentation.A },
      values: { A: original.values.B, B: original.values.A },
      repeatOf: original.id,
    };
  }
  const used = new Set(attached.map((item) => item._trial.repeatOf ?? item._trial.id));
  const posterior = posteriorFor(study, attached);
  const counts = new Map();
  for (const item of attached) {
    const key = `${item._trial.condition.size}:${item._trial.condition.theme}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = study.pool.filter((trial) => !used.has(trial.id)).map((trial) => ({
    trial,
    score: informationScore(trial, posterior[trial.axis], counts.get(`${trial.condition.size}:${trial.condition.theme}`) ?? 0),
  })).sort((a, b) => b.score - a.score || a.trial.tieBreak.localeCompare(b.trial.tieBreak));
  if (!ranked.length) fail('Adaptive trial pool is exhausted.', 'adaptive-pool-exhausted', 2);
  return ranked[0].trial;
}

export function nextAdaptiveTrial(study, priorResponses = []) {
  validateAdaptiveStudy(study);
  if (!Array.isArray(priorResponses) || priorResponses.length >= study.config.maxTrials) fail('Adaptive response history is invalid.', 'adaptive-response-history-invalid', 2);
  return selectNext(study, attachTrials(study, priorResponses));
}

export function validateAdaptiveResponse(study, response) {
  validateAdaptiveStudy(study);
  if (response?.schemaVersion !== 1 || response?.tool !== RESPONSE_TOOL || response?.nonAuthorizing !== true) fail('Unsupported or authorizing adaptive response.', 'adaptive-response-schema-invalid', 2);
  if (response.studyId !== study.studyId || response.studyDigest !== study.studyDigest) fail('Adaptive response belongs to a different study.', 'adaptive-response-study-mismatch', 2);
  if (!SAFE_ID.test(response.raterId)) fail('Adaptive rater ID must be pseudonymous and use safe characters.', 'adaptive-rater-invalid', 2);
  if (!Array.isArray(response.responses) || response.responses.length !== study.config.maxTrials) fail('Adaptive response must complete the configured trial count.', 'adaptive-response-incomplete', 2);
  return attachTrials(study, response.responses).map(({ _trial, ...item }) => item);
}

export function adaptivePreferenceRows(study, response) {
  validateAdaptiveResponse(study, response);
  const attached = attachTrials(study, response.responses);
  return attached.map(({ _trial, ...item }) => {
    const core = {
      schemaVersion: 1,
      tool: DATUM_TOOL,
      nonAuthorizing: true,
      studyId: study.studyId,
      studyDigest: study.studyDigest,
      sourceSha256: study.source.sha256,
      raterId: response.raterId,
      trial: _trial,
      axis: _trial.axis,
      condition: _trial.condition,
      choice: item.choice,
      presentedIndex: item.presentedIndex,
      responseTimeMs: item.responseTimeMs,
    };
    return { ...core, datumDigest: sha256(JSON.stringify(core)) };
  });
}

export function validateAdaptiveDatum(row) {
  if (row?.schemaVersion !== 1 || row?.tool !== DATUM_TOOL || row?.nonAuthorizing !== true) fail('Unsupported or authorizing adaptive preference datum.', 'adaptive-datum-schema-invalid', 2);
  const { datumDigest, ...core } = row;
  if (datumDigest !== sha256(JSON.stringify(core))) fail('Adaptive preference datum was modified after export.', 'adaptive-datum-tampered', 2);
  if (!SAFE_ID.test(row.raterId) || !CHOICES.has(row.choice) || row.trial?.axis !== row.axis || JSON.stringify(row.trial.condition) !== JSON.stringify(row.condition)) fail('Adaptive preference datum semantics are invalid.', 'adaptive-datum-invalid', 2);
  return true;
}

function semanticChoice(item) {
  if (item.choice === 'TIE' || item.choice === 'ABSTAIN') return item.choice;
  return item.trial.presentation[item.choice];
}

function fitAxis(rows) {
  if (!rows.length) return { status: 'NO_EVIDENCE', idealPercent: null, indifferencePercent: null, interval95: null, evidenceRows: 0, tieRows: 0 };
  const raterCount = new Set(rows.map((row) => row.raterId.toLowerCase())).size;
  let best = null;
  const scores = [];
  for (let muIndex = 0; muIndex <= 200; muIndex += 1) {
    const mu = -5 + muIndex * 0.05;
    for (let widthIndex = 0; widthIndex <= 30; widthIndex += 1) {
      const tieWidth = widthIndex * 0.05;
      let loss = 0;
      for (const row of rows) {
        const probs = probabilities(mu, row.trial.values.A, row.trial.values.B, tieWidth, 0.25);
        const index = row.choice === 'A' ? 0 : row.choice === 'B' ? 1 : 2;
        loss -= Math.log(Math.max(EPSILON, probs[index]));
      }
      const entry = { mu, tieWidth, loss };
      scores.push(entry);
      if (!best || loss < best.loss - 1e-10 || (Math.abs(loss - best.loss) < 1e-10 && Math.abs(mu) < Math.abs(best.mu))) best = entry;
    }
  }
  const weights = scores.map((item) => Math.exp(-(item.loss - best.loss)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const byMu = new Map();
  scores.forEach((item, index) => byMu.set(item.mu, (byMu.get(item.mu) ?? 0) + weights[index] / total));
  let cumulative = 0;
  let low = -5;
  let high = 5;
  for (const [mu, weight] of [...byMu.entries()].sort((a, b) => a[0] - b[0])) {
    cumulative += weight;
    if (cumulative >= 0.025 && low === -5) low = mu;
    if (cumulative >= 0.975) { high = mu; break; }
  }
  return {
    status: raterCount >= 3 && rows.length >= 5 ? 'ESTIMATED' : 'UNDERPOWERED',
    idealPercent: formatNumber(best.mu, 4),
    indifferencePercent: formatNumber(best.tieWidth, 4),
    interval95: [formatNumber(low, 4), formatNumber(high, 4)],
    evidenceRows: rows.length,
    raterCount,
    tieRows: rows.filter((row) => row.choice === 'TIE').length,
  };
}

export function estimateIdealPoint(inputRows) {
  if (!Array.isArray(inputRows) || !inputRows.length || inputRows.length > 100000) fail('Ideal-point input must contain 1–100000 response rows.', 'ideal-point-input-invalid', 2);
  const rows = inputRows.map((row) => structuredClone(row));
  const seen = new Set();
  let provenance = null;
  for (const row of rows) {
    if (row.tool !== DATUM_TOOL) fail('Ideal-point estimation accepts only exported adaptive preference data.', 'ideal-point-row-invalid', 2);
    validateAdaptiveDatum(row);
    if (!SAFE_ID.test(row.raterId) || !CHOICES.has(row.choice) || !['x', 'y'].includes(row.axis) || !row.trial || row.trial.axis !== row.axis) fail('Ideal-point response row is invalid.', 'ideal-point-row-invalid', 2);
    const currentProvenance = `${row.studyId}:${row.studyDigest}:${row.sourceSha256}`;
    if (provenance && provenance !== currentProvenance) fail('Ideal-point input mixes different studies or sources.', 'ideal-point-provenance-mismatch', 2);
    provenance = currentProvenance;
    const key = `${row.raterId.toLowerCase()}:${row.trial.id}`;
    if (seen.has(key)) fail('Ideal-point input contains a duplicate rater trial.', 'ideal-point-row-duplicate', 2);
    seen.add(key);
  }
  const evidence = rows.filter((row) => row.choice !== 'ABSTAIN' && !row.trial.repeatOf);
  const evidenceRaters = new Set(evidence.map((row) => row.raterId.toLowerCase()));
  const repeats = rows.filter((row) => row.trial.repeatOf);
  let repeatMatches = 0;
  for (const repeat of repeats) {
    const original = rows.find((row) => row.raterId.toLowerCase() === repeat.raterId.toLowerCase() && row.trial.id === repeat.trial.repeatOf);
    if (original && semanticChoice(original) === semanticChoice(repeat)) repeatMatches += 1;
  }
  const axes = { x: fitAxis(evidence.filter((row) => row.axis === 'x')), y: fitAxis(evidence.filter((row) => row.axis === 'y')) };
  const reasons = [];
  if (evidenceRaters.size < 3) reasons.push('fewer-than-3-evidence-raters');
  if (evidence.length < 5) reasons.push('fewer-than-5-evidence-rows');
  const core = {
    schemaVersion: 1,
    tool: MODEL_TOOL,
    nonAuthorizing: true,
    readiness: { status: reasons.length ? 'UNDERPOWERED' : 'ESTIMATED', reasons },
    stats: {
      rowCount: rows.length,
      evidenceRows: evidence.length,
      raterCount: evidenceRaters.size,
      tieRows: evidence.filter((row) => row.choice === 'TIE').length,
      abstainRows: rows.filter((row) => row.choice === 'ABSTAIN').length,
    },
    reliability: { repeatCount: repeats.length, consistentCount: repeatMatches, rate: repeats.length ? formatNumber(repeatMatches / repeats.length, 6) : null },
    axes,
    limits: ['panel-members-not-credential-verified', 'preference-is-not-ground-truth', 'does-not-authorize-svg-correction'],
  };
  return { ...core, modelDigest: sha256(JSON.stringify(core)) };
}

export function validateIdealPointModel(model) {
  if (model?.schemaVersion !== 1 || model?.tool !== MODEL_TOOL || model?.nonAuthorizing !== true) fail('Unsupported or authorizing ideal-point model.', 'ideal-point-model-invalid', 2);
  const { modelDigest, ...core } = model;
  if (modelDigest !== sha256(JSON.stringify(core))) fail('Ideal-point model was modified after estimation.', 'ideal-point-model-tampered', 2);
  if (!['UNDERPOWERED', 'ESTIMATED'].includes(model.readiness?.status) || !model.axes || !model.limits?.includes('does-not-authorize-svg-correction')) fail('Ideal-point model semantics are invalid.', 'ideal-point-model-invalid', 2);
  return true;
}

export function renderAdaptivePreferenceLabHtml(study, display) {
  validateAdaptiveStudy(study);
  const images = {};
  for (const candidate of study.candidates) {
    images[candidate.id] = {};
    for (const item of display.get(candidate.id) ?? []) images[candidate.id][`${item.size}:${item.theme}`] = { image: item.image, background: item.background };
  }
  const payload = Buffer.from(JSON.stringify({ study, images })).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OptiAI Adaptive Preference Lab</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#0b0e13;color:#f7f9fc}*{box-sizing:border-box}body{margin:0;padding:32px 18px;background:radial-gradient(circle at top,#1d2940,#0b0e13 54%);min-height:100vh}.shell{max-width:820px;margin:auto}.eyebrow{color:#8fa9d5;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(32px,6vw,58px);letter-spacing:-.045em;margin:10px 0}.lede,.meta{color:#9eacc3}.notice{border:1px solid #34435d;background:#121925;padding:14px 16px;border-radius:14px;margin:20px 0}.bar{height:6px;background:#202b3c;border-radius:9px;overflow:hidden}.bar div{height:100%;background:#83a9ff}.meta{display:flex;justify-content:space-between;margin-top:10px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0}.option{border:1px solid #2c3950;border-radius:20px;background:#121925;padding:18px;text-align:center}.stage{height:210px;border-radius:14px;display:grid;place-items:center;margin-top:14px}.stage img{image-rendering:auto}.choices{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.choices button,.export{border:1px solid #34425a;background:#172033;color:#eef4ff;border-radius:12px;padding:14px;font:inherit;font-weight:750;cursor:pointer}.export{width:100%;margin-top:22px;background:#eef3ff;color:#111827}.export:disabled{opacity:.35}.rater{display:grid;gap:8px;margin-top:24px}.rater input{background:#101722;border:1px solid #34425a;color:#fff;border-radius:10px;padding:12px}@media(max-width:640px){.pair{grid-template-columns:1fr}.choices{grid-template-columns:1fr 1fr}.stage{height:150px}}</style></head><body><main class="shell"><div class="eyebrow">OptiAI · Adaptive Preference Lab</div><h1>Which feels better centered?</h1><p class="lede">Each question isolates one size and theme. The next comparison is chosen from prior answers; one pair repeats at the end to measure reliability.</p><div class="notice"><strong>Research only.</strong> This evidence never approves or applies an SVG correction.</div><div class="bar"><div id="bar"></div></div><div class="meta"><span id="progress"></span><span id="condition"></span></div><section class="pair"><article class="option"><h2>A</h2><div class="stage" id="stageA"><img id="imageA" alt=""></div></article><article class="option"><h2>B</h2><div class="stage" id="stageB"><img id="imageB" alt=""></div></article></section><div class="choices"><button data-choice="A">A is better</button><button data-choice="B">B is better</button><button data-choice="TIE">Tie</button><button data-choice="ABSTAIN">Cannot judge</button></div><label class="rater"><span>Pseudonymous rater ID</span><input id="rater" maxlength="64" placeholder="panel-01"></label><button class="export" id="export" disabled>Export complete response</button></main><script>(()=>{'use strict';const p=JSON.parse(atob('${payload}')),s=p.study,G=Array.from({length:101},(_,i)=>-5+i/10),responses=[],attached=[];let started=performance.now(),current;const q=id=>document.getElementById(id),sig=x=>1/(1+Math.exp(-x)),probs=(m,a,b)=>{const d=Math.abs(m-b)-Math.abs(m-a),A=sig((d-.2)/.35),B=sig((-d-.2)/.35);return[A,B,Math.max(1e-12,1-A-B)]},H=v=>-v.reduce((z,x)=>z+(x>0?x*Math.log(x):0),0);function posterior(){const out={x:G.map(()=>1/G.length),y:G.map(()=>1/G.length)};for(const x of attached){if(x.response.choice==='ABSTAIN')continue;const k=x.response.choice==='A'?0:x.response.choice==='B'?1:2,u=out[x.trial.axis].map((w,i)=>w*probs(G[i],x.trial.values.A,x.trial.values.B)[k]),t=u.reduce((a,b)=>a+b,0)||1;out[x.trial.axis]=u.map(v=>v/t)}return out}function next(){if(attached.length===s.config.maxTrials-1){const o=attached[0].trial;return{...o,id:o.repeatId,presentation:{A:o.presentation.B,B:o.presentation.A},values:{A:o.values.B,B:o.values.A},repeatOf:o.id}}const used=new Set(attached.map(x=>x.trial.repeatOf||x.trial.id)),post=posterior(),counts=new Map;for(const x of attached){const k=x.trial.condition.size+':'+x.trial.condition.theme;counts.set(k,(counts.get(k)||0)+1)}return s.pool.filter(t=>!used.has(t.id)).map(t=>{const c=G.map(m=>probs(m,t.values.A,t.values.B)),pred=[0,1,2].map(o=>c.reduce((z,v,i)=>z+post[t.axis][i]*v[o],0)),eh=c.reduce((z,v,i)=>z+post[t.axis][i]*H(v),0),mean=post[t.axis].reduce((z,w,i)=>z+w*G[i],0),mid=(t.values.A+t.values.B)/2,key=t.condition.size+':'+t.condition.theme;return{t,score:H(pred)-eh-(counts.get(key)||0)*.003-Math.abs(mid-mean)*.02}}).sort((a,b)=>b.score-a.score||a.t.tieBreak.localeCompare(b.t.tieBreak))[0].t}function render(){current=next();started=performance.now();const key=current.condition.size+':'+current.condition.theme;q('progress').textContent=(responses.length+1)+' of '+s.config.maxTrials;q('condition').textContent=current.condition.theme+' · '+current.condition.size+'px';q('bar').style.width=(responses.length/s.config.maxTrials*100)+'%';for(const side of ['A','B']){const item=p.images[current.presentation[side]][key];q('image'+side).src=item.image;q('image'+side).width=current.condition.size;q('image'+side).height=current.condition.size;q('stage'+side).style.background=item.background}}document.querySelector('.choices').onclick=e=>{const choice=e.target.dataset.choice;if(!choice||responses.length>=s.config.maxTrials)return;const response={trialId:current.id,choice,presentedIndex:responses.length,responseTimeMs:Math.max(50,Math.min(300000,Math.round(performance.now()-started)))};responses.push(response);attached.push({response,trial:current});if(responses.length===s.config.maxTrials){q('progress').textContent='Complete';q('bar').style.width='100%';q('export').disabled=false}else render()};q('export').onclick=()=>{const raterId=q('rater').value.trim();if(!/^[A-Za-z0-9._-]{1,64}$/.test(raterId)){alert('Use a safe pseudonymous ID.');return}const data={schemaVersion:1,tool:'${RESPONSE_TOOL}',nonAuthorizing:true,studyId:s.studyId,studyDigest:s.studyDigest,raterId,responses},blob=new Blob([JSON.stringify(data,null,2)+'\\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='optiai-adaptive-response-'+s.studyId.slice(0,8)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};render()})();</script></body></html>\n`;
}
