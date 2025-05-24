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

// ----------------- CONFIGURATION START -----------------
// Configure the bot to use the YtDlp library

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

// -------------------- CONFIGURATION END --------------------
// ------------------- LOGGING UTILS START -------------------
// Utility functions for logging and error handling

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
 * For a given prefix (name), generates a set of logging commands.
 * Helps create simple yet customisable logging.
 */
function getLogFunctions(process: string, subprocess?: string) {
    return {
        // logs the messages using console.debug
        log: (...msg: any) => console.debug(`[${process}${subprocess ? `|${subprocess}` : ""}]`, msg.join(" ")),
        // logs the messages using console.error
        error: (...msg: any) => console.error(`[${process}${subprocess ? `|${subprocess}` : ""}]`, msg.join(" ")),
        // edits a specific message reserved for storing bot updates.
        // not always necessary.
    };
}

/**
 * Returns a function that edits a message with the given msg_id in the current chat.
 * Used to update the message with the bot's progress.
 * @param ctx
 * @param msg_id
 */
function getInform(ctx: Context, msg_id: number) {
    return (
            msg: string,
            other?: Parameters<typeof ctx.api.editMessageText>[3],
        ) => { 
            ctx.api.editMessageText(ctx.chatId!, msg_id, msg, {
                parse_mode: "HTML",
                ...other,
            }).catch(e => {
                console.error(`Encountered an error when trying to edit message ${msg_id} in chat ${ctx.chatId}, continuing regardless:`, e);
            })
        }
}
type LogSuite = ReturnType<typeof getLogFunctions>

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

// ------------------- LOGGING UTILS END ----------------------
// -------------------- BOT UTILS START -----------------------
// Utility functions for bot operations

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

// -------------------- BOT UTILS END -------------------------
// -------------- CALLBACK QUERY HANDLER START ----------------
// Handles callback queries from inline keyboard buttons

class CallbackQueryHandler {
    private ctx: Context;
    private inline_msg_id: number;
    private chat_id: number;
    
    private video_id: string; // for better logging
    private url: string; // to be used for downloading
    private format: string;
    private duration: string;
    private height: string;
    private width: string;
    private isAudio: boolean;

    // these are used to store the paths to the files that are downloaded
    private storedFileName: string; // primarily for logging
    private storedFilePath: string;
    private thumbFilePath: string;
    private descrFilePath: string;

    // returns a set of logging functions for any methods of this handler.
    private logSuite: (subprocess?: string) => LogSuite;
    private inform: ReturnType<typeof getInform>;

    constructor(
        ctx: Context,
    ) {
        this.ctx = ctx;
        this.inline_msg_id = ctx.callbackQuery!.message?.message_id!;
        this.chat_id = ctx.chatId!;
        const [video_id, format, duration, height, width] = ctx.callbackQuery!.data!
            .split("|");

        this.video_id = video_id;
        // some video IDs start with a -, which makes yt-dlp treat it as an argument and
        // instantly fail. So, I am wrapping the ID in a basic link
        this.url = `https://youtube.com/watch?v=${video_id}`
        this.format = format;
        this.duration = duration;
        this.height = height;
        this.width = width;
        this.isAudio = !this.height && !this.width;
        
        this.inform = getInform(ctx, this.inline_msg_id);
        this.logSuite = (subprocess?: string) => getLogFunctions("CallbackQueryHandler", subprocess);

        // when downloading, video|audio will be temporarily stored here and then deleted.
        // ytdlp.getFileAsync, which would normally provide a file in intermediate form, doesn't work with merged
        // files (aka bv+ba) for some reason and consistently produces a corrupted file. This workaround resolves
        // the issue
        this.storedFileName = `${video_id}.${this.isAudio ? "m4a" : "mp4"}`;
        this.storedFilePath = path.join(process.cwd(), this.storedFileName);

        // assume thumbnail will be downloaded here (later). for some reason, when downloading audio
        // thumbnail files are moved to be instead stored like "test.m4a.jpg", so I account for that
        this.thumbFilePath = this.isAudio
            ? `${this.storedFilePath}.jpg`
            : path.join(process.cwd(), `${video_id}.jpg`);

        // assume video description is stored in this location, otherwise just display error and still send the file
        // (we can't pass generated description here directly due to callback query data limit of 64 bytes)
        this.descrFilePath = path.join(process.cwd(), `${video_id}-descr.txt`);
    }

