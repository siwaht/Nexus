import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Audio and video preprocessing via ffmpeg.
 *
 * ffmpeg is a system binary, not an npm dependency, so its absence is detected
 * once and reported clearly: audio still works if the file is already in a
 * format the speech model accepts, and video ingestion explains exactly what's
 * missing instead of failing opaquely.
 *
 * Video is handled as audio plus sampled frames — the transcript covers what
 * was said, keyframe captions cover what was on screen. That's not native video
 * understanding and the UI says so.
 */

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

let availability: { ffmpeg: boolean; ffprobe: boolean } | null = null;

function run(
  command: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail; ffmpeg is extremely verbose.
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

export async function mediaToolsAvailable(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
}> {
  if (availability) return availability;
  const probe = async (command: string) => {
    try {
      const result = await run(command, ['-version'], 15_000);
      return result.code === 0;
    } catch {
      return false;
    }
  };
  availability = {
    ffmpeg: await probe(FFMPEG),
    ffprobe: await probe(FFPROBE),
  };
  return availability;
}

export function ffmpegMissingMessage(): string {
  return 'ffmpeg is not installed, so audio conversion and video frame sampling are unavailable. Install ffmpeg (or set FFMPEG_PATH) to enable them. Audio files already in a format the speech model accepts will still be transcribed.';
}

async function withTempFile<T>(
  data: Buffer,
  extension: string,
  work: (filePath: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-media-'));
  const filePath = path.join(
    directory,
    `${crypto.randomBytes(8).toString('hex')}${extension}`,
  );
  try {
    await fs.writeFile(filePath, data);
    return await work(filePath, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface MediaInfo {
  durationS: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export async function probeMedia(
  data: Buffer,
  extension: string,
): Promise<MediaInfo> {
  const { ffprobe } = await mediaToolsAvailable();
  if (!ffprobe) {
    return {
      durationS: null,
      hasAudio: true,
      hasVideo: false,
      width: null,
      height: null,
    };
  }

  return withTempFile(data, extension, async (filePath) => {
    const result = await run(
      FFPROBE,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      60_000,
    );
    if (result.code !== 0) {
      throw new Error(`Could not read the media file. ${result.stderr.slice(-300)}`);
    }
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
      }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const duration = Number.parseFloat(parsed.format?.duration ?? '');
    return {
      durationS: Number.isFinite(duration) ? duration : null,
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      hasVideo: Boolean(video),
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  });
}

/** Normalize any input to 16 kHz mono WAV, which every speech model accepts. */
export async function toWav16kMono(
  data: Buffer,
  extension: string,
): Promise<Buffer> {
  const { ffmpeg } = await mediaToolsAvailable();
  if (!ffmpeg) throw new Error(ffmpegMissingMessage());

  return withTempFile(data, extension, async (filePath, directory) => {
    const output = path.join(directory, 'audio.wav');
    const result = await run(FFMPEG, [
      '-v', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 'wav',
      '-y', output,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `ffmpeg could not convert this file. ${result.stderr.slice(-300)}`,
      );
    }
    return fs.readFile(output);
  });
}

export interface AudioChunk {
  index: number;
  startS: number;
  data: Buffer;
}

/**
 * Split long audio into overlapping windows so a transcription model with a
 * duration limit can handle a full-length recording.
 */
export async function splitAudio(
  data: Buffer,
  extension: string,
  windowS = 600,
): Promise<AudioChunk[]> {
  const { ffmpeg } = await mediaToolsAvailable();
  if (!ffmpeg) throw new Error(ffmpegMissingMessage());

  const info = await probeMedia(data, extension);
  const duration = info.durationS ?? 0;
  if (duration > 0 && duration <= windowS) {
    return [{ index: 0, startS: 0, data: await toWav16kMono(data, extension) }];
  }

  return withTempFile(data, extension, async (filePath, directory) => {
    const chunks: AudioChunk[] = [];
    const total = duration > 0 ? duration : windowS;
    const count = Math.min(Math.ceil(total / windowS), 60);

    for (let index = 0; index < count; index += 1) {
      const startS = index * windowS;
      const output = path.join(directory, `chunk-${index}.wav`);
      const result = await run(FFMPEG, [
        '-v', 'error',
        '-ss', String(startS),
        '-t', String(windowS),
        '-i', filePath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        '-y', output,
      ]);
      if (result.code !== 0) break;
      const buffer = await fs.readFile(output).catch(() => null);
      // A WAV header alone is 44 bytes — anything near that is silence/EOF.
      if (!buffer || buffer.length < 2000) break;
      chunks.push({ index, startS, data: buffer });
    }
    return chunks;
  });
}

export interface Keyframe {
  index: number;
  atS: number;
  png: Buffer;
}

/** Sample frames at a fixed interval for vision captioning. */
export async function extractKeyframes(
  data: Buffer,
  extension: string,
  options: { intervalS?: number; maxFrames?: number } = {},
): Promise<Keyframe[]> {
  const { ffmpeg } = await mediaToolsAvailable();
  if (!ffmpeg) throw new Error(ffmpegMissingMessage());

  const intervalS = options.intervalS ?? 30;
  const maxFrames = options.maxFrames ?? 12;
  const info = await probeMedia(data, extension);
  if (!info.hasVideo) return [];

  const duration = info.durationS ?? intervalS * maxFrames;
  const step = Math.max(intervalS, duration / maxFrames);

  return withTempFile(data, extension, async (filePath, directory) => {
    const frames: Keyframe[] = [];
    for (let index = 0; index < maxFrames; index += 1) {
      const atS = index * step;
      if (duration > 0 && atS >= duration) break;
      const output = path.join(directory, `frame-${index}.png`);
      const result = await run(
        FFMPEG,
        [
          '-v', 'error',
          '-ss', String(atS),
          '-i', filePath,
          '-frames:v', '1',
          // Cap the long edge so vision payloads stay reasonable.
          '-vf', 'scale=1024:-2',
          '-y', output,
        ],
        120_000,
      );
      if (result.code !== 0) break;
      const png = await fs.readFile(output).catch(() => null);
      if (!png || png.length === 0) break;
      frames.push({ index, atS, png });
    }
    return frames;
  });
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}
