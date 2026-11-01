#!/usr/bin/env node
/**
 * Coverage for the video delivery gate.
 *
 * Two layers:
 *
 *   1. Pure, always run: the flash analyzer on synthetic frames, the ebur128
 *      summary parser, the loudness thresholds and the exit-code mapping. These
 *      need no ffmpeg, so the gate's logic is checked on every machine.
 *   2. End to end, run when ffmpeg is available: the real gate as a subprocess
 *      against videos generated into a temp dir — a clean one at feed loudness
 *      (made with the same loudnorm + limiter chain the motion-video skill
 *      prescribes, so the recipe is tested too), a strobe, a quiet mix and a
 *      silent one. Without ffmpeg this layer is SKIPPED and says so; set
 *      XX_STACK_REQUIRE_FFMPEG=1 (CI does) to make a missing ffmpeg a failure.
 *
 * Fixtures are generated, not committed, for the same reason
 * test-anti-slop-rules.mjs keeps its fixtures inline: nothing to drift.
 *
 * Authored in this repository. MIT (repo root LICENSE).
 *
 *   node packs/design/scripts/test-video-gate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { ANALYSIS_FPS, GRID, createFlashAnalyzer } from './video-flash-analyzer.mjs';
import {
  exitCodeFor,
  findFfmpeg,
  loudnessVerdict,
  parseEbur128Summary,
} from './quality-gate-video.mjs';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const gate = path.join(scriptDir, 'quality-gate-video.mjs');

const failures = [];
let passed = 0;
function check(name, condition, detail = '') {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Pure ────────────────────────────────────────────

/** Feed `seconds` of frames whose grey level (0–255) comes from levelAt(frameIndex). */
function analyze(seconds, levelAt) {
  const analyzer = createFlashAnalyzer();
  const frame = new Uint8Array(GRID * GRID * 3);
  for (let i = 0; i < seconds * ANALYSIS_FPS; i++) {
    frame.fill(levelAt(i));
    analyzer.push(frame);
  }
  return analyzer.result();
}

const steady = analyze(2, () => 128);
check('steady frame passes', steady.ok, JSON.stringify(steady.general));

// Full-frame black/white swap every 4 frames at 60 fps = 15 transitions/s.
const strobe = analyze(2, (i) => (Math.floor(i / 4) % 2 ? 255 : 0));
check('strobe fails', !strobe.ok);
check('strobe is reported above 3 flashes/s', strobe.general.maxFlashesPerSecond > 3);

// One full flash per second (two transitions) is well under the limit.
const slow = analyze(3, (i) => (Math.floor(i / 30) % 2 ? 255 : 0));
check('one flash per second passes', slow.ok, JSON.stringify(slow.general));

// A linear fade is one transition, not a flash.
const fade = analyze(2, (i) => Math.round((255 * i) / (2 * ANALYSIS_FPS)));
check('slow fade passes', fade.ok, JSON.stringify(fade.general));

const SUMMARY = `[Parsed_ebur128_0 @ 0x0] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.3 LUFS

  Loudness range:
    LRA:         0.0 LU

  True peak:
    Peak:       -2.1 dBFS
`;
const parsed = parseEbur128Summary(`noise before\n${SUMMARY}`);
check('ebur128 summary parses', parsed?.integratedLufs === -14.2 && parsed?.truePeakDbtp === -2.1, JSON.stringify(parsed));
check('missing summary is null', parseEbur128Summary('no summary here') === null);
check(
  'silent track parses as -inf',
  parseEbur128Summary(SUMMARY.replace('-14.2 LUFS', '-inf LUFS'))?.integratedLufs === -Infinity,
);

check('-14 LUFS / -2 dBTP passes', loudnessVerdict({ integratedLufs: -14, truePeakDbtp: -2 }).status === 'PASS');
check('band edge -16 passes', loudnessVerdict({ integratedLufs: -16, truePeakDbtp: -2 }).status === 'PASS');
check('-16.1 LUFS fails', loudnessVerdict({ integratedLufs: -16.1, truePeakDbtp: -2 }).status === 'FAIL');
check('-11.9 LUFS fails', loudnessVerdict({ integratedLufs: -11.9, truePeakDbtp: -2 }).status === 'FAIL');
check('true peak -0.5 fails', loudnessVerdict({ integratedLufs: -14, truePeakDbtp: -0.5 }).status === 'FAIL');
check('-inf loudness fails', loudnessVerdict({ integratedLufs: -Infinity, truePeakDbtp: -Infinity }).status === 'FAIL');