    /**
     * Handles the download of a video or audio from a given URL using ytdlp.
     * @param args arguments for the download, including format, URL and whether it is audio
     * @param error part of log suite, used to log errors
     * @param inform part of log suite, used to inform the user about the download progress
     * @returns 
     */
    downloadFromLink() {
        const { format, url, isAudio, storedFilePath } = this;
        const inform = this.inform;

        /**
         * Updates the download message with the current progress.
         * @param n_calls number of calls to this function, used to determine the number of dots
         * @param update_data data about the current download progress
         */
        function updateDownloadMessage(
            n_calls: number,
            update_data: VideoProgress,
        ) {
            console.log(update_data);
            inform("Downloading" + ".".repeat(n_calls % 3 + 1));
        }

        /**
         * Returns the arguments for the ytdlp.execAsync function.
         * Uses a base of downloadArgs, which is then modified
         * based on whether the download is for audio or video.
         */
        function getDownloadArgs() {
            // common set of args
            const downloadArgs: ArgsOptions = ytdlpArgs({
                format: format,
                output: storedFilePath,
                writeThumbnail: true,
                convertThumbnails: "jpg",
            });
            
            if (isAudio) {
                return {
                    ...downloadArgs,
                    extractAudio: true,
                    audioFormat: "m4a",
                };
            } else {
                // TODO: check if onData function works
                return {
                    ...downloadArgs,
                    mergeOutputFormat: "mp4"
                } as ArgsOptions;
            }
        }
        
        inform("Downloading...");
        return ytdlp.execAsync(url, getDownloadArgs())
    }
    
    /**
     * Sends the downloaded file to the user.
     * Processses the description file, thumbnail and video file.
     * Appends any metadata to the video file, such as duration, height and width.
     * If the file is audio, it sends it as an audio file with title and author.
     */
    send() {
        // primary variables  
        const { ctx, isAudio, duration, height, width } = this;
        // file paths
        const { storedFilePath, thumbFilePath, descrFilePath } = this;
        // only for logging
        const { video_id, storedFileName } = this;
        const { log, error } = this.logSuite("send");
        const inform = this.inform;

        log(`Successfully donwloaded ${video_id} into temporary file ${storedFilePath}`);
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
            return ctx.replyWithVideo(new InputFile(storedFilePath), {
                cover: new InputFile(thumbFilePath),
                height: parseInt(height),
                width: parseInt(width),
                duration: parseInt(duration),
                caption: videoDescr,
                parse_mode: "HTML",
            });
        } else {
            let title = "";
            let author = "";
            if (hasDescription) {
                const descrLines = videoDescr.split("\n");

                // Expected format for descrLines[0]: "<b>[timestamp]</b> Title Text"
                // Regex captures "Title Text"
                const titleMatch = descrLines[0].match(/^<b>\[.*?\]<\/b>\s*(.*)/);
                title = titleMatch?.[1] || video_id;

                // Expected format for descrLines[1]: "By <b>Author Name</b>"
                // Regex captures "Author Name"
                const authorMatch = descrLines[1].match(/^By <b>(.*?)<\/b>/);
                author = authorMatch?.[1]?.replace(" - Topic", "") || "Unknown Artist";
            }

            return ctx.replyWithAudio(new InputFile(storedFilePath), {
                title: title,
                performer: author,
                duration: parseInt(duration),
                thumbnail: new InputFile(thumbFilePath),
            });
        }
    }

    /**
     * Removes temporary files after download and upload processes are complete. 
     */
    cleanUpFiles() {
        const { storedFilePath, thumbFilePath, descrFilePath } = this;
        const { error, log } = this.logSuite("cleanUpFiles");

        log(`Starting cleanup of temporary files...`);

        try {
            unlinkSync(storedFilePath);
            log(`Temporary file ${storedFilePath} deleted successfully.`);
            unlinkSync(thumbFilePath);
            log(`Temporary file ${thumbFilePath} deleted successfully.`);
            unlinkSync(descrFilePath);
            log(`Temporary file ${descrFilePath} deleted successfully.`);
        } catch (cleanupErr) {
            error(
                `Error deleting temporary files. Continuing regardless.`,
                cleanupErr,
            );
        }
        log(`Cleanup complete.`);
    }

    handle() {
        const { ctx, chat_id, inline_msg_id, video_id } = this;
        const { log, error } = this.logSuite();
        const inform = this.inform;
        
        log(`Started downloading video for ${video_id}`);
        this.downloadFromLink()
            .then(async logs => {
                log(logs);
                await this.send()
                this.cleanUpFiles()
                await ctx.api.deleteMessage(chat_id, inline_msg_id);
            })
            .catch((e) => {
                error(e);
                inform(fullErrorMessage("atDownload", e));
                this.cleanUpFiles()
            })
            
    }
}

