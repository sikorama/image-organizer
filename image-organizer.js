/**
 *  Image Organizer
 *  Vibe coded by Siko
 *
 *  Basically recursively copies picture files from a source folder to a destination folder,
 *  sorted by year, month, day, eventually with the name of the closest city (using exif gps data),
 *  and optionaly adding keyworkds in exif data and filename, using llava via ollama
 *
 */

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs-extra');
const path = require('path');
// For parsing cities file
const csv = require('csv-parser');
// For LLM
const axios = require('axios');
// For ollama
const instance = axios.create();
instance.defaults.timeout = 50000;
// Watch folder mode
const chokidar = require('chokidar');
// For Exif Metadata
const piexif = require('piexifjs');
// For extracting videos metadata
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfprobePath(ffprobePath);

// Fonction pour extraire les métadonnées d'un fichier vidéo
function extractVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                resolve(metadata);
            }
        });
    });
}

// Analyser les arguments de la ligne de commande
const argv = yargs(hideBin(process.argv))
    .option('useOllama', {
        alias: 'o',
        type: 'boolean',
        description: 'Use Ollama and LLaVA model for image tagging',
        default: false
    })
    .option('ollamaUrl', {
        alias: 'u',
        type: 'string',
        description: 'URL for Ollama service',
        default: 'http://localhost:11434'
    })
    .option('sourceDir', {
        alias: 's',
        type: 'string',
        description: 'Source directory to watch for new files',
        default: './source'
    })
    .option('destDir', {
        alias: 'd',
        type: 'string',
        description: 'Destination directory',
        default: './dest'
    })
    .option('processedDir', {
        alias: 'p',
        type: 'string',
        description: 'Destination directory for processed source files',
        default: null
    })
    .option('watchFolder', {
        alias: 'w',
        type: 'boolean',
        description: 'Start watching source directory',
        default: false
    })
    .option('setGps', {
        alias: 'g',
        type: 'string',
        description: 'Force GPS coordinates to a specific city or GPS data',
        default: null
    })
    .argv;


async function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

function findNearestCity(cities, latitude, longitude) {
    let nearestCity = null;
    let minDistance = Infinity;

    cities.forEach(city => {

        const distance = Math.sqrt(
            Math.pow(latitude - parseFloat(city.lat), 2) +
            Math.pow(longitude - parseFloat(city.lng), 2)
        );

        if (distance < minDistance) {
            minDistance = distance;
            nearestCity = city;
        }
    });

    return nearestCity;
}

function loadExifData(jpeg) {
    // Charger les données EXIF existantes
    let exifData;
    try {
        exifData = piexif.load(jpeg.toString('binary'));
    } catch (e) {
        exifData = { "0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": null };
    }
    return exifData;
}

function exifSavePicture(exifData, jpeg, filename) {
    //console.log('saving', exifData)

    // Convertir les données EXIF en binaire
    const exifBytes = piexif.dump(exifData);

    // Insérer les données EXIF dans l'image
    const newJpeg = piexif.insert(exifBytes, jpeg.toString('binary'));

    // Sauvegarder l'image modifiée
    fs.writeFileSync(filename, new Buffer.from(newJpeg, 'binary'));
}

function exifAddCoordinates(exifData, latitude, longitude) {

    const latDMS = decimalToDMS(Math.abs(latitude));
    const longDMS = decimalToDMS(Math.abs(longitude));

    exifData.GPS[piexif.GPSIFD.GPSLatitude] = latDMS;
    exifData.GPS[piexif.GPSIFD.GPSLatitudeRef] = latitude >= 0 ? 'N' : 'S';
    exifData.GPS[piexif.GPSIFD.GPSLongitude] = longDMS;
    exifData.GPS[piexif.GPSIFD.GPSLongitudeRef] = longitude >= 0 ? 'E' : 'W';

}



