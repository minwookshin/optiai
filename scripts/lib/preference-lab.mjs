import { validateDerivedAudit } from './audit-model.mjs';
import { clippingIssues, rasterPng } from './raster.mjs';
import { buildCandidate, sha256, validateAudit, withRootColor } from './svg-document.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

const STUDY_TOOL = 'OptiAI Preference Lab';
const RESPONSE_TOOL = 'OptiAI Preference Response';
const DATUM_TOOL = 'OptiAI Preference Datum';
const CHOICES = new Set(['A', 'B', 'TIE', 'ABSTAIN']);
const MAX_CANDIDATES = 25;
const MAX_TRIALS = 32;
const THEME_COLORS = {
  light: { background: '#ffffff', foreground: '#111827' },
  dark: { background: '#111827', foreground: '#ffffff' },
};

function finitePercent(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}.`, 'invalid-preference-range');
  }
  return formatNumber(parsed, 6);
}

function candidateValues(recommendation, radius, step) {
  const values = new Set([formatNumber(-radius, 6), 0, formatNumber(radius, 6)]);
  for (let value = step; value < radius - step / 1000; value += step) {
    const normalized = formatNumber(value, 6);
    values.add(normalized);
    values.add(formatNumber(-normalized, 6));
  }
  if (Number.isFinite(recommendation) && Math.abs(recommendation) <= 5) values.add(formatNumber(recommendation, 6));
  return [...values].sort((a, b) => a - b);
}

function renderCandidate(svg, correction, sizes, themes, axis) {
  const candidate = buildCandidate(svg, correction);
  const clipping = clippingIssues(svg.sanitized, svg.viewBox, candidate.bytes, candidate.viewBox, sizes);
  if (clipping.clipped) return null;
  const rasters = [];
  const display = [];
  for (const theme of themes) {
    const colors = THEME_COLORS[theme];
    for (const size of sizes) {
      const png = rasterPng(withRootColor(candidate.bytes, colors.foreground), size);
      rasters.push({ theme, size, sha256: sha256(png) });
      display.push({ theme, size, background: colors.background, image: `data:image/png;base64,${png.toString('base64')}` });
    }
  }
  const id = sha256(JSON.stringify({ version: 1, axis, correction, candidateSha256: candidate.sha256 }));
  return {
    record: { id, axis, correction, candidateSha256: candidate.sha256, clipping, rasters },
    display,
  };
}

function buildAxis(svg, axis, values, sizes, themes) {
  const candidates = [];
  const display = new Map();
  for (const value of values) {
    const correction = axis === 'x'
      ? { dxPercent: value, dyPercent: 0 }
      : { dxPercent: 0, dyPercent: value };
    const rendered = renderCandidate(svg, correction, sizes, themes, axis);
    if (!rendered) continue;
    candidates.push(rendered.record);
    display.set(rendered.record.id, rendered.display);
  }
  candidates.sort((a, b) => {
    const av = axis === 'x' ? a.correction.dxPercent : a.correction.dyPercent;
    const bv = axis === 'x' ? b.correction.dxPercent : b.correction.dyPercent;
    return av - bv;
  });
  return { candidates, display };
}

function adjacentTrials(axis, candidates, seed) {
  const trials = [];
  for (let index = 0; index < candidates.length - 1; index += 1) {
    const first = candidates[index];
    const second = candidates[index + 1];
    const canonical = [first.id, second.id].sort();
    const id = sha256(JSON.stringify({ version: 1, axis, candidates: canonical }));
    const flip = Number.parseInt(sha256(`${seed}:${id}`).slice(-2), 16) % 2 === 1;
    trials.push({ id, axis, presentation: { A: flip ? second.id : first.id, B: flip ? first.id : second.id } });
  }
  return trials;
}

function studyCore(study) {
  return {
    schemaVersion: study.schemaVersion,
    tool: study.tool,
    nonAuthorizing: study.nonAuthorizing,
    source: study.source,
    audit: study.audit,
    context: study.context,
    rtl: study.rtl,
    config: study.config,
    candidates: study.candidates,
    trials: study.trials,
  };
}

export function validatePreferenceStudy(study) {
  if (study?.schemaVersion !== 1 || study?.tool !== STUDY_TOOL || study?.nonAuthorizing !== true) {
    fail('Unsupported or authorizing preference-study artifact.', 'preference-study-schema-invalid', 2);
  }
  const digest = sha256(JSON.stringify(studyCore(study)));
  const id = sha256(`optiai-preference-study-v1:${digest}`);
  if (study.studyDigest !== digest || study.studyId !== id) {
    fail('Preference study was modified after generation.', 'preference-study-tampered', 2);
  }
  return true;
}

export function buildPreferenceStudy(svg, audit, auditDocumentSha256, options = {}) {
  validateAudit(svg, audit);
  validateDerivedAudit(svg, audit);
  if (audit.decision?.status === 'ABSTAIN') {
    fail('The audit abstained; repair or manually scope the artwork before collecting preferences.', 'audit-abstained', 2);
  }
  const axis = options.axis ?? 'both';
  if (!['x', 'y', 'both'].includes(axis)) fail('Axis must be x, y, or both.', 'invalid-preference-axis');
  const radiusPercent = finitePercent(options.radiusPercent ?? 2, 'Radius percent', 0.1, 5);
  const stepPercent = finitePercent(options.stepPercent ?? 0.5, 'Step percent', 0.1, radiusPercent);
  const sizes = [...options.sizes];
  const themes = [...options.themes];
  if (!sizes.length || themes.some((theme) => !Object.hasOwn(THEME_COLORS, theme))) fail('Preference sizes and themes are invalid.', 'invalid-preference-context');
  const seed = String(options.seed ?? 'optiai-v1');
  if (!seed || seed.length > 128 || /[\u0000-\u001f\u007f]/u.test(seed)) fail('Seed must be 1–128 printable characters.', 'invalid-preference-seed');

  const recommendation = audit.recommendation ?? { dxPercent: 0, dyPercent: 0 };
  const requestedAxes = axis === 'both' ? ['x', 'y'] : [axis];
  const valuesByAxis = new Map(requestedAxes.map((currentAxis) => {
    const proposed = currentAxis === 'x' ? recommendation.dxPercent : recommendation.dyPercent;
    return [currentAxis, candidateValues(proposed, radiusPercent, stepPercent)];
  }));
  const requestedCandidateCount = [...valuesByAxis.values()].reduce((sum, values) => sum + values.length, 0);
  const requestedTrialCount = [...valuesByAxis.values()].reduce((sum, values) => sum + Math.max(0, values.length - 1), 0);
  if (requestedCandidateCount > MAX_CANDIDATES || requestedTrialCount > MAX_TRIALS) {
    fail(`Preference study exceeds ${MAX_CANDIDATES} candidates or ${MAX_TRIALS} trials. Increase --step-percent or reduce --radius-percent.`, 'preference-study-too-large');
  }
  const candidates = [];
  const trials = [];
  const display = new Map();
  for (const currentAxis of requestedAxes) {
    const values = valuesByAxis.get(currentAxis);
    const built = buildAxis(svg, currentAxis, values, sizes, themes);
    if (built.candidates.length < 2) continue;
    candidates.push(...built.candidates);
    trials.push(...adjacentTrials(currentAxis, built.candidates, seed));
    for (const [id, rasters] of built.display) display.set(id, rasters);
  }
  if (!trials.length) fail('No safe pairwise candidates remain after clipping checks.', 'no-safe-preference-pairs', 2);
  if (candidates.length > MAX_CANDIDATES || trials.length > MAX_TRIALS) {
    fail(`Preference study exceeds ${MAX_CANDIDATES} candidates or ${MAX_TRIALS} trials.`, 'preference-study-too-large');
  }

  const core = {
    schemaVersion: 1,
    tool: STUDY_TOOL,
    nonAuthorizing: true,
    source: {
      realpath: svg.realpath,
      filename: svg.filename,
      sha256: svg.sha256,
      byteLength: svg.byteLength,
      viewBox: svg.viewBox,
    },
    audit: { documentSha256: auditDocumentSha256, derivedSha256: audit.derivedSha256 },
    context: audit.context,
    rtl: Boolean(audit.rtl),
    config: { axis, radiusPercent, stepPercent, seed, sizes, themes },
    candidates,
    trials,
  };
  const studyDigest = sha256(JSON.stringify(core));
  const studyId = sha256(`optiai-preference-study-v1:${studyDigest}`);
  return { study: { ...core, studyDigest, studyId }, display };
}

function cardRows(study, display, trial) {
  const a = new Map(display.get(trial.presentation.A).map((item) => [`${item.theme}:${item.size}`, item]));
  const b = new Map(display.get(trial.presentation.B).map((item) => [`${item.theme}:${item.size}`, item]));
  const rows = [];
  for (const theme of study.config.themes) {
    for (const size of study.config.sizes) {
      const key = `${theme}:${size}`;
      rows.push({ theme, size, background: a.get(key).background, A: a.get(key).image, B: b.get(key).image });
    }
  }
  return rows;
}

export function renderPreferenceLabHtml(study, display) {
  validatePreferenceStudy(study);
  const payload = {
    studyId: study.studyId,
    studyDigest: study.studyDigest,
    trials: study.trials.map((trial) => ({ id: trial.id, rows: cardRows(study, display, trial) })),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OptiAI Preference Lab</title>
<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0d1016;color:#f8fafc}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#1d2638 0,#0d1016 52%);padding:32px 18px}.shell{max-width:940px;margin:auto}.eyebrow{color:#8fa3c7;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(30px,5vw,54px);margin:10px 0 8px;letter-spacing:-.04em}.lede{color:#aab6ca;max-width:680px;line-height:1.6}.notice{margin:20px 0;padding:14px 16px;border:1px solid #33415c;background:#121925;border-radius:14px;color:#b8c4d8}.bar{height:6px;background:#202b3c;border-radius:99px;overflow:hidden;margin:26px 0 12px}.bar>div{height:100%;background:#7aa2ff;transition:width .2s}.meta{display:flex;justify-content:space-between;color:#8fa0bb;font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}.option{border:1px solid #2c3950;border-radius:18px;background:#121925;padding:16px}.option h2{text-align:center;margin:0 0 14px}.raster-grid{display:grid;gap:10px}.raster{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:10px;color:#7f91ad;font-size:12px}.stage{height:76px;border-radius:12px;display:grid;place-items:center;background:var(--stage)}.stage img{image-rendering:auto}.choices{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.choices button,.nav button,.export{appearance:none;border:1px solid #34425a;background:#172033;color:#eef4ff;border-radius:12px;padding:13px 12px;font:inherit;font-weight:750;cursor:pointer}.choices button:hover,.choices button.selected{border-color:#8fb0ff;background:#243455}.nav{display:flex;justify-content:space-between;gap:12px;margin-top:16px}.rater{display:grid;gap:8px;margin-top:28px}.rater input{background:#101722;border:1px solid #34425a;color:#fff;border-radius:10px;padding:12px}.export{margin-top:12px;background:#e9efff;color:#111827;border-color:#e9efff}.export:disabled{opacity:.35;cursor:not-allowed}@media(max-width:680px){.pair{grid-template-columns:1fr}.choices{grid-template-columns:1fr 1fr}}</style></head>
<body><main class="shell"><div class="eyebrow">OptiAI · Preference Lab</div><h1>Which option feels better centered?</h1><p class="lede">Judge the pair across every shown size and theme. Choose Tie when both feel equally good. Choose Cannot judge when the context is insufficient.</p><div class="notice"><strong>Research only.</strong> These selections create preference data. They cannot approve or apply an SVG correction.</div><div class="bar"><div id="progressBar"></div></div><div class="meta"><span id="progressText"></span><span>Blinded A/B</span></div><section class="pair"><article class="option"><h2>A</h2><div id="gridA" class="raster-grid"></div></article><article class="option"><h2>B</h2><div id="gridB" class="raster-grid"></div></article></section><div class="choices" id="choices"><button data-choice="A">A is better</button><button data-choice="B">B is better</button><button data-choice="TIE">Tie</button><button data-choice="ABSTAIN">Cannot judge</button></div><div class="nav"><button id="previous">Previous</button><button id="next">Next</button></div><label class="rater"><span>Pseudonymous rater ID</span><input id="raterId" maxlength="64" placeholder="expert-01" autocomplete="off"></label><button class="export" id="export" disabled>Export complete responses</button></main>
<script>(()=>{'use strict';const payload=JSON.parse(atob('${encoded}'));const answers=new Map();let index=0;const byId=(id)=>document.getElementById(id);const renderGrid=(target,rows,side)=>{target.textContent='';for(const row of rows){const line=document.createElement('div');line.className='raster';const label=document.createElement('span');label.textContent=row.theme+' · '+row.size+'px';const stage=document.createElement('div');stage.className='stage';stage.style.setProperty('--stage',row.background);const image=document.createElement('img');image.src=row[side];image.width=row.size;image.height=row.size;image.alt='';stage.append(image);line.append(label,stage);target.append(line)}};const render=()=>{const trial=payload.trials[index];renderGrid(byId('gridA'),trial.rows,'A');renderGrid(byId('gridB'),trial.rows,'B');byId('progressText').textContent=(index+1)+' of '+payload.trials.length;byId('progressBar').style.width=((index+1)/payload.trials.length*100)+'%';for(const button of byId('choices').querySelectorAll('button'))button.classList.toggle('selected',answers.get(trial.id)===button.dataset.choice);byId('previous').disabled=index===0;byId('next').disabled=index===payload.trials.length-1;byId('export').disabled=answers.size!==payload.trials.length};byId('choices').addEventListener('click',(event)=>{const choice=event.target.dataset.choice;if(!choice)return;answers.set(payload.trials[index].id,choice);if(index<payload.trials.length-1)index+=1;render()});byId('previous').addEventListener('click',()=>{if(index>0){index-=1;render()}});byId('next').addEventListener('click',()=>{if(index<payload.trials.length-1){index+=1;render()}});byId('export').addEventListener('click',()=>{const raterId=byId('raterId').value.trim();if(!/^[A-Za-z0-9._-]{1,64}$/.test(raterId)){alert('Use a 1–64 character pseudonymous ID with letters, numbers, dot, underscore, or hyphen.');return}const response={schemaVersion:1,tool:'${RESPONSE_TOOL}',studyId:payload.studyId,studyDigest:payload.studyDigest,raterId,responses:payload.trials.map((trial)=>({trialId:trial.id,choice:answers.get(trial.id)}))};const blob=new Blob([JSON.stringify(response,null,2)+'\\n'],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='optiai-preference-response-'+payload.studyId.slice(0,8)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)});render()})();</script></body></html>\n`;
}

