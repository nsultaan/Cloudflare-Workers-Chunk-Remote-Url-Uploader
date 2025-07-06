# Cloudflare Worker Chunk Uploader

A web-based tool for uploading large files to Cloudflare R2 storage using chunked uploads via Cloudflare Workers.

## Features

- **Chunked Uploads**: Splits large files into manageable chunks for reliable uploads
- **Progress Tracking**: Real-time progress bar and status updates
- **Session Management**: Automatic session creation and cleanup
- **R2 Integration**: Direct upload to Cloudflare R2 storage
- **Folder Support**: Optional folder organization in R2

## Setup

### 1. Deploy the Cloudflare Worker

You need to deploy the Cloudflare Worker that handles the chunked uploads. The worker should support these endpoints:

- `GET /?url=<file_url>` - Create upload session
- `GET /upload?session=<session_id>&chunk=<chunk_number>&folder=<optional_folder>` - Upload chunk
- `GET /progress?session=<session_id>` - Check upload progress
- `GET /clear?session=<session_id>` - Clear session data

### 2. Configure the Frontend

Update the `WORKER_BASE` constant in `index.php` with your deployed worker URL:

```javascript
const WORKER_BASE = "https://your-worker.your-subdomain.workers.dev";
```

## Usage

1. Open `index.php` in a web browser
2. Enter the remote file URL you want to upload
3. Optionally specify an R2 folder path
4. Click "Start Upload" to begin the chunked upload process
5. Monitor progress and wait for completion

## Files

- `index.php` - Main web interface for the uploader
- `index.js` - Additional JavaScript functionality (if needed)

## Requirements

- Web server with PHP support
- jQuery (loaded from CDN)
- Deployed Cloudflare Worker with R2 integration

## License

MIT License 