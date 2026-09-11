const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function testGoogleTranslateImage() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    console.log('Navigating to Google Translate...');
    await page.goto('https://translate.google.co.in/?sl=auto&tl=en&op=images');

    // Wait for file input to exist
    await page.waitForSelector('input[type="file"]');
    
    // Create a dummy image for testing
    const testImage = path.join(__dirname, 'test_synth.jpg');
    console.log('Uploading image...', testImage);
    const inputUploadHandle = await page.$('input[type="file"]');
    await inputUploadHandle.uploadFile(testImage);

    console.log('Waiting for translation to finish...');
    // Google Translate replaces the image with a canvas or a translated image element.
    // We can wait for the download button to appear to know it finished.
    try {
        await page.waitForSelector('button[aria-label="Download translation"]', { timeout: 15000 });
        console.log('Translation finished!');
        
        // Find the translated image canvas or img src
        const imageData = await page.evaluate(() => {
            // Google Translate renders the translated image to a canvas inside the result view
            const canvas = document.querySelector('canvas');
            if (canvas) return canvas.toDataURL('image/png');
            
            // Or maybe an img tag with src starting with blob: or data:
            const imgs = Array.from(document.querySelectorAll('img'));
            for (let img of imgs) {
                if (img.src.startsWith('blob:') || img.src.startsWith('data:')) {
                    return img.src; // Can't easily extract blob: from evaluate, but if it's a canvas it works
                }
            }
            return null;
        });

        if (imageData) {
            console.log('Successfully captured translated image data!');
        } else {
            console.log('Could not find canvas or translated image data.');
        }
    } catch (e) {
        console.error('Translation failed or timed out:', e.message);
    }

    await browser.close();
}

testGoogleTranslateImage();