function exifAddTags(exifData, tags, caption, comment) {
    if (comment)
        exifData["0th"][piexif.ImageIFD.XPComment] = Array.from(Buffer.from(comment, 'utf-16le'));

    if (caption)
        exifData["0th"][piexif.ImageIFD.XPTitle] = Array.from(Buffer.from(caption, 'utf-16le'));

    let stags = tags;
    if (Array.isArray(tags))
        stags = tags.join(', ');
    exifData["0th"][piexif.ImageIFD.XPKeywords] = Array.from(Buffer.from(stags, 'utf-16le'));

}

async function sendLLMRequest(apiUrl, requestData) {
    try {
        const response = await instance.post(apiUrl, requestData, {
            headers: {
                'Content-Type': 'application/json'
            }
        }).catch(function (error) {
            console.log(error);
        });
        return response.data.response;

    } catch (error) {
        console.error('Error:', error);
        return [];
    }
}

async function llava_analyze_image(imageBuffer) {


    // Lire l'image en tant que buffer

    // Convertir l'image en base64
    const imageBase64 = imageBuffer.toString('base64');
    // URL de l'API Ollama
    const apiUrl = argv.ollamaUrl + '/api/generate';

    // Données de la requête
    const requestData = {
        model: 'llava',
        prompt: 'You are an expert in picture classification and categorization. Provide a list of 6 keywords, only keywords and no comments. keywords will be seperated by commas, on a single line. it will be used as tags to classify pictures in a database',
        images: [imageBase64],
        stream: false
    };

    let tags = await sendLLMRequest(apiUrl, requestData);

    const requestData2 = {
        model: 'llava',
        prompt: 'give a caption title to the picture, providing an accurate description. Only one sentence, 120 characters maximum',
        images: [imageBase64],
        stream: false
    };

    let caption = await sendLLMRequest(apiUrl, requestData2);

    /*const requestData3 = {
        model: 'llava',
        prompt: 'Analyze the image and list all the elements you can see. Describe their attributes such as color, shape, and position. Do not include any subjective opinions or narratives. 600 characters maximum',
        images: [imageBase64],
        stream: false
    };
    //comment
    let comment = await sendLLMRequest(apiUrl, requestData3);
    */

    return { tags, caption };
}

// Fonction pour convertir les degrés décimaux en degrés, minutes, secondes
function decimalToDMS(decimal) {
    const degrees = Math.floor(decimal);
    const minutesDecimal = (decimal - degrees) * 60;
    const minutes = Math.floor(minutesDecimal);
    const seconds = Math.round((minutesDecimal - minutes) * 60 * 100) / 100;

    return [degrees, minutes, seconds];
}


function convertDMSToDD(dms, hemisphere) {
    const degrees = dms[0];
    const minutes = dms[1];
    const seconds = dms[2];

    let dd = degrees + (minutes / 60) + (seconds / 3600);

    // Si l'hémisphère est Sud ou Ouest, la valeur est négative
    if (hemisphere === 'S' || hemisphere === 'W') {
        dd = -dd;
    }

    return dd;
}


function parseExifDateTime(exifDateTime) {
    // Diviser la chaîne de caractères en parties de date et d'heure
    const [datePart, timePart] = exifDateTime.split(' ');
    const [year, month, day] = datePart.split(':').map(Number);
    const [hours, minutes, seconds] = timePart.split(':').map(Number);

    // Créer un objet Date en utilisant les composantes
    return new Date(year, month - 1, day, hours, minutes, seconds);
}

