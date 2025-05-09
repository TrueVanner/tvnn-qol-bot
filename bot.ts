import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import * as dotenv from "dotenv";
import process from "node:process";
import {
    ArgsOptions,
    VideoInfo,
    VideoProgress,
    YtDlp,
    YtDlpOptions,
} from "ytdlp-nodejs";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { platform } from "node:process";

let ytdlpOptions: YtDlpOptions = {};

// Determine paths based on OS
if (platform === "win32") {
    ytdlpOptions = {
        binaryPath: "./bin/yt-dlp.exe",
        ffmpegPath: "./bin/ffmpeg.exe",
    };
    console.log("Detected Windows environment.");
} else {
    ytdlpOptions = {
        binaryPath: "/usr/bin/yt-dlp",
        ffmpegPath: "/usr/bin/ffmpeg",
    };
    console.log(`Detected ${platform} environment (using Linux paths).`);
}

const ytdlp = new YtDlp(ytdlpOptions);

dotenv.config();
const bot = new Bot(process.env.TOKEN!, {
    client: {
        apiRoot: process.env.API_ROOT!,
    },
});
bot.api.setMyCommands([
    {
        command: "format",
        description: "Formats a YouTube link with video details",
    },
]);

/**
 * Is not a sufficiently good check
 * @param url
 * @returns
 */
