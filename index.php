<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Chunk Uploader</title>
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    #progress-bar { width: 100%; background: #eee; border-radius: 3px; margin: 15px 0; height: 22px; }
    #progress-inner { background: #3b82f6; height: 100%; width: 0; border-radius: 3px; transition: width 0.2s; }
    #status { margin-top: 10px; }
    input, button { padding: 8px; margin: 4px 0; }
    #result { margin-top: 20px; background: #e8ffe8; padding: 10px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Cloudflare Worker Chunk Uploader</h2>
  <label>Remote File URL:<br>
    <input type="text" id="file-url" size="60" placeholder="https://...">
  </label>
  <br>
  <label>R2 Folder (optional):<br>
    <input type="text" id="folder" size="30" placeholder="e.g. uploads/2025">
  </label>
  <br>
  <button id="start-btn">Start Upload</button>
  <div id="progress-section" style="display:none;">
    <div id="progress-bar"><div id="progress-inner"></div></div>
    <div id="status"></div>
  </div>
  <div id="result"></div>

  <script>
    // === CONFIG: Worker endpoint base (change to your deployed worker URL) ===
    const WORKER_BASE = "https://test.youracname.workers.dev"; // <-- CHANGE THIS

    let sessionId = null, totalChunks = 0, chunkSize = 0, fileSize = 0, filename = "", folderPath = "";

    // Utility: Sleep
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    $("#start-btn").click(async function() {
      $("#result").empty();
      $("#progress-section").show();
      $("#progress-inner").width(0);
      $("#status").text("Starting upload...");

      // 1. Session create
      let url = $("#file-url").val().trim();
      folderPath = $("#folder").val().trim();
      if (!url) { alert("Please enter file URL!"); return; }
      let sessionResp = await $.getJSON(WORKER_BASE + "/?url=" + encodeURIComponent(url));
      if (sessionResp.error) { $("#status").text(sessionResp.error); return; }

      sessionId = sessionResp.session;
      totalChunks = sessionResp.totalChunks;
      chunkSize = sessionResp.chunkSize;
      fileSize = sessionResp.size;
      filename = sessionResp.filename;

      $("#status").text("Session started. Uploading chunks...");
      await uploadChunks();
    });

    async function uploadChunks() {
      for (let i = 0; i < totalChunks; i++) {
        $("#status").text(`Uploading chunk ${i + 1} of ${totalChunks}...`);
        let url = `${WORKER_BASE}/upload?session=${encodeURIComponent(sessionId)}&chunk=${i}`;
        if (folderPath) url += `&folder=${encodeURIComponent(folderPath)}`;
        // Retry logic (in case of network error)
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            let resp = await $.getJSON(url);
            if (resp.uploaded || resp.already) break;
          } catch (e) {
            if (attempt === 2) {
              $("#status").text(`Failed uploading chunk ${i}.`);
              return;
            }
            await sleep(1000);
          }
        }
        let percent = Math.round(((i + 1) / totalChunks) * 100);
        $("#progress-inner").css("width", percent + "%");
      }
      $("#status").text("All chunks uploaded! Merging...");
      await checkProgress();
    }

    async function checkProgress() {
      let url = `${WORKER_BASE}/progress?session=${encodeURIComponent(sessionId)}`;
      while (true) {
        let resp = await $.getJSON(url);
        if (resp.completed && resp.r2Uploaded) {
          $("#progress-inner").css("width", "100%");
          $("#status").text("Upload complete!");
          let fileUrl = resp.folder ? `${resp.folder}/${resp.filename}` : resp.filename;
          $("#result").html(
            `<b>Done!</b><br>
            File stored as: <code>${fileUrl}</code>
            <br>R2 key: <code>${resp.r2Key}</code>`
          );
          
          // Clear the session after successful upload
          try {
            await $.getJSON(`${WORKER_BASE}/clear?session=${encodeURIComponent(sessionId)}`);
            console.log("Session cleared successfully");
          } catch (e) {
            console.log("Session clear failed:", e);
          }
          
          break;
        } else {
          $("#status").text("Merging chunks...");
          await sleep(1200);
        }
      }
    }
  </script>
</body>
</html>