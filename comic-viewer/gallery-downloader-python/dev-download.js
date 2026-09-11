const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const COMIC_BASE_PATH = 'F:\\Camera\\comic-website';
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

function safeFileName(value, fallback = 'Unknown Title') {
    const cleaned = (value || fallback).replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim();
    return cleaned || fallback;
}

function getImageExtension(url, contentType = '') {
    const urlPath = new URL(url).pathname;
    const match = urlPath.match(/\.([a-z0-9]+)$/i);
    if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();

    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    return 'jpg';
}

function getNHentaiExtension(type) {
    return type === 'p' ? 'png' : type === 'g' ? 'gif' : type === 'w' ? 'webp' : 'jpg';
}

function getNHentaiImageCandidates(mediaId, pageNumber, preferredExt) {
    const hosts = ['i3', 'i', 'i2', 'i5', 'i7'];
    const extensions = Array.from(new Set([preferredExt, 'jpg', 'png', 'webp', 'gif']));

    return hosts.flatMap(host =>
        extensions.map(ext => ({
            url: `https://${host}.nhentai.net/galleries/${mediaId}/${pageNumber}.${ext}`,
            ext
        }))
    );
}

async function downloadStreamToFile(url, filePath, referer) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: { 'Referer': referer }
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function downloadStreamToFileWithExtension(url, baseFilePath, referer) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: { 'Referer': referer }
    });

    const ext = getImageExtension(url, response.headers['content-type'] || '');
    const filePath = `${baseFilePath}.${ext}`;
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    return filePath;
}

