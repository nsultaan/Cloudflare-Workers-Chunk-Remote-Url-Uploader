export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const UPLOADS_KV = env.UPLOADS_KV;
        const R2 = env.R2;

        // Helper functions
        async function getActiveSession() { return await UPLOADS_KV.get("active_session"); }
        async function setActiveSession(sessionId) { await UPLOADS_KV.put("active_session", sessionId); }
        async function clearActiveSession() { await UPLOADS_KV.delete("active_session"); }
        async function getSession(sessionId) {
            const data = await UPLOADS_KV.get(sessionId);
            return data ? JSON.parse(data) : null;
        }
        async function setSession(sessionId, data) { await UPLOADS_KV.put(sessionId, JSON.stringify(data)); }
        async function deleteSession(sessionId) { await UPLOADS_KV.delete(sessionId); }

        // Helper to extract file name from URL
        function getFileName(fileUrl, contentType) {
            try {
                let pathname = new URL(fileUrl).pathname;
                let filename = pathname.split('/').pop() || "file";
                if (!filename.includes('.') && contentType) {
                    const map = {
                        "image/jpeg": "jpg",
                        "image/png": "png",
                        "video/mp4": "mp4",
                        "application/pdf": "pdf",
                        "application/zip": "zip",
                        "text/plain": "txt"
                    };
                    let ext = map[contentType] || "";
                    if (ext) filename = filename + "." + ext;
                }
                return filename;
            } catch {
                return "file";
            }
        }

        // CORS headers utility
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        };

        // Handle OPTIONS (CORS preflight)
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // 1. Session Creation (GET /?url=...)
        if (pathname === "/" && request.method === "GET" && url.searchParams.get("url")) {
            if (await getActiveSession()) {
                return new Response(JSON.stringify({ error: "Ek session already active hai!" }), { status: 409, headers: corsHeaders });
            }
            const fileUrl = url.searchParams.get("url");
            let headResp = await fetch(fileUrl, { method: "HEAD" });
            if (!headResp.ok) return new Response("File URL not accessible.", { status: 400, headers: corsHeaders });
            const sizeRaw = headResp.headers.get("content-length");
            const size = Number(sizeRaw);
            if (!Number.isFinite(size) || size <= 0) {
                return new Response("Invalid file size", { status: 400, headers: corsHeaders });
            }
            const type = headResp.headers.get("content-type") || "application/octet-stream";
            const chunkSize = 25 * 1024 * 1024; // 10MB chunks - optimal for large files
            const totalChunks = Math.ceil(size / chunkSize);
            const sessionId = "session_" + Math.random().toString(36).slice(2) + "_" + Date.now();
            const filename = getFileName(fileUrl, type);

            const session = {
                fileUrl,
                size,
                type,
                chunkSize,
                totalChunks,
                uploaded: Array(totalChunks).fill(false),
                created: Date.now(),
                completed: false,
                filename,
                folder: "",
                multipartUploadId: null,
                multipartParts: []
            };
            await setSession(sessionId, session);
            await setActiveSession(sessionId);

            return new Response(JSON.stringify({
                session: sessionId,
                totalChunks,
                chunkSize,
                size,
                type,
                filename,
                message: "Session started. Use /upload?session=...&chunk=...&folder=... for uploading chunks (GET request only)."
            }), { headers: { "content-type": "application/json", ...corsHeaders } });
        }

        // 2. Chunk Upload (GET /upload?session=...&chunk=...&folder=...)
        if (pathname === "/upload" && request.method === "GET") {
            const sessionId = url.searchParams.get("session");
            const chunkNum = Number(url.searchParams.get("chunk"));
            const folder = url.searchParams.get("folder") || "";

            if (!sessionId || !Number.isInteger(chunkNum)) return new Response("Missing session or chunk", { status: 400, headers: corsHeaders });
            const activeSession = await getActiveSession();
            if (activeSession !== sessionId) return new Response("Session inactive or expired!", { status: 403, headers: corsHeaders });

            let session = await getSession(sessionId);
            if (!session) return new Response("Session not found!", { status: 404, headers: corsHeaders });
            if (chunkNum < 0 || chunkNum >= session.totalChunks) return new Response("Invalid chunk #", { status: 400, headers: corsHeaders });
            if (session.uploaded[chunkNum]) {
                return new Response(JSON.stringify({ chunk: chunkNum, already: true }), { status: 200, headers: { "content-type": "application/json", ...corsHeaders } });
            }

            // Save folder path for this session (set only on first upload or if not set)
            if (folder && (!session.folder || session.folder !== folder)) {
                session.folder = folder.replace(/^\/+|\/+$/g, ""); // remove leading/trailing slashes
            }

            // Initialize multipart upload if not already done
            if (!session.multipartUploadId) {
                let folder = session.folder ? session.folder.replace(/^\/+|\/+$/g, "") : "";
                let finalKey = folder ? `${folder}/${session.filename}` : session.filename;
                
                try {
                    const multipartUpload = await R2.createMultipartUpload(finalKey);
                    session.multipartUploadId = multipartUpload.uploadId;
                    session.finalKey = finalKey;
                    session.multipartParts = [];
                    await setSession(sessionId, session);
                } catch (error) {
                    return new Response(JSON.stringify({ 
                        error: "Failed to initialize multipart upload", 
                        details: error.message 
                    }), { 
                        status: 500, 
                        headers: { "content-type": "application/json", ...corsHeaders } 
                    });
                }
            }

            // Download chunk from source
            const start = chunkNum * session.chunkSize;
            const end = Math.min(start + session.chunkSize, session.size) - 1;
            let chunkData;
            
            try {
                const chunkResp = await fetch(session.fileUrl, { headers: { "Range": `bytes=${start}-${end}` } });
                if (!chunkResp.ok) {
                    return new Response(JSON.stringify({ 
                        error: "Error downloading chunk", 
                        details: `HTTP ${chunkResp.status}: ${chunkResp.statusText}`,
                        chunk: chunkNum,
                        range: `bytes=${start}-${end}`
                    }), { 
                        status: 500, 
                        headers: { "content-type": "application/json", ...corsHeaders } 
                    });
                }
                
                chunkData = await chunkResp.arrayBuffer();
            } catch (error) {
                return new Response(JSON.stringify({ 
                    error: "Failed to download chunk", 
                    details: error.message,
                    chunk: chunkNum,
                    range: `bytes=${start}-${end}`
                }), { 
                    status: 500, 
                    headers: { "content-type": "application/json", ...corsHeaders } 
                });
            }
            
            // Upload part to multipart upload
            const partNumber = chunkNum + 1; // R2 parts are 1-indexed
            try {
                // Resume the multipart upload
                const multipartUpload = R2.resumeMultipartUpload(session.finalKey, session.multipartUploadId);
                
                // Upload the part using the proper multipart API
                const uploadedPart = await multipartUpload.uploadPart(partNumber, chunkData);
                
                // Store part info
                session.multipartParts[chunkNum] = {
                    partNumber: partNumber,
                    etag: uploadedPart.etag
                };
                session.uploaded[chunkNum] = true;
                await setSession(sessionId, session);
            } catch (error) {
                return new Response(JSON.stringify({ 
                    error: "Failed to upload part", 
                    details: error.message,
                    chunk: chunkNum,
                    partNumber: partNumber
                }), { 
                    status: 500, 
                    headers: { "content-type": "application/json", ...corsHeaders } 
                });
            }
            
            return new Response(JSON.stringify({ chunk: chunkNum, uploaded: true, folder: session.folder }), { headers: { "content-type": "application/json", ...corsHeaders } });
        }

        // 3. Progress check and auto-merge (GET /progress?session=...)
        if (pathname === "/progress" && request.method === "GET") {
            const sessionId = url.searchParams.get("session");
            if (!sessionId) return new Response("Missing session", { status: 400, headers: corsHeaders });
            let session = await getSession(sessionId);
            if (!session) return new Response("Session not found", { status: 404, headers: corsHeaders });

            // Complete multipart upload if not completed and all chunks uploaded
            if (!session.completed && session.uploaded.every(Boolean) && session.multipartUploadId) {
                try {
                    let folder = session.folder ? session.folder.replace(/^\/+|\/+$/g, "") : "";
                    let finalKey = folder ? `${folder}/${session.filename}` : session.filename;
                    
                    // Resume the multipart upload
                    const multipartUpload = R2.resumeMultipartUpload(finalKey, session.multipartUploadId);
                    
                    // Prepare parts array for completion
                    const parts = session.multipartParts
                        .filter(part => part) // Remove any undefined entries
                        .map(part => ({
                            partNumber: part.partNumber,
                            etag: part.etag
                        }))
                        .sort((a, b) => a.partNumber - b.partNumber);

                    // Complete the multipart upload
                    const object = await multipartUpload.complete(parts);

                    session.completed = true;
                    session.completedAt = Date.now();
                    session.finalKey = finalKey;
                    await setSession(sessionId, session);
                } catch (error) {
                    return new Response(JSON.stringify({ error: "Failed to complete multipart upload", details: error.message }), { 
                        status: 500, 
                        headers: { "content-type": "application/json", ...corsHeaders } 
                    });
                }
            }

            let folder = session.folder ? session.folder.replace(/^\/+|\/+$/g, "") : "";
            let finalKey = session.finalKey || (folder ? `${folder}/${session.filename}` : session.filename);
            let fileObj = await R2.get(finalKey);
            let uploaded = !!fileObj;

            return new Response(JSON.stringify({
                session: sessionId,
                uploadedChunks: session.uploaded.filter(Boolean).length,
                totalChunks: session.totalChunks,
                completed: !!session.completed,
                r2Uploaded: uploaded,
                filename: session.filename,
                r2Key: finalKey,
                folder: session.folder || "",
                multipartUploadId: session.multipartUploadId
            }), { headers: { "content-type": "application/json", ...corsHeaders } });
        }

        // 4. Debug session (GET /debug?session=...)
        if (pathname === "/debug" && request.method === "GET") {
            const sessionId = url.searchParams.get("session");
            if (!sessionId) return new Response("Missing session", { status: 400, headers: corsHeaders });
            
            let session = await getSession(sessionId);
            if (!session) return new Response("Session not found", { status: 404, headers: corsHeaders });
            
            return new Response(JSON.stringify({
                session: sessionId,
                sessionData: session,
                activeSession: await getActiveSession(),
                timestamp: Date.now()
            }), { 
                headers: { "content-type": "application/json", ...corsHeaders } 
            });
        }

        // 5. Clear session (GET /clear?session=...)
        if (pathname === "/clear" && request.method === "GET") {
            const sessionId = url.searchParams.get("session");
            if (!sessionId) return new Response("Missing session", { status: 400, headers: corsHeaders });
            
            let session = await getSession(sessionId);
            if (session && session.multipartUploadId && !session.completed) {
                // Abort multipart upload if it exists and wasn't completed
                try {
                    let folder = session.folder ? session.folder.replace(/^\/+|\/+$/g, "") : "";
                    let finalKey = folder ? `${folder}/${session.filename}` : session.filename;
                    const multipartUpload = R2.resumeMultipartUpload(finalKey, session.multipartUploadId);
                    multipartUpload.abort();
                } catch (error) {
                    // Ignore abort errors
                }
            }
            
            await deleteSession(sessionId);
            await clearActiveSession();
            return new Response("Session aur data clear ho gaya!", { status: 200, headers: corsHeaders });
        }

        return new Response("Not found", { status: 404, headers: corsHeaders });
    }
};