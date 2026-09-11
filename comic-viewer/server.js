require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const sharp = require('sharp');

// Some Windows/Node network stacks fail on the IPv6-mapped addresses used by
// Hugging Face Spaces even when IPv4 connectivity is available.
dns.setDefaultResultOrder('ipv4first');

const app = express();


const PORT = process.env.PORT || 3001;
const ROOT_DIR = process.env.ROOT_DIR || path.resolve(__dirname, '..');
const COMIC_BASE_PATH = process.env.COMIC_BASE_PATH || path.join(ROOT_DIR, 'comic-website');
const HF_SPACE_BASE = 'https://deepghs-wd14-tagging-online.hf.space';
const HF_TOKEN = process.env.HF_TOKEN || '';
let wd14EndpointCache = null;

// Folder names to exclude from the comic list
const EXCLUDED_FOLDERS = ['comics'];

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/images', express.static(COMIC_BASE_PATH));

// Serve trainer.html from the root folder
app.get('/trainer.html', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'trainer.html'));
});

async function fetchWd14Info() {
    const headers = {};
    if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

    const response = await fetch(`${HF_SPACE_BASE}/gradio_api/info`, { headers });
    if (!response.ok) {
        throw new Error(`WD14 info request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

async function getWd14Endpoint() {
    if (wd14EndpointCache) return wd14EndpointCache;

    const info = await fetchWd14Info();
    const namedEndpoints = info.named_endpoints || info?.data?.named_endpoints || {};
    const entries = Object.entries(namedEndpoints);

    if (entries.length === 0) {
        throw new Error('Could not discover a WD14 endpoint.');
    }

    const [endpointPath, endpointInfo] = entries[0];
    wd14EndpointCache = {
        path: endpointPath,
        info: endpointInfo || {}
    };
    return wd14EndpointCache;
}

async function uploadWd14File(buffer, filename, mimeType) {
    const form = new FormData();
    form.append('files', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);

    const headers = {};
    if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

    const response = await fetch(`${HF_SPACE_BASE}/gradio_api/upload`, {
        method: 'POST',
        headers,
        body: form
    });

    if (!response.ok) {
        throw new Error(`WD14 upload failed: ${response.status} ${response.statusText}`);
    }

    const uploaded = await response.json();
    if (!Array.isArray(uploaded) || !uploaded[0]) {
        throw new Error('WD14 upload returned an unexpected response.');
    }

    return uploaded[0];
}

function buildWd14Payload(filePath, filename, endpointInfo) {
    const defaults = {
        model_name: 'wd14-vit',
        threshold: 0.35,
        use_spaces: false,
        use_escape: true,
        include_ranks: false,
        score_descend: true
    };

    const params = endpointInfo?.parameters || [];
    const payload = {};

    for (const param of params) {
        const name = param.parameter_name || param.name;
        if (!name) continue;

        if (/image|file|input/i.test(name)) {
            payload[name] = {
                path: filePath,
                meta: { _type: 'gradio.FileData' },
                orig_name: filename
            };
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(defaults, name)) {
            payload[name] = defaults[name];
            continue;
        }

        if (param.parameter_has_default && Object.prototype.hasOwnProperty.call(param, 'parameter_default')) {
            payload[name] = param.parameter_default;
            continue;
        }

        payload[name] = null;
    }

    if (!Object.keys(payload).length) {
        payload.image = {
            path: filePath,
            meta: { _type: 'gradio.FileData' },
            orig_name: filename
        };
        Object.assign(payload, defaults);
    }

    return payload;
}

async function callWd14Endpoint(payload, endpointPath) {
    const headers = { 'Content-Type': 'application/json' };
    if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

    const tryUrls = [
        `${HF_SPACE_BASE}/gradio_api/call/v2${endpointPath}`,
        `${HF_SPACE_BASE}/gradio_api/call${endpointPath}`
    ];

    let lastError = null;

    for (const url of tryUrls) {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            return response.json();
        }

        lastError = new Error(`WD14 call failed: ${response.status} ${response.statusText}`);
    }

    throw lastError || new Error('WD14 call failed.');
}

async function pollWd14Result(endpointPath, eventId) {
    const headers = {};
    if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

    const url = `${HF_SPACE_BASE}/gradio_api/call${endpointPath}/${eventId}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`WD14 poll failed: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const completeMatch = text.match(/event:\s*complete\s*[\r\n]+data:\s*(.+)/s);
    if (!completeMatch) {
        throw new Error('WD14 poll did not return a complete event.');
    }

    return JSON.parse(completeMatch[1].trim());
}

app.get('/api/wd14/info', async (req, res) => {
    try {
        const info = await fetchWd14Info();
        res.json(info);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wd14/tag', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
    try {
        const mimeType = req.get('content-type') || 'application/octet-stream';
        const filename = req.get('x-filename') || 'image';
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        const extractTags = (value) => {
            if (!value) return '';
            if (typeof value === 'string') return value.trim();
            if (Array.isArray(value)) {
                for (const entry of value) {
                    const text = extractTags(entry);
                    if (text) return text;
                }
                return '';
            }
            if (typeof value === 'object') {
                if (typeof value.text === 'string') return value.text.trim();
                if (typeof value.tags === 'string') return value.tags.trim();
                if (typeof value.output === 'string') return value.output.trim();
                if (Array.isArray(value.data)) return extractTags(value.data);
            }
            return '';
        };

        const tryPredict = async () => {
            const base64 = buffer.toString('base64');
            const dataUri = `data:${mimeType};base64,${base64}`;

            const payload = {
                data: [
                    dataUri,
                    'wd14-vit',
                    0.35,
                    false,
                    true,
                    false,
                    true
                ],
                fn_index: 0
            };

            const response = await fetch(`${HF_SPACE_BASE}/run/predict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`WD14 predict failed: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            const text = extractTags(result?.data?.[1] ?? result);
            if (!text) {
                throw new Error('WD14 predict response did not contain tags.');
            }

            return { tags: text, raw: result, mode: 'predict' };
        };

        try {
            const direct = await tryPredict();
            res.json({ ok: true, ...direct });
            return;
        } catch (predictErr) {
            console.warn('WD14 direct predict failed, trying queue fallback:', predictErr.message);
        }

        const uploaded = await uploadWd14File(buffer, filename, mimeType);
        const endpoint = await getWd14Endpoint();
        const payload = buildWd14Payload(uploaded.path || uploaded.url || uploaded, filename, endpoint.info);
        const submission = await callWd14Endpoint(payload, endpoint.path);
        const eventId = submission?.event_id || submission?.eventId || submission?.data?.event_id || submission?.data?.eventId;

        if (!eventId) {
            throw new Error('WD14 queue submission did not return an event id.');
        }

        const result = await pollWd14Result(endpoint.path, eventId);
        const text = extractTags(result?.data?.[1] ?? result);

        if (!text) {
            throw new Error('WD14 queue response did not contain tags.');
        }

        res.json({
            ok: true,
            tags: text,
            raw: result,
            mode: 'queue'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Global cache for /api/comics to prevent blocking the event loop on multiple tabs
let comicsCache = null;
let comicsCacheTime = 0;

// 1. Get list of all comic folders (excluding EXCLUDED_FOLDERS)
app.get('/api/comics', async (req, res) => {
    try {
        if (comicsCache && Date.now() - comicsCacheTime < 60000) {
            return res.json(comicsCache);
        }

        const fsp = fs.promises;
        const entries = await fsp.readdir(COMIC_BASE_PATH, { withFileTypes: true });
        
        const validFolders = entries.filter(dirent => 
            dirent.isDirectory() && !EXCLUDED_FOLDERS.includes(dirent.name.toLowerCase())
        );

        const comicsWithThumbs = [];
        
        // Use a loop to avoid EMFILE and yield to event loop
        for (const dirent of validFolders) {
            const folder = dirent.name;
            const folderPath = path.join(COMIC_BASE_PATH, folder);
            
            let images = [];
            try {
                const files = await fsp.readdir(folderPath);
                images = files
                    .filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file))
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            } catch (e) {}

            let metadata = { genres: [] };
            const metadataPath = path.join(folderPath, 'metadata.json');
            try {
                const metaDataRaw = await fsp.readFile(metadataPath, 'utf8');
                metadata = JSON.parse(metaDataRaw);
            } catch (e) {}
            
            let mtimeMs = 0;
            try {
                const stats = await fsp.stat(folderPath);
                mtimeMs = stats.mtimeMs;
            } catch (e) {}

            comicsWithThumbs.push({
                name: folder,
                thumbnail: images.length > 0 ? images[0] : null,
                genres: metadata.genres || [],
                mtime: mtimeMs
            });
        }

        comicsCache = comicsWithThumbs;
        comicsCacheTime = Date.now();
        res.json(comicsWithThumbs);
    } catch (err) {
        console.error(err);
        res.status(500).send("Folder read error");
    }
});

// 2. Get all images inside a selected folder
app.get('/api/comic/:name', (req, res) => {
    try {
        const folderPath = path.join(COMIC_BASE_PATH, req.params.name);
        const images = fs.readdirSync(folderPath)
            .filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        res.json(images);
    } catch (err) {
        console.error(err);
        res.status(500).send("Could not read folder");
    }
});

app.get('/api/download', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send("No URL provided");
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const downloaderPath = path.join(__dirname, 'gallery-downloader-python', 'dev-download.js');
    const child = spawn('node', [downloaderPath, targetUrl]);

    let detectedFolder = '';

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (let line of lines) {
            if (line.trim()) {
                // Detect destination folder from the download logs
                const folderMatch = line.match(/Destination Folder:\s*(.+)/i);
                if (folderMatch) {
                    detectedFolder = folderMatch[1].trim();
                }
                res.write(`data: ${JSON.stringify({ type: 'log', message: line.trim() })}\n\n`);
            }
        }
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (let line of lines) {
            if (line.trim()) res.write(`data: ${JSON.stringify({ type: 'error', message: line.trim() })}\n\n`);
        }
    });

    child.on('close', (code) => {
        // Save the downloader URL to metadata.json if we detected a folder
        if (detectedFolder && code === 0) {
            try {
                const metaPath = path.join(COMIC_BASE_PATH, detectedFolder, 'metadata.json');
                let metadata = {};
                if (fs.existsSync(metaPath)) {
                    try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
                }
                metadata.downloader_url = targetUrl;
                fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
                console.log(`Saved downloader_url to ${detectedFolder}/metadata.json`);
            } catch (e) {
                console.error('Failed to save downloader_url:', e.message);
            }
        }

        // Invalidate the comics cache so new downloads show up
        comicsCache = null;

        res.write(`data: ${JSON.stringify({ type: 'done', code })}\n\n`);
        res.end();
    });

    req.on('close', () => {
        child.kill();
    });

});

// Add this to your Express server.js
const SERVER_INSTANCE_ID = Date.now().toString(); // Changes every restart

app.get('/api/server-status', (req, res) => {
    res.json({ instanceId: SERVER_INSTANCE_ID });
});

// Open a comic folder in Windows File Explorer
function openFolderInExplorer(req, res) {
    const folderPath = path.join(COMIC_BASE_PATH, req.params.name);
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');

    // Pass the path as an actual process argument. This preserves Unicode,
    // brackets, ampersands, and apostrophes without PowerShell quoting rules.
    const explorerPath = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
    const child = spawn(explorerPath, [folderPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    });

    child.once('error', (err) => {
        console.error('Failed to open folder in Explorer:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });

    child.once('spawn', () => {
        child.unref();
        if (!res.headersSent) {
            res.json({ ok: true, path: folderPath });
        }
    });
}

app.get('/api/open-folder/:name', openFolderInExplorer);
app.post('/api/open-folder/:name', openFolderInExplorer);

app.post('/api/create-dataset-folder/:name', express.json(), (req, res) => {
    try {
        const folderName = req.params.name;
        // Basic security check to prevent traversing outside
        if (folderName.includes('..') || folderName.includes('/') || folderName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid folder name' });
        }

        const targetDir = path.join(ROOT_DIR, folderName);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Copy files from source comic folder if provided
        const sourceFolder = req.body && req.body.sourceFolder;
        let copied = 0;
        if (sourceFolder && !sourceFolder.includes('..')) {
            const srcDir = path.join(COMIC_BASE_PATH, sourceFolder);
            if (fs.existsSync(srcDir)) {
                const files = fs.readdirSync(srcDir);
                for (const file of files) {
                    const srcFile = path.join(srcDir, file);
                    const destFile = path.join(targetDir, file);
                    if (fs.statSync(srcFile).isFile()) {
                        fs.copyFileSync(srcFile, destFile);
                        copied++;
                    }
                }
            }
        }

        res.json({ ok: true, path: targetDir, copied });
    } catch (err) {
        console.error('Error creating dataset folder:', err);
        res.status(500).json({ error: err.message });
    }
});

// Browse root workspace folders
app.get('/api/browse-camera', (req, res) => {
    try {
        const cameraRoot = ROOT_DIR;
        const entries = fs.readdirSync(cameraRoot);
        const result = entries.map(name => {
            const fullPath = path.join(cameraRoot, name);
            const stat = fs.statSync(fullPath);
            if (!stat.isDirectory()) return null;
            // Get a quick image preview + count
            let images = [];
            try {
                images = fs.readdirSync(fullPath)
                    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            } catch (e) {}
            return { name, isDir: true, imageCount: images.length, preview: images[0] || null };
        }).filter(Boolean);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Browse a specific subfolder inside root workspace
app.get('/api/browse-camera/:folder', (req, res) => {
    try {
        const folder = req.params.folder;
        if (folder.includes('..')) return res.status(400).json({ error: 'Invalid' });
        const folderPath = path.join(ROOT_DIR, folder);
        const entries = fs.readdirSync(folderPath);
        const result = entries.map(name => {
            const fullPath = path.join(folderPath, name);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                let images = [];
                try {
                    images = fs.readdirSync(fullPath)
                        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
                        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                } catch (e) {}
                return { name, isDir: true, imageCount: images.length, preview: images[0] || null };
            } else {
                return { name, isDir: false, size: stat.size };
            }
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve a preview image from <folder>/<file>
app.get('/api/camera-preview/:folder/:file', (req, res) => {
    try {
        const folder = req.params.folder;
        const file = req.params.file;
        if (folder.includes('..') || file.includes('..')) return res.status(400).send('Invalid');
        const filePath = path.join(ROOT_DIR, folder, file);
        if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ── Trainer file operations ────────────────────────────────────────────────

const CAMERA_ROOT = ROOT_DIR;

function safeTrainerPath(folder, file) {
    if (!folder || folder.includes('..')) return null;
    if (file && (file.includes('..') || file.includes('/') || file.includes('\\'))) return null;
    return file ? path.join(CAMERA_ROOT, folder, file) : path.join(CAMERA_ROOT, folder);
}

// List images + txt status for a trainer folder
app.get('/api/trainer/:folder/images', async (req, res) => {
    try {
        const dir = safeTrainerPath(req.params.folder);
        if (!dir) return res.status(400).json({ error: 'Invalid folder' });
        if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });

        const all = fs.readdirSync(dir);
        const images = all
            .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const resultPromises = images.map(async name => {
            const base = name.replace(/\.[^.]+$/, '');
            const txtName = base + '.txt';
            let tagText = '';
            const txtPath = path.join(dir, txtName);
            if (fs.existsSync(txtPath)) {
                try { tagText = fs.readFileSync(txtPath, 'utf8').trim(); } catch (e) {}
            }
            
            const imagePath = path.join(dir, name);
            let sizeBytes = 0;
            let width = 0;
            let height = 0;
            try {
                const stat = fs.statSync(imagePath);
                sizeBytes = stat.size;
                const metadata = await sharp(imagePath).metadata();
                width = metadata.width || 0;
                height = metadata.height || 0;
            } catch (err) {
                // Ignore metadata errors for individual files
            }

            return {
                name,
                txtName,
                hasTxt: fs.existsSync(txtPath),
                tagText,
                renamed: /^image\d+\.[^.]+$/i.test(name),
                sizeBytes,
                width,
                height
            };
        });

        const result = await Promise.all(resultPromises);

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read txt content for a specific image
app.get('/api/trainer/:folder/txt/:file', (req, res) => {
    try {
        const p = safeTrainerPath(req.params.folder, req.params.file);
        if (!p) return res.status(400).json({ error: 'Invalid' });
        if (!fs.existsSync(p)) return res.json({ content: '' });
        res.json({ content: fs.readFileSync(p, 'utf8').trim() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Write txt content
app.post('/api/trainer/:folder/txt/:file', express.json(), (req, res) => {
    try {
        const p = safeTrainerPath(req.params.folder, req.params.file);
        if (!p) return res.status(400).json({ error: 'Invalid' });
        const content = (req.body && req.body.content !== undefined) ? req.body.content : '';
        fs.writeFileSync(p, content + '\n', 'utf8');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Batch resize images
app.post('/api/trainer/:folder/batch-resize', express.json(), async (req, res) => {
    try {
        const dir = safeTrainerPath(req.params.folder);
        if (!dir) return res.status(400).json({ error: 'Invalid folder' });
        
        const files = req.body.files;
        if (!Array.isArray(files)) return res.status(400).json({ error: 'Invalid files array' });

        const resized = [];
        const errors = [];

        for (const file of files) {
            try {
                const imgPath = path.join(dir, file);
                if (fs.existsSync(imgPath)) {
                    const tempPath = imgPath + '.tmp';
                    await sharp(imgPath)
                        .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 85 })
                        .toFile(tempPath);
                    fs.unlinkSync(imgPath);
                    fs.renameSync(tempPath, imgPath);
                    resized.push(file);
                }
            } catch (err) {
                errors.push({ file, error: err.message });
            }
        }

        res.json({ ok: true, resized, errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Write binary file (crop saves, duplicates)
app.post('/api/trainer/:folder/write/:file',
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
        try {
            const p = safeTrainerPath(req.params.folder, req.params.file);
            if (!p) return res.status(400).json({ error: 'Invalid' });
            fs.writeFileSync(p, req.body);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// Delete a file
app.delete('/api/trainer/:folder/file/:file', (req, res) => {
    try {
        const p = safeTrainerPath(req.params.folder, req.params.file);
        if (!p) return res.status(400).json({ error: 'Invalid' });
        if (fs.existsSync(p)) fs.unlinkSync(p);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename all images sequentially (image01.jpg, image02.jpg, ...)
app.post('/api/trainer/:folder/rename', (req, res) => {
    try {
        const dir = safeTrainerPath(req.params.folder);
        if (!dir) return res.status(400).json({ error: 'Invalid folder' });

        const images = fs.readdirSync(dir)
            .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const width = Math.max(2, String(images.length).length);
        const tmpPrefix = `__tmp_${Date.now()}_`;

        // Stage to temp names
        for (let i = 0; i < images.length; i++) {
            const ext = images[i].replace(/^.*\./, '');
            fs.renameSync(
                path.join(dir, images[i]),
                path.join(dir, `${tmpPrefix}${String(i + 1).padStart(width, '0')}.${ext}`)
            );
        }

        // Rename temp to final
        const tmpFiles = fs.readdirSync(dir)
            .filter(f => f.startsWith(tmpPrefix))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const renamed = [];
        for (let i = 0; i < tmpFiles.length; i++) {
            const ext = tmpFiles[i].replace(/^.*\./, '');
            const finalName = `image${String(i + 1).padStart(width, '0')}.${ext}`;
            fs.renameSync(path.join(dir, tmpFiles[i]), path.join(dir, finalName));
            renamed.push(finalName);
        }

        res.json({ ok: true, renamed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create empty txt files for all images that don't have one
app.post('/api/trainer/:folder/create-txts', (req, res) => {
    try {
        const dir = safeTrainerPath(req.params.folder);
        if (!dir) return res.status(400).json({ error: 'Invalid folder' });

        const images = fs.readdirSync(dir)
            .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

        const created = [];
        for (const img of images) {
            const base = img.replace(/\.[^.]+$/, '');
            const txtPath = path.join(dir, base + '.txt');
            if (!fs.existsSync(txtPath)) {
                fs.writeFileSync(txtPath, '', 'utf8');
                created.push(base + '.txt');
            }
        }
        res.json({ ok: true, created });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add trigger word to all txt files
app.post('/api/trainer/:folder/trigger', express.json(), (req, res) => {
    try {
        const dir = safeTrainerPath(req.params.folder);
        if (!dir) return res.status(400).json({ error: 'Invalid folder' });
        const trigger = req.body && req.body.trigger ? req.body.trigger.trim() : '';
        if (!trigger) return res.status(400).json({ error: 'No trigger word' });

        const txts = fs.readdirSync(dir).filter(f => /\.txt$/i.test(f));
        const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const triggerRegex = new RegExp(`^${escaped}\\s*,`, 'i');

        for (const txt of txts) {
            const p = path.join(dir, txt);
            let content = fs.readFileSync(p, 'utf8').trim();
            if (!content) content = trigger;
            else if (!triggerRegex.test(content)) content = `${trigger}, ${content.replace(/^,+\s*/, '')}`;
            fs.writeFileSync(p, content + '\n', 'utf8');
        }

        res.json({ ok: true, updated: txts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const START_TIME = Date.now();
let hasReceivedPing = false;

app.get('/api/ping', (req, res) => {
    hasReceivedPing = true;
    res.json({ status: 'ok', startTime: START_TIME });
});

// ── Nexus AI — Folder Analysis Engine ──────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'minimax/minimax-m3';

let nexusAnalysisResults = null;
let nexusAnalysisTime = 0;
let nexusAISummary = '';
let nexusAnalysisRunning = false;

async function scanComicFolders() {
    const results = [];
    try {
        const fsp = fs.promises;
        const entries = await fsp.readdir(COMIC_BASE_PATH, { withFileTypes: true });
        
        const folders = entries.filter(dirent => 
            dirent.isDirectory() && !EXCLUDED_FOLDERS.includes(dirent.name.toLowerCase())
        ).map(d => d.name);

        for (const folder of folders) {
            const folderPath = path.join(COMIC_BASE_PATH, folder);
            try {
                const allFiles = await fsp.readdir(folderPath);
                const imageFiles = allFiles.filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));

                if (imageFiles.length === 0) {
                    results.push({ folder, totalImages: 0, extensions: {}, missingNumbers: [], dominantExt: 'none', hasIssues: true });
                    continue;
                }

                // Count extensions
                const extensions = {};
                const numbers = [];
                for (const img of imageFiles) {
                    const ext = img.replace(/^.*\./, '').toLowerCase();
                    const normalExt = ext === 'jpeg' ? 'jpg' : ext;
                    extensions[normalExt] = (extensions[normalExt] || 0) + 1;

                    // Extract numeric part from filename
                    const numMatch = img.match(/^0*(\d+)\./);
                    if (numMatch) {
                        numbers.push(parseInt(numMatch[1], 10));
                    }
                }

                // Determine dominant extension
                const dominantExt = Object.entries(extensions).sort((a, b) => b[1] - a[1])[0][0];

                // Find missing numbers
                const missingNumbers = [];
                if (numbers.length > 0) {
                    numbers.sort((a, b) => a - b);
                    const maxNum = numbers[numbers.length - 1];
                    const numSet = new Set(numbers);
                    for (let i = 1; i <= maxNum; i++) {
                        if (!numSet.has(i)) missingNumbers.push(i);
                    }
                }

                // Check for metadata downloader_url
                let downloaderUrl = '';
                const metaPath = path.join(folderPath, 'metadata.json');
                try {
                    const metaRaw = await fsp.readFile(metaPath, 'utf8');
                    const meta = JSON.parse(metaRaw);
                    downloaderUrl = meta.downloader_url || '';
                } catch {}

                const hasIssues = missingNumbers.length > 0 || Object.keys(extensions).length > 1;
                results.push({
                    folder,
                    totalImages: imageFiles.length,
                    extensions,
                    missingNumbers,
                    dominantExt,
                    hasIssues,
                    downloaderUrl
                });
            } catch (e) {
                results.push({ folder, totalImages: 0, extensions: {}, missingNumbers: [], dominantExt: 'error', hasIssues: true, error: e.message });
            }
        }
    } catch (e) {
        console.error('Nexus AI scan error:', e.message);
    }
    return results;
}

async function generateAISummary(analysisResults) {
    const lmModel = process.env.LM_STUDIO_MODEL || "qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking";

    const issuesFolders = analysisResults.filter(r => r.hasIssues);
    const cleanFolders = analysisResults.filter(r => !r.hasIssues);

    // Build a concise data payload for the AI
    let dataPrompt = `You are Nexus AI, an intelligent comic library analyzer. Analyze this scan data and provide a concise, helpful summary.\n\n`;
    dataPrompt += `Total folders scanned: ${analysisResults.length}\n`;
    dataPrompt += `Folders with issues: ${issuesFolders.length}\n`;
    dataPrompt += `Clean folders: ${cleanFolders.length}\n\n`;

    if (issuesFolders.length > 0) {
        dataPrompt += `FOLDERS WITH ISSUES:\n`;
        for (const f of issuesFolders) {
            dataPrompt += `- "${f.folder}": ${f.totalImages} images, extensions: ${JSON.stringify(f.extensions)}`;
            if (f.missingNumbers.length > 0) {
                dataPrompt += `, missing pages: [${f.missingNumbers.join(', ')}]`;
            }
            if (f.downloaderUrl) {
                dataPrompt += `, source URL available for re-download`;
            }
            dataPrompt += `\n`;
        }
    }

    dataPrompt += `\nProvide a brief summary highlighting:\n1. How many folders have missing pages and which ones are most critical\n2. Any folders with mixed image formats\n3. Suggestions for fixing the issues\nKeep it concise and use bullet points. Do not use markdown headers.`;

    try {
        const response = await fetch('http://localhost:1234/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: lmModel,
                messages: [
                    { role: 'system', content: 'You are Nexus AI, a smart comic library health analyzer. Be concise, helpful, and actionable.' },
                    { role: 'user', content: dataPrompt }
                ],
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('LM Studio API error:', response.status, errText);
            return `AI summary unavailable (API error ${response.status}). Raw scan found ${issuesFolders.length} folders with issues out of ${analysisResults.length} total.`;
        }

        const result = await response.json();
        return result.choices?.[0]?.message?.content || 'AI returned an empty response.';
    } catch (e) {
        console.error('AI summary error:', e.message);
        return `AI summary unavailable (${e.message}). Raw scan found ${issuesFolders.length} folders with issues out of ${analysisResults.length} total.`;
    }
}

async function runNexusAnalysis() {
    if (nexusAnalysisRunning) return;
    nexusAnalysisRunning = true;
    console.log('🧠 Nexus AI: Starting folder analysis...');

    try {
        const results = await scanComicFolders();
        nexusAnalysisResults = results;
        nexusAnalysisTime = Date.now();

        const summary = await generateAISummary(results);
        nexusAISummary = summary;

        const issueCount = results.filter(r => r.hasIssues).length;
        console.log(`🧠 Nexus AI: Analysis complete. ${results.length} folders scanned, ${issueCount} with issues.`);
    } catch (e) {
        console.error('🧠 Nexus AI: Analysis failed:', e.message);
    } finally {
        nexusAnalysisRunning = false;
    }
}

// API: Get full analysis results
app.get('/api/nexus-analysis', async (req, res) => {
    res.json({
        results: nexusAnalysisResults || [],
        summary: nexusAISummary,
        lastAnalyzed: nexusAnalysisTime,
        hasApiKey: true,
        model: process.env.LM_STUDIO_MODEL || "LM Studio",
        usage: null
    });
});

// API: Trigger a fresh analysis
app.post('/api/nexus-analysis/refresh', async (req, res) => {
    if (nexusAnalysisRunning) {
        return res.json({ ok: false, message: 'Analysis already running.' });
    }
    runNexusAnalysis(); // Don't await — let it run in background
    res.json({ ok: true, message: 'Analysis started.' });
});

// ── Downloader URL Tracking ────────────────────────────────────────────────

// Override the download route to also track the URL in metadata.json
// We intercept the stdout to detect the destination folder, then save the URL
const originalDownloadRoute = app._router ? null : null; // placeholder

app.get('/api/download-tracked', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send("No URL provided");
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const downloaderPath = path.join(__dirname, 'gallery-downloader-python', 'dev-download.js');
    const child = spawn('node', [downloaderPath, targetUrl]);

    let detectedFolder = '';

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (let line of lines) {
            if (line.trim()) {
                // Detect destination folder from the download logs
                const folderMatch = line.match(/(?:📂\s*)?Destination Folder:\s*(.+)/i);
                if (folderMatch) {
                    detectedFolder = folderMatch[1].trim();
                }
                res.write(`data: ${JSON.stringify({ type: 'log', message: line.trim() })}\n\n`);
            }
        }
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (let line of lines) {
            if (line.trim()) res.write(`data: ${JSON.stringify({ type: 'error', message: line.trim() })}\n\n`);
        }
    });

    child.on('close', (code) => {
        // Save the downloader URL to metadata.json if we detected a folder
        if (detectedFolder && code === 0) {
            try {
                const metaPath = path.join(COMIC_BASE_PATH, detectedFolder, 'metadata.json');
                let metadata = {};
                if (fs.existsSync(metaPath)) {
                    try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
                }
                metadata.downloader_url = targetUrl;
                fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
                console.log(`📎 Saved downloader_url to ${detectedFolder}/metadata.json`);
            } catch (e) {
                console.error('Failed to save downloader_url:', e.message);
            }
        }

        // Invalidate the comics cache so new downloads show up
        comicsCache = null;

        res.write(`data: ${JSON.stringify({ type: 'done', code })}\n\n`);
        res.end();
    });

    req.on('close', () => {
        child.kill();
    });
});

// ── Image Translation Engine ─────────────────────────────────────────────

// Helper: robustly extract JSON array or individual translation objects from LLM response
function extractTranslationsFromJson(raw) {
    if (!raw) return [];
    
    // First attempt: direct match of a full JSON array [...]
    const arrayMatch = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) return parsed;
        } catch {}
    }

    // Fallback: extract individual valid JSON objects { ... }
    const items = [];
    const objRegex = /\{[^{}]*"(?:text|translation)"[^{}]*\}/g;
    let m;
    while ((m = objRegex.exec(raw)) !== null) {
        try {
            const obj = JSON.parse(m[0]);
            items.push(obj);
        } catch {}
    }
    return items;
}

// Helper: normalize coordinates into standard percentage bounds (x, y, width, height: 0-100)
function normalizeBoundingBox(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') return null;
    const text = (rawItem.text || rawItem.translation || '').trim();
    if (!text) return null;

    let x, y, width, height;

    if (rawItem.xmin != null && rawItem.xmax != null && rawItem.ymin != null && rawItem.ymax != null) {
        let xmin = parseFloat(rawItem.xmin);
        let xmax = parseFloat(rawItem.xmax);
        let ymin = parseFloat(rawItem.ymin);
        let ymax = parseFloat(rawItem.ymax);

        // Standard Qwen-VL grounding uses 0-1000 coordinates. Convert to 0-100%
        const is1000 = Math.max(xmin, xmax, ymin, ymax) > 100;
        const scale = is1000 ? 10 : 1;

        xmin = xmin / scale;
        xmax = xmax / scale;
        ymin = ymin / scale;
        ymax = ymax / scale;

        x = Math.min(xmin, xmax);
        y = Math.min(ymin, ymax);
        width = Math.abs(xmax - xmin);
        height = Math.abs(ymax - ymin);
    } else if (rawItem.x != null && rawItem.y != null) {
        let rx = parseFloat(rawItem.x);
        let ry = parseFloat(rawItem.y);
        let rw = parseFloat(rawItem.width || 20);
        let rh = parseFloat(rawItem.height || 10);

        const is1000 = Math.max(rx, ry, rw, rh) > 100;
        const scale = is1000 ? 10 : 1;

        x = rx / scale;
        y = ry / scale;
        width = rw / scale;
        height = rh / scale;
    } else {
        return null;
    }

    // Clamp coordinates safely within image bounds
    x = Math.max(0, Math.min(95, x));
    y = Math.max(0, Math.min(95, y));
    width = Math.max(5, Math.min(100 - x, width));
    height = Math.max(3, Math.min(100 - y, height));

    return {
        text,
        x: parseFloat(x.toFixed(1)),
        y: parseFloat(y.toFixed(1)),
        width: parseFloat(width.toFixed(1)),
        height: parseFloat(height.toFixed(1))
    };
}

// ── LM Studio Lifecycle & On-Demand Boot Manager ─────────────────────────
const LM_STUDIO_DEFAULT_MODEL = process.env.LM_STUDIO_MODEL || "qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking";
let isLMStudioStarting = false;

// Check if LM Studio HTTP server is answering on port 1234
async function isLMStudioServerReachable(timeoutMs = 1200) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch('http://localhost:1234/v1/models', { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

// Get loaded models via `lms ps`
async function getLoadedLMStudioModels() {
    return new Promise((resolve) => {
        exec('lms ps', { timeout: 4000 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length <= 1 || stdout.includes('No models are currently loaded')) {
                return resolve([]);
            }
            const loaded = [];
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(/\s{2,}/);
                if (parts[0] && parts[0] !== 'IDENTIFIER') {
                    loaded.push(parts[0].trim());
                }
            }
            resolve(loaded);
        });
    });
}

// Measure real-time RAM usage for Node server and LM Studio (Bionic.exe, lms.exe)
async function getMemoryStats() {
    const serverRssBytes = process.memoryUsage().rss;
    const serverMB = (serverRssBytes / (1024 * 1024)).toFixed(1);

    let lmStudioBytes = 0;
    let bionicProcesses = 0;

    await new Promise((resolve) => {
        exec('tasklist /FO CSV /NH', { timeout: 3000 }, (err, stdout) => {
            if (!err && stdout) {
                stdout.split('\n').forEach(line => {
                    if (/Bionic\.exe|lms\.exe/i.test(line)) {
                        const parts = line.split('","');
                        if (parts[4]) {
                            const val = parseInt(parts[4].replace(/[^\d]/g, ''), 10);
                            if (!isNaN(val)) {
                                lmStudioBytes += val * 1024;
                                bionicProcesses++;
                            }
                        }
                    }
                });
            }
            resolve();
        });
    });

    const lmStudioMBVal = lmStudioBytes / (1024 * 1024);
    const lmStudioMB = lmStudioMBVal.toFixed(1);

    const formatMem = (mbVal) => {
        if (mbVal <= 0.5) return '0 MB';
        if (mbVal >= 1024) return (mbVal / 1024).toFixed(2) + ' GB';
        return mbVal.toFixed(0) + ' MB';
    };

    return {
        serverMB: parseFloat(serverMB),
        serverFormatted: formatMem(parseFloat(serverMB)),
        lmStudioMB: parseFloat(lmStudioMB),
        lmStudioFormatted: formatMem(lmStudioMBVal),
        bionicProcesses
    };
}

// Check if Bionic.exe is running in Windows tasklist
async function isBionicProcessRunning() {
    return new Promise((resolve) => {
        exec('tasklist /FI "IMAGENAME eq Bionic.exe" /NH', { timeout: 3000 }, (err, stdout) => {
            if (err || !stdout) return resolve(false);
            resolve(stdout.toLowerCase().includes('bionic.exe'));
        });
    });
}

// Full LM Studio Status with RAM usage
async function getLMStudioStatus() {
    const running = await isLMStudioServerReachable();
    let loadedModels = [];
    if (running) {
        loadedModels = await getLoadedLMStudioModels();
    }
    const bionicRunning = await isBionicProcessRunning();
    const memory = await getMemoryStats();

    return {
        running,
        loadedModels,
        loadedModel: loadedModels[0] || null,
        targetModel: LM_STUDIO_DEFAULT_MODEL,
        isStarting: isLMStudioStarting,
        bionicRunning,
        memory
    };
}

// Memory info endpoint
app.get('/api/system/memory', async (req, res) => {
    try {
        const mem = await getMemoryStats();
        res.json(mem);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Start LM Studio server & load model on-demand
async function startLMStudio(targetModel = LM_STUDIO_DEFAULT_MODEL) {
    if (isLMStudioStarting) {
        // Wait for active boot process
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (!isLMStudioStarting) break;
        }
        return await getLMStudioStatus();
    }

    isLMStudioStarting = true;
    console.log(`[LM Studio] Booting on-demand with model: "${targetModel}"...`);

    try {
        let serverRunning = await isLMStudioServerReachable(800);
        if (!serverRunning) {
            console.log('[LM Studio] Starting headless server (`lms server start --cors`)...');
            exec('lms server start --cors');

            // Wait for port 1234 to respond (up to 30 seconds)
            const startTime = Date.now();
            while (Date.now() - startTime < 30000) {
                await new Promise(r => setTimeout(r, 1000));
                serverRunning = await isLMStudioServerReachable(1000);
                if (serverRunning) break;
            }

            if (!serverRunning) {
                throw new Error('LM Studio server failed to respond on port 1234 within 30 seconds.');
            }
            console.log('[LM Studio] Server is active on port 1234.');
        }

        // Check if model is loaded
        const loaded = await getLoadedLMStudioModels();
        if (!loaded.some(m => m.toLowerCase().includes(targetModel.toLowerCase()) || targetModel.toLowerCase().includes(m.toLowerCase()))) {
            console.log(`[LM Studio] Loading model "${targetModel}"...`);
            await new Promise((resolve) => {
                exec(`lms load "${targetModel}"`, { timeout: 90000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.warn('[LM Studio] Model load notice:', err.message, stderr || '');
                    }
                    resolve();
                });
            });
            console.log(`[LM Studio] Model load finished.`);
        } else {
            console.log(`[LM Studio] Model "${targetModel}" is already in memory.`);
        }

        isLMStudioStarting = false;
        return await getLMStudioStatus();
    } finally {
        isLMStudioStarting = false;
    }
}

// Stop LM Studio server and completely free RAM / VRAM
async function stopLMStudio() {
    console.log('[LM Studio] Stopping server and freeing memory...');

    // 1. Unload model to release VRAM immediately
    await new Promise((resolve) => {
        exec('lms unload --all', { timeout: 6000 }, () => resolve());
    });

    // 2. Stop the local server
    await new Promise((resolve) => {
        exec('lms server stop', { timeout: 6000 }, () => resolve());
    });

    // 3. Terminate background Bionic daemon to free all host RAM
    await new Promise((resolve) => {
        exec('taskkill /F /IM Bionic.exe /T', { timeout: 5000 }, () => resolve());
    });

    console.log('[LM Studio] Successfully stopped. GPU and RAM freed.');
    return { success: true, message: 'LM Studio stopped and memory freed.' };
}

// REST Endpoints for LM Studio Management
app.get('/api/lmstudio/status', async (req, res) => {
    try {
        const status = await getLMStudioStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/lmstudio/start', async (req, res) => {
    try {
        const status = await startLMStudio();
        res.json({ success: true, ...status });
    } catch (e) {
        console.error('[LM Studio] Start error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/lmstudio/stop', async (req, res) => {
    try {
        const result = await stopLMStudio();
        res.json(result);
    } catch (e) {
        console.error('[LM Studio] Stop error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Translation Persistence API ──────────────────────────────────────────
// Get saved translations for a comic folder
app.get('/api/page-translations/:folder', async (req, res) => {
    try {
        const folder = req.params.folder;
        const filePath = path.join(COMIC_BASE_PATH, folder, '.translations.json');
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return res.json({ success: true, translations: JSON.parse(raw) });
        }
        res.json({ success: true, translations: {} });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Save translations for a specific page or entire comic
app.post('/api/save-page-translations', async (req, res) => {
    try {
        const { folder, image, boxes } = req.body;
        if (!folder || !image) return res.status(400).json({ error: 'Missing folder or image' });

        const folderPath = path.join(COMIC_BASE_PATH, folder);
        if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder not found' });

        const filePath = path.join(folderPath, '.translations.json');
        let data = {};
        if (fs.existsSync(filePath)) {
            try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
        }

        data[image] = {
            boxes: boxes || [],
            savedAt: new Date().toISOString()
        };

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[Translations] Saved ${boxes ? boxes.length : 0} boxes for "${image}" in "${folder}".`);
        res.json({ success: true, count: boxes ? boxes.length : 0 });
    } catch (e) {
        console.error('[Translations] Save error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Clear saved translation for a specific page
app.post('/api/clear-page-translations', async (req, res) => {
    try {
        const { folder, image } = req.body;
        if (!folder || !image) return res.status(400).json({ error: 'Missing folder or image' });

        const filePath = path.join(COMIC_BASE_PATH, folder, '.translations.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            delete data[image];
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Qwen 3 Vision Captioning for Dataset Trainer ─────────────────────────
app.post('/api/trainer/qwen-caption', async (req, res) => {
    const { folder, image, dataUrl, mode } = req.body;

    try {
        let imageDataUrl = dataUrl;

        // If folder and image are provided, read and process from disk
        if (!imageDataUrl && image) {
            let imgPath = path.resolve(ROOT_DIR, folder || '', image);
            if (!fs.existsSync(imgPath) && folder) {
                imgPath = path.resolve(COMIC_BASE_PATH, folder, image);
            }
            if (!fs.existsSync(imgPath)) {
                return res.status(404).json({ error: `Image not found: ${imgPath}` });
            }

            const imgBuffer = fs.readFileSync(imgPath);
            const processed = await sharp(imgBuffer)
                .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            imageDataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
        }

        if (!imageDataUrl) {
            return res.status(400).json({ error: 'No image provided for captioning.' });
        }

        // Ensure LM Studio is active
        const isRunning = await isLMStudioServerReachable(800);
        if (!isRunning) {
            console.log('[Trainer Qwen] LM Studio offline. Booting on-demand...');
            await startLMStudio();
        }

        const isTags = mode === 'tags';
        const prompt = isTags
            ? 'You are an expert anime/manga dataset tagger for LoRA training. Analyze this image and output comma-separated tags describing the character, hair, eyes, expression, clothing, pose, framing, background, and art style. Output ONLY comma-separated tags, all lowercase, no markdown, no explanation.'
            : 'You are an expert AI dataset captioner for Flux and SDXL LoRA training. Describe this image in a single natural language caption paragraph focusing on the main subject, hair style/color, expression, clothing, pose, action, background, and visual style. Be direct, clear, and concise without introductory filler.';

        const lmModel = process.env.LM_STUDIO_MODEL || "qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking";
        console.log(`[Trainer Qwen] Generating ${mode || 'caption'} for "${image || 'image'}"...`);

        const chatMessages = [
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: imageDataUrl } }
                ]
            }
        ];

        const lmBody = JSON.stringify({
            model: lmModel,
            messages: chatMessages,
            temperature: 0.2,
            max_tokens: 500
        });

        const lmResponse = await new Promise((resolve, reject) => {
            const r = require('http').request('http://localhost:1234/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(lmBody) },
                timeout: 120000
            }, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    body: data
                }));
            });
            r.on('error', reject);
            r.write(lmBody);
            r.end();
        });

        if (!lmResponse.ok) throw new Error(`LM Studio error ${lmResponse.status}: ${lmResponse.body}`);

        const parsed = JSON.parse(lmResponse.body);
        let content = parsed.choices?.[0]?.message?.content || '';

        // Strip thinking tags if uncensored thinking model is used
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        console.log(`[Trainer Qwen] Done generating: "${content.substring(0, 80)}..."`);
        res.json({ success: true, text: content, usage: parsed.usage });

    } catch (e) {
        console.error('[Trainer Qwen] Captioning error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Re-Download Missing Pages via Stored URL ─────────────────────────────
app.post('/api/redownload-missing', async (req, res) => {
    const { folder, downloaderUrl } = req.body;
    if (!folder) return res.status(400).json({ error: 'Missing folder' });

    let targetUrl = downloaderUrl;
    const folderPath = path.join(COMIC_BASE_PATH, folder);

    if (!targetUrl && fs.existsSync(folderPath)) {
        const metaPath = path.join(folderPath, 'metadata.json');
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                targetUrl = meta.downloader_url || '';
            } catch {}
        }
    }

    if (!targetUrl) {
        return res.status(400).json({ error: 'No downloader URL found on record for this comic.' });
    }

    console.log(`[Downloader] Re-fetching missing pages for "${folder}" using URL: ${targetUrl}...`);

    const downloaderPath = path.join(__dirname, 'gallery-downloader-python', 'dev-download.js');
    const child = spawn('node', [downloaderPath, targetUrl]);

    let outputLog = '';
    child.stdout.on('data', (d) => { outputLog += d.toString(); });
    child.stderr.on('data', (d) => { outputLog += d.toString(); });

    child.on('close', (code) => {
        console.log(`[Downloader] Re-fetch completed with exit code ${code}`);
        // Trigger fresh Nexus analysis so missing pages list updates
        runNexusAnalysis().catch(() => {});
    });

    res.json({
        success: true,
        message: `Download started for "${folder}" using stored URL: ${targetUrl}`
    });
});

