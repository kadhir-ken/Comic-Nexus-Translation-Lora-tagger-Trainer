# LM Studio Setup & Model Guide for Comic Nexus

This guide walks you through setting up **[LM Studio](https://lmstudio.ai/)** to power 100% offline, free, and private vision AI translation and captioning inside **Comic Nexus**.

---

## 1. Why LM Studio?

- **100% Private & Offline**: Comic images and translated dialogue never leave your local computer.
- **Zero API Costs**: No subscription, no credit card, no rate limits.
- **Automatic On-Demand Management**: Comic Nexus automatically launches the LM Studio engine via the command line when you request a translation, and lets you unload it with one click to free up all GPU VRAM.

---

## 2. Step 1: Install LM Studio

1. Visit **[https://lmstudio.ai/](https://lmstudio.ai/)**.
2. Download the installer for your operating system (**Windows**, **macOS**, or **Linux**).
3. Run the installer and launch LM Studio.

---

## 3. Step 2: Install the `lms` Command-Line Tool

Comic Nexus uses the `lms` CLI utility to start the server and load/unload models on demand.

1. Open **Command Prompt** or **PowerShell**.
2. Run:
   ```powershell
   lms bootstrap
   ```
   *(If prompted, allow it to add `lms` to your user PATH).*
3. Verify the installation by typing:
   ```powershell
   lms --version
   ```
   If a version number appears (e.g. `0.3.x`), the CLI tool is ready.

---

## 4. Step 3: Download Vision AI Models

Comic translation requires a **Vision-Language Model (VLM)** capable of reading text directly from image crops and speech bubbles.

### Configured Default Model
In `comic-viewer/.env`, the default model identifier is set to:
```
LM_STUDIO_MODEL=qwen3.5-2b-claude-4.6-os-auto-variable-heretic-uncensored-thinking
```

### Recommended Vision Models Available in LM Studio

Open the **Search tab** (magnifying glass icon on the left sidebar of LM Studio) and search for any of the following:

| Model Name | Size / VRAM Required | Strengths | Search Query in LM Studio |
| :--- | :--- | :--- | :--- |
| **Qwen 2.5 VL 7B Instruct** *(Recommended)* | ~5 - 8 GB VRAM | Best translation accuracy, outstanding OCR for Japanese/Korean/Chinese characters. | `qwen2.5-vl-7b-instruct` |
| **Qwen 2.5 VL 3B Instruct** | ~2.5 - 4 GB VRAM | Extremely fast, lightweight, runs smoothly even on lower-tier GPUs or integrated graphics. | `qwen2.5-vl-3b-instruct` |
| **Qwen2 VL 7B Instruct** | ~5 - 8 GB VRAM | Excellent multilingual capability with high bubble detection reliability. | `qwen2-vl-7b-instruct` |
| **Llama 3.2 11B Vision Instruct** | ~8 - 12 GB VRAM | High reasoning ability for English localization and complex grammar. | `llama-3.2-11b-vision` |

> [!TIP]
> When choosing a download file, choose the **`Q4_K_M`** or **`Q5_K_M`** quantization (GGUF format) for the optimal balance between visual quality, speed, and VRAM usage.

---

## 5. Step 4: Configure Your Model Name in Comic Nexus

Once your chosen model finishes downloading in LM Studio:

1. List your downloaded models by running:
   ```powershell
   lms ls
   ```
   This will print the exact identifier string of the downloaded model.

2. Open **`comic-viewer/.env`** in any text editor.
3. Set `LM_STUDIO_MODEL` to match your downloaded model's identifier:
   ```env
   LM_STUDIO_MODEL=your-model-identifier-here
   ```
   *(Example: `LM_STUDIO_MODEL=qwen2.5-vl-7b-instruct`)*

---

## 6. Step 5: GPU Acceleration & Performance Settings

Inside LM Studio, navigate to the **Settings** tab for models:
- **GPU Offload**: Set to **MAX** (100% of layers offloaded to GPU) for near-instant speech bubble translation.
- **Context Length**: Set between **4096** and **8192** tokens.
- **Flash Attention**: Enable if supported by your GPU (NVIDIA RTX series).

---

## 7. How Comic Nexus Controls LM Studio

You don't need to manually start the server before reading comics:

- **Automatic Start**: When you click **Translate** on any comic page in the reader, Comic Nexus automatically starts `lms server start --cors` on port `1234` and loads the model.
- **RAM / VRAM Monitor**: In the top navigation bar of `index.html` and `reader.html`, you will see live memory stats showing LM Studio's RAM consumption.
- **1-Click Free VRAM**: When you are finished reading or want to switch to gaming or LoRA training, click the **Stop AI** button in the navigation bar. The server unloads the model immediately and frees all GPU VRAM.

---

## Troubleshooting

### 1. `lms: The term 'lms' is not recognized`
- Ensure you ran `lms bootstrap`.
- Restart your terminal or VS Code window so the updated Windows `PATH` environment variable takes effect.
- Default path on Windows: `%USERPROFILE%\.cache\lm-studio\bin` or `%LOCALAPPDATA%\Programs\LM Studio\resources\app\bin`.

### 2. Port 1234 is already in use
- If another application is running on port 1234, stop it or restart LM Studio from the taskbar.

### 3. Out of Memory (CUDA OOM)
- If your GPU runs out of VRAM, switch to a smaller quantization (e.g. `Q4_K_M` or `Q3_K_M`), or download the `Qwen 2.5 VL 3B` model.
- You can also reduce GPU layers in LM Studio so that excess layers spill safely into system RAM.
