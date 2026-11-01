#!/usr/bin/env node
/**
 * Delivery gate for a rendered video.
 *
 * Two deterministic checks, no model call:
 *
 *   flash     WCAG 2.3.1 general and red flash thresholds, measured on decoded
 *             pixels by video-flash-analyzer.mjs (vendored from gg-framework).
 *   loudness  EBU R128 integrated loudness within FEED_LOUDNESS of -14 LUFS and
 *             true peak at or below -1 dBTP, measured by ffmpeg's ebur128
 *             filter. A video with no audio stream is NOT_APPLICABLE, not PASS:
 *             silent video is a legitimate choice, not evidence of good audio.
 *
 * Each check reports PASS, FAIL, UNVERIFIED or NOT_APPLICABLE. A check the
 * evidence cannot settle (ffmpeg missing, decode error, the file changed while
 * it was read) is UNVERIFIED, never guessed.
 *
 * Exit 0 = every check passed or does not apply. Exit 1 = a check failed: do
 * not deliver the file. Exit 2 = a check could not run: the file is unverified,
 * and must be reported as such rather than delivered as checked.
 *
 * ffmpeg is looked up from XX_STACK_FFMPEG, then PATH. It is never installed
 * or downloaded. A screen, not a certification.
 *
 * Authored in this repository. MIT (repo root LICENSE). The flash analysis it
 * calls is MIT, Copyright (c) 2025 KenKai; see video-flash-analyzer.mjs.
 *
 *   node packs/design/scripts/quality-gate-video.mjs <video> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { analyzeFlashes } from './video-flash-analyzer.mjs';

/** Feed platforms normalise to about -14 LUFS; this is the accepted band around it. */
export const TARGET_LUFS = -14;
export const FEED_LOUDNESS = 2;
/** Headroom so lossy re-encoding by the platform does not clip. */
export const MAX_TRUE_PEAK_DBTP = -1;

export function findFfmpeg(env = process.env) {
  const override = env.XX_STACK_FFMPEG?.trim();
  if (override) return fs.existsSync(override) ? path.resolve(override) : null;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exe);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

/**
 * Parse the summary block ffmpeg's ebur128 filter prints at the end of a run.
 * Returns null when the block is missing, which the caller treats as UNVERIFIED.
 */
export function parseEbur128Summary(stderr) {
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const integrated = summary.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  const truePeak = summary.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/);
  if (!integrated || !truePeak) return null;
  const num = (text) => (text === '-inf' ? -Infinity : Number(text));
  return { integratedLufs: num(integrated[1]), truePeakDbtp: num(truePeak[1]) };
}

/** Pure verdict on measured loudness, so the thresholds are testable without ffmpeg. */
export function loudnessVerdict({ integratedLufs, truePeakDbtp }) {
  const reasons = [];
  if (!Number.isFinite(integratedLufs)) {
    reasons.push('integrated loudness is -inf: the audio track is silent');
  } else if (Math.abs(integratedLufs - TARGET_LUFS) > FEED_LOUDNESS) {
    reasons.push(
      `integrated loudness ${integratedLufs} LUFS is outside ${TARGET_LUFS} ±${FEED_LOUDNESS} LUFS`,
    );
  }
  if (truePeakDbtp > MAX_TRUE_PEAK_DBTP) {
    reasons.push(`true peak ${truePeakDbtp} dBTP is above ${MAX_TRUE_PEAK_DBTP} dBTP`);
  }
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}

function hasAudioStream(ffmpeg, file) {
  // `-map 0:a:0` fails when there is no audio stream; that failure is the answer.
  const probe = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) return true;
  if (/matches no streams/i.test(probe.stderr)) return false;
  throw new Error(`ffmpeg could not read the file: ${probe.stderr.trim().slice(-500)}`);
}

function checkLoudness(ffmpeg, file) {
  try {
    if (!hasAudioStream(ffmpeg, file)) {
      return { status: 'NOT_APPLICABLE', reasons: ['no audio stream'] };
    }
  } catch (error) {
    return { status: 'UNVERIFIED', reasons: [error.message] };
  }
  const run = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const measured = run.status === 0 ? parseEbur128Summary(run.stderr) : null;
  if (!measured) {
    return {
      status: 'UNVERIFIED',
      reasons: [`ebur128 gave no summary: ${run.stderr.trim().slice(-500)}`],
    };
  }
  return { ...loudnessVerdict(measured), ...measured };
}

async function checkFlash(ffmpeg, file) {
  try {
    const result = await analyzeFlashes(file, ffmpeg);
    const failures = [...result.general.failures, ...result.red.failures];
    return {
      status: result.ok ? 'PASS' : 'FAIL',
      reasons: failures.map(({ start, end }) => `flashing above the WCAG limit between ${start}s and ${end}s`),
      maxFlashesPerSecond: Math.max(result.general.maxFlashesPerSecond, result.red.maxFlashesPerSecond),
      duration: result.duration,
    };
  } catch (error) {
    return { status: 'UNVERIFIED', reasons: [error.message] };
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function evaluateVideo(file, env = process.env) {
  const ffmpeg = findFfmpeg(env);
  if (!ffmpeg) {
    const reason = 'ffmpeg not found (set XX_STACK_FFMPEG or put ffmpeg on PATH)';
    return {
      file,
      checks: {
        flash: { status: 'UNVERIFIED', reasons: [reason] },
        loudness: { status: 'UNVERIFIED', reasons: [reason] },
      },
    };
  }
  const before = sha256(file);
  const checks = { flash: await checkFlash(ffmpeg, file), loudness: checkLoudness(ffmpeg, file) };
  if (sha256(file) !== before) {
    for (const check of Object.values(checks)) {
      check.status = 'UNVERIFIED';
      check.reasons = ['the file changed while it was being checked'];
    }
  }
  return { file, videoSha256: before, checks };
}

export function exitCodeFor(report) {
  const statuses = Object.values(report.checks).map((c) => c.status);
  if (statuses.includes('FAIL')) return 1;
  if (statuses.includes('UNVERIFIED')) return 2;
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const files = argv.filter((a) => a !== '--json');
  if (files.length !== 1) {
    console.error('usage: quality-gate-video.mjs <video> [--json]');
    process.exit(2);
  }
  const file = path.resolve(files[0]);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error(`Not a file: ${files[0]}`);
    process.exit(2);
  }
  const report = await evaluateVideo(file);
  const code = exitCodeFor(report);
  if (json) {
    console.log(JSON.stringify({ ...report, exitCode: code }));
  } else {
    console.log(`Video gate: ${path.relative(process.cwd(), file) || file}`);
    for (const [name, check] of Object.entries(report.checks)) {
      const detail = check.reasons.length ? ` — ${check.reasons.join('; ')}` : '';
      console.log(`  ${check.status.padEnd(14)} ${name}${detail}`);
    }
    console.log(
      code === 0
        ? 'PASS: cleared to deliver.'
        : code === 1
          ? 'FAIL: do not deliver this file.'
          : 'UNVERIFIED: a check could not run; report the file as unchecked.',
    );
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
