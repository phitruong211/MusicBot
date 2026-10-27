const env = process.env;

module.exports = {
  token: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID || null,
  color: parseInt((env.EMBED_COLOR || "#5865F2").replace("#", ""), 16),
  status: env.BOT_STATUS || "/play",
  // Tiền tố lệnh chữ ("r!play ..."), không phân biệt hoa thường. Đặt PREFIX= (rỗng) để tắt.
  prefix: env.PREFIX ?? "r!",
  messageContent: false, // index.js đặt true khi Message Content Intent đã bật trong Developer Portal
  defaultVolume: Number(env.DEFAULT_VOLUME || 60),
  leaveAfterMs: Number(env.LEAVE_AFTER_SECONDS || 120) * 1000,
  lavalink: {
    host: env.LAVALINK_HOST || "localhost",
    port: Number(env.LAVALINK_PORT || 2333),
    password: env.LAVALINK_PASSWORD || "youshallnotpass",
  },
  // Node thứ hai chạy Opus quality 10 (Lavalink chỉ đặt được chất lượng Opus cho cả node, nên mỗi mức một node).
  // Không đặt LAVALINK_HQ_HOST thì bot chỉ dùng một node và ẩn lựa chọn Opus.
  lavalinkHq: env.LAVALINK_HQ_HOST
    ? {
        host: env.LAVALINK_HQ_HOST,
        port: Number(env.LAVALINK_HQ_PORT || 2333),
        password: env.LAVALINK_PASSWORD || "youshallnotpass",
      }
    : null,
};
