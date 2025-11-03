import WebSocket from "ws";

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
          <Stream url="wss://${request.headers.host}/media-stream"/>
        </Connect>
      </Response>`;

        reply.type("text/xml").send(twimlResponse);
    });

    // WebSocket route for handling media streams from Twilio
    fastify.register(async (fastifyInstance) => {
        fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
            console.info("[Server] Twilio connected to media stream.");
            let outQueue = [];
            let streamSid = null;
            let elevenLabsWs = null;
            // Diagnostics
            let stats = {
                twilioMediaInFrames: 0,      // frames received from Twilio
                forwardedToELBytes: 0,       // bytes sent to ElevenLabs
                elAudioFrames: 0,            // audio frames received from ElevenLabs
                forwardedToTwilioBytes: 0    // bytes sent back to Twilio
            };
            // --- Outbound pacing to Twilio: 160B @ 50fps (20ms) ---
            // (reuses your existing `outQueue` — do NOT redeclare it)
            const FRAME_BYTES = 160;
            const FRAME_INTERVAL_MS = 20;
            let pacerTimer = null;

            function startPacer() {
                if (pacerTimer) return;
                pacerTimer = setInterval(() => {
                    try {
                        if (!connection || connection.readyState !== WebSocket.OPEN) return;
                        if (!streamSid) return;
                        const b64 = outQueue.shift();
                        if (!b64) return;
                        console.log(`[Pacer] sending 160B frame sid=${streamSid} q=${outQueue.length}`);
                        connection.send(JSON.stringify({
                            event: "media",
                            streamSid,
                            media: { payload: b64 }
                        }));
                        // count bytes actually sent
                        stats.forwardedToTwilioBytes += Buffer.from(b64, "base64").length;
                    } catch (e) {
                        console.warn("[Pacer] send error:", e?.message);
                    }
                }, FRAME_INTERVAL_MS);
            }

            function stopPacer() {
                if (!pacerTimer) return;
                clearInterval(pacerTimer);
                pacerTimer = null;
            }

            function stripWaveIfNeeded(buf) {
                // If EL wraps μ-law in WAV, strip to raw 'data' chunk
                if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF") {
                    const dataIdx = buf.indexOf(Buffer.from("data"));
                    if (dataIdx > 0 && dataIdx + 8 <= buf.length) {
                        return buf.subarray(dataIdx + 8); // skip 'data' + chunk size
                    }
                }
                return buf;
            }

            function enqueueELBase64(elBase64) {
                let buf = Buffer.from(elBase64, "base64");
                buf = stripWaveIfNeeded(buf); // ensure raw μ-law 8k mono
                // Slice into 160-byte frames and queue
                for (let i = 0; i < buf.length; i += FRAME_BYTES) {
                    const frame = buf.subarray(i, Math.min(i + FRAME_BYTES, buf.length));
                    outQueue.push(frame.toString("base64"));
                }
            }
            //Diagnostics
            const statsTimer = setInterval(() => {
                console.log(`[STATS] in(Twilio frames)=${stats.twilioMediaInFrames} -> EL(bytes)=${stats.forwardedToELBytes} | in(EL frames)=${stats.elAudioFrames} -> Twilio(bytes)=${stats.forwardedToTwilioBytes}`);
            }, 5000);
            connection.on("close", () => clearInterval(statsTimer));
            //Diagnostics end

            const DateVar = req.query?.Date || new Date().toISOString().slice(0, 10);
            const TimeVar = req.query?.Time || new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            const NameVar = req.query?.Name || "Caller";
            const ContactVar = req.query?.Contact_Details || "";

            // Gate streaming until the agent confirms init
            let convoReady = false;
            try {
                // Get authenticated WebSocket URL
                const signedUrl = await getSignedUrl();
                const u = new URL(signedUrl);
                u.searchParams.set("output_format", "ulaw_8000");
                const elevenLabsUrl = u.toString();
                // Connect to ElevenLabs using the signed URL
                elevenLabsWs = new WebSocket(elevenLabsUrl);

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
                        const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
                        const msg = JSON.parse(text);

                        // 1) Mark conversation ready when we get initiation metadata (cover multiple shapes)
                        if (
                            !convoReady && (
                                msg.type === "conversation_initiation_metadata" ||
                                msg.event === "conversation_initiation_metadata" ||
                                msg.conversation_initiation_metadata ||
                                msg.conversation_initiation_metadata_event
                            )
                        ) {
                            const meta =
                                msg.conversation_initiation_metadata ||
                                msg.conversation_initiation_metadata_event ||
                                {};
                            console.info("[II] Received conversation initiation metadata.");
                            if (meta.agent_output_audio_format || meta.user_input_audio_format) {
                                console.info(
                                    `[II] Formats: agent_output=${meta.agent_output_audio_format} | user_input=${meta.user_input_audio_format}`
                                );
                            }
                            convoReady = true;
                        }

                        // 2) Extract audio and enqueue for paced send to Twilio
                        let b64 = null;
                        if (msg.type === "audio" && msg.audio_event && msg.audio_event.audio_base_64) {
                            b64 = msg.audio_event.audio_base_64; // EL "audio" event shape
                        } else if (msg.agent_audio_chunk) {
                            b64 = msg.agent_audio_chunk;
                        } else if (msg.audio_base64) {
                            b64 = msg.audio_base64;
                        } else if (msg.audio && (msg.audio.chunk || msg.audio.base64)) {
                            b64 = msg.audio.chunk || msg.audio.base64;
                        }

                        if (b64) {
                            stats.elAudioFrames++;
                            enqueueELBase64(b64); // packetize to 160B frames
                        }
                    } catch (e) {
                        console.error("EL ws parse error", e);
                    }
                });

                // Fallback: if EL never sends initiation metadata, proceed after 1500ms
                let elReadyFallbackTimer = setTimeout(() => {
                    if (!convoReady) {
                        console.warn("[II] No initiation metadata from EL after 1500ms — proceeding anyway.");
                        convoReady = true;
                    }
                }, 1500);

                // Handle errors from ElevenLabs WebSocket
                elevenLabsWs.on("error", (error) => {
                    clearTimeout(elReadyFallbackTimer);
                    console.error("[II] WebSocket error:", error);
                });

                // Handle close event for ElevenLabs WebSocket
                elevenLabsWs.on("close", () => {
                    clearTimeout(elReadyFallbackTimer);
                    console.log("[II] Disconnected.");
                });

                // Function to handle messages from ElevenLabs
                const handleElevenLabsMessage = (message, connection) => {
                    switch (message.type) {
                        case "conversation_initiation_metadata": {
                            const meta = message.conversation_initiation_metadata_event || {};
                            console.info("[II] Received conversation initiation metadata.");
                            console.info(`[II] Formats: agent_output=${meta.agent_output_audio_format} | user_input=${meta.user_input_audio_format}`);
                            convoReady = true;
                            break;
                        }
                        case "audio": {
                            const b64 = message.audio_event?.audio_base_64;
                            if (!b64) break;
                            stats.elAudioFrames++;
                            stats.forwardedToTwilioBytes += Buffer.from(b64, "base64").length;

                            if (!streamSid) {
                                outQueue.push(b64);               // buffer until Twilio says "start"
                                break;
                            }
                            // Send to Twilio
                            if (message.audio_event?.audio_base_64) {
                                const audioData = {
                                    event: "media",
                                    streamSid,
                                    media: {
                                        payload: message.audio_event.audio_base_64,
                                    },
                                };
                                connection.send(JSON.stringify(audioData));
                            }
                            break;
                            // Send to Twilio
                            connection.send(JSON.stringify({
                                event: "media",
                                streamSid,
                                media: {
                                    payload: message.audio_event.audio_base_64,
                                },
                            }));
                            break;
                            break;
                        }
                        case "interruption": {
                            connection.send(JSON.stringify({ event: "clear", streamSid }));
                            break;
                        }
                        case "ping": {
                            if (message.ping_event?.event_id) {
                                const pongResponse = {
                                    type: "pong",
                                    event_id: message.ping_event.event_id,
                                };
                                elevenLabsWs.send(JSON.stringify(pongResponse));
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
                            case "start": {
                                streamSid = data.start.streamSid;
                                const fmt = data.start.mediaFormat || {};
                                console.log(`[Twilio] start sid=${streamSid} encoding=${fmt.encoding} rate=${fmt.sampleRate} ch=${fmt.channels}`);
                                // Do NOT flush the whole queue at once; let the pacer drain it
                                startPacer();
                                break;
                            }
                            case "media": {
                                if (convoReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                                    const audioMessage = {
                                        user_audio_chunk: Buffer.from(
                                            data.media.payload,
                                            "base64"
                                        ).toString("base64"),
                                    };
                                    elevenLabsWs.send(JSON.stringify(audioMessage));
                                }
                                if (convoReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                                    // count Twilio inbound frames and bytes forwarded to EL
                                    stats.twilioMediaInFrames++;
                                    const buf = Buffer.from(data.media.payload, "base64");
                                    stats.forwardedToELBytes += buf.length;
                                    // forward to ElevenLabs (same payload, just normalized)
                                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: buf.toString("base64") }));
                                }
                                break;
                            }
                            case "stop": {
                                stopPacer();
                                console.log(`[Twilio] stream ${data.streamSid} stopped by Twilio`);
                                break;
                            }
                            default: {
                                console.log(`[Twilio] Received unhandled event: ${data.event}`);
                            }
                        }
                    } catch (error) {
                        console.error("[Twilio] Error processing message:", error);
                    }
                });

                // Handle close event from Twilio
                connection.on("close", () => {
                    stopPacer();
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