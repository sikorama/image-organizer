# image-organizer
This script is a simple tool for automating the management and organization of images, leveraging EXIF metadata and AI capabilities to enrich image information.
It transforms cryptic filenames into descriptive ones and sorts them into structured directories.

## Synopsis

The application scans recursively a **Source Directory** for images. For each file, it:
1. **Analyzes** the content using a Vision Model (like LLaVA) via Ollama.
2. **Generates** a clean, slug-style caption and a set of descriptive tags.
3. **Organizes** the file into a destination folder based on its date or original folder structure.
4. **Writes** metadata back to the file (optional) and handles the source file cleanup.

---

## Configuration Options

### Path Management
* `-s, --sourceDir`: The folder to scan for new images. *(Default: `./source`)*
* `-d, --destDir`: The root folder where organized images will be stored. *(Default: `./dest`)*
* `-p, --processedDir`: If set, original files are moved here after processing instead of staying in the source. *(Default: `null`)* Ignored when `--move` is used, since the original is already relocated to `destDir`.
* `-k, --keepTree`: When enabled, reproduces the source folder hierarchy in the destination instead of sorting by date.
* `-M, --move`: Moves files directly into `destDir` instead of copying them, so the original is not kept in `sourceDir`. *(Default: `false`)*

### AI & Tagging (Ollama)
* `-o, --useOllama`: Enables AI-powered image analysis. Required for auto-captioning and tagging.
* `-m, --ollamaModel`: The specific Vision Model to use. *(Default: `llava:7b`)*
* `-u, --ollamaUrl`: The endpoint of your Ollama service. Useful for remote processing. *(Default: `http://localhost:11434`)*
* `-x, --addExifData`: Writes the generated AI tags and captions directly into the Jpeg EXIF metadata.

### Execution & Workflow
* `-w, --watchFolder`: Persistent mode. Watches the source directory for new files in real-time.
* `-r, --run`: Actually apply changes (move/copy/mkdir). If false, it acts as a **Dry Run**. *(Default: `true`)*
* `-q, --quiet`: Disables console output of the generated shell commands.

---

## Usage Examples

### 1. The "Safety First" Scan (Dry Run)
Check how your files would be renamed and sorted by date without actually moving anything:
```bash
node image-organizer.js -o -r false
```

### 2. Full Automation (Sorting by Date)
Analyze images using Moondream (lighter model), write EXIF data, and move processed originals to a backup folder:
```bash
node image-organizer.js -o -m moondream -x -p ./backups
```

### 3. Archive Migration (Keeping Structure)
Organize a remote drive into a new local drive while preserving the original folder names instead of using dates:
```bash
node image-organizer.js -s /mnt/old_drive -d /home/user/new_drive -k -o
```

### 4. Remote Processing Service
Watch a specific folder and use a powerful GPU server elsewhere on your network to do the heavy lifting:
```bash
node image-organizer.js -w -o -u http://192.168.1.1:11434 -m llava:13b
```

---

## Naming Convention
The app generates filenames following this pattern:
`[original_name]_[ai_caption]__[tag1]_[tag2]_[tag3].jpg`
* All characters are converted to lowercase.
* Accents are removed.
* Spaces are replaced by underscores (`_`).
* Duplicate tags or tags already present in the caption are automatically filtered out.
* original name is kept by default