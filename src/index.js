const { Client, GatewayIntentBits, ActivityType, Events, MessageFlags } = require("discord.js");
const { LavalinkManager } = require("lavalink-client");
const config = require("./config");
const db = require("./db");
const commands = require("./commands");
const { nowEmbed, panelRow, scheduleLeave, cancelLeave, autoplay, applyPrefs } = require("./music");

if (!config.token || !config.clientId) {
  console.error("Thiếu DISCORD_TOKEN hoặc CLIENT_ID trong .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const lava = (client.lavalink = new LavalinkManager({
  nodes: [
    {
      id: "main",
      host: config.lavalink.host,
      port: config.lavalink.port,
      authorization: config.lavalink.password,
      retryAmount: 30,
      retryDelay: 5000,
    },
  ],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true, // bài lỗi thì tự nhảy bài kế tiếp
  client: { id: config.clientId, username: "MusicBot" },
  playerOptions: {
    defaultSearchPlatform: "ytsearch",
    onDisconnect: { destroyPlayer: true, autoReconnect: false },
  },
  queueOptions: { maxPreviousTracks: 25 },
}));

client.on("raw", (d) => lava.sendRawData(d));

// ---------- 24/7 ----------
async function restorePlayer(s) {
  try {
    if (!client.guilds.cache.has(s.guild_id)) return;
    const player =
      lava.getPlayer(s.guild_id) ??
      lava.createPlayer({
        guildId: s.guild_id,
        voiceChannelId: s.voice_channel,
        textChannelId: s.text_channel,
        selfDeaf: true,
        volume: s.volume ?? config.defaultVolume,
      });
    if (!player.connected) await player.connect();
    await applyPrefs(player);
  } catch (e) {
    console.error(`[24/7] ${s.guild_id}:`, e.message);
  }
}

let restored = false;
lava.nodeManager.on("connect", async (node) => {
  console.log(`[lavalink] node ${node.id} đã kết nối`);
  if (restored) return;
  restored = true;
  for (const s of db.alwaysOnGuilds()) await restorePlayer(s);
});
lava.nodeManager.on("disconnect", (node) => {
  console.warn(`[lavalink] node ${node.id} mất kết nối`);
  restored = false; // Lavalink restart làm mất player, nạp lại khi nối lại
});
lava.nodeManager.on("error", (node, err) => console.error(`[lavalink] ${node.id}:`, err.message));

// ---------- sự kiện phát nhạc ----------
const textChannel = (player) => client.channels.cache.get(player.textChannelId);

lava.on("trackStart", async (player, track) => {
  cancelLeave(player);
  player.get("panel")?.delete().catch(() => {});
  if (!db.getSettings(player.guildId).announce) return;
  const msg = await textChannel(player)
    ?.send({ embeds: [nowEmbed(player, track)], components: [panelRow(player)] })
    .catch(() => null);
  player.set("panel", msg);
});

lava.on("trackError", (player, track, payload) => {
  console.error("[trackError]", track?.info.uri, payload?.exception?.message, payload?.exception?.cause);
  textChannel(player)?.send(`⚠️ Không phát được **${track?.info.title ?? "bài này"}**, đang chuyển bài.`).catch(() => {});
});

lava.on("queueEnd", async (player, track) => {
  player.get("panel")?.edit({ components: [] }).catch(() => {});
  if (db.getSettings(player.guildId).autoplay && track) {
    const ok = await autoplay(player, track).catch((e) => (console.error("[autoplay]", e.message), false));
    if (ok) return;
  }
  scheduleLeave(player);
});

lava.on("playerDestroy", (player) => {
  cancelLeave(player);
  clearTimeout(player.get("emptyTimer"));
  player.get("panel")?.delete().catch(() => {});
  const s = db.getSettings(player.guildId);
  if (s.always_on && s.voice_channel) setTimeout(() => restorePlayer(s), 5000);
});

// Kênh voice không còn người (trừ bot) trong 60 giây thì rời, trừ khi bật 24/7.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const player = lava.getPlayer(newState.guild.id);
  if (!player) return;
  if (oldState.channelId !== player.voiceChannelId && newState.channelId !== player.voiceChannelId) return;

  clearTimeout(player.get("emptyTimer"));
  const channel = newState.guild.channels.cache.get(player.voiceChannelId);
  const humans = channel?.members.filter((m) => !m.user.bot).size ?? 0;
  if (humans === 0 && !db.getSettings(newState.guild.id).always_on) {
    player.set("emptyTimer", setTimeout(() => player.destroy("Kênh trống").catch(() => {}), 60_000));
  }
});

// ---------- khởi động & lệnh ----------
client.once(Events.ClientReady, async () => {
  await lava.init({ ...client.user });
  client.user.setActivity(config.status, { type: ActivityType.Listening });

  const defs = commands.list.map((c) => c.data.toJSON());
  if (config.guildId) await client.application.commands.set(defs, config.guildId);
  else await client.application.commands.set(defs);
  console.log(`Đã đăng nhập ${client.user.tag}, ${defs.length} lệnh`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) return await commands.autocomplete(i);
    if (i.isButton() && i.customId.startsWith("m:")) return await commands.button(i);
    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return await i.reply({ content: "Chỉ dùng được trong server.", flags: MessageFlags.Ephemeral });
    await commands.byName.get(i.commandName)?.run(i);
  } catch (e) {
    console.error(`[${i.commandName ?? i.customId}]`, e);
    const msg = { content: "❌ Có lỗi xảy ra, thử lại sau.", flags: MessageFlags.Ephemeral };
    await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

// Docker gửi SIGTERM khi tắt máy/stop; đóng gateway sạch để bot hiện offline ngay thay vì treo vài phút.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await client.destroy();
    process.exit(0);
  });
}
client.login(config.token);