// Helper: call LM Studio with single image
async function callLMStudio(dataUrl, prompt, lmModel) {
    const chatMessages = [
        {
            role: "user",
            content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } }
            ]
        }
    ];

    const lmBody = JSON.stringify({
        model: lmModel,
        messages: chatMessages,
        temperature: 0.1,
        max_tokens: 3500
    });

    const lmResponse = await new Promise((resolve, reject) => {
        const req = require('http').request('http://localhost:1234/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(lmBody) },
            timeout: 3600000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('error', reject);
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                body: data
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('LM Studio timeout')));
        req.write(lmBody);
        req.end();
    });

    if (!lmResponse.ok) throw new Error(`LM Studio error ${lmResponse.status}: ${lmResponse.body}`);

    const result = JSON.parse(lmResponse.body);
    const usage = result.usage || {};
    const rawContent = result.choices?.[0]?.message?.content || '';

    const rawItems = extractTranslationsFromJson(rawContent);
    const normalized = rawItems.map(normalizeBoundingBox).filter(Boolean);

    return { translations: normalized, usage };
}

app.post('/api/translate-image', async (req, res) => {
    const { folder, image, language } = req.body;
    if (!folder || !image) return res.status(400).json({ error: "Missing folder or image" });

    const targetLang = language || 'English';

    try {
        const imagePath = path.join(COMIC_BASE_PATH, folder, image);
        if (!fs.existsSync(imagePath)) return res.status(404).json({ error: "Image not found" });

        const sharp = require('sharp');
        const imageBuffer = fs.readFileSync(imagePath);

        // Preprocess full-page image: resize to optimal dimensions for vision model (1024 max dimension)
        const processedBuffer = await sharp(imageBuffer)
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

        const dataUrl = `data:image/jpeg;base64,${processedBuffer.toString('base64')}`;

        const isTamil = targetLang.toLowerCase() === 'tamil';
        const lmModel = process.env.LM_STUDIO_MODEL || "qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking";

        let prompt;
        if (isTamil) {
            prompt = `You are an expert manga/comic translator.
Locate ALL speech bubbles, dialogue boxes, and text captions across this entire page.
For each text element:
1. Translate foreign text into natural, fluent Tamil (தமிழ்).
   CRITICAL TRANSLATION RULE: The comic text is in a foreign language (such as Italian, Japanese, Spanish, Korean). You MUST TRANSLATE every single text element into natural Tamil (தமிழ்). NEVER copy or repeat foreign words (Italian, Japanese, etc.). Write every single translation in proper Tamil script (தமிழ் எழுத்துகளில்).
2. Locate its bounding box with coordinates normalized to 0-1000 (where 0 is top/left and 1000 is bottom/right):
   - xmin: left edge (0-1000)
   - ymin: top edge (0-1000)
   - xmax: right edge (0-1000)
   - ymax: bottom edge (0-1000)

Output ONLY a JSON array with this exact structure, no markdown fences:
[{"text":"தமிழ் மொழிபெயர்ப்பு","xmin":50,"ymin":20,"xmax":250,"ymax":80}]`;
        } else {
            prompt = `You are an expert manga/comic translator.
Locate ALL speech bubbles, dialogue boxes, and text captions across this entire page.
For each text element:
1. Translate foreign text into natural, fluent ${targetLang}.
   CRITICAL TRANSLATION RULE: The comic text is in a foreign language (such as Italian, Japanese, Spanish, Korean). You MUST TRANSLATE every single text element into natural ${targetLang}. NEVER copy or repeat the original foreign words. Every single bubble MUST be fully translated into ${targetLang}.
2. Locate its bounding box with coordinates normalized to 0-1000 (where 0 is top/left and 1000 is bottom/right):
   - xmin: left edge (0-1000)
   - ymin: top edge (0-1000)
   - xmax: right edge (0-1000)
   - ymax: bottom edge (0-1000)

Output ONLY a JSON array with this exact structure, no markdown fences:
[{"text":"${targetLang} translated text","xmin":50,"ymin":20,"xmax":250,"ymax":80}]`;
        }

        // Ensure LM Studio is active and model is loaded before calling vision inference
        const isRunning = await isLMStudioServerReachable(800);
        if (!isRunning) {
            console.log(`[Translate] LM Studio not running. Booting on-demand with model "${lmModel}"...`);
            await startLMStudio(lmModel);
        }

        console.log(`[Translate] Processing "${image}" (${targetLang}) via LM Studio...`);

        const result = await callLMStudio(dataUrl, prompt, lmModel);

        console.log(`[Translate] Done — detected & translated ${result.translations.length} bubbles.`);

        res.json({
            success: true,
            translations: result.translations,
            usage: result.usage,
            model: `${lmModel} (LM Studio)`
        });

    } catch (e) {
        console.error('Translation error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Upscayl AI Integration (SSE streaming) ──────────────────────────────


app.get('/api/upscale', async (req, res) => {
    const { folder } = req.query;
    if (!folder) { res.status(400).end(); return; }

    const folderPath = safeTrainerPath(folder);
    if (!folderPath || !fs.existsSync(folderPath)) {
        res.status(404).end(); return;
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
        const sharp = require('sharp');
        const files = fs.readdirSync(folderPath);

        // Exclude leftover temp files
        const candidates = files.filter(f =>
            /\.(jpg|jpeg|png|webp)$/i.test(f) &&
            !f.startsWith('upscaled_') &&
            !/_upscayl_/i.test(f)
        );

        // For each candidate, decide if it needs upscaling:
        // - jpg/webp → always upscale
        // - png → only upscale if its longest dimension < 1500px (i.e. it's an original, not already upscaled)
        const UPSCALED_THRESHOLD = 1500;
        const needsUpscale = [];
        let skipped = 0;

        for (const f of candidates) {
            if (/\.(jpg|jpeg|webp)$/i.test(f)) {
                needsUpscale.push(f);
            } else {
                // It's a .png — check dimensions
                try {
                    const meta = await sharp(path.join(folderPath, f)).metadata();
                    const longest = Math.max(meta.width || 0, meta.height || 0);
                    if (longest < UPSCALED_THRESHOLD) {
                        needsUpscale.push(f); // small png = original, needs upscaling
                    } else {
                        skipped++; // large png = already upscaled, skip
                    }
                } catch {
                    skipped++; // unreadable file, skip
                }
            }
        }

        const images = needsUpscale;

        if (candidates.length === 0) {
            send({ type: 'error', message: 'No images found in folder' });
            res.end(); return;
        }

        if (images.length === 0) {
            send({ type: 'complete', processed: 0, skipped, message: 'All images already upscaled!' });
            res.end(); return;
        }

        const upscaylPath = 'C:\\Program Files\\Upscayl\\resources\\bin\\upscayl-bin.exe';
        if (!fs.existsSync(upscaylPath)) {
            send({ type: 'error', message: 'Upscayl executable not found' });
            res.end(); return;
        }

        send({ type: 'start', total: images.length, skipped });

        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const inputPath = path.join(folderPath, image);
            const outExt = '.png';
            const finalPath = inputPath.replace(/\.[^.]+$/, outExt);
            
            // Generate a very short temporary path to bypass Windows 260-char limit for upscayl-bin.exe
            const shortInPath = path.join(CAMERA_ROOT, 'temp_in_' + Date.now() + path.extname(image));
            const shortOutPath = path.join(CAMERA_ROOT, 'temp_out_' + Date.now() + outExt);

            send({ type: 'progress', current: i + 1, total: images.length, image });
            console.log(`[Upscayl] (${i + 1}/${images.length}) ${image}`);

            try {
                // Copy original to the short path
                fs.copyFileSync(inputPath, shortInPath);

                await new Promise((resolve, reject) => {
                    const child = spawn(upscaylPath, [
                        '-i', shortInPath,
                        '-o', shortOutPath,
                        '-s', '4',
                        '-m', 'C:\\Program Files\\Upscayl\\resources\\models',
                        '-n', 'upscayl-standard-4x'
                    ], { cwd: 'C:\\Program Files\\Upscayl\\resources\\bin' });

                    let errLog = '';
                    child.stderr.on('data', (d) => { errLog += d.toString(); });

                    child.on('close', (code) => {
                        if (code === 0 && fs.existsSync(shortOutPath)) {
                            resolve();
                        } else {
                            reject(new Error(`Upscayl exited with code ${code}. Log: ${errLog}`));
                        }
                    });
                    child.on('error', reject);
                });

                // Move from short path back to the long path
                fs.renameSync(shortOutPath, finalPath);
                
                // Cleanup short input path
                if (fs.existsSync(shortInPath)) fs.unlinkSync(shortInPath);
                
                // If original had a different extension (e.g. .jpg), remove it
                if (finalPath !== inputPath && fs.existsSync(inputPath)) {
                    fs.unlinkSync(inputPath);
                }

                send({ type: 'done_image', current: i + 1, total: images.length, image, output: path.basename(finalPath) });
            } catch (e) {
                // Ensure temp files are cleaned up even on failure
                if (fs.existsSync(shortInPath)) fs.unlinkSync(shortInPath);
                if (fs.existsSync(shortOutPath)) fs.unlinkSync(shortOutPath);
                throw e; // Bubble up to fail the overall request
            }
        }

        send({ type: 'complete', processed: images.length });
    } catch (e) {
        console.error('Upscale Error:', e);
        send({ type: 'error', message: e.message });
    }

    res.end();
});

app.listen(PORT, async () => {
    console.log(`Node Server running at http://localhost:${PORT}`);
    
    // (Removed automatic cron for Nexus AI per user request)
    
    // Wait 3 seconds to see if an existing browser tab connects to us via /api/ping
    setTimeout(() => {
        if (!hasReceivedPing) {
            console.log("No existing browser tab detected. Opening Chrome...");
            require('child_process').exec(`start chrome http://localhost:${PORT}/index.html`);
        } else {
            console.log("Existing browser tab detected. It will auto-refresh.");
        }
    }, 3000);
});