function isYoutubeURL(url: string) {
    // Regular expression to match YouTube video URLs
    const youtubeRegex = /(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/;
    return youtubeRegex.test(url);
}

/**
 * Appends cookies and extractor-args info to the provided argument list to avoid redundancy.
 */
function ytdlpArgs(args: ArgsOptions): ArgsOptions {
    return {
        extractorArgs: {
            "youtube": [`getpot_bgutil_baseurl=${process.env.BGUTIL_ROOT!}`],
        },
        cookies: "cookies.txt",
        ...args,
    };
}

/**
 * Universal arguments used to retrieve file information about the video.
 */
const infoArgs = ytdlpArgs({
    quiet: true,
    dumpJson: true,
});

/**
 * Takes duration in seconds, returns a string in the format Hh Mm Ss
 * @param totalSeconds
 * @returns
 */
function getDurationString(totalSeconds: number) {
    const seconds = totalSeconds % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
}

/**
 * Returns a formattred extract from VideoInfo that contains details about
 * the title, uploader and duration.
 */
function generateDescription(info: VideoInfo) {
    // tags ended up being useless, so I am moving away from them
    // const tags = info.tags.slice(0,3).join(", ").slice(0,-2) + (info.tags.length > 3 ? ", ..." : "")

    return `<b>[${getDurationString(info.duration)}]</b> ${info.title}\nBy <b>${info.uploader}</b>`;
}

/**
 * For a given prefix (name), generates a set of logging commands.
 * Helps create simple yet customisable logging.
 */
function getLogSuite(name: string) {
    return {
        // logs the messages using console.debug
        log: (...msg: any) => console.debug(`[${name}]`, msg.join(" ")),
        // logs the messages using console.error
        error: (...msg: any) => console.error(`[${name}]`, msg.join(" ")),
        // edits a specific message reserved for storing bot updates.
        // not always necessary.
    };
}

/**
 * Outputs a function that can be used to update a dedicated
 * bot message with new info. Serves as a way to indicate progress
 * to the user.
 */
function getInform(ctx: Context, msg_id: number) {
    return async (
        msg: string,
        other?: Parameters<typeof ctx.api.editMessageText>[3],
    ) => ctx.api.editMessageText(ctx.chatId!, msg_id, msg, {
        parse_mode: "HTML",
        ...other,
    });
}

/**
 * A list of error messages for specific situations to be sent to the user when the
 * error occurs. Intended to be reused for similar error scenarions.
 */
const errorMessages = {
    atGettingInfo:
        `Failed to obtain info from a YouTube video. Try again, and if not some coding fuckup, the error is either:\n
        1. Network connection issue, try again soon\n
        2. An issue with how YouTube processes YT-DLP requests - try again, and if the error repeats means I have to add some workarounds.`,
    atDownload:
        `Encountered an error when downloading the file, try again; if it repeats, it's most likely either one of these:\n
        1. <b>You tried to download a large file which either takes 500 seconds to properly upload or weights more than 2GB.</b> 
        Both are internal limitations that I can't change, so reduce the filesize or use /format to simply format the YouTube link
        and send it this way.\n
        2. <b>A code issue on my size.</b>\n
        3. <b>A deeper issue with YT-DLP.</b> This is the library I use for downloading the video, and I have no control over it.
        If it fails consistently, it most likely indicates a change in how YouTube processes YT-DLP requests and possibly mean 
        that the bot can no longer function.`,
    badURL:
        `The URL you inputted is invalid. The bot only accepts valid YouTube links.`,
};
/**
 * Returns the text of the error for the given category and the error log.
 */
const fullErrorMessage = (errorCategory: keyof typeof errorMessages, e: any) =>
    errorMessages[errorCategory] + `\nError log: ${e}`;

bot.on("callback_query:data", (ctx) => {
    const inline_msg_id = ctx.callbackQuery.message?.message_id!;
    const chat_id = ctx.chatId!;
    const [video_id, format, duration, height, width] = ctx.callbackQuery.data
        .split("|");

    // some video IDs start with a -, which makes yt-dlp treat it as an argument and
    // instantly fail. So, I am wrapping the ID in a basic link.
    const url = `https://youtube.com/watch?v=${video_id}`
    // dedicated input when audio is sent; values can't be null|undefined by default
    const isAudio = !height && !width;

    const { log, error } = getLogSuite("Callback query");
    const inform = getInform(ctx, inline_msg_id);

    function updateDownloadMessage(
        n_calls: number,
        update_data: VideoProgress,
    ) {
        console.log(update_data);
        inform("Downloading" + ".".repeat(n_calls % 3 + 1));
    }

    // when downloading, video|audio will be temporarily stored here and then deleted.
    // ytdlp.getFileAsync, which would normally provide a file in intermediate form, doesn't work with merged
    // files (aka bv+ba) for some reason and consistently produces a corrupted file. This workaround resolves
    // the issue
    const storedFileName = `${video_id}.${isAudio ? "m4a" : "mp4"}`;
    const storedFilePath = path.join(process.cwd(), storedFileName);

    // assume thumbnail will be downloaded here (later). for some reason, when downloading audio
    // thumbnail files are moved to be instead stored like "test.m4a.jpg", so I account for that
    const thumbFilePath = isAudio
        ? `${storedFilePath}.jpg`
        : path.join(process.cwd(), `${video_id}.jpg`);

    // assume video description is stored in this location, otherwise just display error and still send the file
    // (we can't pass generated description here directly due to callback query data limit of 64 bytes)
    const descrFilePath = path.join(process.cwd(), `${video_id}-descr.txt`);

    log(`Started downloading video for ${video_id}`);
    
    // common set of args
    let downloadArgs: ArgsOptions = ytdlpArgs({
        format: format,
        output: storedFilePath,
        writeThumbnail: true,
        convertThumbnails: "jpg",
    });
    
    if (isAudio) {
        downloadArgs = {
            ...downloadArgs,
            extractAudio: true,
            audioFormat: "m4a",
        };
    } else {
        let n_calls = 0;
        // onProgress doesn't seem to work, but I added it here anyway
        downloadArgs = {
            ...downloadArgs,
            mergeOutputFormat: "mp4",
            onProgress: (p: VideoProgress) => {
                console.log("got here"); // for some reason, this never happens
                try {
                    // in case updating too much causes an error, I prevent
                    // the entire bot from going up in flames
                    updateDownloadMessage(++n_calls, p);
                } catch (e) {
                    error(e);
                }
            },
        } as ArgsOptions & { onProgress: (p: VideoProgress) => void };
    }
    
    inform("Downloading...");
    // some videoIDs = 
    ytdlp.execAsync(url, downloadArgs) // sanitizing input because it's apparently needed
        .then(async (logs) => {
            log(logs);
            log(
                `Successfully donwloaded ${video_id} into temporary file ${storedFilePath}`,
            );
            inform("Download complete, uploading...");
            log(`Sending file: ${storedFileName}`);

            let videoDescr = "";
            let hasDescription = false;
            try {
                videoDescr = readFileSync(descrFilePath).toString();
                hasDescription = true;
                log(`Read video description from ${descrFilePath}`);
            } catch (readErr) {
                error(
                    `Could not read description file for ${video_id}, continuing regardless.\n`,
                    readErr,
                );
            }
            if (!isAudio) {
                /*
				const thumbnailArgs: ArgsOptions = ytdlpArgs({
					listThumbnails: true,
					quiet: true
				})

				// depends a lot on the semantics of yt-dlp output
				const thumb = await ytdlp.execAsync(video_id, thumbnailArgs).then(async out => {

					const links = out.split("\n").filter(line => {
						// split at spaces, including consequtive spaces (accounting for output format)
						const split = line.split(RegExp(" +"))
						// only keep the lines that contain links to high quality formats
						const quality
						return split.length === 4
							&& !isNaN(Number(split[0]))
							&& split[4].startsWith('http')
							&& split[4].includes('hq')
					}).map(line => line.split(" ")[4]) // keep only the link

					let result = links.find(link => link.includes("hq1"))
					if(!result) result = links.find(link => link.includes("default"))
					if()
					for(const link of links) {
						if(link.includes("hq1"))
					}
				}).catch(err => {
					error("Thumbnails were not found or properly processed")
					return null;
				})
				*/

                await ctx.replyWithVideo(new InputFile(storedFilePath), {
                    cover: new InputFile(thumbFilePath),
                    height: parseInt(height),
                    width: parseInt(width),
                    duration: parseInt(duration),
                    caption: videoDescr,
                    parse_mode: "HTML",
                });
            } else {
                let title = `[${video_id}]`;
                let author = "";
                if (hasDescription) {
                    const descrLines = videoDescr.split("\n");
                    title = descrLines[0].split(" [")[0];
                    author = descrLines[1].match(/<b>(.*?)<\/b>/)?.[1] ||
                        "Unknown Artist";
                }

                await ctx.replyWithAudio(new InputFile(storedFilePath), {
                    title: title,
                    performer: author,
                    duration: parseInt(duration),
                    thumbnail: new InputFile(thumbFilePath),
                });
            }

            log(`File sent, deleting ${storedFileName}`);

            try {
                unlinkSync(storedFilePath);
                log(`Temporary file ${storedFilePath} deleted successfully.`);
                unlinkSync(thumbFilePath);
                log(`Temporary file ${thumbFilePath} deleted successfully.`);
                unlinkSync(descrFilePath);
                log(`Temporary file ${descrFilePath} deleted successfully.`);
            } catch (cleanupErr) {
                error(
                    `Error deleting temporary file ${storedFilePath}. Continuing regardless.`,
                    cleanupErr,
                );
            }

            // delete info message after uploading
            await ctx.api.deleteMessage(chat_id, inline_msg_id);
        }).catch((e) => {
            error(e);
            inform(fullErrorMessage("atDownload", e));

            // Attempt to clean up the temporary file even if download failed
            try {
                // since the paths are created sequentially, doing them in order is fine
                unlinkSync(storedFilePath);
                unlinkSync(thumbFilePath);
                unlinkSync(descrFilePath);
            } catch (_) {
                // Ignore error if file doesn't exist
            }
        });
});

bot.on("message::url", async (ctx) => {
    const { log, error } = getLogSuite("URL handler");
    const url = ctx.message!.text!; // we know that this block can only trigger if url is present in the message

    if (!isYoutubeURL(url)) {
        ctx.reply(
            "I can only process YouTube links. Send any YouTube link to receive an auto-formatted response, or request a specific result using commands.",
        );
        log("Rejected: Not a YouTube link");
        return;
    }

    const bot_msg_id = await ctx.reply("Gathering video info...").then(
        (msg) => {
            return msg.message_id;
        },
    );

    const inform = getInform(ctx, bot_msg_id);

    ytdlp.execAsync(url, infoArgs).then((out) => {
        const info = JSON.parse(out) as VideoInfo;
        const video_id = info.id;

        // the goal is to approximate the total filesize of the video
        // using disjoint best formats; find all videoformats, sort by
        // filesize in reverse (largest first)
        const videoformats = info.formats.filter((f) =>
            (f.vcodec != "none") && (f.filesize) && (f.height)
        ).sort((a, b) => a.filesize! - b.filesize!);

        // find all audioformats, also sort by filesize
        const largest_audio = info.formats.filter((f) =>
            (f.acodec != "none") && (f.filesize)
        ).sort((a, b) => b.filesize! - a.filesize!)[0];

        // list of all possible formats, assuming no 8K+
        const formats = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '4K']

        // for each quality ID (from formats) stores the format ID,
        // filesize, true height and true width of the video in the format
        const existingFormats: Record<
            typeof formats[number],
            [string, number, number, number]
        > = {};

        videoformats.forEach((format) => {
            // files are sorted by size so smaller files take precedence
            // over larger ones
            const h = format.height!;
            const w = format.width!;
            const fID = format.format_id;
            const filesize = format.filesize!;
            
            let qID = "144p";
            if (h < 360) qID = "240p";
            else if (h < 480) qID = "360p";
            else if (h < 720) qID = "480p";
            else if (h < 1080) qID = "720p";
            else if (h < 1440) qID = "1080p";
            else if (h < 2160) qID = "1440p";
            else if (h < 4320) qID = "4K"; // assuming no 8K+ videos

            existingFormats[qID] = [fID, filesize, h, w];
        });

        const videoDescr = generateDescription(info) + `\n${url}`;
        try {
            writeFileSync(`${video_id}-descr.txt`, videoDescr);
            log(`Successfully wrote description for ${video_id} to file.`);
        } catch (writeErr) {
            error(
                `Could not write description file for ${video_id}:`,
                writeErr,
            );
        }

        const downloadMenuMarkup = new InlineKeyboard();
        const formatSize = (bytes: number): string => {
            const kb = bytes / 1024;
            const sizes = ["KB", "MB", "GB"];
            const i = Math.floor(Math.log(kb) / Math.log(1024));
            const formattedSize = parseFloat(
                (kb / Math.pow(1024, i)).toFixed(1),
            );
            return `${formattedSize}${sizes[i]}`;
        };

        downloadMenuMarkup.text(
            `Music (≈${formatSize(largest_audio.filesize!)})`,
            `${info.id}|ba|${info.duration}||`,
        );

        Object.entries(existingFormats)
            .sort(([res1], [res2]) => formats.indexOf(res1) - formats.indexOf(res2))
            .forEach(([res, [id, size, h, w]]) => {
                downloadMenuMarkup.row();
                downloadMenuMarkup.text(
                    `${res} (≤${formatSize(size + largest_audio.filesize!)})`,
                    `${video_id}|${id}+ba|${info.duration}|${h}|${w}`,
                );
        });

        inform("Select one option:", {
            reply_markup: downloadMenuMarkup,
        });
    }).catch((e) => {
        error(e);
        if (`${e}`.includes("not a valid URL")) {
            inform(fullErrorMessage("badURL", e));
        } else {
            inform(fullErrorMessage("atGettingInfo", e));
        }
    });
});