async function downloadChapter(page, url, genres = []) {
    console.log(`\n📄 Processing chapter: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });

    // 1. Get Metadata for Folder Naming
    const folderNameRaw = await page.evaluate(() => {
        const breadcrumbs = document.querySelectorAll('.breadcrumb li');
        if (breadcrumbs.length > 0) {
            return breadcrumbs[breadcrumbs.length - 1].innerText.trim();
        }
        return null;
    });

    if (!folderNameRaw) {
        throw new Error("Could not find the series name in breadcrumbs.");
    }

    const folderName = safeFileName(folderNameRaw);
    const dir = path.join(COMIC_BASE_PATH, folderName);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    console.log(`📂 Destination Folder: ${folderName}`);

    // Save metadata
    const metadataPath = path.join(dir, 'metadata.json');
    if (!fs.existsSync(metadataPath) && genres && genres.length > 0) {
        fs.writeFileSync(metadataPath, JSON.stringify({ genres }));
    }

    // 2. Extract Image URLs
    const images = await page.$$eval('.wp-manga-chapter-img', imgs =>
        imgs.map(img => img.getAttribute('data-src') || img.src)
    );

    if (images.length === 0) {
        console.log("⚠️ No images found for this chapter. Skipping.");
        return;
    }

    console.log(`📸 Found ${images.length} images. Starting Download...`);

    // 3. Sequential Download
    for (let i = 0; i < images.length; i++) {
        const imgUrl = images[i].trim();
        const filename = `${(i + 1).toString().padStart(3, '0')}.jpg`;
        const filePath = path.join(dir, filename);

        if (fs.existsSync(filePath)) {
            console.log(`✅ Progress: ${i + 1}/${images.length}`);
            continue;
        }

        try {
            const response = await axios({
                url: imgUrl,
                method: 'GET',
                responseType: 'stream',
                headers: { 'Referer': url }
            });

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            console.log(`✅ Progress: ${i + 1}/${images.length}`);
        } catch (e) {
            console.error(`❌ Failed to download ${filename}: ${e.message}`);
        }
    }
    console.log("✨ Chapter Download Complete.");
}

async function downloadNHentaiGallery(page, url) {
    console.log(`\n📖 Processing nHentai gallery: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    const galleryData = await page.evaluate(() => {
        const titleDOM = document.querySelector('h1.title .pretty') || document.querySelector('h2.title');
        const titleRaw = titleDOM ? titleDOM.innerText : 'Unknown Title';
        
        const artistDOM = document.querySelector('a[href^="/artist/"] .name');
        const artist = artistDOM ? artistDOM.innerText : 'Unknown Artist';
        
        const tags = Array.from(document.querySelectorAll('.tags a.tag .name')).map(el => el.innerText);
        
        const scripts = document.querySelectorAll('script');
        let mediaId = null;
        let images = [];
        
        for (let s of scripts) {
            if (s.innerText.includes('window._gallery')) {
                try {
                    const match = s.innerText.match(/window\._gallery\s*=\s*JSON\.parse\((["'].*?["'])\);/);
                    if (match) {
                        const jsonString = eval(match[1]);
                        const data = JSON.parse(jsonString);
                        mediaId = data.media_id;
                        images = data.images.pages;
                    }
                } catch (e) { }
                break;
            }
        }
        
        // Fallback if script extraction fails
        if (!mediaId) {
            const firstImg = document.querySelector('.gallerythumb img');
            if (firstImg) {
                const src = firstImg.getAttribute('data-src') || firstImg.src;
                const m = src.match(/galleries\/(\d+)\//);
                if (m) mediaId = m[1];
                
                const thumbs = document.querySelectorAll('.gallerythumb img');
                for (let i=0; i<thumbs.length; i++) {
                    images.push({ t: 'j' }); // Assume jpg as fallback if we can't extract precise extension
                }
            }
        }
        
        return { titleRaw, artist, tags, mediaId, images };
    });
    
    if (!galleryData.mediaId || !galleryData.images || galleryData.images.length === 0) {
        console.log("⚠️ Could not extract gallery images. Skipping.");
        return;
    }
    
    const safeArtist = safeFileName(galleryData.artist, 'Unknown Artist');
    const safeTitle = safeFileName(galleryData.titleRaw);
    const folderName = `[${safeArtist}] ${safeTitle}`;
    
    const dir = path.join(COMIC_BASE_PATH, folderName);
    
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    console.log(`📂 Destination Folder: ${folderName}`);
    
    const metadataPath = path.join(dir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
        fs.writeFileSync(metadataPath, JSON.stringify({ genres: galleryData.tags, author: galleryData.artist }));
    }
    
    console.log(`📸 Found ${galleryData.images.length} images. Starting Download...`);
    
    for (let i = 0; i < galleryData.images.length; i++) {
        const pageNumber = i + 1;
        const preferredExt = getNHentaiExtension(galleryData.images[i].t);
        const baseFilename = pageNumber.toString().padStart(3, '0');
        const existingFile = IMAGE_EXTENSIONS
            .map(ext => path.join(dir, `${baseFilename}.${ext}`))
            .find(filePath => fs.existsSync(filePath));
        
        if (existingFile) {
            console.log(`✅ Progress: ${pageNumber}/${galleryData.images.length}`);
            continue;
        }

        const candidates = getNHentaiImageCandidates(galleryData.mediaId, pageNumber, preferredExt);
        let downloaded = false;
        let lastError = null;

        for (const candidate of candidates) {
            const filename = `${baseFilename}.${candidate.ext}`;
            const filePath = path.join(dir, filename);

            try {
                await downloadStreamToFile(candidate.url, filePath, url);
                downloaded = true;
                break;
            } catch (e) {
                lastError = e;
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }

        if (downloaded) {
            console.log(`Progress: ${pageNumber}/${galleryData.images.length}`);
            await new Promise(r => setTimeout(r, 200));
        } else {
            console.error(`Failed to download ${baseFilename}: ${lastError.message}. First URL tried: ${candidates[0].url}`);
        }
        continue;
        
        try {
            const response = await axios({
                url: imgUrl,
                method: 'GET',
                responseType: 'stream',
                headers: { 'Referer': url }
            });
            
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            if ((i + 1) % 10 === 0) console.log(`✅ Progress: ${i + 1}/${galleryData.images.length}`);
            
            // Minor delay
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`❌ Failed to download ${filename}: ${e.message}. URL: ${imgUrl}`);
        }
    }
    console.log("✨ Gallery Download Complete.");
}

async function downloadNHentaiAuthor(page, authorUrl) {
    console.log(`\n🔍 Processing nHentai page (Author / Tag / Search): ${authorUrl}`);
    
    let currentPage = 1;
    let allGalleryLinks = [];
    
    while (true) {
        let pageUrl = authorUrl;
        if (currentPage > 1) {
            pageUrl = authorUrl.includes('?') ? `${authorUrl}&page=${currentPage}` : `${authorUrl}?page=${currentPage}`;
        }
        
        console.log(`📄 Scanning page ${currentPage}...`);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
        
        const galleryLinks = await page.$$eval('.gallery a.cover', links => links.map(a => a.href));
        
        if (galleryLinks.length === 0) break;
        
        allGalleryLinks.push(...galleryLinks);
        
        const hasNext = await page.$('a.next');
        if (!hasNext) break;
        
        currentPage++;
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log(`📚 Found ${allGalleryLinks.length} total galleries for this author.`);
    
    // Download oldest first
    const sortedLinks = allGalleryLinks.reverse();
    for (let i = 0; i < sortedLinks.length; i++) {
        console.log(`\n=== Downloading Gallery ${i + 1} of ${sortedLinks.length} ===`);
        await downloadNHentaiGallery(page, sortedLinks[i]);
    }
    console.log("\n🎉 ALL AUTHOR GALLERIES DOWNLOADED!");
}

async function downloadEHentaiGallery(page, url) {
    console.log(`\nProcessing E-Hentai gallery: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Bypass Content Warning if present
    const warningLink = await page.$('a[href*="nw=always"], a[href*="nw=session"]');
    if (warningLink) {
        console.log("⚠️ Content Warning detected. Bypassing...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            warningLink.click()
        ]);
    }

    const galleryData = await page.evaluate(() => {
        const titleRaw = document.querySelector('#gn')?.innerText
            || document.querySelector('#gj')?.innerText
            || document.title
            || 'Unknown Title';

        const tags = Array.from(document.querySelectorAll('#taglist a'))
            .map(a => a.innerText.trim())
            .filter(Boolean);

        const pageNumbers = Array.from(document.querySelectorAll('.ptt a'))
            .map(a => Number(a.innerText.trim()))
            .filter(Number.isFinite);

        return {
            titleRaw,
            tags,
            pageCount: pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1
        };
    });

    const folderName = safeFileName(galleryData.titleRaw);
    const dir = path.join(COMIC_BASE_PATH, folderName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    console.log(`Destination Folder: ${folderName}`);

    const metadataPath = path.join(dir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
        fs.writeFileSync(metadataPath, JSON.stringify({
            genres: galleryData.tags,
            source: url
        }, null, 2));
    }

    const galleryBaseUrl = url.split('?')[0];
    const imagePageLinks = [];

    for (let galleryPage = 0; galleryPage < galleryData.pageCount; galleryPage++) {
        const pageUrl = galleryPage === 0 ? url : `${galleryBaseUrl}?p=${galleryPage}`;
        console.log(`Scanning gallery page ${galleryPage + 1}/${galleryData.pageCount}...`);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

        const links = await page.$$eval('#gdt a', anchors =>
            Array.from(new Set(anchors.map(a => a.href).filter(Boolean)))
        );

        imagePageLinks.push(...links);
        await new Promise(r => setTimeout(r, 500));
    }

    const uniqueImagePageLinks = Array.from(new Set(imagePageLinks));
    if (uniqueImagePageLinks.length === 0) {
        console.log("Could not find E-Hentai image page links. Check whether the gallery is accessible.");
        return;
    }

    console.log(`Found ${uniqueImagePageLinks.length} images. Starting Download...`);

    for (let i = 0; i < uniqueImagePageLinks.length; i++) {
        const pageNumber = i + 1;
        const baseFilename = pageNumber.toString().padStart(3, '0');
        const existingFile = IMAGE_EXTENSIONS
            .map(ext => path.join(dir, `${baseFilename}.${ext}`))
            .find(filePath => fs.existsSync(filePath));

        if (existingFile) {
            console.log(`✅ Progress: ${pageNumber}/${uniqueImagePageLinks.length}`);
            continue;
        }

        const imagePageUrl = uniqueImagePageLinks[i];

        try {
            await page.goto(imagePageUrl, { waitUntil: 'domcontentloaded' });
            const imageUrl = await page.evaluate(() => {
                const img = document.querySelector('#img') || document.querySelector('#i3 img');
                return img ? img.src : null;
            });

            if (!imageUrl) {
                console.error(`Failed to find image URL for ${baseFilename}`);
                continue;
            }

            await downloadStreamToFileWithExtension(imageUrl, path.join(dir, baseFilename), imagePageUrl);
            console.log(`Progress: ${pageNumber}/${uniqueImagePageLinks.length}`);
            await new Promise(r => setTimeout(r, 700));
        } catch (e) {
            console.error(`Failed to download ${baseFilename}: ${e.message}`);
        }
    }

    console.log("E-Hentai Gallery Download Complete.");
}

async function startProject(url) {
    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    });

    const page = await browser.newPage();
    console.log("🚀 Launching Stealth Engine...");

    try {
        if (url.includes('nhentai.net')) {
            if (url.includes('/artist/') || url.includes('/tag/') || url.includes('/search')) {
                // Author, Artist, Tag, or Search results — all use same paginated gallery grid
                await downloadNHentaiAuthor(page, url);
            } else if (url.includes('/g/')) {
                // Single Gallery Download
                await downloadNHentaiGallery(page, url);
            } else {
                console.log("❌ Unrecognized nHentai URL pattern. Must be /artist/, /tag/, /search, or /g/");
            }
            return;
        }

        if (url.includes('e-hentai.org') || url.includes('ehentai.org') || url.includes('exhentai.org')) {
            if (url.includes('/g/')) {
                await downloadEHentaiGallery(page, url);
            } else {
                console.log("Unrecognized E-Hentai URL pattern. Please use a gallery URL containing /g/");
            }
            return;
        }

        await page.goto(url, { waitUntil: 'networkidle2' });

        // Check if we are on a series page by looking for chapter list
        const chapterLinks = await page.$$eval('li.wp-manga-chapter > a', links => {
            // Some sites might have duplicate links, let's keep only unique hrefs
            return Array.from(new Set(links.map(a => a.href)));
        });

        if (chapterLinks.length > 0) {
            console.log(`📚 Found series page with ${chapterLinks.length} chapters.`);

            // Extract genres from series page
            const genres = await page.evaluate(() => {
                const genresDiv = document.querySelector('.genres-content');
                if (genresDiv) {
                    return Array.from(genresDiv.querySelectorAll('a')).map(a => a.innerText.trim());
                }
                return [];
            });
            if (genres.length > 0) console.log(`🏷️ Tags/Genres found: ${genres.join(', ')}`);

            // Reverse the array so we download from first chapter to last
            const sortedLinks = chapterLinks.reverse();
            for (let i = 0; i < sortedLinks.length; i++) {
                console.log(`\n=== Downloading Chapter ${i + 1} of ${sortedLinks.length} ===`);
                await downloadChapter(page, sortedLinks[i], genres);
            }
            console.log("\n🎉 ALL CHAPTERS DOWNLOADED!");
        } else {
            // Fallback: Check if it's a single chapter page by seeing if there are images
            const hasImages = await page.$('.wp-manga-chapter-img');
            if (hasImages) {
                console.log("📖 Single chapter URL detected.");
                await downloadChapter(page, url);
            } else {
                console.log("❌ Could not find any chapter links or images on this page. Check the URL.");
            }
        }

    } catch (err) {
        console.error("❌ Developer Error:", err.message);
    } finally {
        await browser.close();
    }
}

const targetUrl = process.argv[2];
if (!targetUrl) {
    console.error("❌ Please provide a URL as an argument.");
    process.exit(1);
}
startProject(targetUrl);