const report = (a, b) => ({ checks: { flash: { status: a }, loudness: { status: b } } });
check('PASS + NOT_APPLICABLE exits 0', exitCodeFor(report('PASS', 'NOT_APPLICABLE')) === 0);
check('UNVERIFIED exits 2', exitCodeFor(report('PASS', 'UNVERIFIED')) === 2);
check('FAIL outranks UNVERIFIED', exitCodeFor(report('FAIL', 'UNVERIFIED')) === 1);

// ── 2. End to end ──────────────────────────────────────

function runGate(file, env = process.env) {
  const run = spawnSync(process.execPath, [gate, file, '--json'], { encoding: 'utf8', env });
  let parsedReport = null;
  try {
    parsedReport = JSON.parse(run.stdout);
  } catch {
    // Reported through the status check below.
  }
  return { code: run.status, report: parsedReport, stderr: run.stderr };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-video-gate-'));
let e2e = 'skipped';
try {
  // A missing ffmpeg must surface as UNVERIFIED (exit 2), never as a pass.
  const dummy = path.join(tmp, 'dummy.mp4');
  fs.writeFileSync(dummy, 'not a video');
  const missing = runGate(dummy, { ...process.env, XX_STACK_FFMPEG: path.join(tmp, 'no-ffmpeg') });
  check('missing ffmpeg exits 2', missing.code === 2, `exit ${missing.code} ${missing.stderr}`);
  check('missing ffmpeg is UNVERIFIED', missing.report?.checks.flash.status === 'UNVERIFIED');

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    if (process.env.XX_STACK_REQUIRE_FFMPEG === '1') {
      failures.push('ffmpeg not found and XX_STACK_REQUIRE_FFMPEG=1: end-to-end layer cannot run');
    }
  } else {
    e2e = 'ran';
    const make = (name, args) => {
      const out = path.join(tmp, name);
      const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`fixture ${name} failed: ${run.stderr}`);
      return out;
    };
    const grey = ['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=30:d=4'];
    const video = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4'];
    const FEED_CHAIN =
      'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=192000,' +
      'alimiter=limit=0.79:level=false:attack=1:release=50,aresample=48000';

    const clean = make('clean.mp4', [...grey, ...tone, '-shortest', '-af', FEED_CHAIN, ...video, '-c:a', 'aac', '-b:a', '320k']);
    const quiet = make('quiet.mp4', [...grey, ...tone, '-shortest', ...video, '-c:a', 'aac']);
    const silent = make('silent.mp4', [...grey, ...video]);
    const strobeFile = make('strobe.mp4', [
      '-f', 'lavfi', '-i',
      "color=c=black:s=160x120:r=30:d=3,geq=lum='if(lt(mod(N\\,4)\\,2)\\,235\\,16)':cb=128:cr=128",
      ...video,
    ]);

    const c = runGate(clean);
    check('clean video exits 0', c.code === 0, JSON.stringify(c.report?.checks));
    check('clean video loudness PASS', c.report?.checks.loudness.status === 'PASS');

    const q = runGate(quiet);
    check('quiet mix exits 1', q.code === 1, JSON.stringify(q.report?.checks));
    check('quiet mix loudness FAIL', q.report?.checks.loudness.status === 'FAIL');

    const s = runGate(silent);
    check('silent video exits 0', s.code === 0, JSON.stringify(s.report?.checks));
    check('silent video loudness NOT_APPLICABLE', s.report?.checks.loudness.status === 'NOT_APPLICABLE');

    const st = runGate(strobeFile);
    check('strobe video exits 1', st.code === 1, JSON.stringify(st.report?.checks));
    check('strobe video flash FAIL', st.report?.checks.flash.status === 'FAIL');

    const notVideo = runGate(dummy);
    check('undecodable file exits 2', notVideo.code === 2, JSON.stringify(notVideo.report?.checks));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL video gate: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `PASS video gate: ${passed} checks` +
    (e2e === 'ran' ? ' (pure + end to end)' : ' (pure only — end-to-end SKIPPED: ffmpeg not found)'),
);