/**
 * Handles /format command.
 */
bot.command("format", async (ctx) => {
    const { log, error } = getLogSuite("/format handler");

    if (ctx.message) {
        const url = ctx.msg.text.split("/format ")[1];

        log(`Checking: ${url}`);
        if (!isYoutubeURL(url)) {
            ctx.reply(
                "This command only accepts YouTube links, and appends video descriptions to them.",
            );
            return;
        }

        log("Started getting info");
        const bot_msg_id = await ctx.reply("Gathering video info...").then(
            (msg) => {
                return msg.message_id;
            },
        );

        const inform = getInform(ctx, bot_msg_id);

        ytdlp.execAsync(url, infoArgs).then((out) => {
            const description = generateDescription(JSON.parse(out));
            inform(`${description}\n${url}`);
        }).catch((e) => {
            error(e);
            if (`${e}`.includes("not a valid URL")) {
                inform(fullErrorMessage("badURL", e));
            } else {
                inform(fullErrorMessage("atGettingInfo", e));
            }
        });
    }
});

/**
 * Default message handler. Can only be triggerred if a non-link message is sent.
 */
bot.on("message", (ctx) => {
    const { log } = getLogSuite("Default message handler");
    // only explain purpose if in private chat
    if (ctx.chat.type == "private") {
        ctx.reply(
            "I can only process YouTube links. Send any YouTube link to receive an auto-formatted response, or request a specific result using commands.",
        );
    }
    log("No processing done: not a YouTube link");
});

console.debug("[Bot] Starting!");
bot.start();