export function validatePreferenceResponse(study, response) {
  validatePreferenceStudy(study);
  if (response?.schemaVersion !== 1 || response?.tool !== RESPONSE_TOOL) fail('Unsupported preference response.', 'preference-response-schema-invalid', 2);
  if (response.studyId !== study.studyId || response.studyDigest !== study.studyDigest) fail('Response belongs to a different preference study.', 'preference-response-study-mismatch', 2);
  if (typeof response.raterId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(response.raterId)) fail('Rater ID must be pseudonymous and use safe characters.', 'preference-rater-invalid', 2);
  if (!Array.isArray(response.responses) || response.responses.length !== study.trials.length) fail('Response must answer every trial exactly once.', 'preference-response-incomplete', 2);
  const known = new Set(study.trials.map((trial) => trial.id));
  const answers = new Map();
  for (const item of response.responses) {
    if (!known.has(item?.trialId)) fail('Response contains an unknown trial.', 'preference-trial-unknown', 2);
    if (answers.has(item.trialId)) fail('Response contains a duplicate trial.', 'preference-trial-duplicate', 2);
    if (!CHOICES.has(item.choice)) fail('Choice must be A, B, TIE, or ABSTAIN.', 'preference-choice-invalid', 2);
    answers.set(item.trialId, item.choice);
  }
  return study.trials.map((trial) => ({ trialId: trial.id, choice: answers.get(trial.id) }));
}

