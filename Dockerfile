# stage 1: compile the code to an executable
FROM denoland/deno:2.2.12 AS builder
WORKDIR /app
COPY deno.json deno.lock* ./
COPY bot.ts ./

# Mount a cache directory to Deno's cache location
# Replace /deno-dir if your Deno version uses a different default cache path inside the container
RUN --mount=type=cache,target=/deno-dir deno cache --lock=deno.lock bot.ts
RUN deno compile --allow-read --allow-write --allow-env --allow-net --allow-run --output bot_bin bot.ts

# stage 2: run the executable
# debian is used for now since file compiled for deno does not satisfy requirements for alpine
FROM debian:stable-slim

# Install ffmpeg and curl (needed for downloading yt-dlp) using apt
# Clean up apt cache afterwards to keep image size down
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg curl python3 ca-certificates && \
    # Download the latest Linux yt-dlp binary
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp && \
    chmod a+rx /usr/bin/yt-dlp && \
    # Clean up apt cache
    rm -rf /var/lib/apt/lists/*
WORKDIR /etc/bot
COPY --from=builder /app/bot_bin /etc/bot/
# directory files
COPY .env ./
# yt-dlp plugins
COPY plugins /etc/yt-dlp/plugins
COPY cookies.txt ./cookies.txt
# run the bot
CMD ["/etc/bot/bot_bin"]