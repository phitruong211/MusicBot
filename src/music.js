const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const config = require("./config");
const { getSettings } = require("./db");

const pad = (n) => String(n).padStart(2, "0");

exports.fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

// "90", "1:30", "1:02:03" -> ms; trả null nếu sai định dạng
exports.parseTime = (text) => {
  const parts = text.trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
};

// Màu embed riêng của từng server (lưu dạng hex 6 ký tự), không đặt thì dùng màu trong .env.
exports.colorOf = (guildId) => {
  const c = getSettings(guildId).color;
  return c ? parseInt(c, 16) : config.color;
};

// 15 băng EQ của Lavalink: 0=25Hz ... 8=1kHz ... 14=16kHz. Gain từ -0.25 đến 1.
const bands = (from, ...gains) => gains.map((gain, i) => ({ band: from + i, gain }));
exports.EQ_PRESETS = {
  flat: [],
  bass: bands(0, 0.25, 0.2, 0.15, 0.1, 0.05),
  treble: bands(9, 0.05, 0.1, 0.15, 0.2, 0.25, 0.25),
  vocal: bands(7, 0.1, 0.2, 0.2, 0.15, 0.1),
  edm: bands(0, 0.2, 0.15, 0.1, 0, -0.05, -0.05, 0, 0, 0, 0.05, 0.1, 0.15, 0.2, 0.2, 0.15),
  lofi: bands(0, 0.1, 0.1, 0.05, 0, 0, 0, 0, 0, 0, -0.05, -0.1, -0.15, -0.2, -0.25, -0.25),
};

// Áp EQ + tốc độ/cao độ đã lưu của server lên player (gọi khi player mới được tạo).
exports.applyPrefs = async (player) => {
  const { eq, speed, pitch } = getSettings(player.guildId);
  const fm = player.filterManager;
  if (eq) await (exports.EQ_PRESETS[eq]?.length ? fm.setEQ(exports.EQ_PRESETS[eq]) : fm.clearEQ());
  if (speed) await fm.setSpeed(speed);
  if (pitch) await fm.setPitch(pitch);
};

exports.nowEmbed = (player, track) => {
  const { info } = track;
  const loop = { off: "Tắt", track: "Bài hiện tại", queue: "Cả hàng chờ" }[player.repeatMode];
  const line = [info.author || "?", info.isStream ? "LIVE" : exports.fmt(info.duration), track.requester?.id && `<@${track.requester.id}>`];
  return new EmbedBuilder()
    .setDescription(line.filter(Boolean).join(" • "))
    .setColor(exports.colorOf(player.guildId))
    .setAuthor({ name: player.paused ? "Đang tạm dừng" : "Đang phát" })
    .setTitle(info.title.slice(0, 256))
    .setURL(info.uri || null)
    .setThumbnail(info.artworkUrl || null)
    .setFooter({ text: `Âm lượng ${player.volume}% • Lặp: ${loop} • Hàng chờ: ${player.queue.tracks.length} bài` });
};

exports.SOURCES = [
  { name: "YouTube", value: "ytsearch" },
  { name: "YouTube Music", value: "ytmsearch" },
  { name: "Spotify", value: "spsearch" },
  { name: "SoundCloud", value: "scsearch" },
];

// Node theo chất lượng Opus của server: "hq" (Opus 10) nếu được chọn và đang kết nối, còn lại "main" (Opus 5).
exports.nodeIdFor = (lava, guildId) =>
  getSettings(guildId).opus === 10 && lava.nodeManager.nodes.get("hq")?.connected ? "hq" : "main";

// Một hàng nút duy nhất; tua và xáo trộn dùng lệnh /seek, /shuffle.
exports.panelRows = (player) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("m:pause")
      .setEmoji(player.paused ? "▶️" : "⏸️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("m:skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("m:loop")
      .setEmoji("🔁")
      .setStyle(player.repeatMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("m:stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  ),
];

// Không đặt role DJ = ai cũng điều khiển được.
exports.isDJ = (member) => {
  const { dj_role } = getSettings(member.guild.id);
  return (
    !dj_role ||
    member.roles.cache.has(dj_role) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
};

exports.scheduleLeave = (player, delay = config.leaveAfterMs) => {
  clearTimeout(player.get("leaveTimer"));
  if (getSettings(player.guildId).always_on) return;
  player.set(
    "leaveTimer",
    setTimeout(() => {
      if (!player.playing && !player.paused) player.destroy("Không hoạt động").catch(() => {});
    }, delay),
  );
};

exports.cancelLeave = (player) => clearTimeout(player.get("leaveTimer"));

// Autoplay: lấy "YouTube Mix" của bài vừa phát. Bài không phải YouTube (vd Spotify) thì tìm bản YouTube trước.
exports.autoplay = async (player, lastTrack) => {
  let id = lastTrack.info.sourceName === "youtube" ? lastTrack.info.identifier : null;
  if (!id) {
    const found = await player.search({ query: `ytsearch:${lastTrack.info.title} ${lastTrack.info.author}` }, lastTrack.requester);
    id = found.tracks[0]?.info.identifier;
  }
  if (!id) return false;

  const mix = await player.search({ query: `https://www.youtube.com/watch?v=${id}&list=RD${id}` }, lastTrack.requester);
  const seen = new Set([id, ...player.queue.previous.map((t) => t.info.identifier)]);
  const next = mix.tracks.filter((t) => !seen.has(t.info.identifier)).slice(0, 10);
  if (!next.length) return false;

  await player.queue.add(next);
  await player.play();
  return true;
};
