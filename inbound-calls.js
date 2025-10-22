import WebSocket from "ws";
// ---- AUDIO HELPERS (paste near top of file) ----
function parseWavAndExtractData(wavBuf) {
    // Basic RIFF/WAVE checks
    if (wavBuf.slice(0, 4).toString() !== "RIFF" || wavBuf.slice(8, 12).toString() !== "WAVE") {
        throw new Error("Not a WAV container");
    }

    let pos = 12; // start of first chunk after RIFF header
    let audioFormat = null, numChannels = null, sampleRate = null, bitsPerSample = null;
    let dataStart = null, dataSize = null;

    while (pos + 8 <= wavBuf.length) {
        const chunkId = wavBuf.slice(pos, pos + 4).toString();
        const chunkSize = wavBuf.readUInt32LE(pos + 4);
        const chunkStart = pos + 8;

        if (chunkId === "fmt ") {
            audioFormat = wavBuf.readUInt16LE(chunkStart + 0);   // 7 = u-law
            numChannels = wavBuf.readUInt16LE(chunkStart + 2);   // expect 1
            sampleRate = wavBuf.readUInt32LE(chunkStart + 4);   // expect 8000
            bitsPerSample = wavBuf.readUInt16LE(chunkStart + 14);  // 8 for u-law in WAV
        } else if (chunkId === "data") {
            dataStart = chunkStart;
            dataSize = chunkSize;
        }

        // Chunks are word-aligned; odd sizes have a pad byte
        pos = chunkStart + chunkSize + (chunkSize % 2);

        if (dataStart != null && audioFormat != null) break;
    }

    if (dataStart == null || dataSize == null) throw new Error("WAV has no data chunk");
    return {
        data: wavBuf.subarray(dataStart, dataStart + dataSize),
        audioFormat, numChannels, sampleRate, bitsPerSample
    };
}

function ensureRawUlawBase64(inB64) {
    if (!inB64) return { ok: false, reason: "empty" };
    const buf = Buffer.from(inB64, "base64");

    // WAV? ("RIFF....WAVE")
    if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WAVE") {
        const info = parseWavAndExtractData(buf);
        if (info.audioFormat !== 7) {
            return { ok: false, reason: `wav-not-ulaw(fmt=${info.audioFormat})` };
        }
        if (info.sampleRate !== 8000) {
            console.warn(`[WAV] sampleRate=${info.sampleRate} (expected 8000) — Twilio wants 8 kHz`);
        }
        if (info.numChannels !== 1) {
            console.warn(`[WAV] channels=${info.numChannels} (expected mono) — Twilio wants mono`);
        }
        return { ok: true, b64: info.data.toString("base64"), note: "stripped-wav" };
    }

    // MP3? (ID3 or frame sync)
    if (buf.length >= 3 && (buf.slice(0, 3).toString() === "ID3" || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0))) {
        return { ok: false, reason: "mp3-container" };
    }

    // Ogg/Opus?
    if (buf.length >= 4 && buf.slice(0, 4).toString() === "OggS") {
        return { ok: false, reason: "ogg-container" };
    }

    // Looks like raw μ-law bytes already
    return { ok: true, b64: inB64, note: "raw" };
}

