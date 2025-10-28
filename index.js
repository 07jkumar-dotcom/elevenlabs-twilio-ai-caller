import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { registerInboundRoutes } from './inbound-calls.js';
import { registerOutboundRoutes } from './outbound-calls.js';
// --- u-law beep generator (8 kHz) ---
function linearToMuLawSample(sample) { // sample: signed 16-bit PCM
    const BIAS = 0x84;       // 132
    const CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    // Find exponent
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
        exponent--;
    }
    // Mantissa
    const mantissa = (sample >> (exponent + 3)) & 0x0F;

    // ?-law byte, ones' complement
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function generateBeepUlawBase64({
    ms = 250,          // duration
    freq = 1000,       // 1 kHz is easy to hear over PSTN
    sampleRate = 8000, // Twilio requirement
    level = 0.3        // amplitude 0..1
} = {}) {
    const total = Math.floor(sampleRate * (ms / 1000));
    const pcm = new Int16Array(total);

    // 5 ms fade-in/out to avoid clicks
    const fadeSamples = Math.floor(sampleRate * 0.005);

    for (let i = 0; i < total; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, i / fadeSamples, (total - 1 - i) / fadeSamples);
        const s = Math.sin(2 * Math.PI * freq * t) * level * env;
        pcm[i] = Math.max(-1, Math.min(1, s)) * 32767 | 0;
    }

    const mu = new Uint8Array(total);
    for (let i = 0; i < total; i++) mu[i] = linearToMuLawSample(pcm[i]);
    return Buffer.from(mu).toString('base64');
}

// Send a beep, and request a 'mark' so we know it played
function sendBeep({ ws, streamSid, label = "beep_test" }) {
    if (!ws || !streamSid) return;
    const payload = generateBeepUlawBase64({ ms: 250, freq: 1000 });

    // Optional: clear any buffered audio so the beep plays immediately
    ws.send(JSON.stringify({ event: "clear", streamSid }));

    ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload }
    }));

    ws.send(JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: label }
    }));
}
// Load environment variables from .env file
dotenv.config();

// Initialize Fastify server
const fastify = Fastify({
  logger: true // Enable logging
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8080;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Start the Fastify server
const start = async () => {
  try {
    // Register route handlers
    await registerInboundRoutes(fastify);
    await registerOutboundRoutes(fastify);

    // Start listening
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[Server] Listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();