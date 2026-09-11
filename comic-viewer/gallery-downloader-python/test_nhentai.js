const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    });
    const page = await browser.newPage();
    console.log("Navigating to nhentai...");
    await page.goto("https://nhentai.net/g/343103/", { waitUntil: 'domcontentloaded' });
    
    const domData = await page.evaluate(() => {
        let media_id = "-";
        let pages = [];
        
        // Let's check for __NEXT_DATA__ (nhentai uses Next.js now usually?) Wait no, they use django but wait, let's see scripts
        const scripts = document.querySelectorAll('script');
        let rawData = null;
        for (let s of scripts) {
            if (s.innerText.includes('JSON.parse("{\\"id\\"')) {
                rawData = s.innerText;
                break;
            }
        }
        
        // try to extract gallery object directly
        if (typeof window._gallery !== 'undefined') {
            media_id = window._gallery.media_id;
            pages = window._gallery.images.pages;
        }

        // if not window._gallery, let's try to grab all thumbnail sources
        const thumbs = Array.from(document.querySelectorAll('.gallerythumb img')).map(img => img.getAttribute('data-src') || img.src);
        
        // extract artist and title
        const titleDOM = document.querySelector('h1.title .pretty');
        const title = titleDOM ? titleDOM.innerText : 'Unknown Title';
        
        const artist = Array.from(document.querySelectorAll('a[href^="/artist/"] .name')).map(el => el.innerText)[0] || 'Unknown Artist';

        return {
            hasGallery: typeof window._gallery !== 'undefined',
            rawDataSnippet: rawData ? rawData.substring(0, 100) : null,
            thumbsLength: thumbs.length,
            firstThumb: thumbs[0],
            title,
            artist
        };
    });
    console.log("DOM Data:", domData);
    
    await browser.close();
}
run();