bot.on("callback_query:data", (ctx) => {
    const handler = new CallbackQueryHandler(ctx);
    handler.handle();
});

// ------------------ CALLBACK QUERY HANDLER END ----------------
// -------------------- MESSAGE HANDLER START -------------------
// Handles messages that contain URLs or commands

const allowedFormats = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '4K']
const QUALITY_LEVELS: { threshold: number; label: (typeof allowedFormats)[number]; }[] = [
        { threshold: 360, label: "240p" },
        { threshold: 480, label: "360p" },
        { threshold: 720, label: "480p" },
        { threshold: 1080, label: "720p" },
        { threshold: 1440, label: "1080p" },
        { threshold: 2160, label: "1440p" },
        { threshold: 4320, label: "4K" },
    ];

function getQualityID(height: number): typeof allowedFormats[number] {
        for (const level of QUALITY_LEVELS) {
            if (height < level.threshold) {
                return level.label;
            }
        }
        return "4K"; // Or a specific label for very high resolutions if 4320 is not the max
    }
class URLMessageHandler {
    private ctx: Context;
    private url: string;
    private _bot_msg_id?: number; // message ID for the initial message

    private get bot_msg_id() {
        if (this._bot_msg_id === undefined) {
            this.logSuite().error("Tried to access bot_msg_id before it was set.");
            throw new Error("Bot message ID is not set. Call fetchVideoInfo() first.");
        }
        return this._bot_msg_id;
    }

    private logSuite: (subprocess?: string) => LogSuite;
    private _inform?: ReturnType<typeof getInform>;

    private get inform() {
        // sets the function if it's not set yet
        if (this._inform === undefined) {
            this._inform = getInform(this.ctx, this.bot_msg_id);
        }
        return this._inform;
    }

    constructor(
        ctx: Context,
    ) {
        this.ctx = ctx;
        this.url = ctx.message!.text!; // we know that this block can only trigger if url is present in the message
        this.logSuite = (subprocess?: string) => getLogFunctions("MessageHandler", subprocess)
    }

    fetchVideoInfo() {
        const { ctx, url } = this;
        const { log } = this.logSuite("fetchVideoInfo");
        return ctx.reply("Gathering video info...")
            .then(msg => {
                this._bot_msg_id = msg.message_id
                log(`Set bot message ID to ${this.bot_msg_id}`);

                return ytdlp.execAsync(url, infoArgs)
                    .then(out => JSON.parse(out) as VideoInfo)
        })
    }

