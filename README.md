# 🌌 Memory Graph

**Memory Graph** is a futuristic, AI-powered desktop gallery designed to help you rediscover your memories. It goes beyond simple folders, using state-of-the-art machine learning to organize your photos and videos by people, locations, and visual concepts.

![Memory Graph Timeline](docs/images/timeline.png)

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)

---

## ✨ Key Features

### 📅 Semantic Timeline
Explore your memories on a dynamic, zoomable timeline. The app automatically clusters photos into "Events" based on time and visual similarity, creating a cohesive story of your life.

![Semantic Timeline](docs/images/timeline_2.png)

### 👤 Identity Discovery
Advanced face recognition (DETR + CLIP) identifies individuals across your entire library. Group photos by person, name your friends, and find every moment you shared with them.

![Identity Gallery](docs/images/people.png)

### 📍 Global Map Mode
See where your memories were made. Photos with GPS metadata are pinned to an interactive world map, allowing you to re-travel your favorite journeys.

![Map Mode](docs/images/map.png)

### 🔍 Intelligent Search
- **Keyword Search**: Find photos by date, location, or automatically identified tags.
- **Semantic Search**: Search for visual concepts (e.g., "sunset at the beach" or "birthday party") even if those words aren't in the filename.

### 🎨 Futuristic Interface
Experience a premium, glassmorphic UI with:
- **Sidebar-driven navigation** for a focused workspace.
- **Floating Island** controls for a minimalist aesthetic.
- **Micro-animations** and smooth transitions.

---

## 🛠️ Tech Stack

- **Framework**: [Electron](https://www.electronjs.org/) (Desktop)
- **Database**: [SQLite](https://www.sqlite.org/) with `better-sqlite3`
- **AI Engine**: [Transformers.js](https://huggingface.co/docs/transformers.js/)
  - **Detections**: `Xenova/detr-resnet-50`
  - **Embeddings**: `Xenova/clip-vit-base-patch32`
- **Metadata**: `exifr` for high-performance EXIF parsing.
- **Video**: `fluent-ffmpeg` for thumbnailing and metadata extraction.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- [npm](https://www.npmjs.com/)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/memory-desktop.git
   cd memory-desktop
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Rebuild native modules (for SQLite support):
   ```bash
   npm run rebuild
   ```
4. Start the application:
   ```bash
   npm start
   ```

---

## 🛡️ Privacy First
Memory Graph is **offline-first**. All AI processing, face recognition, and indexing happen locally on your machine. Your photos and personal data never leave your device.

## 📜 License
This project is licensed under the ISC License.
