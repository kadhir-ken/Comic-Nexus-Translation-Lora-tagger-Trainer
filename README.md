# Comic Nexus — AI Comic Reader, Auto-Translator & LoRA Dataset Studio

An all-in-one suite designed for reading comics and manga, running on-demand AI speech bubble translation, and preparing high-quality labeled datasets for AI LoRA training (Stable Diffusion / Flux).

---

## Key Highlights

- **AI-Powered Comic Reader**: Smooth infinite-scroll vertical webtoon reader with keyboard shortcuts, page jumping, and bookmarking.
- **On-Demand Speech Bubble Translation**: Translate Japanese, Korean, Chinese, and other languages directly inside comic speech bubbles into English or Tamil using local vision AI or cloud models.
- **LoRA Dataset Studio & Tagger (`trainer.html`)**: Built-in dataset preparation environment with Hugging Face WD14 Danbooru tagging, Qwen vision captioning, batch tag editing, tag frequency graphs, and search-and-replace.
- **Desktop Electron App (`nexus window app`)**: Optional native desktop launcher with real-time server logging and one-click controls.
- **Zero VRAM Waste**: LM Studio integration boots headless on-demand only when translating, and can be stopped with a single click to instantly free up GPU VRAM.

---

## Project Structure

```
├── comic-viewer/                  # Web server & comic reader web application
│   ├── server.js                  # Express backend (port 3001), AI pipelines, image server
│   ├── reader.html                # Vertical reading interface & AI bubble overlay
│   ├── index.html                 # Comic library catalog, cover viewer, RAM monitor
│   ├── downloader.html            # Gallery downloader utility
│   ├── package.json               # Node.js dependencies (express, sharp, cors, dotenv)
│   └── .env.example               # Template environment configuration
├── nexus window app/              # Electron desktop application
│   ├── main.js                    # Electron main process & server supervisor
│   ├── index.html                 # Desktop launcher UI & live log console
│   └── package.json               # Electron dependencies
├── trainer.html                   # LoRA Dataset preparation, WD14 tagging & captioning UI
├── comicapp.bat                   # 1-Click launcher for backend server & web UI
├── Start_Nexus_App.bat            # 1-Click launcher for Electron desktop app
├── LM_STUDIO_GUIDE.md             # Complete setup guide for offline local AI models
└── README.md                      # Project documentation
```

---

## Prerequisites

1. **Node.js**: Version 18.x or higher installed ([Download Node.js](https://nodejs.org/)).
2. **Local AI (Recommended)**: [LM Studio](https://lmstudio.ai/) for completely free, private, offline translation.
   - See [LM_STUDIO_GUIDE.md](LM_STUDIO_GUIDE.md) for step-by-step installation and model selection.
3. **Cloud AI (Optional)**: If you prefer cloud APIs, you can provide an OpenRouter or Gemini API key.

---

## Quick Start Guide

### 1. Installation

Clone this repository and install dependencies in the required modules:

```bash
git clone https://github.com/kadhir-ken/Comic-Nexus-Translation-Lora-tagger-Trainer.git
cd Comic-Nexus-Translation-Lora-tagger-Trainer

# Install backend dependencies
cd comic-viewer
npm install

# Install desktop app dependencies (optional)
cd "../nexus window app"
npm install
cd ..
```

### 2. Environment Configuration

In `comic-viewer/`, copy `.env.example` to `.env`:

```bash
copy comic-viewer\.env.example comic-viewer\.env
```

Edit `comic-viewer/.env` to configure your preferences:
```env
# Optional cloud fallback keys
OPENROUTER_API_KEY=your_openrouter_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here

# Local LM Studio Model Identifier (see LM_STUDIO_GUIDE.md)
LM_STUDIO_MODEL=qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking

# Server port (default: 3001)
PORT=3001

# Optional: Path to your comic library folder (defaults to ./comic-website)
COMIC_BASE_PATH=
```

### 3. Launch the Application

You can launch using the included batch scripts or through the command line:

- **Option A (Web Server & Browser)**:
  Double-click `comicapp.bat` or run:
  ```bash
  node comic-viewer/server.js
  ```
  Then open [http://localhost:3001](http://localhost:3001) in your web browser.

- **Option B (Desktop App)**:
  Double-click `Start_Nexus_App.bat` or run:
  ```bash
  cd "nexus window app"
  npm start
  ```

---

## How to Use

### 1. Reading Comics & AI Translation
1. Place your comic folders containing images (`.jpg`, `.png`, `.webp`) inside `comic-website/` or point `COMIC_BASE_PATH` in `.env` to your folder.
2. Open `http://localhost:3001` and select any comic to enter the reader.
3. In the reader:
   - Click **Translate (English)** or **Translate (Tamil)** below any page.
   - The server boots the local vision AI (or cloud API), crops and detects speech bubbles, and renders translated text overlays directly over original speech bubbles.
   - You can toggle or clear translations at any time.

### 2. LoRA Dataset Studio (`trainer.html`)
Open `http://localhost:3001/trainer.html` to access the training studio:
1. **Browse & Load Folder**: Select any image dataset folder on your system.
2. **Auto-Tag with WD14**: Run automated Danbooru tagging using the HuggingFace WD14 engine.
3. **Vision Captioning**: Generate natural language captions using Qwen vision models.
4. **Tag Management**: Inspect tag frequencies, filter out unwanted tags (e.g. watermark, bad anatomy), and bulk search-and-replace tags across all `.txt` caption files.
5. **Ready for Training**: Saved caption files (`.txt` alongside each image) are immediately compatible with Kohya-ss, EveryDream, or Flux LoRA trainers.

---

## AI Models & LM Studio Integration

For full offline, uncensored translation, Comic Nexus communicates directly with **LM Studio** via port `1234`.

- The default model identifier is:
  `qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking`
- Compatible with any Qwen 2.5 Vision, Qwen 2 VL, or LLaVA model loaded in LM Studio.

For full installation steps, `lms` CLI setup, and recommended model downloads, read the [LM Studio Setup Guide](LM_STUDIO_GUIDE.md).

---

## License & Disclaimer

This software is for personal, educational, and workflow automation purposes. Ensure you have the rights to any media you translate or process.