async function processFile(filePath, destDir, cities) {
    try {
        const stat = await fs.stat(filePath);
        let date = new Date(stat.mtime);
        //console.info(stat);

        let location = false;
        let tags = false;
        let caption = false;
        let comment = "";
        let skip = false;

        if (stat.isFile()) {
            const lcfp = filePath.toLowerCase();

            const JpegExtensions = ['.jpg', '.jpeg', '.jfif'];
            const NonJpegExtensions = ['.heic', '.png', '.webp'];
            const videoExtensions = ['.mp4', '.avi', '.mov'];

            let isJpegType = JpegExtensions.some(item => lcfp.endsWith(item));
            let isPicture = isJpegType || NonJpegExtensions.some(item => lcfp.endsWith(item));
            let isVideo = videoExtensions.some(item => lcfp.endsWith(item));

            if (isPicture || isVideo) {

                // Extraire le nom du fichier et son extension
                const parsedPath = path.parse(filePath);

                let process_exif_data = false;
                let process_video_data = false;
                let process_llm = argv.useOllama;

                if (isVideo) {
                    process_llm = false;
                    process_video_data = true;
                    skip = true;
                }

                if (isJpegType == true)
                    process_exif_data = true;

                if (lcfp.endsWith('.webp') || lcfp.endsWith('.heic')) process_llm = false;

                //console.log(process_llm, argv.useOllama, !isVideo, !lcfp.endsWith('.webp'));


                let imageBuffer;
                if (isPicture) imageBuffer = fs.readFileSync(filePath);

                // Extract EXIF metadata
                if (process_exif_data) {

                    try {
                        exd = loadExifData(imageBuffer);
                        //console.info(exd);
                        if (exd) {
                            try {

                                const piexifGPS = exd.GPS;
                                if (piexifGPS) {

                                    if (piexifGPS.hasOwnProperty(piexif.GPSIFD.GPSLatitude)) {
                                        // Extract GPS Data
                                        const gpsLatitudeRef = piexifGPS[piexif.GPSIFD.GPSLatitudeRef];
                                        const gpsLatitude = piexifGPS[piexif.GPSIFD.GPSLatitude].map(coord => coord[0] / coord[1]);
                                        const gpsLongitudeRef = piexifGPS[piexif.GPSIFD.GPSLongitudeRef];
                                        const gpsLongitude = piexifGPS[piexif.GPSIFD.GPSLongitude].map(coord => coord[0] / coord[1]);
                                        const latitude = convertDMSToDD(gpsLatitude, gpsLatitudeRef);
                                        const longitude = convertDMSToDD(gpsLongitude, gpsLongitudeRef);
                                        // Get closest city
                                        const nearestCity = findNearestCity(cities, latitude, longitude);
                                        console.info('[CITY]', latitude, longitude, "=>", nearestCity?.city,nearestCity?.country);
                                        if (nearestCity) {
                                            location = nearestCity.city + '-' + nearestCity.iso2;
                                        }
                                    }
                                }
                            }
                            catch (e) {
                                console.error(filePath, "Error Extracting GPS coordinates", e);
                            }

                            if (exd.Exif) {

                                try {

                                    if (exd.Exif[piexif.ExifIFD.DateTimeDigitized]) {
                                        date = parseExifDateTime(exd.Exif[piexif.ExifIFD.DateTimeDigitized]);
                                        //console.info('exif date digitized ',piexif.ExifIFD.DateTimeDigitized, date);
                                    }

                                    if (exd.Exif[piexif.ExifIFD.DateTimeOriginal]) {
                                        date = parseExifDateTime(exd.Exif[piexif.ExifIFD.DateTimeOriginal]);
                                        //console.info('exif date original ',piexif.ExifIFD.DateTimeOriginal, date);
                                    }
                                }
                                catch (e) {
                                    console.info(filePath, 'Exif Data Error', e);
                                }
                            }
                        }
                    }
                    catch (e) {
                        console.error(filePath, 'Picture  Data Extraction Error', e);
                    }
                }

                // Extract video metadata
                if (process_video_data) {
                    let data = await extractVideoMetadata(filePath);
                    console.info("video data:", data);
                }


                if (process_llm) {
                    const analyze_results = await llava_analyze_image(imageBuffer);
                    tags = analyze_results.tags.toLowerCase().trim().split(',').map(item => item.trim()).sort();
                    caption = analyze_results.caption;
                    //comment = analyze_results.comment;
                    console.info('Tags=', tags);
                    console.info('caption=', caption);
                    //console.info('comment=', comment);
                }

                // Créer le chemin de destination
                const year = String(date.getFullYear());
                const month = String(date.getMonth() + 1).padStart(2, '0');
                let day = String(date.getDate()).padStart(2, '0');
                if (location)
                    day = day + '-' + location;
                //console.info(destDir, year, month, day);
                const destPath = path.join(destDir, year, month, day);

                // Créer le répertoire de destination s'il n'existe pas
                await fs.ensureDir(destPath);

                // Vérifier si le fichier existe déjà dans le répertoire de destination
                let destFilePath;


                if (process_llm && (tags.length > 0)) {
                    // Traiter les tags
                    const processedTags = tags.map(tag => tag.replace(/\s+/g, '_')).join('-');
                    // Construire le nouveau nom de fichier
                    const newFileName = `${parsedPath.name}-${processedTags}${parsedPath.ext}`;
                    destFilePath = path.join(destPath, newFileName);
                }
                else {
                    destFilePath = path.join(destPath, path.basename(filePath));
                }

                if (skip == false) {
                    let counter = 1;
                    while (await fs.pathExists(destFilePath)) {
                        const fileName = path.parse(filePath).name;
                        const fileExt = path.parse(filePath).ext;
                        destFilePath = path.join(destPath, `${fileName}_${counter}${fileExt}`);
                        counter++;
                    }

                    if (process_exif_data && exd && tags.length > 0) {
                        exifAddTags(exd, tags, caption/*, comment*/);
                        //exifAddCoordinates(exd, 0.49,0.02);
                        console.log(`[COPY] ${filePath} to ${destFilePath} with exif update`);
                        exifSavePicture(exd, imageBuffer, destFilePath);
                    }
                    else process_exif_data = false;

                    if (!process_exif_data) {
                        // Copier le fichier vers le répertoire de destination
                        console.log(`[COPY] ${filePath} to ${destFilePath}`);
                        await fs.copy(filePath, destFilePath);
                    }

                    // Deplacer le fichier dans le repertoire 'processed'
                    if (argv.processedDir) {
                        const relfilepath = path.relative(argv.sourceDir, filePath);
                        processedFilePath = path.join(argv.processedDir, relfilepath);
                        console.log(`[MOVE] ${filePath} to ${processedFilePath}`);
                        await fs.move(filePath, processedFilePath, { overwrite: true });

                    }
                }
                else
                console.info("[SKIP]", filePath);

            }
        }
    } catch (error) {
        console.error('Error:', error);
    }
}