let __loggedFirstChunk = false;
function logFirstChunkInfo(b64) {
    if (__loggedFirstChunk) return;
    __loggedFirstChunk = true;
    const buf = Buffer.from(b64 || "", "base64");
    const head = buf.slice(0, 16).toString("hex");
    console.log(`[EL audio] first 16 bytes: ${head} (len=${buf.length})`);
}
// ---- END AUDIO HELPERS ----
export function registerInboundRoutes(fastify) {
    // Check for the required environment variables
    const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
        console.error("Missing required environment variables");
        throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
    }

    // Helper function to get signed URL for authenticated conversations
    async function getSignedUrl() {
        try {
            const response = await fetch(
                `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
                {
                    method: 'GET',
                    headers: {
                        'xi-api-key': ELEVENLABS_API_KEY
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to get signed URL: ${response.statusText}`);
            }

            const data = await response.json();
            return data.signed_url;
        } catch (error) {
            console.error("Error getting signed URL:", error);
            throw error;
        }
    }

    // Route to handle incoming calls from Twilio
    fastify.all("/incoming-call-eleven", async (request, reply) => {
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

        reply.type("text/xml").send(twimlResponse);
    });

    // WebSocket route for handling media streams from Twilio
    fastify.register(async (fastifyInstance) => {
        fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
            console.info("[Server] Twilio connected to media stream.");

            let streamSid = null;
            let elevenLabsWs = null;
            const DateVar = req.query?.Date || new Date().toISOString().slice(0, 10);
            const TimeVar = req.query?.Time || new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            const NameVar = req.query?.Name || "Caller";
            const ContactVar = req.query?.Contact_Details || "";

            // Gate streaming until the agent confirms init
            let convoReady = false;
            try {
                // Get authenticated WebSocket URL
                const signedUrl = await getSignedUrl();

                // Connect to ElevenLabs using the signed URL
                elevenLabsWs = new WebSocket(signedUrl);

                // Handle open event for ElevenLabs WebSocket
                elevenLabsWs.on("open", () => {
                    console.log("[II] Connected to Conversational AI. Sending dynamic variables…");
                    elevenLabsWs.send(JSON.stringify({
                        type: "conversation_initiation_client_data",
                        dynamic_variables: {
                            Date: DateVar,
                            Time: TimeVar,
                            Name: NameVar,
                            Contact_Details: ContactVar,
                        },
                    }));
                });
                // Handle messages from ElevenLabs
                elevenLabsWs.on("message", (data) => {
                    try {
                        const message = JSON.parse(data);
                        handleElevenLabsMessage(message, connection);
                    } catch (error) {
                        console.error("[II] Error parsing message:", error);
                    }
                });

                // Handle errors from ElevenLabs WebSocket
                elevenLabsWs.on("error", (error) => {
                    console.error("[II] WebSocket error:", error);
                });

                // Handle close event for ElevenLabs WebSocket
                elevenLabsWs.on("close", () => {
                    console.log("[II] Disconnected.");
                });

                // Function to handle messages from ElevenLabs
                const handleElevenLabsMessage = (message, connection) => {
                    switch (message.type) {
                        case "conversation_initiation_metadata":
                            console.info("[II] Received conversation initiation metadata.");
                            convoReady = true;
                            break;
                        // AFTER (replacement)
                        case "audio": {
                            const b64In = message.audio_event?.audio_base_64;
                            if (!b64In) break;

                            // one-time peek for debugging
                            logFirstChunkInfo(b64In);

                            // ensure Twilio gets RAW μ-law@8k (strip WAV if needed; reject MP3/Ogg)
                            const ensured = ensureRawUlawBase64(b64In);
                            if (!ensured.ok) {
                                console.warn("[EL] Unsupported audio container:", ensured.reason, "— not sending to Twilio");
                                break; // don't send unusable audio
                            }
                            if (ensured.note === "stripped-wav") {
                                console.log("[EL] Received WAV μ-law — stripped header and forwarding raw bytes");
                            }

                            // Optional but tidy: send ~20ms frames (160 bytes each) to Twilio
                            const raw = Buffer.from(ensured.b64, "base64");
                            for (let off = 0; off < raw.length; off += 160) {
                                const chunk = raw.subarray(off, Math.min(off + 160, raw.length)).toString("base64");
                                connection.send(JSON.stringify({
                                    event: "media",
                                    streamSid,
                                    media: { payload: chunk }
                                }));
                            }
                            break;
                        }
                    }
                };

                // Handle messages from Twilio
                connection.on("message", async (message) => {
                    try {
                        const data = JSON.parse(message);
                        switch (data.event) {
                            case "start":
                                streamSid = data.start.streamSid;
                                console.log(`[Twilio] Stream started with ID: ${streamSid}`);
                                break;
                            case "media":
                                if (convoReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                                    const audioMessage = {
                                        user_audio_chunk: Buffer.from(
                                            data.media.payload,
                                            "base64"
                                        ).toString("base64"),
                                    };
                                    elevenLabsWs.send(JSON.stringify(audioMessage));
                                }
                                break;
                            case "stop":
                                if (elevenLabsWs) {
                                    elevenLabsWs.close();
                                }
                                break;
                            default:
                                console.log(`[Twilio] Received unhandled event: ${data.event}`);
                        }
                    } catch (error) {
                        console.error("[Twilio] Error processing message:", error);
                    }
                });

                // Handle close event from Twilio
                connection.on("close", () => {
                    if (elevenLabsWs) {
                        elevenLabsWs.close();
                    }
                    console.log("[Twilio] Client disconnected");
                });

                // Handle errors from Twilio WebSocket
                connection.on("error", (error) => {
                    console.error("[Twilio] WebSocket error:", error);
                    if (elevenLabsWs) {
                        elevenLabsWs.close();
                    }
                });

            } catch (error) {
                console.error("[Server] Error initializing conversation:", error);
                if (elevenLabsWs) {
                    elevenLabsWs.close();
                }
                connection.socket.close();
            }
        });
    });
}