    /**
     * Processes the video information retrieved from ytdlp.
     * It sorts the video formats by filesize, finds the largest audio format,
     * and stores the description of the video in a file.
     */
    processVideoInfo(info: VideoInfo) {
        const { url } = this;
        const { log, error } = this.logSuite("processVideoInfo");

        console.log(info.formats)

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

        // for each quality ID (from formats) stores the format ID,
        // filesize, true height and true width of the video in the format
        const existingFormats: Record<
            typeof allowedFormats[number],
            [string, number, number, number]
        > = {};

        videoformats.forEach((format) => {
            // files are sorted by size so smaller files take precedence over larger ones
            const h = format.height!;
            const w = format.width!;
            const fID = format.format_id;
            const filesize = format.filesize!;

            existingFormats[getQualityID(h)] = [fID, filesize, h, w];
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
        
        return { video_id, existingFormats, largest_audio };
    }

    /**
     * Builds an inline keyboard with the available formats and the largest audio format.
     * The keyboard allows the user to select a format to download.
     * @param existingFormats - a record of available formats
     * @param largest_audio - the largest audio format
     */
    buildInlineKeyboard(info: VideoInfo, processingResult: ReturnType<typeof this.processVideoInfo>) {
        const { video_id, existingFormats, largest_audio } = processingResult;
        // const { log, error } = this.logSuite("buildInlineKeyboard");

        const downloadMenuMarkup = new InlineKeyboard();

        function formatSize(bytes: number) {
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
            .sort(([res1], [res2]) => allowedFormats.indexOf(res1) - allowedFormats.indexOf(res2))
            .forEach(([res, [id, size, h, w]]) => {
                downloadMenuMarkup.row();
                downloadMenuMarkup.text(
                    `${res} (≤${formatSize(size + largest_audio.filesize!)})`,
                    `${video_id}|${id}+ba|${info.duration}|${h}|${w}`,
                );
        });

        return downloadMenuMarkup
    }

    async handle() {
        const { ctx, url } = this;
        const { log, error } = this.logSuite();

        if (!isYoutubeURL(url)) {
            log("Rejected: Not a YouTube link");
            ctx.reply(
                "I can only process YouTube links. Send any YouTube link to receive an auto-formatted response, or request a specific result using commands.",
            );
            return;
        }

        await this.fetchVideoInfo()
            .then(info => {
                this.inform("Select one option:", {
                    reply_markup: this.buildInlineKeyboard(info, this.processVideoInfo(info)),
                });
            })
            .catch(e => {
                error(e);
                if (`${e}`.includes("not a valid URL")) {
                    this.inform(fullErrorMessage("badURL", e));
                } else {
                    this.inform(fullErrorMessage("atGettingInfo", e));
                }
            })
    }
}

bot.on("message::url", async (ctx) => {
    new URLMessageHandler(ctx).handle();
});

// -------------------- MESSAGE HANDLER END -------------------
// -------------------- COMMAND HANDLER START -----------------

/**
 * Simple handler for the /format command.
 * It takes a YouTube link, retrieves the video information using ytdlp,
 * and formats the response with the video description and link.
 */
class FormatCommandHandler {
    private url: string;
    private logSuite: (subprocess?: string) => LogSuite;
    private inform: ReturnType<typeof getInform>;

    constructor(
        private ctx: Context,
    ) {
        this.url = ctx.message!.text!.split("/format ")[1];
        
        this.inform = getInform(ctx, ctx.message!.message_id!);
        this.logSuite = (subprocess?: string) => getLogFunctions("FormatCommandHandler", subprocess);
    }

    handle() {
        const { url } = this;
        const { log, error } = this.logSuite();
        const inform = this.inform;

        if (!isYoutubeURL(url)) {
            inform(
                "This command only accepts YouTube links, and appends video descriptions to them.",
            );
            return;
        }

        log(`Checking: ${url}`);
        inform("Gathering video info...");

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
}

/**
 * Handles /format command.
 */
bot.command("format", (ctx) => {
    new FormatCommandHandler(ctx).handle();
});

// -------------------- COMMAND HANDLER END -------------------
// -------------------- DEFAULT MESSAGE HANDLER START -----------------

/**
 * Default message handler. Can only be triggerred if a non-link message is sent.
 */
class DefaultMessageHandler {
    private logSuite: (subprocess?: string) => LogSuite;
    private inform: ReturnType<typeof getInform>;
    constructor(
        private ctx: Context,
    ) {
        this.inform = getInform(ctx, ctx.message?.message_id!);
        this.logSuite = (subprocess?: string) => getLogFunctions("DefaultMessageHandler", subprocess);
    }

    handle() {
        const { log } = this.logSuite();
        log("No processing done: not a YouTube link");

        // only explain purpose if in private chat
        if (this.ctx.chat!.type == "private") {
            this.inform(
                "I can only process YouTube links. Send any YouTube link to receive an auto-formatted response, or request a specific result using commands.",
            );
        }
    }
}

bot.on("message", (ctx) => {
    new DefaultMessageHandler(ctx).handle();
});

// -------------------- DEFAULT MESSAGE HANDLER END -------------------

console.debug("Starting...");
bot.start();