export function preferenceRows(study, response) {
  const answers = validatePreferenceResponse(study, response);
  const candidates = new Map(study.candidates.map((candidate) => [candidate.id, candidate]));
  const trials = new Map(study.trials.map((trial) => [trial.id, trial]));
  return answers.map(({ trialId, choice }) => {
    const trial = trials.get(trialId);
    const candidateA = candidates.get(trial.presentation.A);
    const candidateB = candidates.get(trial.presentation.B);
    const preferredCandidateId = choice === 'A' ? candidateA.id : choice === 'B' ? candidateB.id : null;
    return {
      schemaVersion: 1,
      tool: DATUM_TOOL,
      nonAuthorizing: true,
      studyId: study.studyId,
      sourceSha256: study.source.sha256,
      sourceViewBox: study.source.viewBox.raw,
      context: study.context,
      rtl: study.rtl,
      targetSizes: study.config.sizes,
      themes: study.config.themes,
      raterId: response.raterId,
      trialId,
      axis: trial.axis,
      candidateA: { id: candidateA.id, correction: candidateA.correction, candidateSha256: candidateA.candidateSha256 },
      candidateB: { id: candidateB.id, correction: candidateB.correction, candidateSha256: candidateB.candidateSha256 },
      choice,
      preferredCandidateId,
      tie: choice === 'TIE',
      abstain: choice === 'ABSTAIN',
      pairwiseWinnerEligible: choice === 'A' || choice === 'B',
    };
  });
}