async function traverseDirectory(srcDir, destDir, cities) {
    const files = await fs.readdir(srcDir);

    for (const file of files) {
        const filePath = path.join(srcDir, file);
        const stat = await fs.stat(filePath);

        if (stat.isDirectory()) {
            // Si c'est un répertoire, appeler la fonction récursivement
            await traverseDirectory(filePath, destDir, cities);
        } else {
            // Si c'est un fichier, le traiter
            await processFile(filePath, destDir, cities);
        }
    }
}

// Gérer les erreurs non capturées
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

async function main() {
    const citiesfilePath = './worldcities.csv';
    const cities = await parseCSV(citiesfilePath);
    const srcDirectory = argv.sourceDir;
    const destDirectory = argv.destDir;

    await traverseDirectory(srcDirectory, argv.destDir, cities).catch(console.error);

    if (argv.watchFolder == true) {
        // Initialiser le watcher
        const watcher = chokidar.watch(argv.sourceDir, {
            ignored: /(^|[\/\\])\../, // Ignorer les fichiers cachés
            persistent: true,
            ignoreInitial: true // Ignorer les fichiers déjà présents au démarrage
        });

        // Événement pour les nouveaux fichiers ajoutés
        watcher.on('add', async (filePath) => {
            console.log(`New file detected: ${filePath}`);
            //TODO: queue files in async queue
            await processFile(filePath, argv.destDir, cities);

        });

        // Événement pour les erreurs
        watcher.on('error', (error) => {
            console.error('Watcher error:', error);
        });

        // Événement pour les changements dans le répertoire
        watcher.on('ready', () => {
            console.log(`Watching for new files in: ${argv.sourceDir}`);
        });


    }

}

main().catch(console.error);

