/**
 * Kokoro TTS Provider
 *
 * Local/self-hosted TTS via Kokoro-FastAPI (OpenAI-compatible API).
 * Free, no API key needed. Runs via Docker or existing instance.
 *
 * Setup: docker run -d --name callme-kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
 */

import OpenAI from 'openai';
import { execSync, spawnSync } from 'child_process';
import type { TTSProvider, TTSConfig } from './types.js';

const DOCKER_IMAGE = 'ghcr.io/remsky/kokoro-fastapi-cpu:latest';
const CONTAINER_NAME = 'callme-kokoro';
const DEFAULT_PORT = 8880;
const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_POLL_MS = 2000;

/**
 * Normalize Kokoro URL — strip trailing /v1 and / so we have a clean base
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/**
 * Ensure a Kokoro Docker container is running.
 * Call this BEFORE creating the provider when no CALLME_KOKORO_URL is set.
 */
export async function ensureKokoroRunning(): Promise<string> {
  // Check if Docker is available
  const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 10000 });
  if (dockerCheck.status !== 0) {
    console.error('\n[Kokoro] Docker not available. To use Kokoro TTS, either:');
    console.error('  1. Install Docker and restart');
    console.error('  2. Set CALLME_KOKORO_URL to an existing Kokoro instance');
    console.error(`\nNote: CALLME_OPENAI_API_KEY is still required for speech-to-text.\n`);
    throw new Error('Docker required for auto-setup of Kokoro TTS');
  }

  // Check if container exists (running or stopped)
  const psAll = spawnSync('docker', ['ps', '-a', '--filter', `name=^${CONTAINER_NAME}$`, '--format', '{{.Status}}'], {
    stdio: 'pipe', timeout: 10000,
  });
  const containerStatus = psAll.stdout?.toString().trim();

  if (containerStatus) {
    if (containerStatus.startsWith('Up')) {
      console.error(`[Kokoro] Container '${CONTAINER_NAME}' already running`);
    } else {
      // Container exists but stopped — restart it
      console.error(`[Kokoro] Starting stopped container '${CONTAINER_NAME}'...`);
      const startResult = spawnSync('docker', ['start', CONTAINER_NAME], { stdio: 'pipe', timeout: 30000 });
      if (startResult.status !== 0) {
        const err = startResult.stderr?.toString() || 'unknown error';
        throw new Error(`Failed to start stopped container '${CONTAINER_NAME}': ${err.trim()}`);
      }
    }
  } else {
    // No container — pull and run
    console.error(`[Kokoro] Starting new container '${CONTAINER_NAME}'...`);
    console.error(`[Kokoro] Image: ${DOCKER_IMAGE}`);
    console.error('[Kokoro] First run may take a minute to download the model...');

    const run = spawnSync('docker', [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-p', `${DEFAULT_PORT}:8880`,
      DOCKER_IMAGE,
    ], { stdio: 'pipe', timeout: 120000 });

    if (run.status !== 0) {
      const err = run.stderr?.toString() || 'unknown error';
      if (err.includes('port is already allocated') || err.includes('address already in use')) {
        console.error(`[Kokoro] Port ${DEFAULT_PORT} is already in use.`);
        console.error(`  Set CALLME_KOKORO_URL=http://localhost:<port>/v1 to use a different port`);
      }
      throw new Error(`Failed to start Kokoro container: ${err.trim()}`);
    }
  }

  const baseUrl = `http://localhost:${DEFAULT_PORT}`;

  // Wait for health
  console.error('[Kokoro] Waiting for service to be ready...');
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/v1/audio/voices`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        console.error('[Kokoro] Service ready!');
        return baseUrl;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }

  throw new Error(`Kokoro service did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

export class KokoroTTSProvider implements TTSProvider {
  readonly name = 'kokoro';
  private client: OpenAI | null = null;
  private voice: string = 'af_bella';

  initialize(config: TTSConfig): void {
    const baseUrl = config.apiUrl
      ? normalizeBaseUrl(config.apiUrl)
      : `http://localhost:${DEFAULT_PORT}`;

    this.client = new OpenAI({
      apiKey: 'not-needed',
      baseURL: `${baseUrl}/v1`,
    });
    this.voice = config.voice || 'af_bella';

    console.error(`TTS provider: Kokoro (voice: ${this.voice}, url: ${baseUrl})`);
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.client) throw new Error('Kokoro TTS not initialized');

    const response = await this.client.audio.speech.create({
      model: 'kokoro',
      voice: this.voice as any,
      input: text,
      response_format: 'pcm',
      speed: 1.0,
    });

    const arrayBuffer = await response.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);

    // Strip WAV header if present (Kokoro might wrap PCM in WAV)
    if (buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      // Parse WAV header to find data chunk and validate format
      const channels = buffer.readUInt16LE(22);
      const sampleRate = buffer.readUInt32LE(24);
      const bitsPerSample = buffer.readUInt16LE(34);

      if (channels !== 1 || bitsPerSample !== 16) {
        console.error(`[Kokoro] WARNING: Expected mono 16-bit PCM, got ${channels}ch ${bitsPerSample}-bit`);
      }
      if (sampleRate !== 24000) {
        console.error(`[Kokoro] WARNING: Expected 24kHz, got ${sampleRate}Hz — audio may sound wrong`);
      }

      // Find 'data' chunk (not always at byte 44)
      let dataOffset = 12; // skip RIFF header
      while (dataOffset + 8 < buffer.length) {
        const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
        const chunkSize = buffer.readUInt32LE(dataOffset + 4);
        if (chunkId === 'data') {
          dataOffset += 8; // skip chunk header
          break;
        }
        dataOffset += 8 + chunkSize;
      }
      console.error(`[Kokoro] Stripping WAV header (${dataOffset} bytes, ${sampleRate}Hz ${channels}ch ${bitsPerSample}-bit)`);
      buffer = buffer.subarray(dataOffset);
    }

    return buffer;
  }
}
