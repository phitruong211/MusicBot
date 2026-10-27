const env = process.env;

module.exports = {
  token: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID || null,
  color: parseInt((env.EMBED_COLOR || "#5865F2").replace("#", ""), 16),
  status: env.BOT_STATUS || "/play",
  defaultVolume: Number(env.DEFAULT_VOLUME || 60),
  leaveAfterMs: Number(env.LEAVE_AFTER_SECONDS || 120) * 1000,
  lavalink: {
    host: env.LAVALINK_HOST || "localhost",
    port: Number(env.LAVALINK_PORT || 2333),
    password: env.LAVALINK_PASSWORD || "youshallnotpass",
  },
};
